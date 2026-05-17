Total output lines: 2528

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
import hashlib
import shlex
import shutil
import ast
import ctypes
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
JOB_RESULTS_FILE = '/tmp/gpu_results.json'
GPU_CONFIG_FILE = '/tmp/gpu_config.json'
GPU_INFO_FILE = '/tmp/gpu_info.json'
CUDA_PREFLIGHT_FILE = '/tmp/gpu_cuda_preflight.json'
POLL_INTERVAL = 3  # seconds
DEFAULT_MAX_CONCURRENT = 1
DEFAULT_JOB_TIMEOUT = 3600  # 1 hour default
DEFAULT_WORKBENCH_ROOT = '/tmp/ar3-workbenches'
DEFAULT_MODEL_CACHE_ROOT = '/opt/AR-3/model_cache'
DEFAULT_DISK_WARN_FREE_BYTES = 8 * 1024**3
DEFAULT_DISK_FAIL_FREE_BYTES = 2 * 1024**3
DEFAULT_WORKBENCH_PRUNE_MAX_BYTES = 10 * 1024**3
DEFAULT_WORKBENCH_PRUNE_MIN_AGE_SECONDS = 6 * 3600

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


def update_job_queue_status(job_id: str, status: str):
    """Persist a fine-grained worker lifecycle status for API/UI polling."""
    if not job_id:
        return
    with queue_lock:
        queue = read_queue()
        changed = False
        now = datetime.now().isoformat()
        for job in queue:
            if job.get('jobId') == job_id:
                job['status'] = status
                job['updatedAt'] = now
                if status == 'preparing_workbench':
                    job['claimedAt'] = job.get('claimedAt') or now
                if status == 'running_experiment':
                    job['startedAt'] = job.get('startedAt') or now
                changed = True
                break
        if changed:
            write_queue(queue)

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


def _safe_slug(value: str, fallback: str = 'space') -> str:
    """Return a stable filesystem-safe slug for a space/job value."""
    value = str(value or '').strip().lower()
    slug = re_module.sub(r'[^a-z0-9_.-]+', '-', value).strip('-._')
    return slug[:80] or fallback


