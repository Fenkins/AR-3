#!/usr/bin/env python3
"""
GPU Worker for AR-3 Research Platform
Runs on Vast.ai instance, polls for GPU jobs and executes them.

Supports concurrent execution via ThreadPoolExecutor - configurable via GPU_MAX_CONCURRENT.

Usage: python3 gpu_worker.py [--poll-interval 3] [--max-concurrent 1]
"""

import json
import os
import sys
import time
import subprocess
import traceback
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
JOB_RESULTS_FILE = '/tmp/gpu_results.json'
GPU_CONFIG_FILE = '/tmp/gpu_config.json'
POLL_INTERVAL = 3  # seconds
DEFAULT_MAX_CONCURRENT = 1
DEFAULT_JOB_TIMEOUT = 300  # 5 minutes

# Thread-safe lock for queue file operations
queue_lock = threading.Lock()

def log(msg, thread_id=None):
    tid = f"[T-{thread_id}]" if thread_id is not None else "[GPU Worker]"
    print(f"[{datetime.now().isoformat()}] {tid} {msg}", flush=True)

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

def get_gpu_config():
    """Read GPU config from file (written by API server)."""
    try:
        if not os.path.exists(GPU_CONFIG_FILE):
            return {'maxConcurrent': DEFAULT_MAX_CONCURRENT, 'jobTimeout': DEFAULT_JOB_TIMEOUT}
        with open(GPU_CONFIG_FILE, 'r') as f:
            return json.load(f)
    except:
        return {'maxConcurrent': DEFAULT_MAX_CONCURRENT, 'jobTimeout': DEFAULT_JOB_TIMEOUT}

def execute_python_code(code: str, timeout: int = DEFAULT_JOB_TIMEOUT) -> dict:
    """Execute Python code and return result/error."""
    log(f"Executing Python code ({len(code)} chars)", thread_id=threading.current_thread().name)
    
    code_file = f"/tmp/gpu_code_{int(time.time()*1000)}.py"
    with open(code_file, 'w') as f:
        f.write(code)
    
    try:
        result = subprocess.run(
            ['python3', code_file],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd='/tmp'
        )
        
        os.unlink(code_file)
        
        if result.returncode == 0:
            return {
                'success': True,
                'output': result.stdout.strip(),
                'error': None,
            }
        else:
            return {
                'success': False,
                'output': result.stdout.strip(),
                'error': result.stderr.strip() or f'Exit code: {result.returncode}',
            }
    except subprocess.TimeoutExpired:
        os.unlink(code_file)
        return {
            'success': False,
            'output': '',
            'error': f'Code execution timed out ({timeout}s limit)',
        }
    except Exception as e:
        try:
            os.unlink(code_file)
        except:
            pass
        return {
            'success': False,
            'output': '',
            'error': f"Execution error: {str(e)}\n{traceback.format_exc()}",
        }

def cleanup_gpu_memory():
    """Attempt to free GPU memory between jobs."""
    try:
        subprocess.run(
            ['python3', '-c', 'import torch; torch.cuda.empty_cache(); print("GPU cache cleared")'],
            capture_output=True, timeout=10
        )
    except:
        pass

