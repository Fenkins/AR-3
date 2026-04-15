#!/usr/bin/env python3
"""
GPU Worker for AR-3 Research Platform
Runs on Vast.ai instance, polls for GPU jobs and executes them.

Usage: python3 gpu_worker.py [--poll-interval 5]

GPU jobs are submitted via POST /api/jobs/gpu and results polled via GET.
The worker:
1. Polls /tmp/gpu_jobs.json for pending jobs
2. Executes each job (runs the prompt as a Python script or similar)
3. Writes results to /tmp/gpu_results.json
4. Updates job status in /tmp/gpu_jobs.json
"""

import json
import os
import sys
import time
import subprocess
import traceback
from datetime import datetime
from pathlib import Path

JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
JOB_RESULTS_FILE = '/tmp/gpu_results.json'
POLL_INTERVAL = 5  # seconds

def log(msg):
    print(f"[GPU Worker {datetime.now().isoformat()}] {msg}", flush=True)

def read_queue():
    try:
        if not os.path.exists(JOB_QUEUE_FILE):
            return []
        with open(JOB_QUEUE_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        log(f"Error reading queue: {e}")
        return []

def write_queue(jobs):
    try:
        with open(JOB_QUEUE_FILE, 'w') as f:
            json.dump(jobs, f, indent=2)
    except Exception as e:
        log(f"Error writing queue: {e}")

def read_results():
    try:
        if not os.path.exists(JOB_RESULTS_FILE):
            return {}
        with open(JOB_RESULTS_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        log(f"Error reading results: {e}")
        return {}

def write_results(results):
    try:
        with open(JOB_RESULTS_FILE, 'w') as f:
            json.dump(results, f, indent=2)
    except Exception as e:
        log(f"Error writing results: {e}")

def execute_job(job):
    """Execute a GPU job and return the result."""
    job_id = job['jobId']
    space_id = job['spaceId']
    stage_name = job['stageName']
    prompt = job['prompt']
    context = job.get('context', '')

    log(f"Executing job {job_id}: stage={stage_name}, space={space_id}")

    try:
        # For now, execute the prompt as a Python script
        # In a real implementation, this would:
        # - Load trained models from disk
        # - Run inference/training based on the prompt
        # - Return output

        # Create a working directory for this job
        work_dir = f"/tmp/gpu_job_{job_id}"
        os.makedirs(work_dir, exist_ok=True)

        # Write the prompt and context to files for inspection
        with open(f"{work_dir}/prompt.txt", 'w') as f:
            f.write(prompt)
        with open(f"{work_dir}/context.txt", 'w') as f:
            f.write(context)

        # Execute with nvidia-smi to confirm GPU is available
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,memory.total,utilization.gpu', '--format=csv,noheader'],
            capture_output=True,
            text=True,
            timeout=10
        )

        gpu_info = result.stdout.strip()
        log(f"GPU Info: {gpu_info}")

        # Placeholder: in a real implementation, you would run actual GPU code here
        # For example:
        # - Load a PyTorch model
        # - Run training loop
        # - Run inference
        #
        # output = run_gpu_compute(prompt, context)
        #
        # For now, we simulate with a simple GPU check + echo

        output = f"[GPU Worker] Job {job_id} executed successfully.\n"
        output += f"Stage: {stage_name}\n"
        output += f"GPU: {gpu_info}\n"
        output += f"Prompt length: {len(prompt)} chars\n"
        output += f"\n--- Prompt Summary ---\n{prompt[:500]}..."

        return {
            'jobId': job_id,
            'output': output,
            'tokensUsed': len(prompt.split()) * 2,  # rough estimate
            'cost': 0.0,  # GPU compute cost would be tracked here
            'completedAt': datetime.now().isoformat(),
        }

    except subprocess.TimeoutExpired:
        return {
            'jobId': job_id,
            'output': '',
            'error': 'GPU job timed out',
            'completedAt': datetime.now().isoformat(),
        }
    except Exception as e:
        return {
            'jobId': job_id,
            'output': '',
            'error': f"GPU job failed: {str(e)}\n{traceback.format_exc()}",
            'completedAt': datetime.now().isoformat(),
        }

def process_jobs():
    queue = read_queue()
    results = read_results()

    # Find and process pending jobs
    processed = False
    for job in queue:
        if job['status'] == 'pending':
            # Mark as running
            job['status'] = 'running'
            job['startedAt'] = datetime.now().isoformat()
            write_queue(queue)

            # Execute the job
            result = execute_job(job)

            # Store result
            results[job['jobId']] = result

            # Mark job as completed in queue
            for j in queue:
                if j['jobId'] == job['jobId']:
                    j['status'] = 'completed'
                    j['completedAt'] = datetime.now().isoformat()
                    break

            write_queue(queue)
            write_results(results)
            processed = True
            log(f"Job {job['jobId']} completed: {result.get('error') or 'success'}")

    return processed

def main():
    log(f"GPU Worker started. Polling every {POLL_INTERVAL}s for jobs...")
    log(f"Job queue: {JOB_QUEUE_FILE}")
    log(f"Results file: {JOB_RESULTS_FILE}")

    # Verify GPU is available
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            log(f"GPU detected: {result.stdout.strip()}")
        else:
            log("WARNING: nvidia-smi failed. GPU may not be available.")
    except FileNotFoundError:
        log("ERROR: nvidia-smi not found. GPU worker requires CUDA.")
        sys.exit(1)
    except Exception as e:
        log(f"WARNING: Could not detect GPU: {e}")

    while True:
        try:
            processed = process_jobs()
            # If we processed jobs, check immediately again
            # Otherwise sleep before next poll
            if not processed:
                time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            log("GPU Worker stopped by user.")
            break
        except Exception as e:
            log(f"Error in main loop: {e}")
            traceback.print_exc()
            time.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    main()