def run_cuda_driver_preflight(timeout: int = 10) -> dict:
    """Check CUDA driver compute initialization, not just nvidia-smi/NVML.

    nvidia-smi uses NVML and can succeed on broken Vast/container allocations
    where libcuda cannot initialize compute contexts. Weak research models tend
    to misdiagnose that as a torch wheel problem, so this preflight records the
    lower-level CUDA driver result before any package installation starts.
    """
    diagnosis = {
        'ok': False,
        'status': 'unknown',
        'checkedAt': datetime.now().isoformat(),
        'nvidiaSmi': None,
        'cudaDriver': None,
        'deviceNodes': [],
        'environment': {
            'CUDA_VISIBLE_DEVICES': os.environ.get('CUDA_VISIBLE_DEVICES'),
            'NVIDIA_VISIBLE_DEVICES': os.environ.get('NVIDIA_VISIBLE_DEVICES'),
            'NVIDIA_DRIVER_CAPABILITIES': os.environ.get('NVIDIA_DRIVER_CAPABILITIES'),
            'LD_LIBRARY_PATH': os.environ.get('LD_LIBRARY_PATH'),
        },
        'guidance': [],
    }

    try:
        for pattern in ('/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia0'):
            if os.path.exists(pattern):
                stat = os.stat(pattern)
                diagnosis['deviceNodes'].append({
                    'path': pattern,
                    'mode': oct(stat.st_mode & 0o777),
                    'major': os.major(stat.st_rdev) if hasattr(os, 'major') else None,
                    'minor': os.minor(stat.st_rdev) if hasattr(os, 'minor') else None,
                })
    except Exception as exc:
        diagnosis['deviceNodeError'] = repr(exc)

    try:
        smi = subprocess.run(
            ['nvidia-smi', '--query-gpu=index,uuid,name,driver_version,memory.total,memory.used', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        diagnosis['nvidiaSmi'] = {
            'returncode': smi.returncode,
            'stdout': smi.stdout.strip()[:2000],
            'stderr': smi.stderr.strip()[:2000],
        }
    except Exception as exc:
        diagnosis['nvidiaSmi'] = {'error': repr(exc)}

    try:
        lib = ctypes.CDLL('libcuda.so.1')
        cu_driver_get_version = lib.cuDriverGetVersion
        cu_driver_get_version.argtypes = [ctypes.POINTER(ctypes.c_int)]
        cu_driver_get_version.restype = ctypes.c_int
        cu_init = lib.cuInit
        cu_init.argtypes = [ctypes.c_uint]
        cu_init.restype = ctypes.c_int
        cu_device_get_count = lib.cuDeviceGetCount
        cu_device_get_count.argtypes = [ctypes.POINTER(ctypes.c_int)]
        cu_device_get_count.restype = ctypes.c_int
        driver_version = ctypes.c_int(-1)
        count = ctypes.c_int(-1)
        driver_rc = cu_driver_get_version(ctypes.byref(driver_version))
        init_rc = cu_init(0)
        count_rc = cu_device_get_count(ctypes.byref(count))
        diagnosis['cudaDriver'] = {
            'driverVersionRc': driver_rc,
            'driverVersion': driver_version.value,
            'cuInit': init_rc,
            'cuDeviceGetCount': count_rc,
            'deviceCount': count.value,
        }
    except Exception as exc:
        diagnosis['cudaDriver'] = {'error': repr(exc)}

    smi_ok = bool(diagnosis.get('nvidiaSmi') and diagnosis['nvidiaSmi'].get('returncode') == 0)
    cuda_driver = diagnosis.get('cudaDriver') or {}
    cu_init = cuda_driver.get('cuInit')
    count_rc = cuda_driver.get('cuDeviceGetCount')
    device_count = cuda_driver.get('deviceCount')
    if cu_init == 0 and count_rc == 0 and (device_count or 0) > 0:
        diagnosis['ok'] = True
        diagnosis['status'] = 'cuda_compute_ready'
        diagnosis['guidance'].append('CUDA driver compute path is healthy; package/model failures can be debugged at the Python layer.')
    elif smi_ok and cu_init not in (None, 0):
        diagnosis['status'] = 'nvml_visible_cuda_init_failed'
        diagnosis['guidance'].extend([
            'nvidia-smi/NVML can see the GPU, but libcuda cannot initialize compute.',
            'Do not spend cycles reinstalling torch, torchvision, CUDA wheels, or transformers for this error.',
            'This is an infrastructure/container allocation failure. Reboot may not be enough; recycle or replace the Vast instance, then rerun this preflight before research jobs.',
        ])
    elif not smi_ok:
        diagnosis['status'] = 'gpu_not_visible_to_container'
        diagnosis['guidance'].extend([
            'nvidia-smi cannot see a GPU from the container.',
            'Check Vast allocation/container GPU exposure before running research code.',
        ])
    else:
        diagnosis['status'] = 'cuda_preflight_failed'
        diagnosis['guidance'].append('CUDA preflight failed; inspect cudaDriver and nvidiaSmi fields before installing ML packages.')

    try:
        with open(CUDA_PREFLIGHT_FILE, 'w') as f:
            json.dump(diagnosis, f, indent=2, sort_keys=True)
    except Exception as exc:
        diagnosis['writeError'] = repr(exc)
    return diagnosis


def cuda_preflight_failure_message(preflight: dict) -> str:
    status = preflight.get('status') or 'unknown'
    cuda_driver = preflight.get('cudaDriver') or {}
    nvidia_smi = preflight.get('nvidiaSmi') or {}
    return (
        f"GPU infrastructure unavailable before experiment execution: {status}. "
        f"cuInit={cuda_driver.get('cuInit')}, cuDeviceGetCount={cuda_driver.get('cuDeviceGetCount')}, "
        f"deviceCount={cuda_driver.get('deviceCount')}, nvidiaSmiReturnCode={nvidia_smi.get('returncode')}. "
        "If nvidia-smi succeeds but cuInit is non-zero, recycle/replace the Vast instance before retrying; do not reinstall torch."
    )


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, default)).strip())
    except Exception:
        return default


def _dir_size_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for child in path.rglob('*'):
        try:
            if child.is_file() or child.is_symlink():
                total += child.lstat().st_size
        except FileNotFoundError:
            continue
    return total