def extract_gpu_command(prompt: str) -> dict:
    """Extract GPU command from LLM response prompt."""
    import re
    
    gpu_command = None
    
    # Strategy 1a: Full JSON parse
    try:
        parsed = json.loads(prompt.strip())
        if isinstance(parsed, dict) and parsed.get('action') == 'run_python' and isinstance(parsed.get('code'), str):
            gpu_command = parsed
            log(f"Strategy 1a: Parsed full prompt as JSON GPU command", thread_id=threading.current_thread().name)
    except:
        pass
    
    # Strategy 1b: Brace-matching JSON extraction
    if not gpu_command:
        in_str = False
        escape_next = False
        brace_depth = 0
        json_start = -1
        for i, ch in enumerate(prompt):
            if escape_next:
                escape_next = False
                continue
            if ch == '\\' and in_str:
                escape_next = True
                continue
            if ch == '"' and not escape_next:
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == '{':
                if brace_depth == 0:
                    json_start = i
                brace_depth += 1
            elif ch == '}':
                brace_depth -= 1
                if brace_depth == 0 and json_start >= 0:
                    candidate_str = prompt[json_start:i+1]
                    try:
                        candidate = json.loads(candidate_str)
                        if isinstance(candidate, dict) and candidate.get('action') == 'run_python' and isinstance(candidate.get('code'), str):
                            gpu_command = candidate
                            log(f"Strategy 1b: Found JSON GPU command at pos {json_start}", thread_id=threading.current_thread().name)
                            break
                    except:
                        pass
                    json_start = -1
    
    # Strategy 2: ```python blocks
    if not gpu_command:
        code_blocks = re.findall(r'```python\s*(.*?)\s*```', prompt, re.DOTALL)
        if code_blocks:
            biggest = max(code_blocks, key=len).strip()
            if len(biggest) > 20:
                if biggest.strip().startswith('{'):
                    try:
                        parsed = json.loads(biggest)
                        if isinstance(parsed.get('code'), str) and isinstance(parsed.get('action'), str):
                            gpu_command = parsed
                    except:
                        code_match = re.search(r'"code":\s*"([^"\\]*(?:\\.[^"\\]*)*)"', biggest, re.DOTALL)
                        if code_match:
                            gpu_command = {"action": "run_python", "code": code_match.group(1)}
                if not gpu_command:
                    gpu_command = {"action": "run_python", "code": biggest}
    
    # Strategy 3: Raw Python-like code
    if not gpu_command:
        lines = prompt.split('\n')
        code_lines = []
        in_code = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('#') or stripped.startswith('- ') or stripped.startswith('* ') or not stripped:
                if in_code:
                    in_code = False
                continue
            if any(ind in stripped for ind in ['import ', 'from ', 'def ', 'class ', 'torch.', 'cuda', 'tensor']):
                in_code = True
                code_lines.append(stripped)
            elif in_code and not stripped.startswith('{') and not stripped.startswith('"'):
                code_lines.append(stripped)
        if code_lines:
            code = '\n'.join(code_lines)
            if len(code) > 20:
                gpu_command = {"action": "run_python", "code": code}
    
    if not gpu_command or not isinstance(gpu_command.get('code'), str) or len(gpu_command.get('code', '')) < 10:
        gpu_command = {"action": "nvidia_smi"}
    
    return gpu_command

def execute_gpu_command(job: dict, timeout: int = DEFAULT_JOB_TIMEOUT) -> dict:
    """Execute a GPU command from the job queue."""
    job_id = job['jobId']
    stage_name = job.get('stageName', 'unknown')
    space_name = job.get('spaceName', 'unknown')
    prompt = job.get('prompt', '')
    context = job.get('context', '')
    
    tid = threading.current_thread().name
    log(f"Processing GPU job {job_id}: stage={stage_name} space={space_name}", thread_id=tid)
    log(f"Prompt length: {len(prompt)} chars", thread_id=tid)
    
    try:
        gpu_command = extract_gpu_command(prompt)
        action = gpu_command.get('action', 'run_python')
        
        if action == 'run_python':
            code = gpu_command.get('code', '')
            if not code or len(code) < 10:
                return {
                    'success': False,
                    'output': '',
                    'error': 'No valid Python code found in LLM response',
                }
            log(f"Running Python code, {len(code)} chars", thread_id=tid)
            result = execute_python_code(code, timeout=timeout)
            
        elif action == 'run_bash':
            cmd = gpu_command.get('command', gpu_command.get('cmd', ''))
            log(f"Running bash command: {cmd[:100]}", thread_id=tid)
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=120
            )
            result = {
                'success': result.returncode == 0,
                'output': result.stdout.strip(),
                'error': result.stderr.strip() if result.returncode != 0 else None,
            }
            
        elif action == 'nvidia_smi':
            result = subprocess.run(
                ['nvidia-smi', '--query-gpu=name,memory.total,memory.used,utilization.gpu,utilization.memory', '--format=csv,noheader,nounits'],
                capture_output=True, text=True, timeout=10
            )
            gpu_info = result.stdout.strip().split(', ')
            result = {
                'success': True,
                'output': json.dumps({
                    'gpu_name': gpu_info[0],
                    'memory_total_mb': gpu_info[1],
                    'memory_used_mb': gpu_info[2],
                    'gpu_utilization': gpu_info[3] + '%',
                    'memory_utilization': gpu_info[4] + '%',
                }),
                'error': None,
            }
        else:
            result = {
                'success': False,
                'output': '',
                'error': f"Unknown GPU action: {action}. Supported: run_python, run_bash, nvidia_smi",
            }
        
        # Cleanup GPU memory after job
        cleanup_gpu_memory()
        
        return result
        
    except Exception as e:
        cleanup_gpu_memory()
        return {
            'success': False,
            'output': '',
            'error': f"GPU command failed: {str(e)}\n{traceback.format_exc()}",
        }

