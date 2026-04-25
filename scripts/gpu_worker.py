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
import re as re_module
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
JOB_RESULTS_FILE = '/tmp/gpu_results.json'
GPU_CONFIG_FILE = '/tmp/gpu_config.json'
POLL_INTERVAL = 3  # seconds
DEFAULT_MAX_CONCURRENT = 1
DEFAULT_JOB_TIMEOUT = 3600  # 1 hour default

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


def _safe_float(val, default=0.0):
    """Coerce a value to float, handling int/str/float types."""
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val.strip())
        except Exception:
            return default
    return default


def extract_gpu_command(prompt: str) -> dict:
    """Extract GPU command from LLM response using robust multi-strategy approach.

    Strategies (in order):
      0. Strip markdown fences, try direct JSON parse
      1. Largest ```python block (not wrapped in JSON)
      2. Quote-aware brace matching for JSON objects with "code" field
      3. Bare ```python blocks (no JSON wrapper)
      4. Line-by-line code assembly (skip bullets/headers)
      5. Fallback: nvidia-smi diagnostic
    """
    import re

    # ── Strategy 0: Direct JSON from LLM (structured output) ─────────────────
    # Strip any surrounding markdown fences
    stripped = re_module.sub(
        r'^```(json|python)?\s*(.*?)\s*```$',
        r'\2',
        prompt.strip(),
        flags=re_module.DOTALL | re_module.IGNORECASE
    ).strip()
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict) and parsed.get('action') == 'run_python' and isinstance(parsed.get('code'), str):
            log(f"Strategy 0: Direct JSON parse OK, code={len(parsed['code'])} chars",
                thread_id=threading.current_thread().name)
            return parsed
    except Exception:
        pass

    gpu_command = None

    # ── Strategy 1: Largest ```python block (not JSON) ───────────────────────
    code_blocks = re_module.findall(
        r'```python\s*(.*?)\s*```',
        prompt,
        re_module.DOTALL | re_module.IGNORECASE
    )
    if code_blocks:
        best = max(code_blocks, key=lambda b: len(b.strip())).strip()
        # Remove non-ASCII characters (em-dash —, curly quotes, etc.) from extracted code
        best_clean = ''.join(c if ord(c) < 128 else '?' for c in best)
        if len(best_clean) > 50 and not best_clean.startswith('{'):
            log(f"Strategy 1: Pure ```python block, {len(best_clean)} chars",
                thread_id=threading.current_thread().name)
            return {"action": "run_python", "code": best_clean}

    # ── Strategy 2: Quote-aware brace matching for JSON objects ───────────────
    # Collect all top-level JSON objects containing 'action' and 'code'
    in_str = False
    escape_next = False
    brace_depth = 0
    json_start = -1
    candidates = []
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
                candidates.append(prompt[json_start:i+1])
                json_start = -1

    for cand in candidates:
        try:
            cand_obj = json.loads(cand)
            if (isinstance(cand_obj, dict)
                    and cand_obj.get('action') == 'run_python'
                    and isinstance(cand_obj.get('code'), str)
                    and len(cand_obj['code']) > 20):
                log(f"Strategy 2: JSON object with run_python, {len(cand_obj['code'])} chars",
                    thread_id=threading.current_thread().name)
                return cand_obj
        except Exception:
            pass

    # ── Strategy 3: Bare ```python blocks ─────────────────────────────────────
    for block in code_blocks:
        block = block.strip()
        # Remove non-ASCII characters (em-dash —, curly quotes, etc.)
        block_clean = ''.join(c if ord(c) < 128 else '?' for c in block)
        if len(block_clean) > 50 and re_module.search(r'\b(import |from |torch|cuda|tensor|def |class )', block_clean):
            log(f"Strategy 3: Bare ```python block with code, {len(block_clean)} chars",
                thread_id=threading.current_thread().name)
            return {"action": "run_python", "code": block_clean}

    # ── Strategy 4: Line-by-line code assembly ────────────────────────────────
    lines = prompt.split('\n')
    code_lines = []
    in_code = False
    for raw_line in lines:
        stripped = raw_line.strip()
        # Skip non-code lines
        if (stripped.startswith('#')
                or stripped.startswith('- ')
                or stripped.startswith('* ')
                or not stripped):
            if in_code:
                in_code = False
            continue
        if stripped.startswith('```') or stripped.startswith('{"'):
            continue
        # Skip numbered list items (e.g. "1. We need to load..." or "1. Simulates...")
        # unless they contain actual Python code (assignment, function call, import, etc.)
        if re.match(r'^\d+\.\s+\w', stripped):
            # Skip if line has NO Python indicators (no =, (, dot, keywords)
            if not any(kw in stripped for kw in ['=', '(', '.', 'import ', 'from ', 'def ', 'class ', 'torch.', 'cuda.', 'tensor(', '.cuda()', '.to(', 'return ', 'for ']):
                continue
        # Skip lines containing non-ASCII characters (em-dash —, en-dash –, quotes, etc.)
        # These are prose text from the LLM, not code
        if any(ord(c) > 127 for c in stripped):
            continue
        # Code indicators
        if any(kw in stripped for kw in ['import ', 'from ', 'def ', 'class ',
                                         'torch.', 'cuda.', 'tensor(', '.cuda()', '.to(']):
            in_code = True
        if in_code:
            code_lines.append(raw_line)
        elif len(code_lines) > 0 and stripped:
            if stripped.startswith('    ') or stripped.startswith('\t'):
                code_lines.append(raw_line)
            elif len(code_lines) > 5:
                break

    if code_lines:
        code = ''.join(c if ord(c) < 128 else '?' for c in '\n'.join(code_lines))
        if len(code) > 30:
            log(f"Strategy 4: Assembled code lines, {len(code)} chars",
                thread_id=threading.current_thread().name)
            return {"action": "run_python", "code": code}

    # ── Fallback: nvidia-smi diagnostic ─────────────────────────────────────
    log(f"WARNING: No valid GPU command found — falling back to nvidia-smi",
        thread_id=threading.current_thread().name)
    log(f"  Prompt preview (200 chars): {prompt[:200]}",
        thread_id=threading.current_thread().name)
    return {"action": "nvidia_smi"}