def _largest_child_dirs(path: Path, limit: int = 5) -> list:
    """Return bounded size metadata for largest direct child directories."""
    if not path.exists() or not path.is_dir():
        return []
    entries = []
    for child in path.iterdir():
        try:
            if not child.is_dir():
                continue
            entries.append({
                'path': str(child),
                'bytes': _dir_size_bytes(child),
                'modifiedAt': datetime.fromtimestamp(child.stat().st_mtime).isoformat(),
            })
        except FileNotFoundError:
            continue
        except Exception as exc:
            entries.append({
                'path': str(child),
                'bytes': None,
                'warning': f'size unavailable: {exc}',
            })
    return sorted(entries, key=lambda item: item.get('bytes') or 0, reverse=True)[:limit]


def prune_stale_workbenches(context: dict) -> dict:
    """Remove old sibling workbenches when the shared root exceeds limits.

    The active job workbench is never pruned. Thresholds are intentionally
    environment-controlled because small Vast disks need tighter retention than
    larger local development machines.
    """
    workbench_dir = Path(context['workbench_dir']).resolve()
    root = workbench_dir.parent
    max_bytes = _env_int('AR3_WORKBENCH_PRUNE_MAX_BYTES', DEFAULT_WORKBENCH_PRUNE_MAX_BYTES)
    min_age_seconds = _env_int('AR3_WORKBENCH_PRUNE_MIN_AGE_SECONDS', DEFAULT_WORKBENCH_PRUNE_MIN_AGE_SECONDS)
    warn_free = _env_int('AR3_DISK_WARN_FREE_BYTES', DEFAULT_DISK_WARN_FREE_BYTES)
    deleted = []
    errors = []

    if max_bytes <= 0 or not root.exists() or not root.is_dir():
        return {'enabled': max_bytes > 0, 'deleted': deleted, 'errors': errors, 'reason': 'disabled_or_missing_root'}

    try:
        usage = shutil.disk_usage(root)
        free_bytes = usage.free
    except Exception:
        free_bytes = None

    root_bytes = _dir_size_bytes(root)
    if root_bytes <= max_bytes and (free_bytes is None or free_bytes >= warn_free):
        return {
            'enabled': True,
            'deleted': deleted,
            'errors': errors,
            'rootBytesBefore': root_bytes,
            'maxBytes': max_bytes,
            'reason': 'within_limits',
        }

    now = time.time()
    candidates = []
    for child in root.iterdir():
        try:
            if not child.is_dir() or child.is_symlink() or child.resolve() == workbench_dir:
                continue
            stat = child.stat()
            age_seconds = max(0, int(now - stat.st_mtime))
            if age_seconds < min_age_seconds:
                continue
            candidates.append({
                'path': child,
                'bytes': _dir_size_bytes(child),
                'modifiedAt': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                'ageSeconds': age_seconds,
            })
        except FileNotFoundError:
            continue
        except Exception as exc:
            errors.append({'path': str(child), 'error': str(exc)})

    for candidate in sorted(candidates, key=lambda item: item['modifiedAt']):
        if root_bytes <= max_bytes and (free_bytes is None or free_bytes >= warn_free):
            break
        path = candidate['path']
        try:
            shutil.rmtree(path)
            root_bytes = max(0, root_bytes - int(candidate.get('bytes') or 0))
            if free_bytes is not None:
                try:
                    free_bytes = shutil.disk_usage(root).free
                except Exception:
                    free_bytes = None
            deleted.append({
                'path': str(path),
                'bytes': candidate.get('bytes'),
                'modifiedAt': candidate.get('modifiedAt'),
                'ageSeconds': candidate.get('ageSeconds'),
            })
        except Exception as exc:
            errors.append({'path': str(path), 'error': str(exc)})

    return {
        'enabled': True,
        'deleted': deleted,
        'errors': errors,
        'rootBytesBefore': _dir_size_bytes(root) + sum(int(item.get('bytes') or 0) for item in deleted),
        'rootBytesAfter': _dir_size_bytes(root),
        'freeBytesAfter': free_bytes,
        'maxBytes': max_bytes,
        'minAgeSeconds': min_age_seconds,
        'reason': 'pruned' if deleted else 'no_eligible_stale_workbenches',
    }