def process_job(job: dict, timeout: int) -> dict:
    """Process a single job (called from worker thread)."""
    job_id = job['jobId']
    
    with queue_lock:
        queue = read_queue()
        for j in queue:
            if j['jobId'] == job_id:
                j['status'] = 'running'
                j['startedAt'] = datetime.now().isoformat()
                write_queue(queue)
                break
    
    tid = threading.current_thread().name
    log(f"Executing GPU job {job_id}", thread_id=tid)
    
    result = execute_gpu_command(job, timeout=timeout)
    
    with queue_lock:
        results = read_results()
        results[job_id] = {
            'jobId': job_id,
            'output': result.get('output', ''),
            'error': result.get('error'),
            'success': result.get('success', False),
            'completedAt': datetime.now().isoformat(),
        }
        write_results(results)
        
        queue = read_queue()
        for j in queue:
            if j['jobId'] == job_id:
                j['status'] = 'completed'
                j['completedAt'] = datetime.now().isoformat()
                break
        write_queue(queue)
    
    if result.get('success'):
        log(f"Job {job_id} succeeded: {str(result.get('output',''))[:100]}", thread_id=tid)
    else:
        log(f"Job {job_id} failed: {result.get('error', 'unknown')}", thread_id=tid)
    
    return result

def get_pending_jobs() -> list:
    """Get pending jobs and mark them as claimed (atomic)."""
    with queue_lock:
        queue = read_queue()
        pending = [j for j in queue if j.get('status') == 'pending']
        
        # Claim first N pending jobs based on max concurrent
        config = get_gpu_config()
        max_concurrent = config.get('maxConcurrent', DEFAULT_MAX_CONCURRENT)
        
        claimed = []
        for job in pending:
            if len(claimed) >= max_concurrent:
                break
            # Mark as claimed (will be picked up by worker threads)
            for j in queue:
                if j['jobId'] == job['jobId']:
                    j['status'] = 'claimed'
                    j['claimedAt'] = datetime.now().isoformat()
                    claimed.append(j)
                    break
        
        if claimed:
            write_queue(queue)
        
        return claimed

def main():
    import argparse
    parser = argparse.ArgumentParser(description='GPU Worker for AR-3')
    parser.add_argument('--poll-interval', type=int, default=POLL_INTERVAL, help='Poll interval in seconds')
    parser.add_argument('--max-concurrent', type=int, default=None, help='Max concurrent GPU jobs (overrides config)')
    args = parser.parse_args()
    
    log(f"GPU Worker starting with poll_interval={args.poll_interval}s")
    
    # Verify GPU
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            log(f"GPU detected: {result.stdout.strip()}")
        else:
            log("WARNING: nvidia-smi failed")
    except Exception as e:
        log(f"ERROR: Could not detect GPU: {e}")
        sys.exit(1)
    
    # Determine max concurrent
    config = get_gpu_config()
    max_concurrent = args.max_concurrent if args.max_concurrent else config.get('maxConcurrent', DEFAULT_MAX_CONCURRENT)
    job_timeout = config.get('jobTimeout', DEFAULT_JOB_TIMEOUT)
    log(f"Configuration: maxConcurrent={max_concurrent}, jobTimeout={job_timeout}s")
    
    # Main loop
    while True:
        try:
            # Get config periodically (may have changed)
            config = get_gpu_config()
            max_concurrent = config.get('maxConcurrent', DEFAULT_MAX_CONCURRENT)
            job_timeout = config.get('jobTimeout', DEFAULT_JOB_TIMEOUT)
            
            # Get pending jobs
            pending = get_pending_jobs()
            
            if pending:
                log(f"Found {len(pending)} pending jobs, executing with {max_concurrent} concurrent workers")
                
                # Execute jobs concurrently
                with ThreadPoolExecutor(max_workers=max_concurrent) as executor:
                    futures = {executor.submit(process_job, job, job_timeout): job for job in pending}
                    for future in as_completed(futures):
                        job = futures[future]
                        try:
                            future.result()
                        except Exception as e:
                            log(f"Job {job['jobId']} raised exception: {e}")
            else:
                time.sleep(args.poll_interval)
                
        except KeyboardInterrupt:
            log("GPU Worker stopped by interrupt.")
            break
        except Exception as e:
            log(f"Error in main loop: {e}")
            time.sleep(args.poll_interval)

if __name__ == '__main__':
    main()