def execute_quantized_code(code: str, timeout: int = DEFAULT_JOB_TIMEOUT) -> dict:
    """"Execute Python code with quantized model support (bitsandbytes 8-bit)."""
    log(f"Executing quantized Python code ({len(code)} chars)",
        thread_id=threading.current_thread().name)

    # ── Pre-process: coerce f-string tensor.item():.Nf patterns ─────────────
    fixed_code = re_module.sub(
        r"f(['\"])(.+?)\{(.+?)\.item\(\):\.(\\d+)f\}(.*?)\\1",
        lambda m: "f'" + m.group(2) + '{float(' + m.group(3) + '.item()):.'
                  + m.group(4) + 'f}' + m.group(5) + "'",
        code
    )
    if fixed_code != code:
        log(f"Format-string coercion applied",
            thread_id=threading.current_thread().name)

    code_file = f"/tmp/gpu_code_{int(time.time()*1000)}.py"
    with open(code_file, 'w') as f:
        f.write(fixed_code)

    try:
        result = subprocess.run(
            ['python3', code_file],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd='/tmp',
            env={
                **os.environ,
                'LD_LIBRARY_PATH': '/usr/local/cuda/lib64:' + os.environ.get('LD_LIBRARY_PATH', ''),
            }
        )
        try:
            os.unlink(code_file)
        except Exception:
            pass

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
        try:
            os.unlink(code_file)
        except Exception:
            pass
        return {
            'success': False,
            'output': '',
            'error': f'Code execution timed out ({timeout}s limit)',
        }
    except Exception as e:
        try:
            os.unlink(code_file)
        except Exception:
            pass
        return {
            'success': False,
            'output': '',
            'error': str(e),
        }