def collect_workbench_disk_pressure(context: dict) -> dict:
    """Return a bounded disk pressure snapshot for job metadata and logs."""
    workbench_dir = Path(context['workbench_dir'])
    root = workbench_dir.parent
    model_cache_root = Path(os.environ.get('AR3_MODEL_CACHE_ROOT', DEFAULT_MODEL_CACHE_ROOT))
    try:
        usage = shutil.disk_usage(root if root.exists() else workbench_dir)
        used = usage.total - usage.free
        used_percent = round((used / usage.total) * 100, 2) if usage.total else None
    except Exception as exc:
        return {
            'ok': True,
            'warning': f'disk pressure unavailable: {exc}',
            'workbenchDir': str(workbench_dir),
            'workbenchRoot': str(root),
        }

    workbench_bytes = _dir_size_bytes(workbench_dir)
    workbench_root_bytes = _dir_size_bytes(root)
    model_cache_bytes = _dir_size_bytes(model_cache_root)
    largest_workbench_dirs = _largest_child_dirs(root)
    warn_free = _env_int('AR3_DISK_WARN_FREE_BYTES', DEFAULT_DISK_WARN_FREE_BYTES)
    fail_free = _env_int('AR3_DISK_FAIL_FREE_BYTES', DEFAULT_DISK_FAIL_FREE_BYTES)
    warning = None
    if usage.free < warn_free:
        warning = f'low disk space: {usage.free} bytes free under workbench root {root}'
    return {
        'ok': usage.free >= fail_free,
        'warning': warning,
        'workbenchDir': str(workbench_dir),
        'workbenchRoot': str(root),
        'modelCacheRoot': str(model_cache_root),
        'freeBytes': usage.free,
        'totalBytes': usage.total,
        'usedPercent': used_percent,
        'workbenchBytes': workbench_bytes,
        'workbenchRootBytes': workbench_root_bytes,
        'largestWorkbenchDirs': largest_workbench_dirs,
        'modelCacheBytes': model_cache_bytes,
        'warnFreeBytes': warn_free,
        'failFreeBytes': fail_free,
    }


def prepare_workbench(job: dict) -> dict:
    """Create/reuse a persistent per-space workbench and execution env.

    Research jobs need to download models, datasets, wheels, and artifacts over
    multiple cycles. Running every job in /tmp with global pip installs loses
    that context and causes repeated downloads. This function gives each space a
    stable sandbox directory and redirects common ML caches into it.
    """
    root = Path(os.environ.get('AR3_WORKBENCH_ROOT', DEFAULT_WORKBENCH_ROOT))
    space_key_source = job.get('spaceId') or job.get('spaceName') or job.get('jobId') or 'space'
    space_slug = _safe_slug(space_key_source)
    digest = hashlib.sha1(str(space_key_source).encode('utf-8')).hexdigest()[:8]
    workbench = root / f'{space_slug}-{digest}'
    packages_dir = workbench / 'python-packages'
    cache_dir = workbench / 'cache'
    artifacts_dir = workbench / 'artifacts'
    for directory in (workbench, packages_dir, cache_dir, artifacts_dir):
        directory.mkdir(parents=True, exist_ok=True)

    existing_pythonpath = os.environ.get('PYTHONPATH', '')
    pythonpath = str(packages_dir) + ((os.pathsep + existing_pythonpath) if existing_pythonpath else '')
    library_paths = [
        '/usr/local/nvidia/lib',
        '/usr/local/nvidia/lib64',
        '/usr/local/cuda/compat',
        '/usr/local/cuda/lib64',
        '/usr/local/cuda/targets/x86_64-linux/lib',
    ]
    existing_ld_library_path = os.environ.get('LD_LIBRARY_PATH', '')
    if existing_ld_library_path:
        library_paths.append(existing_ld_library_path)

    env = {
        **os.environ,
        'AR3_WORKBENCH_DIR': str(workbench),
        'AR3_ARTIFACTS_DIR': str(artifacts_dir),
        'HF_HOME': str(cache_dir / 'huggingface'),
        'HUGGINGFACE_HUB_CACHE': str(cache_dir / 'huggingface' / 'hub'),
        'TRANSFORMERS_CACHE': str(cache_dir / 'huggingface' / 'transformers'),
        'TORCH_HOME': str(cache_dir / 'torch'),
        'PIP_NO_CACHE_DIR': '1',
        'PYTHONPATH': pythonpath,
        'LD_LIBRARY_PATH': os.pathsep.join(library_paths),
    }
    return {
        'workbench_dir': str(workbench),
        'packages_dir': str(packages_dir),
        'artifacts_dir': str(artifacts_dir),
        'env': env,
    }