def execute_python_code(code: str, timeout: int = DEFAULT_JOB_TIMEOUT) -> dict:
    """Execute Python code and return result/error."""
    log(f"Executing Python code ({len(code)} chars)",
        thread_id=threading.current_thread().name)

    # ── Pre-process: coerce f-string tensor.item():.Nf patterns ────────────────
    # .item() can return int/str/float — wrapping with float() prevents format errors
    # Matches: f'{expr.item():.4f}' → f'{float(expr.item()):.4f}'
    fixed_code = re_module.sub(
        r"f(['\"])(.+?)\{(.+?)\.item\(\):\.(\d+)f\}(.*?)\1",
        lambda m: "f'" + m.group(2) + '{float(' + m.group(3) + '.item()):.'
                  + m.group(4) + 'f}' + m.group(5) + "'",
        code
    )
    if fixed_code != code:
        log(f"Format-string coercion applied",
            thread_id=threading.current_thread().name)

    code_file = f"/tmp/gpu_code_{int(time.time()*1000)}.py"
    with open(code_file, 'w') as f:
        f.write(fixed_code)

    try:
        result = subprocess.run(
            ['python3', code_file],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd='/tmp'
        )
        try:
            os.unlink(code_file)
        except Exception:
            pass

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
        try:
            os.unlink(code_file)
        except Exception:
            pass
        return {
            'success': False,
            'output': '',
            'error': f'Code execution timed out ({timeout}s limit)',
        }
    except Exception as e:
        try:
            os.unlink(code_file)
        except Exception:
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
            ['python3', '-c',
             'import torch; torch.cuda.empty_cache(); print("GPU cache cleared")'],
            capture_output=True, timeout=10
        )
    except Exception:
        pass


def execute_gpu_command(job: dict, timeout: int = DEFAULT_JOB_TIMEOUT) -> dict:
    """Execute a GPU command from the job queue."""
    job_id = job['jobId']
    stage_name = job.get('stageName', 'unknown')
    space_name = job.get('spaceName', 'unknown')
    prompt = job.get('prompt', '')
    context = job.get('context', '')

    tid = threading.current_thread().name
    log(f"Processing GPU job {job_id}: stage={stage_name} space={space_name}",
        thread_id=tid)
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

        elif action == 'run_quantized':
            # bitsandbytes 8-bit quantization path
            code = gpu_command.get('code', '')
            if not code or len(code) < 10:
                return {
                    'success': False,
                    'output': '',
                    'error': 'No valid Python code found',
                }
            log(f"Running quantized Python code, {len(code)} chars", thread_id=tid)
            result = execute_quantized_code(code, timeout=timeout)

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
                ['nvidia-smi',
                 '--query-gpu=name,memory.total,memory.used,utilization.gpu,utilization.memory',
                 '--format=csv,noheader,nounits'],
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

        result['code'] = gpu_command.get('code', '')
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

        config = get_gpu_config()
        max_concurrent = config.get('maxConcurrent', DEFAULT_MAX_CONCURRENT)

        claimed = []
        for job in pending:
            if len(claimed) >= max_concurrent:
                break
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
    parser.add_argument('--poll-interval', type=int, default=POLL_INTERVAL,
                        help='Poll interval in seconds')
    parser.add_argument('--max-concurrent', type=int, default=None,
                        help='Max concurrent GPU jobs (overrides config)')
    args = parser.parse_args()

    log(f"GPU Worker starting with poll_interval={args.poll_interval}s")

    # Verify GPU
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version,memory.total',
             '--format=csv,noheader'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            log(f"GPU detected: {result.stdout.strip()}")
        else:
            log("WARNING: nvidia-smi failed")
    except Exception as e:
        log(f"ERROR: Could not detect GPU: {e}")
        sys.exit(1)

    config = get_gpu_config()
    max_concurrent = args.max_concurrent if args.max_concurrent else \
                     config.get('maxConcurrent', DEFAULT_MAX_CONCURRENT)
    job_timeout = config.get('jobTimeout', DEFAULT_JOB_TIMEOUT)
    log(f"Configuration: maxConcurrent={max_concurrent}, jobTimeout={job_timeout}s")

    while True:
        try:
            config = get_gpu_config()
            max_concurrent = config.get('maxConcurrent', DEFAULT_MAX_CONCURRENT)
            job_timeout = config.get('jobTimeout', DEFAULT_JOB_TIMEOUT)

            pending = get_pending_jobs()

            if pending:
                log(f"Found {len(pending)} pending jobs, executing with "
                    f"{max_concurrent} concurrent workers")
                with ThreadPoolExecutor(max_workers=max_concurrent) as executor:
                    futures = {executor.submit(process_job, job, job_timeout): job
                               for job in pending}
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