def _dependency_to_pip_spec(dep) -> str:
    """Normalize a command/manifest dependency into a concrete pip spec."""
    if isinstance(dep, dict):
        name = str(
            dep.get('name') or dep.get('package') or dep.get('pip') or dep.get('pipPackage') or
            dep.get('pip_package') or dep.get('importName') or dep.get('import_name') or
            dep.get('module') or dep.get('import') or ''
        ).strip()
        version_spec = str(dep.get('versionSpec') or dep.get('version') or dep.get('constraint') or '').strip()
        if version_spec and not re_module.match(r'^(==|!=|~=|>=|<=|>|<)', version_spec):
            version_spec = '==' + version_spec
        dep = name + version_spec
    dep = str(dep).strip()
    return dep


PYTHON_IMPORT_PACKAGE_ALIASES = {
    'pil': 'Pillow',
    'cv2': 'opencv-python-headless',
    'sklearn': 'scikit-learn',
    'yaml': 'PyYAML',
    'bs4': 'beautifulsoup4',
    'skimage': 'scikit-image',
    'sentence_transformers': 'sentence-transformers',
    'dotenv': 'python-dotenv',
}


def _split_dependency_name_and_suffix(dep: str) -> tuple:
    match = re_modul…17532 tokens truncated…pkg}' detected, attempting pip install: " + ' '.join(shlex.quote(d) for d in repair['deps']),
                        thread_id=threading.current_thread().name)
                    install_res = subprocess.run(
                        repair['cmd'],
                        capture_output=True, text=True, timeout=120, env=context['env']
                    )
                    if install_res.returncode == 0:
                        log(f"Package '{pkg}' installed, retrying code execution",
                            thread_id=threading.current_thread().name)
                        # Write code file and retry
                        with open(code_file, 'w') as f:
                            f.write(fixed_code)
                        result = subprocess.run(
                            ['python3', code_file],
                            capture_output=True, text=True,
                            timeout=timeout,
                            cwd=context['workbench_dir'],
                            env=context['env'],
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
                                'error': f'Failed even after installing {pkg}:\n' + result.stderr.strip(),
                            }
                    else:
                        log(f"Failed to install '{pkg}': {install_res.stderr.strip()}",
                            thread_id=threading.current_thread().name)
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
        update_job_queue_status(job_id, 'preparing_workbench')
        context_info = prepare_workbench(job)
        workbench_prune = prune_stale_workbenches(context_info)
        if workbench_prune.get('deleted'):
            log('Pruned stale workbenches: ' + json.dumps(workbench_prune.get('deleted'), sort_keys=True), thread_id=tid)
        if workbench_prune.get('errors'):
            log('Workbench prune errors: ' + json.dumps(workbench_prune.get('errors'), sort_keys=True), thread_id=tid)
        disk_pressure = collect_workbench_disk_pressure(context_info)
        if disk_pressure.get('warning'):
            log(disk_pressure['warning'], thread_id=tid)
        cuda_preflight = run_cuda_driver_preflight()
        cuda_preflight_output = 'cuda_driver_preflight=' + json.dumps(cuda_preflight, sort_keys=True)
        if not cuda_preflight.get('ok'):
            log('CUDA driver preflight failed: ' + json.dumps({
                'status': cuda_preflight.get('status'),
                'cudaDriver': cuda_preflight.get('cudaDriver'),
                'nvidiaSmi': cuda_preflight.get('nvidiaSmi'),
            }, sort_keys=True), thread_id=tid)
        preparation_manifest = extract_preparation_manifest(job)
        result_metadata = {
            'workbenchDir': context_info['workbench_dir'],
            'artifactsDir': context_info['artifacts_dir'],
            'dependencies': gpu_command.get('dependencies', []),
            'preparationManifestApplied': bool(preparation_manifest),
            'diskPressure': disk_pressure,
            'workbenchPrune': workbench_prune,
            'cudaPreflight': cuda_preflight,
        }
        disk_pressure_output = 'disk_pressure=' + json.dumps(disk_pressure, sort_keys=True)
        workbench_prune_output = 'workbench_prune=' + json.dumps(workbench_prune, sort_keys=True)
        if not disk_pressure.get('ok', True):
            return {
                'success': False,
                'output': workbench_prune_output + '\n' + disk_pressure_output + '\n' + cuda_preflight_output,
                'error': 'Insufficient free disk space for GPU job preparation',
                **result_metadata,
            }
        if not cuda_preflight.get('ok'):
            return {
                'success': False,
                'output': workbench_prune_output + '\n' + disk_pressure_output + '\n' + cuda_preflight_output,
                'error': cuda_preflight_failure_message(cuda_preflight),
                **result_metadata,
            }
        preparation_output = ''
        if preparation_manifest:
            log('Applying preparation manifest before experiment execution', thread_id=tid)
            prep_result = prepare_manifest_environment(preparation_manifest, context_info, timeout=min(timeout, 1800), job_id=job_id)
            preparation_output = prep_result.get('output', '')
            if not prep_result.get('success'):
                return {
                    'success': False,
                    'output': preparation_output,
                    'error': prep_result.get('error') or 'Preparation manifest failed',
                    **result_metadata,
                }
            disk_pressure_after_preparation = collect_workbench_disk_pressure(context_info)
            result_metadata['diskPressureAfterPreparation'] = disk_pressure_after_preparation
            disk_pressure_after_preparation_output = 'disk_pressure_after_preparation=' + json.dumps(disk_pressure_after_preparation, sort_keys=True)
            preparation_output = (preparation_output + '\n' + disk_pressure_after_preparation_output).strip()
            if disk_pressure_after_preparation.get('warning'):
                log(disk_pressure_after_preparation['warning'], thread_id=tid)
            if not disk_pressure_after_preparation.get('ok', True):
                return {
                    'success': False,
                    'output': preparation_output,
                    'error': 'Insufficient free disk space after GPU job preparation',
                    **result_metadata,
                }

        if action == 'run_python':
            code = gpu_command.get('code', '')
            if not code or len(code) < 10:
                return {
                    'success': False,
                    'output': '',
                    'error': 'No valid Python code found in LLM response',
                }
            log(f"Running Python code, {len(code)} chars", thread_id=tid)
            result = execute_python_code(
                code,
                timeout=timeout,
                context=context_info,
                dependencies=[*(preparation_manifest or {}).get('dependencies', []), *gpu_command.get('dependencies', [])],
                job_id=job_id,
            )

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
        result['output'] = (workbench_prune_output + '\n' + disk_pressure_output + '\n' + cuda_preflight_output + '\n' + result.get('output', '')).strip()
        if preparation_output:
            result['output'] = (preparation_output + '\n' + result.get('output', '')).strip()
        update_job_queue_status(job_id, 'validating_evidence')
        result = validate_execution_result_evidence(result)
        result.update(result_metadata)
        cleanup_gpu_memory()
        return result

    except Exception as e:
        cleanup_gpu_memory()
        return {
            'success': False,
            'output': '',
            'error': f"GPU command failed: {str(e)}\n{traceback.format_exc()}",
        }


def classify_terminal_job_status(result: dict) -> str:
    """Map a finished worker result to the persisted lifecycle terminal state."""
    if result.get('success'):
        return 'completed'
    error = str(result.get('error') or '').lower()
    infrastructure_markers = (
        'gpu infrastructure unavailable', 'cuinit=', 'nvml_visible_cuda_init_failed',
        'recycle/replace the vast instance',
    )
    if any(marker in error for marker in infrastructure_markers):
        return 'failed_runtime'
    validation_markers = (
        'contract_failure_reason', 'self-reported', 'validation', 'rejected',
        'no valid python code', 'executable code rejected', 'placeholder',
        'missing runtime gpu evidence', 'json action must', 'did not parse',
    )
    if any(marker in error for marker in validation_markers):
        return 'failed_validation'
    return 'failed_runtime'


def process_job(job: dict, timeout: int) -> dict:
    """Process a single job (called from worker thread)."""
    job_id = job['jobId']

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
            'code': result.get('code', ''),
            'workbenchDir': result.get('workbenchDir'),
            'artifactsDir': result.get('artifactsDir'),
            'dependencies': result.get('dependencies', []),
            'preparationManifestApplied': result.get('preparationManifestApplied', False),
            'diskPressure': result.get('diskPressure'),
            'diskPressureAfterPreparation': result.get('diskPressureAfterPreparation'),
            'cudaPreflight': result.get('cudaPreflight'),
            'completedAt': datetime.now().isoformat(),
        }
        write_results(results)

        queue = read_queue()
        terminal_status = classify_terminal_job_status(result)
        for j in queue:
            if j['jobId'] == job_id:
                j['status'] = terminal_status
                j['completedAt'] = datetime.now().isoformat()
                break
        write_queue(queue)

    if result.get('success'):
        log(f"Job {job_id} succeeded: {str(result.get('output',''))[:100]}", thread_id=tid)
    else:
        log(f"Job {job_id} failed: {result.get('error', 'unknown')}", thread_id=tid)

    return result


STALE_INFLIGHT_RECLAIM_SECONDS = int(os.environ.get('GPU_STALE_INFLIGHT_RECLAIM_SECONDS', '120'))
INFLIGHT_JOB_STATUSES = {
    'claimed',
    'preparing_workbench',
    'installing_dependencies',
    'running_experiment',
    'validating_evidence',
}


def _iso_timestamp_age_seconds(value: str) -> float:
    try:
        timestamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        now = datetime.now(timestamp.tzinfo) if timestamp.tzinfo else datetime.now()
        return max(0.0, (now - timestamp).total_seconds())
    except Exception:
        return 0.0


def _reclaim_stale_inflight_jobs(queue: list, results: dict, stale_after_seconds: int) -> bool:
    changed = False
    for job in queue:
        job_id = job.get('jobId')
        if not job_id or job_id in results:
            continue
        if job.get('status') not in INFLIGHT_JOB_STATUSES:
            continue
        marker = job.get('updatedAt') or job.get('claimedAt') or job.get('startedAt')
        if _iso_timestamp_age_seconds(marker) < stale_after_seconds:
            continue
        stale_status = job.get('status')
        job['status'] = 'pending'
        job['reclaimedAt'] = datetime.now().isoformat()
        job['reclaimReason'] = f'stale in-flight worker status {stale_status}'
        changed = True
    return changed


def get_pending_jobs() -> list:
    """Get pending jobs and mark them as claimed (atomic)."""
    with queue_lock:
        queue = read_queue()
        results = read_results()
        reclaimed = _reclaim_stale_inflight_jobs(queue, results, STALE_INFLIGHT_RECLAIM_SECONDS)
        pending = [j for j in queue if j.get('status') in ('pending', 'queued')]

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

        if claimed or reclaimed:
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
        gpu_info = None
        if result.returncode == 0:
            gpu_line = result.stdout.strip()
            log(f"GPU detected: {gpu_line}")
            # Parse GPU info: "NVIDIA GeForce RTX 4090, 550.107.02, 24564 MiB"
            parts = [p.strip() for p in gpu_line.split(',')]
            gpu_name = parts[0] if len(parts) > 0 else 'Unknown'
            gpu_mem = parts[2] if len(parts) > 2 else 'Unknown'
            gpu_info = {'name': gpu_name, 'full': gpu_line, 'memory': gpu_mem}
            # Write GPU info to file for research-engine to read
            try:
                import json
                with open(GPU_INFO_FILE, 'w') as f:
                    json.dump(gpu_info, f)
            except Exception as info_err:
                log(f"Warning: could not write GPU info: {info_err}")
        else:
            log("WARNING: nvidia-smi failed")
    except Exception as e:
        log(f"ERROR: Could not detect GPU: {e}")
        sys.exit(1)

    cuda_preflight = run_cuda_driver_preflight()
    if cuda_preflight.get('ok'):
        log('CUDA driver preflight passed: ' + json.dumps(cuda_preflight.get('cudaDriver'), sort_keys=True))
    else:
        log('CUDA driver preflight failed before polling jobs: ' + json.dumps({
            'status': cuda_preflight.get('status'),
            'cudaDriver': cuda_preflight.get('cudaDriver'),
            'nvidiaSmi': cuda_preflight.get('nvidiaSmi'),
            'guidance': cuda_preflight.get('guidance'),
        }, sort_keys=True))

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
