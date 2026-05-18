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
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
JOB_RESULTS_FILE = '/tmp/gpu_results.json'
GPU_CONFIG_FILE = '/tmp/gpu_config.json'
GPU_INFO_FILE = '/tmp/gpu_info.json'
CUDA_PREFLIGHT_FILE = '/tmp/gpu_cuda_preflight.json'
DEFAULT_PRISMA_DB_FILE = 'prisma/dev.db'
POLL_INTERVAL = 3  # seconds
DEFAULT_MAX_CONCURRENT = 1
DEFAULT_JOB_TIMEOUT = 3600  # 1 hour default
DEFAULT_WORKBENCH_ROOT = '/tmp/ar3-workbenches'
DEFAULT_MODEL_CACHE_ROOT = '/opt/AR-3/model_cache'
DEFAULT_DISK_WARN_FREE_BYTES = 8 * 1024**3
DEFAULT_DISK_FAIL_FREE_BYTES = 2 * 1024**3
DEFAULT_WORKBENCH_PRUNE_MAX_BYTES = 10 * 1024**3
DEFAULT_WORKBENCH_PRUNE_MIN_AGE_SECONDS = 6 * 3600
ALLOWED_GENERATED_TMP_PREFIXES = (
    '/tmp/ar3-workbenches',
)

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


def _resolve_prisma_db_file() -> str:
    explicit = os.environ.get('AR3_PRISMA_DB_PATH')
    if explicit:
        return explicit
    database_url = os.environ.get('DATABASE_URL') or ''
    if database_url.startswith('file:'):
        db_path = database_url[len('file:'):]
        if db_path.startswith('//'):
            db_path = db_path[2:]
        return db_path
    return DEFAULT_PRISMA_DB_FILE


def _prisma_db_path() -> Path:
    path = Path(_resolve_prisma_db_file())
    if not path.is_absolute():
        # Prisma resolves relative file: SQLite URLs from the prisma schema
        # directory, while this worker runs from the repository root.
        schema_relative = Path.cwd() / 'prisma' / path
        cwd_relative = Path.cwd() / path
        if cwd_relative.exists() and _sqlite_has_table(cwd_relative, 'GpuJob'):
            path = cwd_relative
        elif schema_relative.exists() and _sqlite_has_table(schema_relative, 'GpuJob'):
            path = schema_relative
        else:
            path = cwd_relative if cwd_relative.exists() else schema_relative
    return path


def _sqlite_has_table(db_path: Path, table_name: str) -> bool:
    try:
        con = sqlite3.connect(str(db_path), timeout=1)
        try:
            row = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
                (table_name,),
            ).fetchone()
            return bool(row)
        finally:
            con.close()
    except Exception:
        return False


def update_prisma_gpu_job_status(job_id: str, status: str, result: dict = None, message: str = None):
    """Best-effort mirror from the file-polled worker into Prisma's GpuJob row.

    The Next.js API also lazily syncs /tmp/gpu_results.json into Prisma when
    polled, but the research loop can stall if no poll observes a finished file
    result. Writing terminal state here keeps DB-backed status authoritative.
    """
    if not job_id:
        return
    db_path = _prisma_db_path()
    if not db_path.exists():
        return
    now_iso = datetime.now().isoformat()
    now_ms = int(time.time() * 1000)
    try:
        con = sqlite3.connect(str(db_path), timeout=5)
        con.row_factory = sqlite3.Row
        try:
            row = con.execute(
                'SELECT status, eventsJson FROM GpuJob WHERE jobId = ?',
                (job_id,),
            ).fetchone()
            if not row:
                return
            events = []
            try:
                events = json.loads(row['eventsJson'] or '[]')
                if not isinstance(events, list):
                    events = []
            except Exception:
                events = []
            event = {
                'at': now_iso,
                'toStatus': status,
                'message': message or f'GPU worker set job status to {status}',
            }
            if row['status'] and row['status'] != status:
                event['fromStatus'] = row['status']
            events.append(event)
            result_json = json.dumps(result) if result is not None else None
            if result_json is None:
                con.execute(
                    'UPDATE GpuJob SET status = ?, eventsJson = ?, updatedAt = ? WHERE jobId = ?',
                    (status, json.dumps(events), now_ms, job_id),
                )
            else:
                con.execute(
                    'UPDATE GpuJob SET status = ?, resultJson = ?, eventsJson = ?, updatedAt = ? WHERE jobId = ?',
                    (status, result_json, json.dumps(events), now_ms, job_id),
                )
            con.commit()
        finally:
            con.close()
    except Exception as e:
        log(f"Warning: could not mirror GPU job {job_id} to Prisma DB: {e}")


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
    if changed:
        update_prisma_gpu_job_status(job_id, status)

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
    scratch_dir = workbench / 'tmp'
    model_scratch_dir = workbench / 'model-scratch'
    for directory in (workbench, packages_dir, cache_dir, artifacts_dir, scratch_dir, model_scratch_dir):
        directory.mkdir(parents=True, exist_ok=True)
    parsed_context = {}
    raw_context = job.get('context') or ''
    if isinstance(raw_context, dict):
        parsed_context = raw_context
    elif isinstance(raw_context, str) and raw_context.strip():
        try:
            parsed_context = json.loads(raw_context)
        except Exception:
            parsed_context = {}
    memory_offload = parsed_context.get('memoryOffload') if isinstance(parsed_context, dict) else None
    memory_offload_enabled = bool(isinstance(memory_offload, dict) and memory_offload.get('enabled'))
    ram_offload_dir = workbench / 'ram-offload'
    if memory_offload_enabled:
        ram_offload_dir.mkdir(parents=True, exist_ok=True)

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
        'AR3_SCRATCH_DIR': str(scratch_dir),
        'AR3_MODEL_SCRATCH_DIR': str(model_scratch_dir),
        'HF_HOME': str(cache_dir / 'huggingface'),
        'HUGGINGFACE_HUB_CACHE': str(cache_dir / 'huggingface' / 'hub'),
        'TRANSFORMERS_CACHE': str(cache_dir / 'huggingface' / 'transformers'),
        'TORCH_HOME': str(cache_dir / 'torch'),
        'TMPDIR': str(scratch_dir),
        'TMP': str(scratch_dir),
        'TEMP': str(scratch_dir),
        'PIP_NO_CACHE_DIR': '1',
        'PYTHONPATH': pythonpath,
        'LD_LIBRARY_PATH': os.pathsep.join(library_paths),
    }
    if memory_offload_enabled:
        env.update({
            'AR3_ENABLE_RAM_OFFLOAD': '1',
            'AR3_RAM_OFFLOAD_DIR': str(ram_offload_dir),
            'AR3_TRANSFORMERS_MAX_MEMORY_JSON': json.dumps({'0': '6GiB', 'cpu': '48GiB'}),
            'PYTORCH_CUDA_ALLOC_CONF': env.get('PYTORCH_CUDA_ALLOC_CONF') or 'expandable_segments:True',
        })
    return {
        'workbench_dir': str(workbench),
        'packages_dir': str(packages_dir),
        'artifacts_dir': str(artifacts_dir),
        'scratch_dir': str(scratch_dir),
        'model_scratch_dir': str(model_scratch_dir),
        'memory_offload_enabled': memory_offload_enabled,
        'ram_offload_dir': str(ram_offload_dir),
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
    match = re_module.match(r'^([A-Za-z0-9_.-]+)(.*)$', dep)
    if not match:
        return dep, ''
    return match.group(1), match.group(2)


def _dependency_import_alias_to_package(dep: str) -> str:
    name, suffix = _split_dependency_name_and_suffix(dep)
    normalized_name = name.lower().replace('-', '_')
    import_path_like = bool(re_module.match(r'^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$', name))
    top_level_name = name.split('.', 1)[0] if import_path_like else name
    alias = (
        PYTHON_IMPORT_PACKAGE_ALIASES.get(normalized_name) or
        PYTHON_IMPORT_PACKAGE_ALIASES.get(top_level_name.lower().replace('-', '_'))
    )
    if not alias:
        if import_path_like:
            return top_level_name + suffix
        return dep
    if alias == 'scikit-learn':
        return alias
    return alias + suffix


def normalize_declared_dependencies(dependencies) -> dict:
    """Return safe pip args for declared dependencies.

    Weak implementer models often declare a bare "torch" dependency. On CUDA
    12.2/12.8 VAST images, current PyPI may resolve to newer CUDA 13 wheels
    that import but report torch.cuda.is_available() == False with the host
    driver. Pin bare torch-family requests to a known CUDA 12.4 wheel set and
    add PyTorch's cu124 index so autonomous jobs preserve real GPU access.
    """
    deps = []
    seen = set()
    needs_pytorch_cu124 = False
    torch_pins = {
        'torch': 'torch==2.5.1',
        'torchvision': 'torchvision==0.20.1',
        'torchaudio': 'torchaudio==2.5.1',
    }
    package_pins = {
        # LLaDA's remote modeling code is not compatible with transformers 5.x
        # tie_weights kwargs. Weak agents usually ask for bare/lower-bound
        # transformers, so keep those jobs on the last known-good 4.x line.
        # Pin tokenizers with it because existing workbenches may already have
        # tokenizers 0.22+, which Transformers 4.45 refuses to import.
        'transformers': 'transformers==4.45.2',
        'tokenizers': 'tokenizers==0.20.3',
    }
    stdlib_names = set(getattr(sys, 'stdlib_module_names', set())) | set(sys.builtin_module_names)

    for dep in dependencies or []:
        dep = _dependency_to_pip_spec(dep)
        if not dep or dep.lower() in {'python', 'pip'}:
            continue
        # Dependencies are pip specs, not shell commands/options. Allow PEP 440
        # comparison operators (for example torch>=2.0.0) because models often
        # emit versioned package requirements; subprocess receives argv directly,
        # so these are not shell redirections.
        if re_module.search(r'[;&|`$\n\r]', dep) or dep.startswith('-'):
            return {'success': False, 'error': f'Unsafe dependency spec rejected: {dep!r}', 'deps': [], 'pip_args': []}

        raw_name, _suffix = _split_dependency_name_and_suffix(dep)
        import_name = raw_name.strip().lower().replace('-', '_')
        if import_name in stdlib_names:
            continue
        dep = _dependency_import_alias_to_package(dep)
        dep_name = re_module.split(r'[<>=!~\[]', dep, maxsplit=1)[0].strip().lower().replace('_', '-')
        normalized = torch_pins.get(dep_name) or package_pins.get(dep_name) or dep
        if dep_name in torch_pins:
            needs_pytorch_cu124 = True
        if normalized not in seen:
            deps.append(normalized)
            seen.add(normalized)
        if dep_name == 'transformers' and package_pins['tokenizers'] not in seen:
            deps.append(package_pins['tokenizers'])
            seen.add(package_pins['tokenizers'])

    pip_args = []
    if needs_pytorch_cu124:
        pip_args.extend(['--index-url', 'https://download.pytorch.org/whl/cu124', '--extra-index-url', 'https://pypi.org/simple'])
    return {'success': True, 'deps': deps, 'pip_args': pip_args, 'error': None}


MISSING_MODULE_PACKAGE_ALIASES = PYTHON_IMPORT_PACKAGE_ALIASES

PIP_PACKAGE_IMPORT_ALIASES = {
    'pillow': 'PIL',
    'opencv-python-headless': 'cv2',
    'opencv-python': 'cv2',
    'scikit-learn': 'sklearn',
    'pyyaml': 'yaml',
    'beautifulsoup4': 'bs4',
    'scikit-image': 'skimage',
    'sentence-transformers': 'sentence_transformers',
    'python-dotenv': 'dotenv',
}


def _dependency_import_name(dep) -> str:
    if isinstance(dep, dict):
        explicit = str(
            dep.get('importName') or dep.get('import_name') or dep.get('module') or dep.get('import') or ''
        ).strip()
        if explicit:
            return explicit.split('.', 1)[0]
    dep_spec = _dependency_to_pip_spec(dep)
    package_name, _suffix = _split_dependency_name_and_suffix(dep_spec)
    normalized = package_name.strip().lower().replace('_', '-')
    return PIP_PACKAGE_IMPORT_ALIASES.get(normalized, package_name.replace('-', '_')).split('.', 1)[0]


def _declared_dependency_imports_available(dependencies, context: dict, timeout: int = 45) -> dict:
    imports = []
    seen = set()
    stdlib_names = set(getattr(sys, 'stdlib_module_names', set())) | set(sys.builtin_module_names)
    for dep in dependencies or []:
        import_name = _dependency_import_name(dep).strip()
        if not import_name:
            continue
        if import_name.lower() in stdlib_names:
            continue
        if not re_module.match(r'^[A-Za-z_][A-Za-z0-9_]*$', import_name):
            continue
        if import_name not in seen:
            imports.append(import_name)
            seen.add(import_name)
    if not imports:
        return {'success': True, 'imports': [], 'missing': [], 'output': 'no import checks required'}

    checker = '''
import importlib.util
import json
import sys
imports = json.loads(sys.argv[1])
missing = [name for name in imports if importlib.util.find_spec(name) is None]
print(json.dumps({"imports": imports, "missing": missing}, sort_keys=True))
raise SystemExit(1 if missing else 0)
'''.strip()
    result = subprocess.run(
        [sys.executable, '-c', checker, json.dumps(imports)],
        capture_output=True, text=True, timeout=timeout, cwd=context['workbench_dir'], env=context['env']
    )
    try:
        payload = json.loads((result.stdout or '').strip().splitlines()[-1])
    except Exception:
        payload = {'imports': imports, 'missing': imports, 'raw': _combined_completed_output(result)}
    return {
        'success': result.returncode == 0,
        'imports': payload.get('imports') or imports,
        'missing': payload.get('missing') or [],
        'output': _combined_completed_output(result),
    }


def _cached_dependency_install_is_valid(record_path: Path, dependencies, normalized: dict, context: dict) -> dict:
    if not record_path.exists():
        return {'success': False, 'reason': 'missing dependency install record'}
    try:
        with open(record_path, 'r') as f:
            record = json.load(f)
    except Exception as exc:
        return {'success': False, 'reason': f'invalid dependency install record: {exc}'}
    if not isinstance(record, dict):
        return {'success': False, 'reason': 'previous dependency install record is not an object'}
    if record.get('normalized') != normalized.get('deps') or record.get('pipArgs') != normalized.get('pip_args'):
        return {'success': False, 'reason': 'dependency set changed'}
    availability = _declared_dependency_imports_available(dependencies, context)
    if not availability.get('success'):
        missing = ', '.join(availability.get('missing') or [])
        return {'success': False, 'reason': f'cached dependencies missing imports: {missing or "unknown"}'}
    return {'success': True, 'reason': 'cached dependencies verified by import checks', 'imports': availability.get('imports') or []}


def _declared_dependency_specs_satisfied(dependencies, context: dict, timeout: int = 45) -> dict:
    """Verify imports and simple installed distribution versions for declared deps.

    Importability alone is not enough after dependency specs change: a module can
    import while an explicit ==/>=/<= requirement is not installed. This helper
    keeps the fast path safe by requiring import availability for every declared
    dependency and, when a version operator is present, matching installed
    distribution metadata from the workbench Python path.
    """
    availability = _declared_dependency_imports_available(dependencies, context, timeout=timeout)
    if not availability.get('success'):
        return availability

    requirements = []
    for dep in dependencies or []:
        dep_spec = _dependency_import_alias_to_package(_dependency_to_pip_spec(dep))
        if not dep_spec:
            continue
        match = re_module.match(r'^([A-Za-z0-9_.-]+)(==|!=|~=|>=|<=|>|<)([^,;\[\s]+)', dep_spec)
        if match:
            requirements.append({
                'name': match.group(1),
                'op': match.group(2),
                'version': match.group(3),
            })
    if not requirements:
        return availability

    code = r'''
import importlib.metadata as md
import json
import re
import sys
from pathlib import Path
packages_dir = __PACKAGES_DIR__
if packages_dir:
    sys.path.insert(0, packages_dir)
requirements = __REQUIREMENTS__

def parts(v):
    nums = []
    for part in re.split(r'[^0-9]+', str(v)):
        if part != '':
            nums.append(int(part))
    return tuple(nums or [0])

def cmp_versions(installed, wanted):
    a = parts(installed)
    b = parts(wanted)
    max_len = max(len(a), len(b))
    a = a + (0,) * (max_len - len(a))
    b = b + (0,) * (max_len - len(b))
    return (a > b) - (a < b)

def ok(installed, op, wanted):
    c = cmp_versions(installed, wanted)
    if op == '==': return c == 0
    if op == '!=': return c != 0
    if op == '>=': return c >= 0
    if op == '<=': return c <= 0
    if op == '>': return c > 0
    if op == '<': return c < 0
    if op == '~=': return c >= 0
    return False

failures = []
versions = {}
for req in requirements:
    name = req['name']
    try:
        installed = md.version(name)
    except Exception as exc:
        failures.append({'name': name, 'reason': 'metadata_missing', 'error': repr(exc)})
        continue
    versions[name] = installed
    if not ok(installed, req['op'], req['version']):
        failures.append({'name': name, 'reason': 'version_mismatch', 'installed': installed, 'required': req['op'] + req['version']})
print(json.dumps({'ok': not failures, 'failures': failures, 'versions': versions}, sort_keys=True))
raise SystemExit(0 if not failures else 2)
'''.replace('__PACKAGES_DIR__', repr(str(context.get('packages_dir') or ''))).replace('__REQUIREMENTS__', repr(requirements))
    try:
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=timeout, env=context.get('env'))
    except subprocess.TimeoutExpired:
        return {'success': False, 'reason': 'dependency version check timed out', 'imports': availability.get('imports') or []}
    if result.returncode != 0:
        return {
            'success': False,
            'reason': 'dependency version requirements not satisfied: ' + (result.stdout.strip() or result.stderr.strip()),
            'imports': availability.get('imports') or [],
        }
    return availability


def missing_module_install_command(module_name: str, context: dict) -> dict:
    """Build a safe workbench-local pip install command for ModuleNotFoundError repair."""
    module_name = str(module_name or '').strip()
    if not re_module.match(r'^[A-Za-z_][A-Za-z0-9_]*$', module_name):
        return {'success': False, 'error': f'Unsafe missing module name rejected: {module_name!r}'}
    package = MISSING_MODULE_PACKAGE_ALIASES.get(module_name.lower(), module_name)
    normalized = normalize_declared_dependencies([package])
    if not normalized.get('success'):
        return {'success': False, 'error': normalized.get('error')}
    deps = normalized['deps']
    if not deps:
        return {'success': False, 'error': f'Missing module {module_name!r} is not a pip-installable dependency'}
    cmd = [
        sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
        '--no-cache-dir', '--upgrade', *normalized['pip_args'], '--target', context['packages_dir'], *deps,
    ]
    return {'success': True, 'cmd': cmd, 'deps': deps, 'pip_args': normalized['pip_args'], 'error': None}


TORCH_CUDA_SMOKE_CODE = r'''
import json
try:
    import torch
    payload = {
        "torch_version": getattr(torch, "__version__", None),
        "torch_cuda_version": getattr(torch.version, "cuda", None),
        "torch_cuda_available": bool(torch.cuda.is_available()),
        "cuda_device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }
    if torch.cuda.is_available():
        x = torch.ones((1,), device="cuda")
        payload["cuda_tensor_sum"] = float(x.sum().item())
    print(json.dumps(payload, sort_keys=True))
    raise SystemExit(0 if payload["torch_cuda_available"] else 2)
except Exception as exc:
    print(json.dumps({"torch_cuda_available": False, "torch_error": repr(exc)}, sort_keys=True))
    raise
'''.strip()


PYTORCH_CUDA_INSTALL_ARGS = [
    '--index-url', 'https://download.pytorch.org/whl/cu124',
    '--extra-index-url', 'https://pypi.org/simple',
    'torch==2.5.1', 'torchvision==0.20.1', 'torchaudio==2.5.1',
]


TORCH_PACKAGE_PREFIXES = (
    'torch', 'torchvision', 'torchaudio', 'torchgen', 'triton', 'nvidia',
    'functorch', 'pytorch_triton', 'pytorch_triton_rocm',
)


def _combined_completed_output(result) -> str:
    return ((getattr(result, 'stdout', '') or '') + '\n' + (getattr(result, 'stderr', '') or '')).strip()


CUDA_TOOLKIT_LD_LIBRARY_PATHS = {
    '/usr/local/cuda/compat',
    '/usr/local/cuda/lib64',
    '/usr/local/cuda/targets/x86_64-linux/lib',
}


def _without_cuda_toolkit_ld_path(env: dict) -> dict:
    """Return env with CUDA toolkit libs removed so PyTorch wheel nvidia libs win.

    Vast images can expose toolkit/compat libraries older or newer than the
    per-workbench PyTorch wheel stack. In particular, /usr/local/cuda/compat
    may provide a libnvJitLink that shadows the wheel's nvidia-nvjitlink-cu12
    library and causes libcusparse import failures. Keep driver libraries, but
    remove toolkit paths from runtime execution environments.
    """
    cleaned = dict(env)
    parts = [
        part for part in cleaned.get('LD_LIBRARY_PATH', '').split(os.pathsep)
        if part and part not in CUDA_TOOLKIT_LD_LIBRARY_PATHS
    ]
    cleaned['LD_LIBRARY_PATH'] = os.pathsep.join(parts)
    return cleaned


def _torch_cuda_runtime_env(context: dict) -> dict:
    """Build an execution env where workbench PyTorch CUDA wheel libs win.

    PEP 599 CUDA wheels install shared libraries under
    python-packages/nvidia/<component>/lib. Prepending those directories makes
    torch import and CUDA initialization deterministic even when the container
    has incompatible /usr/local/cuda compatibility libraries.
    """
    cleaned = _without_cuda_toolkit_ld_path(context['env'])
    packages_dir = Path(context.get('packages_dir') or '')
    wheel_libs = []
    for component in (
        'nvjitlink', 'cusparse', 'cublas', 'cuda_runtime', 'cuda_nvrtc',
        'cudnn', 'cufft', 'curand', 'cusolver', 'nccl', 'nvtx',
    ):
        lib_dir = packages_dir / 'nvidia' / component / 'lib'
        if lib_dir.is_dir():
            wheel_libs.append(str(lib_dir))
    existing = [p for p in cleaned.get('LD_LIBRARY_PATH', '').split(os.pathsep) if p]
    merged = []
    for part in wheel_libs + existing:
        if part not in merged:
            merged.append(part)
    cleaned['LD_LIBRARY_PATH'] = os.pathsep.join(merged)
    return cleaned


def _torch_cuda_broken_output(output: str) -> bool:
    text = str(output or '').lower()
    broken_markers = [
        '__nvjitlinkcomplete', 'libnvjitlink', 'libcusparse', 'undefined symbol',
        'torch_cuda_available": false', "torch_cuda_available': false", 'cuda error',
    ]
    return any(marker in text for marker in broken_markers)


def _purge_torch_package_dirs(packages_dir: str) -> list:
    """Remove per-workbench torch/nvidia wheel directories likely to shadow global CUDA libs."""
    root = Path(packages_dir)
    removed = []
    if not root.exists():
        return removed
    for child in list(root.iterdir()):
        name = child.name.lower()
        normalized = name.replace('_', '-').split('-')[0]
        if name.startswith(TORCH_PACKAGE_PREFIXES) or normalized in TORCH_PACKAGE_PREFIXES:
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
            removed.append(child.name)
    return sorted(removed)


def ensure_torch_cuda_workbench(context: dict, force: bool = False, timeout: int = 600) -> dict:
    """Smoke-test torch CUDA in a workbench; repair poisoned torch/nvidia wheels if needed.

    VAST CUDA images can import a globally working torch while a per-space --target install
    shadows it with an incompatible CUDA wheel set. The observed failure is often
    `undefined symbol: __nvJitLinkComplete_12_4` or torch.cuda.is_available()
    returning false on a visible GPU. Detect that before experiment execution,
    clear only the workbench-local torch/CUDA wheel dirs, install a CUDA 12.4
    wheel set, then run the smoke test again and surface evidence in job output.
    """
    outputs = []
    torch_env = _torch_cuda_runtime_env(context)
    smoke = subprocess.run(
        [sys.executable, '-c', TORCH_CUDA_SMOKE_CODE],
        capture_output=True, text=True, timeout=min(timeout, 120), cwd=context['workbench_dir'], env=torch_env
    )
    first_output = _combined_completed_output(smoke)
    outputs.append(f'torch_cuda_smoke initial exit={smoke.returncode}\n{first_output}')
    if smoke.returncode == 0 and not force:
        return {'success': True, 'repaired': False, 'output': '\n'.join(outputs), 'error': None}

    if smoke.returncode != 0 and not (_torch_cuda_broken_output(first_output) or force):
        return {'success': False, 'repaired': False, 'output': '\n'.join(outputs), 'error': 'Torch CUDA smoke test failed before repair: ' + first_output[-1000:]}

    removed = _purge_torch_package_dirs(context['packages_dir'])
    outputs.append('torch_cuda_repair removed=' + json.dumps(removed))
    install_cmd = [
        sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--upgrade',
        '--target', context['packages_dir'], *PYTORCH_CUDA_INSTALL_ARGS,
    ]
    install = subprocess.run(install_cmd, capture_output=True, text=True, timeout=timeout, env=context['env'])
    install_output = _combined_completed_output(install)
    outputs.append(f'torch_cuda_repair install exit={install.returncode}\n{install_output[-2000:]}')
    if install.returncode != 0:
        return {'success': False, 'repaired': True, 'output': '\n'.join(outputs), 'error': 'Torch CUDA repair install failed: ' + install_output[-1000:]}

    smoke2 = subprocess.run(
        [sys.executable, '-c', TORCH_CUDA_SMOKE_CODE],
        capture_output=True, text=True, timeout=min(timeout, 120), cwd=context['workbench_dir'], env=torch_env
    )
    second_output = _combined_completed_output(smoke2)
    outputs.append(f'torch_cuda_smoke after_repair exit={smoke2.returncode}\n{second_output}')
    if smoke2.returncode != 0:
        return {'success': False, 'repaired': True, 'output': '\n'.join(outputs), 'error': 'Torch CUDA smoke test failed after repair: ' + second_output[-1000:]}
    return {'success': True, 'repaired': True, 'output': '\n'.join(outputs), 'error': None}


def _code_or_deps_need_torch(code: str, dependencies=None) -> bool:
    if re_module.search(r'(^|\n)\s*(import\s+torch|from\s+torch\b)|\btorch\.', str(code or '')):
        return True
    for dep in dependencies or []:
        name = _dependency_to_pip_spec(dep)
        dep_name = re_module.split(r'[<>=!~\[]', name, maxsplit=1)[0].strip().lower().replace('_', '-')
        if dep_name in {'torch', 'torchvision', 'torchaudio'}:
            return True
    return False


def install_declared_dependencies(dependencies, context: dict, timeout: int = 900, job_id: str = '') -> dict:
    """Install JSON-declared Python deps into the space workbench, not globally."""
    normalized = normalize_declared_dependencies(dependencies)
    if not normalized.get('success'):
        return {'success': False, 'error': normalized.get('error')}
    deps = normalized['deps']
    record_path = None
    if context.get('workbench_dir'):
        record_path = Path(context['workbench_dir']) / 'installed_dependencies.json'

        def write_dependency_record(success: bool, error: str = None):
            payload = {
                'timestamp': datetime.now().isoformat(),
                'success': bool(success),
                'declared': dependencies or [],
                'normalized': deps,
                'pipArgs': normalized['pip_args'],
                'error': error,
            }
            tmp_path = record_path.with_suffix('.json.tmp')
            with open(tmp_path, 'w') as f:
                json.dump(payload, f, indent=2, sort_keys=True)
            os.replace(tmp_path, record_path)
    else:
        def write_dependency_record(success: bool, error: str = None):
            return None

    if not deps:
        write_dependency_record(True)
        return {'success': True, 'output': 'no declared dependencies', 'error': None}

    if record_path is not None:
        cached = _cached_dependency_install_is_valid(record_path, dependencies or [], normalized, context)
        if cached.get('success'):
            imports = ','.join(cached.get('imports') or [])
            return {
                'success': True,
                'output': f'cached_dependencies={record_path}\nverified_imports={imports}',
                'error': None,
            }
        # If the exact dependency set changed but every declared import already
        # resolves from the workbench/global environment, avoid another expensive
        # --target --upgrade pip pass. Reinstalling torch-family wheels into the
        # same target on every autonomous step can monopolize the worker for
        # minutes while producing no new capability.
        availability = _declared_dependency_specs_satisfied(dependencies or [], context)
        if availability.get('success'):
            write_dependency_record(True)
            imports = ','.join(availability.get('imports') or [])
            return {
                'success': True,
                'output': f'cached_dependencies={record_path}\nverified_imports={imports}\ncache_reconciled=imports_already_available',
                'error': None,
            }

    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--upgrade', *normalized['pip_args'], '--target', context['packages_dir'], *deps]
    update_job_queue_status(job_id, 'installing_dependencies')
    log('Installing declared dependencies into workbench: ' + ' '.join(shlex.quote(d) for d in deps),
        thread_id=threading.current_thread().name)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=context['env'])
    if result.returncode != 0:
        error = result.stderr.strip() or f'pip exited {result.returncode}'
        write_dependency_record(False, error)
        return {
            'success': False,
            'output': result.stdout.strip(),
            'error': error,
        }
    write_dependency_record(True)
    output = result.stdout.strip()
    if record_path is not None:
        output = (output + '\n' if output else '') + f'installed_dependencies={record_path}'
    return {'success': True, 'output': output, 'error': None}


def strip_markdown_headers(code: str) -> str:
    """Remove markdown/table/header lines accidentally captured around code."""
    kept = []
    for line in code.split('\n'):
        stripped = line.strip()
        if not stripped:
            kept.append(line)
            continue
        if re_module.match(r'^(#{1,6}\s|[-*]\s+|\|.*\|$|```)', stripped):
            continue
        kept.append(line)
    return '\n'.join(kept).strip()


def _extract_first_json_object(text: str):
    """Return the first valid JSON object embedded in text, using quote-aware braces."""
    in_str = False
    escape_next = False
    brace_depth = 0
    json_start = -1
    for i, ch in enumerate(str(text or '')):
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
                try:
                    parsed = json.loads(text[json_start:i + 1])
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    pass
                json_start = -1
    return None


def extract_preparation_manifest(job: dict):
    """Extract a validated preparation manifest from job context or prompt markers.

    The Next.js side persists a PreparationManifest in Space.setupStep and passes it
    through job context. Older jobs may only contain the appended
    [PREPARATION_MANIFEST_VALIDATED] marker in the prompt, so support both.
    """
    context = job.get('context') or ''
    if isinstance(context, dict):
        candidate = context.get('preparationManifest') or context.get('manifest')
        if isinstance(candidate, dict):
            return candidate
    if isinstance(context, str) and context.strip():
        try:
            parsed = json.loads(context)
            if isinstance(parsed, dict):
                candidate = parsed.get('preparationManifest') or parsed.get('manifest')
                if isinstance(candidate, dict):
                    return candidate
        except Exception:
            marker_obj = _extract_first_json_object(context)
            if isinstance(marker_obj, dict) and marker_obj.get('schemaVersion') == 'ar3.preparation-manifest.v1':
                return marker_obj

    prompt = job.get('prompt') or ''
    marker = '[PREPARATION_MANIFEST_VALIDATED]:'
    if marker in prompt:
        after_marker = prompt.split(marker, 1)[1]
        candidate = _extract_first_json_object(after_marker)
        if isinstance(candidate, dict):
            return candidate
    return None


SMOKE_DESTRUCTIVE_COMMAND_MARKERS = re_module.compile(
    r'\b(?:rm\s+-rf|mkfs|shutdown|reboot|poweroff|halt|dd\s+if=|:>\s*\/)\b',
    re_module.IGNORECASE,
)


def _smoke_executable_index(argv: list) -> int:
    """Return the argv index for the actual smoke executable after safe wrappers."""
    index = 0
    if argv and Path(argv[0]).name == 'env':
        index = 1
        while index < len(argv) and re_module.match(r'^[A-Za-z_][A-Za-z0-9_]*=.*$', argv[index]):
            index += 1
    if index < len(argv) and Path(argv[index]).name == 'timeout':
        index += 1
        if index < len(argv) and re_module.match(r'^\d+[smhd]?$', argv[index]):
            index += 1
    return index


def _normalize_smoke_python_argv(argv: list, executable_index: int) -> list:
    normalized = list(argv)
    executable = Path(normalized[executable_index]).name
    if executable in {'python', 'python3'}:
        normalized[executable_index] = sys.executable or normalized[executable_index]
    return normalized


def _safe_smoke_command(command: str):
    command = str(command or '').strip()
    if not command:
        return None, 'empty smoke test command'
    if SMOKE_DESTRUCTIVE_COMMAND_MARKERS.search(command):
        return None, 'destructive smoke test command rejected'

    heredoc_match = re_module.match(
        r"^(python(?:3)?|/[^\s]+/python(?:3)?)\s+-\s+<<['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?\s*\n(.*?)\n\2\s*$",
        command,
        flags=re_module.DOTALL,
    )
    if heredoc_match:
        code = heredoc_match.group(3).strip('\n')
        if not code.strip():
            return None, 'empty python heredoc smoke test command'
        return [sys.executable or heredoc_match.group(1), '-c', code], None

    try:
        argv = shlex.split(command)
    except Exception as exc:
        return None, f'invalid smoke test command: {exc}'
    if not argv:
        return None, 'empty smoke test command'
    allowed = {'python', 'python3', 'pytest', 'node', 'bash', 'sh', 'nvidia-smi'}
    executable_index = _smoke_executable_index(argv)
    if executable_index >= len(argv):
        return None, f'unsupported smoke test wrapper {argv[0]!r}'
    executable = Path(argv[executable_index]).name
    if executable not in allowed:
        return None, f'unsupported smoke test executable {argv[executable_index]!r}'
    return _normalize_smoke_python_argv(argv, executable_index), None


def _manifest_model_allow_patterns(model: dict) -> list:
    """Return safe HuggingFace snapshot allow patterns requested by manifest."""
    for key in ('files', 'downloadFiles', 'allowPatterns', 'allow_patterns'):
        value = model.get(key)
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        if isinstance(value, list):
            patterns = [str(v).strip() for v in value if str(v).strip()]
            if patterns:
                return patterns[:50]
    if model.get('downloadFull') is True and os.environ.get('AR3_ALLOW_FULL_MODEL_DOWNLOAD') == '1':
        return []
    return ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'generation_config.json', '*.md', '*.txt']


def _manifest_model_cache_root(context: dict) -> Path:
    """Return the shared model cache root used across persistent workbenches."""
    configured = os.environ.get('AR3_MODEL_CACHE_ROOT') or context.get('model_cache_root') or DEFAULT_MODEL_CACHE_ROOT
    return Path(configured)


def _manifest_model_local_dir(model_id: str, context: dict) -> Path:
    """Return a stable, collision-resistant local dir for a HuggingFace model id."""
    digest = hashlib.sha1(str(model_id).encode('utf-8')).hexdigest()[:10]
    slug = _safe_slug(str(model_id).replace('/', '-'), 'model')
    return _manifest_model_cache_root(context) / f'{slug}-{digest}'


def resolve_manifest_models(manifest: dict, context: dict, timeout: int = 900) -> dict:
    """Resolve/download manifest HuggingFace models into the persistent workbench."""
    models = manifest.get('models') or [] if isinstance(manifest, dict) else []
    if not models:
        return {'success': True, 'output': 'no manifest models declared', 'error': None}

    model_cache_root = _manifest_model_cache_root(context)
    model_cache_root.mkdir(parents=True, exist_ok=True)
    resolution = []
    output_parts = [f'model_cache_root={model_cache_root}']
    resolver_code = r'''
import json
import os
from pathlib import Path

repo_id = os.environ['AR3_MODEL_ID']
local_dir = Path(os.environ['AR3_MODEL_LOCAL_DIR'])
allow_patterns = json.loads(os.environ.get('AR3_MODEL_ALLOW_PATTERNS') or '[]')
try:
    from huggingface_hub import HfApi, snapshot_download
except ModuleNotFoundError as exc:
    raise SystemExit('huggingface_hub unavailable after dependency install: ' + repr(exc))

api = HfApi()
info = api.model_info(repo_id)
local_dir.mkdir(parents=True, exist_ok=True)
kwargs = {
    'repo_id': repo_id,
    'local_dir': str(local_dir),
    'local_dir_use_symlinks': False,
    'resume_download': True,
}
if allow_patterns:
    kwargs['allow_patterns'] = allow_patterns
snapshot_path = snapshot_download(**kwargs)
downloaded = []
for path in Path(snapshot_path).rglob('*'):
    if path.is_file():
        downloaded.append(str(path.relative_to(snapshot_path)))
print(json.dumps({
    'ok': True,
    'repo_id': repo_id,
    'sha': getattr(info, 'sha', None),
    'pipeline_tag': getattr(info, 'pipeline_tag', None),
    'local_dir': snapshot_path,
    'allow_patterns': allow_patterns,
    'downloaded_files': sorted(downloaded)[:200],
}, sort_keys=True))
'''

    for i, model in enumerate(models):
        if not isinstance(model, dict):
            return {'success': False, 'output': '\n'.join(output_parts), 'error': f'Invalid model entry at index {i}'}
        if model.get('source') != 'huggingface':
            continue
        model_id = str(model.get('id') or '').strip()
        required = model.get('required') is True
        if not model_id:
            if required:
                return {'success': False, 'output': '\n'.join(output_parts), 'error': f'Required HuggingFace model at index {i} is missing id'}
            continue
        local_dir = _manifest_model_local_dir(model_id, context)
        allow_patterns = _manifest_model_allow_patterns(model)
        install = subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--target', context['packages_dir'], 'huggingface_hub>=0.20'],
            capture_output=True, text=True, timeout=min(timeout, 300), env=context['env']
        )
        if install.returncode != 0:
            err = install.stderr.strip() or f'pip exited {install.returncode}'
            if required:
                return {'success': False, 'output': '\n'.join(output_parts), 'error': f'HuggingFace resolver dependency install failed for {model_id}: {err}'}
            output_parts.append(f'model_resolve {model_id} skipped resolver install failed: {err}')
            continue
        env = {
            **context['env'],
            'AR3_MODEL_ID': model_id,
            'AR3_MODEL_LOCAL_DIR': str(local_dir),
            'AR3_MODEL_ALLOW_PATTERNS': json.dumps(allow_patterns),
        }
        result = subprocess.run([sys.executable, '-c', resolver_code], capture_output=True, text=True, timeout=timeout, cwd=context['workbench_dir'], env=env)
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        output_parts.append(f'model_resolve {model_id} exit={result.returncode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}')
        if result.returncode != 0:
            if required:
                return {'success': False, 'output': '\n'.join(output_parts), 'error': f'Required HuggingFace model {model_id!r} failed to resolve/download'}
            continue
        try:
            item = json.loads(stdout) if stdout.startswith('{') else {'repo_id': model_id, 'raw': stdout}
        except Exception:
            item = {'repo_id': model_id, 'raw': stdout}
        item['manifest_index'] = i
        item['local_dir'] = item.get('local_dir') or str(local_dir)
        resolution.append(item)

    resolution_file = Path(context['workbench_dir']) / 'model_resolution.json'
    with open(resolution_file, 'w') as f:
        json.dump({'models': resolution}, f, indent=2, sort_keys=True)
    context['env']['AR3_MODEL_RESOLUTION_FILE'] = str(resolution_file)
    context['env']['AR3_MODEL_CACHE_DIR'] = str(model_cache_root)
    output_parts.append(f'model_resolution_file={resolution_file}')
    return {'success': True, 'output': '\n'.join(output_parts), 'error': None}


def _append_preparation_run_history(context: dict, manifest_path: Path, success: bool, output: str, error: str = None) -> str:
    """Append a bounded preparation history entry in the persistent workbench."""
    history_path = Path(context['workbench_dir']) / 'preparation_run_history.json'
    entry = {
        'timestamp': datetime.now().isoformat(),
        'manifestPath': str(manifest_path),
        'success': bool(success),
        'error': error,
        'outputTail': str(output or '')[-4000:],
    }
    try:
        if history_path.exists():
            with open(history_path, 'r') as f:
                history = json.load(f)
            if not isinstance(history, list):
                history = []
        else:
            history = []
    except Exception:
        history = []
    history.append(entry)
    history = history[-20:]
    tmp_path = history_path.with_suffix('.json.tmp')
    with open(tmp_path, 'w') as f:
        json.dump(history, f, indent=2, sort_keys=True)
    os.replace(tmp_path, history_path)
    return str(history_path)


def prepare_manifest_environment(manifest: dict, context: dict, timeout: int = 900, job_id: str = '') -> dict:
    """Install manifest dependencies, resolve models, and run smoke tests before experiment code."""
    if not isinstance(manifest, dict):
        return {'success': True, 'output': 'no preparation manifest supplied', 'error': None}

    manifest_path = Path(context['workbench_dir']) / 'preparation_manifest.json'
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2, sort_keys=True)

    dep_result = install_declared_dependencies(manifest.get('dependencies') or [], context, timeout=timeout, job_id=job_id)
    output_parts = [f'preparation_manifest={manifest_path}']

    def finish(success: bool, error: str = None) -> dict:
        history_path = _append_preparation_run_history(context, manifest_path, success, '\n'.join(output_parts), error)
        output_with_history = '\n'.join(output_parts + [f'preparation_run_history={history_path}'])
        return {'success': success, 'output': output_with_history, 'error': error}

    if dep_result.get('output'):
        output_parts.append('dependency_install:\n' + dep_result.get('output', ''))
    if not dep_result.get('success'):
        return finish(False, 'Preparation dependency installation failed: ' + str(dep_result.get('error', 'unknown')))

    manifest_needs_torch = _code_or_deps_need_torch(
        '\n'.join(
            [str(smoke.get('command') or '') for smoke in manifest.get('smokeTests') or [] if isinstance(smoke, dict)]
            + [str(model.get('smokeTest') or '') for model in manifest.get('models') or [] if isinstance(model, dict)]
        ),
        manifest.get('dependencies') or [],
    )
    if manifest_needs_torch:
        torch_result = ensure_torch_cuda_workbench(context, timeout=min(timeout, 600))
        if torch_result.get('output'):
            output_parts.append('torch_cuda_workbench:\n' + torch_result.get('output', ''))
        if not torch_result.get('success'):
            return finish(False, 'Preparation torch CUDA workbench validation failed: ' + str(torch_result.get('error', 'unknown')))
        context['env'] = _torch_cuda_runtime_env(context)

    model_resolution = resolve_manifest_models(manifest, context, timeout=timeout)
    if model_resolution.get('output'):
        output_parts.append('model_resolution:\n' + model_resolution.get('output', ''))
    if not model_resolution.get('success'):
        return finish(False, 'Preparation model resolution failed: ' + str(model_resolution.get('error', 'unknown')))

    for model in manifest.get('models') or []:
        if not isinstance(model, dict):
            return finish(False, 'Invalid model entry in preparation manifest')
        if model.get('required') is not True:
            continue
        model_id = str(model.get('id') or 'required-model')
        smoke_command = str(model.get('smokeTest') or '').strip()
        if not smoke_command:
            output_parts.append(f'model_smoke {model_id} skipped: no smoke test command supplied; model resolution evidence accepted')
            continue
        argv, err = _safe_smoke_command(smoke_command)
        if err:
            return finish(False, f'Required model smoke test {model_id!r} rejected: {err}')
        smoke_timeout = max(5, min(int(model.get('timeoutSeconds') or 300), timeout))
        result = subprocess.run(argv, capture_output=True, text=True, timeout=smoke_timeout, cwd=context['workbench_dir'], env=context['env'])
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        output_parts.append(f'model_smoke {model_id} exit={result.returncode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}')
        if result.returncode != 0:
            return finish(False, f'Required model smoke test {model_id!r} failed')

    for smoke in manifest.get('smokeTests') or []:
        if not isinstance(smoke, dict):
            return finish(False, 'Invalid smoke test entry in preparation manifest')
        name = str(smoke.get('name') or 'smoke-test')
        argv, err = _safe_smoke_command(smoke.get('command') or '')
        if err:
            return finish(False, f'Preparation smoke test {name!r} rejected: {err}')
        smoke_timeout = int(smoke.get('timeoutSeconds') or min(timeout, 300))
        smoke_timeout = max(5, min(smoke_timeout, timeout))
        result = subprocess.run(argv, capture_output=True, text=True, timeout=smoke_timeout, cwd=context['workbench_dir'], env=context['env'])
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        output_parts.append(f'smoke_test {name} exit={result.returncode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}')
        if result.returncode != 0:
            return finish(False, f'Preparation smoke test {name!r} failed')
        expected = [str(e) for e in smoke.get('expectedEvidence') or []]
        combined = stdout + '\n' + stderr
        missing = [e for e in expected if e and e not in combined]
        if missing:
            return finish(False, f'Preparation smoke test {name!r} missing expected evidence: {missing}')
    return finish(True, None)


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
    # AGGRESSIVE: any line with 4+ spaces indentation and alphanumeric content is code
    lines = prompt.split('\n')
    code_lines = []
    in_code = False
    for raw_line in lines:
        stripped = raw_line.strip()
        # Skip empty lines
        if not stripped:
            if in_code:
                in_code = False
            continue
        # Skip comment-only lines, markdown bullets
        if stripped.startswith('#') or stripped.startswith('- ') or stripped.startswith('* '):
            if in_code:
                in_code = False
            continue
        if stripped.startswith('```') or stripped.startswith('{'):
            continue
        # Skip numbered list items WITHOUT Python indicators (unless indented 4+ spaces)
        # AGGRESSIVE: any indented line (4+ spaces) with alphanumeric content is potential code
        leading_spaces = len(raw_line) - len(raw_line.lstrip())
        if leading_spaces >= 4:
            # SKIP: lines that look like markdown prose/doc strings, not Python code
            _skip = False
            _s_strip = stripped
            # Skip long lines starting with quotes (likely doc strings in markdown)
            if len(_s_strip) > 60 and _s_strip[0] in ('"', "'"):
                _skip = True
            # Skip numbered list items like "6. Uses actual tensor operations..." (both '.' and ')' formats)
            if re_module.match(r'^\d+[.)]\s+[^=+\-|:]+$', _s_strip):
                _skip = True
            # Skip lines that look like parameter docs: "latent_dim  = 8192   (description)"
            if re_module.match(r'^\s*[a-z_][a-z_0-9]*\s*=\s*\d+.*\([^)]*\)\s*$', _s_strip):
                _skip = True
            # Skip lines with only markdown-ish content (starts with quotes or parens)
            if _s_strip and _s_strip[0] in ('(', '[', '{') and not any(k in _s_strip for k in ('torch.', 'nn.', 'F.', 'self.', '=')):
                _skip = True
            # Additional markdown prose skip patterns
            if '    ' in raw_line and ':' in stripped and '(' not in stripped and '=' not in stripped and '->' not in stripped:
                if not any(k in stripped for k in ('torch.', 'nn.', 'F.', 'self.', 'def ', 'class ', 'return ')):
                    _skip = True
            if '    ' in raw_line and stripped.startswith('(') and stripped.endswith(')'):
                _skip = True
            if re_module.match(r'^\s{4,}\w+\s*:\s*\w+\s*=\s*\S.*#.*$', raw_line):
                _skip = True
            if re_module.match(r'^\s*\|.*\|\s*$', stripped):
                _skip = True

            if not _skip and any(c.isalnum() for c in stripped):
                in_code = True
                code_lines.append(raw_line)
                # Don't stop early — collect up to 50 lines
                if len(code_lines) >= 50:
                    break
            continue
        # UnIndented or lightly indented: only include if it has strong Python indicators
        if any(kw in stripped for kw in ['import ', 'from ', 'def ', 'class ',
                                         'torch.', 'cuda.', 'tensor(', '.cuda()', '.to(']):
            in_code = True
        if in_code:
            code_lines.append(raw_line)
            if len(code_lines) >= 50:
                break
        elif len(code_lines) > 0 and stripped:
            # Light indentation — could be continuation
            if stripped.startswith('    ') or stripped.startswith('\t'):
                code_lines.append(raw_line)
            elif len(code_lines) > 5:
                break

    if code_lines:
        code = ''.join(c if ord(c) < 128 else '?' for c in '\n'.join(code_lines))
        code = strip_markdown_headers(code)
        code_lines_final = [ln for ln in code.split(chr(10)) if ln.strip()
                           and not re_module.match(r'^(#{1,6}\s|\*\*|\-\-\-|\d+\.\s+[A-Z])', ln.strip())]
        code = chr(10).join(code_lines_final)
        if len(code) > 30:
            # POST-PROCESSING VALIDATION GATE:
            # Strategy 4 assembles indented lines that LOOK like Python but are actually
            # markdown prose (doc strings, bullet descriptions). Reject if no real Python
            # indicators are present, to prevent SyntaxError cascade from bad code.
            indicators = ["import ", "from ", "def ", "class ", "torch.", "nn.", "F.",
                         "cuda.", "tensor(", "self.", "return ", "for ", "while ",
                         "if ", "else:", "try:", "except ", ".cpu()", ".cuda()",
                         ".to(", "torch.nn", "torch.cuda", "= torch", "= [", "= {"]
            n_ind = sum(1 for i in indicators if i in code)
            has_sig = any(kw in code for kw in ["import ", "def ", "class ", "torch."])
            if n_ind < 3 and not has_sig:
                log(f"Strategy 4: ASSEMBLY REJECTED (n_ind={n_ind}<3, has_sig={has_sig}). "
                    "Falling through to nvidia-smi fallback.",
                    thread_id=threading.current_thread().name)
            else:
                # HEREDOC STRIP
                _s4_lines = code.split('\n')
                _s4_clean = []
                for _ln in _s4_lines:
                    _ls = _ln.strip()
                    if _ls in ('PYEOF', 'EOF', 'PYTHON', 'BASH', 'MARKER'): continue
                    if re_module.match(r"^'{3,}$", _ls) or re_module.match(r'^"{3,}$', _ls): continue
                    if re_module.search(r'^\s*<<\s+["\']?[A-Z]+["\']?\s*$', _ln): continue
                    _s4_clean.append(_ln)
                code = '\n'.join(_s4_clean)

                # AUTO-IMPORT for Strategy 4
                if re_module.search(r'\bre\.[A-Za-z_][A-Za-z_0-9]*\b', code):
                    if not any('import re' in c for c in _s4_clean[:5]):
                        code = 'import re\n' + code
                if re_module.search(r'\bnp\.[A-Za-z_][A-Za-z_0-9]*\b', code):
                    if not any('import numpy' in c for c in _s4_clean[:5]):
                        code = 'import numpy as np\n' + code
                if re_module.search(r'\bplt\.[A-Za-z_][A-Za-z_0-9]*\b', code):
                    if not any('import matplotlib' in c for c in _s4_clean[:5]):
                        code = 'import matplotlib.pyplot as plt\n' + code

                # EXPANDED VALIDATION GATE
                indicators_s4 = ["import ", "from ", "def ", "class ", "torch.", "nn.", "F.",
                                 "cuda.", "tensor(", "self.", "return ", "for ", "while ",
                                 "if ", "else:", "try:", "except ", ".cpu()", ".cuda()",
                                 ".to(", "torch.nn", "torch.cuda", "= torch", "= [", "= {",
                                 "re.", "np.", "plt.", "dtype", "device", "shape", "grad"]
                n_ind_s4 = sum(1 for i in indicators_s4 if i in code)
                has_sig_s4 = any(kw in code for kw in ["import ", "def ", "class ", "torch.", "re.", "nn."])
                if n_ind_s4 < 3 and not has_sig_s4:
                    log(f"Strategy 4: ASSEMBLY REJECTED (n_ind_s4={n_ind_s4}<3, has_sig={has_sig_s4}). "
                        "Falling through to nvidia-smi fallback.",
                        thread_id=threading.current_thread().name)
                elif 'PYEOF' in code or 'EOF' in code:
                    log(f"Strategy 4: REJECTED -- heredoc markers still present after strip. "
                        "Falling through to nvidia-smi fallback.",
                        thread_id=threading.current_thread().name)
                else:
                    log(f"Strategy 4: Assembled {len(code_lines_final)} lines, {len(code)} chars "
                        f"(indicators={n_ind_s4})",
                        thread_id=threading.current_thread().name)
                    return {"action": "run_python", "code": code}

    # ── No valid GPU command: fail fast instead of masking bad model output as nvidia-smi success ──
    log(f"ERROR: No valid GPU command found — refusing nvidia-smi fallback for research jobs",
        thread_id=threading.current_thread().name)
    log(f"  Prompt preview (200 chars): {prompt[:200]}",
        thread_id=threading.current_thread().name)
    return {"action": "invalid", "error": "No executable GPU command found. Expected JSON {action:'run_python', code:'...'} with real Python code."}



def execute_quantized_code(code: str, timeout: int = DEFAULT_JOB_TIMEOUT, context: dict = None) -> dict:
    """"Execute Python code with quantized model support (bitsandbytes 8-bit)."""
    log(f"Executing quantized Python code ({len(code)} chars)",
        thread_id=threading.current_thread().name)
    context = context or prepare_workbench({'spaceId': 'default'})

    # ── Pre-process: coerce f-string tensor.item():.Nf patterns ─────────────
    fixed_code = re_module.sub(
        r"f(['\"])([^'\"]*?)\{([^{}]+?)\.item\(\):\.(\d+)f\}([^'\"]*?)\1",
        lambda m: "f'" + m.group(2) + '{float(' + m.group(3) + '.item()):.'
                  + m.group(4) + 'f}' + m.group(5) + "'",
        code
    )

    # ── Patch: Handle LLaDA transformers 5.x compatibility ─────────────────
    patch_wrapper = """
import torch
import builtins as _builtins
_orig_getattr = torch.nn.Module.__getattr__
def _patched_getattr(self, name, *args, **kwargs):
    if name == 'all_tied_weights_keys':
        return {}
    return _orig_getattr(self, name, *args, **kwargs)
torch.nn.Module.__getattr__ = _patched_getattr
"""
    fixed_code = patch_wrapper + fixed_code

    if fixed_code != code:
        log(f"Format-string coercion applied",
            thread_id=threading.current_thread().name)

    code_file = str(Path(context.get('scratch_dir') or context['workbench_dir']) / f"gpu_code_{int(time.time()*1000)}.py")
    with open(code_file, 'w') as f:
        f.write(fixed_code)

    try:
        result = subprocess.run(
            ['python3', code_file],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=context['workbench_dir'],
            env={
                **context.get('env', os.environ),
                'LD_LIBRARY_PATH': '/usr/local/cuda/lib64:' + context.get('env', os.environ).get('LD_LIBRARY_PATH', ''),
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



def repair_embedded_newline_string_literals(code: str) -> str:
    """Repair common LLM/JSON escape damage: "<physical newline>".join(...).

    Generated GPU commands sometimes intend `"\\n".join(xs)` but the string arrives
    as a physical newline between quotes, causing `SyntaxError: unterminated string
    literal`. Keep this repair narrow so normal multi-line code is untouched.
    """
    # Handle both `"\n".join(xs)` and `"\n" + text` when the backslash
    # has been decoded into a physical newline between two quotes.
    return re_module.sub(r'([\"\'])\n\1(?=\s*(?:\.join\s*\(|\+|,|\)|\]))', r'\1\\n\1', code)


def repair_common_torch_api_mistakes(code: str) -> str:
    """Repair narrow, observed PyTorch API hallucinations in generated experiments."""
    fixed = re_module.sub(r'(?<![A-Za-z0-9_])total_mem(?![A-Za-z0-9_])', 'total_memory', code)
    # Observed in live weak-model output: the model defines SINGLE_MODEL_VRAM_GIB
    # and later references SINGLE_MODEL_VRAM_VRAM_GIB, causing a NameError before
    # any evidence is produced. Keep the repair literal rather than fuzzy.
    fixed = fixed.replace('SINGLE_MODEL_VRAM_VRAM_GIB', 'SINGLE_MODEL_VRAM_GIB')
    return fixed


def repair_common_gpu_info_key_assumptions(code: str) -> str:
    """Repair observed generated-code assumptions about optional GPU info keys."""
    optional_bool_keys = ('can_load_2x_8b_model_fp16',)
    fixed = code
    for key in optional_bool_keys:
        fixed = re_module.sub(
            rf"(\b[A-Za-z_][A-Za-z0-9_]*\b)\[['\"]{re_module.escape(key)}['\"]\]",
            rf"\1.get('{key}', False)",
            fixed,
        )
    return fixed


def repair_malformed_dict_value_format_specs(code: str) -> str:
    """Repair LLM-emitted dict values that use f-string format specs outside f-strings.

    Generated experiments sometimes produce invalid Python such as
    ``{'agreement': consensus_result['avg_agreement']:.3f}``.  The intent is a
    rounded numeric metric value, not a type annotation.  Keep the repair narrow:
    only dict-style key/value separators followed by a simple name/attribute/
    subscript expression and a ``:.Nf`` suffix before a comma or closing brace.
    """
    expr = r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\n\[\]]+\]|\.[A-Za-z_][A-Za-z0-9_]*|\([^\n()]*\))*"
    pattern = re_module.compile(rf"(:\s*)({expr})\s*:\.(\d+)f(?=\s*[,}}])")
    return pattern.sub(lambda m: f"{m.group(1)}round({m.group(2)}, {m.group(3)})", code)


def auto_fix_code(code: str) -> str:
    """Attempt to fix common SyntaxError/IndentationError issues in one pass."""
    import re as re_module

    def _compiles(candidate: str) -> bool:
        try:
            compile(candidate, '<gpu-worker-auto-fix>', 'exec')
            return True
        except SyntaxError:
            return False

    # CRITICAL: init `fixed` BEFORE any closure referencing it (UnboundLocal bytecode bug).
    # Repair physical-newline string literals before delimiter balancing. The line-by-line
    # delimiter fixer is intentionally broad and can corrupt valid multi-line dict calls
    # (e.g. item.update({ ... })) when the only real syntax error is a decoded "\n".
    fixed = repair_embedded_newline_string_literals(code)
    fixed = repair_common_torch_api_mistakes(fixed)
    fixed = repair_malformed_dict_value_format_specs(fixed)
    if fixed != code and _compiles(fixed):
        return fixed

    # 1. Add missing colons after def/class/if/for/while/elif/else/try/except/finally/with
    # Pattern: line ending with keyword followed by newline (no colon)
    keyword_lines = re_module.compile(
        r'^(\s*)(def |class |if |elif |else:|try:|except |finally:|with |for |while |async def |async class )',
        re_module.MULTILINE
    )
    def add_colon(m):
        text = m.group(2)
        # Already has colon
        if text.endswith(':'):
            return m.group(1) + text
        # if/elif/else/try/except/finally/with/for/while need colon
        return m.group(1) + text + ':'
    fixed = keyword_lines.sub(add_colon, fixed)

    # 2. Fix missing closing parens/brackets/braces on lines
    # Count open (, [, { and try to close them at end of line
    lines = fixed.split('\n')
    fixed_lines = []
    for line in lines:
        fixed_lines.append(line)
        open_parens = line.count('(') - line.count(')')
        open_brackets = line.count('[') - line.count(']')
        open_braces = line.count('{') - line.count('}')
        # If we opened more than we closed and line doesn't end with comma/backslash
        if open_parens > 0 and not line.rstrip().endswith(('\\', ',', '+')):
            fixed_lines[-1] += ')' * open_parens
        if open_brackets > 0 and not line.rstrip().endswith(('\\', ',', '+')):
            fixed_lines[-1] += ']' * open_brackets
        if open_braces > 0 and not line.rstrip().endswith(('\\', ',', '+')):
            fixed_lines[-1] += '}' * open_braces
    fixed = '\n'.join(fixed_lines)

    # 3. Fix common indentation errors: dedent lines that start with blank space after unindented line
    # (i.e., fix "def foo():\npass\n  something" type issues)
    lines = fixed.split('\n')
    fixed_lines = []
    prev_indented = False
    for line in lines:
        stripped = line.lstrip()
        leading_spaces = len(line) - len(stripped)
        # If we go from non-indented to indented without intermediate dedent
        if stripped and leading_spaces > 0 and not prev_indented and fixed_lines:
            prev_line = fixed_lines[-1].strip()
            # Previous line was a colon-less header, add pass first
            if prev_line and not prev_line.startswith('#') and not prev_line.startswith('return') and '(' not in prev_line and ')' not in prev_line:
                # Check if last line looks like it needed a colon
                if not prev_line.endswith(':'):
                    pass  # already handled above
        fixed_lines.append(line)
        prev_indented = (leading_spaces > 0)
    fixed = '\n'.join(fixed_lines)

    return fixed


COMMON_STDLIB_MODULES = {
    'json', 'os', 'sys', 'math', 'random', 'time', 'datetime', 'pathlib', 'statistics',
    'itertools', 'functools', 'collections', 'subprocess', 're', 'csv', 'tempfile', 'shutil',
}

COMMON_STDLIB_SYMBOL_IMPORTS = {
    'defaultdict': 'from collections import defaultdict',
    'Counter': 'from collections import Counter',
    'deque': 'from collections import deque',
}


def inject_missing_common_stdlib_imports(code: str) -> str:
    """Prepend imports for common stdlib modules referenced but not imported.

    Weak implementer models often emit otherwise executable experiments that use
    json.dumps/os.getcwd/pathlib.Path in final metrics reporting but omit the
    import line. Repair only top-level stdlib module names, and only after AST
    parsing succeeds, so pseudocode/syntax errors still fail fast.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return code

    imported = set()
    loaded_names = set()
    assigned_names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add((alias.asname or alias.name.split('.')[0]))
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imported.add(node.module.split('.')[0])
            for alias in node.names:
                imported.add(alias.asname or alias.name)
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                loaded_names.add(node.id)
            elif isinstance(node.ctx, (ast.Store, ast.Del)):
                assigned_names.add(node.id)

    missing = sorted((loaded_names & COMMON_STDLIB_MODULES) - imported - assigned_names)
    missing_symbol_imports = [
        import_line for symbol, import_line in sorted(COMMON_STDLIB_SYMBOL_IMPORTS.items())
        if symbol in loaded_names and symbol not in imported and symbol not in assigned_names
    ]
    if not missing and not missing_symbol_imports:
        return code
    import_lines = [f'import {name}' for name in missing] + missing_symbol_imports
    return ''.join(f'{line}\n' for line in import_lines) + code


def inject_json_numpy_scalar_encoder_patch(code: str) -> str:
    """Make generated json.dumps/json.dump tolerate ML scalar types.

    Live weak-model experiments often compute metrics with NumPy or torch and
    then pass those values directly to json.dumps. Python's stock JSON encoder
    rejects np.bool_/np.float32/ndarray and tensor values, turning otherwise
    useful executable experiments into runtime failures before evidence prints.
    """
    if not re_module.search(r'\bjson\.(?:dump|dumps)\s*\(', code):
        return code
    if '_ar3_json_default' in code:
        return code
    patch = '''
try:
    import json as _ar3_json_module
    _ar3_original_json_default = _ar3_json_module.JSONEncoder.default
    def _ar3_json_default(self, obj):
        try:
            import numpy as _ar3_np
            if isinstance(obj, _ar3_np.generic):
                return obj.item()
            if isinstance(obj, _ar3_np.ndarray):
                return obj.tolist()
        except Exception:
            pass
        try:
            import torch as _ar3_torch
            if isinstance(obj, _ar3_torch.Tensor):
                return obj.detach().cpu().tolist()
        except Exception:
            pass
        return _ar3_original_json_default(self, obj)
    _ar3_json_module.JSONEncoder.default = _ar3_json_default
except Exception as _ar3_json_patch_error:
    print("ar3_json_patch_warning=" + repr(_ar3_json_patch_error))
'''
    return patch + '\n' + code


def validate_executable_experiment_code(code: str) -> dict:
    """Fail fast on prose/pseudocode before any dependency install or execution.

    TypeScript validation catches normal API submissions, but the worker also accepts
    queued jobs directly and has legacy markdown extraction paths. This guard keeps
    weak-model prose from consuming GPU time or mutating persistent workbenches.
    """
    text = str(code or '')
    placeholder_patterns = [
        r'\bTODO\b',
        r'\bFIXME\b',
        r'placeholder',
        r'pseudocode',
        r'your code here',
        r'\bpass\s*(?:#.*)?$',
        r'\.\.\.',
        r'implement (?:this|the actual|real)',
    ]
    for pattern in placeholder_patterns:
        if re_module.search(pattern, text, flags=re_module.IGNORECASE | re_module.MULTILINE):
            return {'ok': False, 'error': f'Executable code rejected: placeholder/pseudocode marker matched {pattern!r}'}

    unmanaged_tmp_path = find_unmanaged_tmp_path_literal(text)
    if unmanaged_tmp_path:
        return {
            'ok': False,
            'error': (
                'Executable code rejected: unmanaged absolute /tmp path '
                f'{unmanaged_tmp_path!r}; use AR3_WORKBENCH_DIR, AR3_ARTIFACTS_DIR, '
                'AR3_SCRATCH_DIR, AR3_MODEL_SCRATCH_DIR, or tempfile instead'
            ),
        }

    if not re_module.search(r'\b(print\s*\(|json\.dump|json\.dumps|logging\.)', text):
        return {'ok': False, 'error': 'Executable code rejected: experiment must print/log measurable evidence'}

    gpu_probe_patterns = [
        r'\btorch\.cuda\b',
        r'\bcuda\.is_available\b',
        r'\.cuda\s*\(',
        r'\.to\s*\(\s*[\'\"]cuda',
        r'\bdevice\s*=\s*[\'\"]cuda',
        r'\bcupy\b',
        r'\btriton\b',
        r'\btensorflow\b.*\bGPU\b',
        r'\bjax\b.*\b(device|gpu)\b',
        r'\bnvidia-smi\b',
        r'\bnvml\b',
        r'\bgpu_name\b',
        r'\bcuda_available\b',
        r'\bvram\b',
    ]
    if not any(re_module.search(pattern, text, flags=re_module.IGNORECASE | re_module.DOTALL) for pattern in gpu_probe_patterns):
        return {'ok': False, 'error': 'Executable code rejected: experiment must include a GPU/CUDA probe or GPU runtime evidence path'}

    return {'ok': True, 'error': None}


def find_unmanaged_tmp_path_literal(code: str):
    """Return a hardcoded /tmp path that would escape AR-3 space cleanup."""
    try:
        tree = ast.parse(str(code or ''))
    except SyntaxError:
        return None

    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        value = node.value.strip()
        if value == '/tmp' or value.startswith('/tmp/'):
            if any(value == prefix or value.startswith(prefix + '/') for prefix in ALLOWED_GENERATED_TMP_PREFIXES):
                continue
            return value
    return None


def _iter_json_objects_from_output(output: str):
    """Yield all JSON objects embedded in stdout/stderr evidence.

    Worker output often prepends a one-line torch smoke JSON before the actual
    pretty-printed experiment evidence. A first-object-only scan lets later
    self-reported contract failures hide behind valid GPU smoke evidence, so scan
    the full stream with quote-aware brace matching.
    """
    text = str(output or '')
    seen = set()
    in_str = False
    escape_next = False
    brace_depth = 0
    json_start = -1
    for i, ch in enumerate(text):
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_str:
            escape_next = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '{':
            if brace_depth == 0:
                json_start = i
            brace_depth += 1
        elif ch == '}' and brace_depth:
            brace_depth -= 1
            if brace_depth == 0 and json_start >= 0:
                raw = text[json_start:i + 1]
                json_start = -1
                try:
                    parsed = json.loads(raw)
                except Exception:
                    continue
                if isinstance(parsed, dict):
                    key = (json_start, i, raw[:120])
                    if key not in seen:
                        seen.add(key)
                        yield parsed


def _flatten_json_evidence(value, prefix='') -> dict:
    """Flatten structured stdout JSON so manifest evidence can be checked.

    The GPU worker receives only stdout/stderr after execution, not TypeScript's
    richer validator state. Flattening lets the worker enforce preparation
    manifest grading/success criteria itself and fail jobs early enough for the
    research loop to retry instead of recording a fake success.
    """
    flattened = {}
    if isinstance(value, dict):
        for key, nested in value.items():
            path = f'{prefix}.{key}' if prefix else str(key)
            flattened[path] = nested
            flattened.update(_flatten_json_evidence(nested, path))
    elif isinstance(value, list):
        for index, nested in enumerate(value[:50]):
            path = f'{prefix}[{index}]' if prefix else f'[{index}]'
            flattened[path] = nested
            flattened.update(_flatten_json_evidence(nested, path))
    return flattened


def _value_is_concrete(value) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value is True
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        text = value.strip().lower()
        return bool(text) and text not in {'false', 'none', 'null', 'unknown', 'missing', 'not_found', 'failed', 'error'}
    if isinstance(value, list):
        return any(_value_is_concrete(item) for item in value)
    if isinstance(value, dict):
        return any(_value_is_concrete(item) for item in value.values())
    return False


def _metric_terms(text: str) -> list:
    raw = re_module.findall(r'[A-Za-z][A-Za-z0-9_.-]*', str(text or '').lower())
    stopwords = {
        'and', 'are', 'artifact', 'artifacts', 'check', 'concrete', 'evidence',
        'field', 'fields', 'include', 'includes', 'metric', 'metrics', 'must',
        'name', 'print', 'prints', 'score', 'stdout', 'stderr', 'the', 'with',
    }
    terms = []
    for item in raw:
        item = item.replace('-', '_')
        if item in stopwords:
            continue
        if '_' in item or '.' in item or item in {'accuracy', 'acc', 'cuda', 'cuda_available', 'device', 'f1', 'gpu_name', 'latency', 'loss', 'precision', 'recall', 'runtime', 'throughput', 'vram'}:
            terms.append(item)
    return list(dict.fromkeys(terms))


def _path_matches_term(path: str, term: str) -> bool:
    normalized_path = str(path or '').lower().replace('-', '_')
    normalized_term = str(term or '').lower().replace('-', '_')
    parts = [p for p in re_module.split(r'[.\[\]]+', normalized_path) if p]
    return normalized_term in parts or normalized_path.endswith('.' + normalized_term) or normalized_path == normalized_term


def _numeric_values_for_metric(flattened: dict, metric: str) -> list:
    terms = _metric_terms(metric) or [str(metric or '').lower().replace('-', '_')]
    values = []
    for path, value in flattened.items():
        if not any(_path_matches_term(path, term) for term in terms):
            continue
        if isinstance(value, (int, float)):
            values.append(float(value))
        elif isinstance(value, str):
            match = re_module.match(r'^\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)', value, flags=re_module.IGNORECASE)
            if match:
                values.append(float(match.group(1)))
    return values


def _parse_threshold(threshold: str):
    text = str(threshold or '').strip().lower()
    symbolic = re_module.match(r'^(>=|>|<=|<|=|==)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)', text, flags=re_module.IGNORECASE)
    if symbolic:
        op = '=' if symbolic.group(1) == '==' else symbolic.group(1)
        return op, float(symbolic.group(2))
    phrase = re_module.search(r'\b(at least|minimum|min|greater than|more than|above|at most|maximum|max|less than|below|under|no more than|equals?|equal to)\b\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)', text, flags=re_module.IGNORECASE)
    if not phrase:
        return None
    raw = phrase.group(1)
    op = '>=' if raw in {'at least', 'minimum', 'min'} else '>' if raw in {'greater than', 'more than', 'above'} else '<=' if raw in {'at most', 'maximum', 'max', 'no more than'} else '<' if raw in {'less than', 'below', 'under'} else '='
    return op, float(phrase.group(2))


def _threshold_ok(actual: float, parsed_threshold) -> bool:
    op, expected = parsed_threshold
    if op == '>=':
        return actual >= expected
    if op == '>':
        return actual > expected
    if op == '<=':
        return actual <= expected
    if op == '<':
        return actual < expected
    return actual == expected


def _validate_preparation_manifest_runtime_criteria(result: dict, json_objects: list) -> dict:
    manifest = result.get('preparationManifest') or result.get('preparation_manifest')
    if not isinstance(manifest, dict):
        return {'ok': True, 'error': None}

    experiment_objects = []
    for obj in json_objects:
        if not isinstance(obj, dict):
            continue
        if obj.get('type') == 'autonomous_preparation_manifest':
            continue
        keys = {str(k).lower() for k in obj.keys()}
        if keys <= {'cuda_device', 'cuda_tensor_sum', 'torch_cuda_available', 'torch_cuda_version', 'torch_version'}:
            continue
        if keys & {'disk_pressure', 'workbench_prune', 'cuda_driver_preflight', 'model_cache_root', 'model_resolution_file'}:
            continue
        experiment_objects.append(obj)

    flattened = {}
    for obj in experiment_objects:
        flattened.update(_flatten_json_evidence(obj))

    missing_evidence = []
    for smoke in (manifest.get('smokeTests') or manifest.get('smoke_tests') or [])[:20]:
        if not isinstance(smoke, dict):
            continue
        for expected in (smoke.get('expectedEvidence') or smoke.get('expected_evidence') or [])[:20]:
            terms = _metric_terms(expected) or [str(expected).lower().replace('-', '_')]
            if any(term in {'cuda_available', 'gpu_name', 'device', 'vram'} for term in terms):
                # Runtime GPU evidence is checked separately; do not force every
                # experiment to repeat setup-smoke-only fields verbatim.
                continue
            if terms and not any(any(_path_matches_term(path, term) and _value_is_concrete(value) for path, value in flattened.items()) for term in terms):
                missing_evidence.append(str(expected))

    if missing_evidence:
        return {
            'ok': False,
            'error': 'Experiment output did not satisfy preparation manifest expected evidence fields: ' + '; '.join(missing_evidence[:3]),
        }

    failed_thresholds = []
    for criterion in (manifest.get('successCriteria') or manifest.get('success_criteria') or [])[:20]:
        if not isinstance(criterion, dict):
            continue
        metric = str(criterion.get('metric') or criterion.get('field') or '').strip()
        threshold = str(criterion.get('threshold') or criterion.get('target') or '').strip()
        parsed = _parse_threshold(threshold)
        if not metric or not parsed:
            continue
        values = _numeric_values_for_metric(flattened, metric)
        if not values or not any(_threshold_ok(value, parsed) for value in values):
            failed_thresholds.append(f'{metric} {threshold}')

    if failed_thresholds:
        return {
            'ok': False,
            'error': 'Experiment output did not satisfy preparation manifest success criteria thresholds: ' + '; '.join(failed_thresholds[:3]),
        }

    return {'ok': True, 'error': None}


def validate_execution_result_evidence(result: dict) -> dict:
    """Reject self-reported invalid experiments after execution.

    Some weak implementers generate Python wrappers that execute successfully but
    print a JSON sentinel such as {"contract_failure_reason": "..."}. Treating
    that as success records a non-experiment as completed work and breaks retry
    feedback. This post-run gate promotes those sentinels to hard failures.

    Also require actual runtime GPU evidence in stdout/stderr. Static code checks
    only prove that the script mentioned CUDA; the completed job should show the
    GPU path really executed so graders can distinguish real experiments from
    wrappers that merely print "done".
    """
    if not result.get('success'):
        return result

    output = result.get('output', '')
    failure_keys = ('contract_failure_reason', 'contractFailureReason', 'failure_reason')
    json_objects = list(_iter_json_objects_from_output(output))
    manifest_criteria = _validate_preparation_manifest_runtime_criteria(result, json_objects)
    if not manifest_criteria.get('ok'):
        result['success'] = False
        result['error'] = manifest_criteria.get('error')
        return result
    for obj in json_objects:
        is_autonomous_preparation_probe = obj.get('type') == 'autonomous_preparation_manifest'
        for key in failure_keys:
            value = obj.get(key)
            if value and not is_autonomous_preparation_probe:
                result['success'] = False
                result['error'] = f'Experiment output self-reported {key}: {value}'
                return result
        status = str(obj.get('status') or obj.get('verdict') or '').strip().lower()
        if status in {'invalid', 'rejected', 'contract_failed', 'contract-failed'}:
            result['success'] = False
            result['error'] = f'Experiment output self-reported failure status: {status}'
            return result

    evidence_keys = {
        'cuda_available', 'gpu_name', 'gpu_count', 'gpu_memory', 'gpu_memory_total',
        'vram', 'device', 'device_name', 'torch_cuda_version', 'nvidia_driver',
    }
    smoke_only_keys = {
        'cuda_device', 'cuda_tensor_sum', 'torch_cuda_available', 'torch_cuda_version',
        'torch_version',
    }
    preparation_metadata_keys = {
        # Worker/job preparation metadata that can be emitted before the actual
        # autonomous preparation manifest. These objects prove setup state, not
        # completed research evidence, so they should not make a preparation
        # milestone fail simply because they lack experiment metrics.
        'disk_pressure', 'workbench_prune', 'cuda_driver_preflight',
        'freebytes', 'phase', 'warning', 'deleted', 'errors', 'status',
        'model_cache_root', 'model_resolution_file', 'models',
        'repo_id', 'sha', 'pipeline_tag', 'local_dir', 'allow_patterns',
        'downloaded_files', 'manifest_index',
    }
    fake_research_summary_keys = {
        'research_complete', 'key_findings', 'recommended_approach',
        'conclusion', 'summary', 'analysis',
    }
    output_text = str(output)
    has_preparation_only_markers = bool(
        re_module.search(r'\bpreparation_manifest\s*=', output_text)
        or re_module.search(r'\bmodel_smoke\b.*\bskipped\b.*\bmodel resolution evidence accepted\b', output_text, flags=re_module.IGNORECASE | re_module.DOTALL)
    )
    saw_preparation_contract_failure = False
    saw_problematic_non_prelude_json = False
    saw_structured_experiment_evidence = False
    for obj in json_objects:
        is_autonomous_preparation_probe = obj.get('type') == 'autonomous_preparation_manifest'
        saw_preparation_contract_failure = saw_preparation_contract_failure or bool(
            is_autonomous_preparation_probe and any(obj.get(key) for key in failure_keys)
        )
        lowered_keys = {str(key).lower() for key in obj.keys()}
        is_worker_torch_smoke = bool(lowered_keys) and lowered_keys <= smoke_only_keys
        is_preparation_metadata = bool(lowered_keys) and (
            bool(lowered_keys & preparation_metadata_keys)
            or (
                'ok' in lowered_keys
                and bool(lowered_keys & {'repo_id', 'local_dir', 'downloaded_files', 'sha'})
            )
        )
        if is_autonomous_preparation_probe or is_worker_torch_smoke:
            continue
        if is_preparation_metadata:
            continue
        if lowered_keys & evidence_keys:
            if has_preparation_only_markers and lowered_keys <= (evidence_keys | smoke_only_keys | {'sum'}):
                continue
            saw_structured_experiment_evidence = True
            return result
        if any(str(obj.get(key)).lower().startswith('cuda') for key in ('device', 'runtime', 'backend')):
            if has_preparation_only_markers and lowered_keys <= (evidence_keys | smoke_only_keys | {'sum'}):
                continue
            saw_structured_experiment_evidence = True
            return result
        if lowered_keys & fake_research_summary_keys:
            saw_problematic_non_prelude_json = True
            continue
        saw_problematic_non_prelude_json = True

    if saw_preparation_contract_failure and saw_problematic_non_prelude_json:
        result['success'] = False
        result['error'] = 'Experiment output missing structured runtime GPU evidence outside the failed preparation probe'
        return result

    if has_preparation_only_markers and not saw_structured_experiment_evidence and not saw_preparation_contract_failure:
        result['success'] = False
        result['error'] = 'Experiment output only showed preparation/model-resolution smoke evidence; missing structured runtime experiment evidence'
        return result

    evidence_patterns = [
        r'\bcuda[_ -]?(available|device|version)\b',
        r'\bgpu[_ -]?(name|count|memory|util|device)\b',
        r'\bvram\b',
        r'\bnvidia\b',
        r'\brtx\s*\d+',
        r'\btesla\b',
        r'\ba\d{2,3}\b',
    ]
    if any(re_module.search(pattern, str(output), flags=re_module.IGNORECASE) for pattern in evidence_patterns):
        return result

    result['success'] = False
    result['error'] = 'Experiment output missing runtime GPU evidence (e.g. cuda_available, gpu_name, VRAM, or nvidia-smi output)'
    return result


def execute_python_code(code: str, timeout: int = DEFAULT_JOB_TIMEOUT, context: dict = None, dependencies=None, job_id: str = '') -> dict:
    """Execute Python code inside a persistent per-space workbench."""
    context = context or prepare_workbench({'spaceId': 'default'})
    log(f"Executing Python code ({len(code)} chars) in {context['workbench_dir']}",
        thread_id=threading.current_thread().name)

    validation = validate_executable_experiment_code(code)
    if not validation.get('ok'):
        return {'success': False, 'output': '', 'error': validation.get('error')}

    dep_result = install_declared_dependencies(dependencies or [], context, job_id=job_id)
    if not dep_result.get('success'):
        return {
            'success': False,
            'output': dep_result.get('output', ''),
            'error': 'Dependency installation failed: ' + str(dep_result.get('error', 'unknown')),
        }

    torch_prep_output = ''
    if _code_or_deps_need_torch(code, dependencies or []):
        torch_result = ensure_torch_cuda_workbench(context)
        torch_prep_output = torch_result.get('output', '')
        if not torch_result.get('success'):
            return {
                'success': False,
                'output': torch_prep_output,
                'error': 'Torch CUDA workbench validation failed: ' + str(torch_result.get('error', 'unknown')),
            }
        context['env'] = _torch_cuda_runtime_env(context)

    update_job_queue_status(job_id, 'running_experiment')

    # ── Pre-process: coerce f-string tensor.item():.Nf patterns ────────────────
    # .item() can return int/str/float — wrapping with float() prevents format errors
    # Matches: f'{expr.item():.4f}' → f'{float(expr.item()):.4f}'
    fixed_code = re_module.sub(
        r"f(['\"])([^'\"]*?)\{([^{}]+?)\.item\(\):\.(\d+)f\}([^'\"]*?)\1",
        lambda m: "f'" + m.group(2) + '{float(' + m.group(3) + '.item()):.'
                  + m.group(4) + 'f}' + m.group(5) + "'",
        code
    )

    fixed_code = repair_embedded_newline_string_literals(fixed_code)
    fixed_code = repair_common_torch_api_mistakes(fixed_code)
    fixed_code = repair_common_gpu_info_key_assumptions(fixed_code)
    fixed_code = repair_malformed_dict_value_format_specs(fixed_code)
    fixed_code = inject_missing_common_stdlib_imports(fixed_code)
    fixed_code = inject_json_numpy_scalar_encoder_patch(fixed_code)

    if context.get('memory_offload_enabled'):
        ram_offload_dir = context.get('ram_offload_dir') or os.environ.get('AR3_RAM_OFFLOAD_DIR') or '/tmp/ar3-ram-offload'
        max_memory_json = context.get('env', {}).get('AR3_TRANSFORMERS_MAX_MEMORY_JSON', '{"0":"6GiB","cpu":"48GiB"}')
        fixed_code = re_module.sub(r"device_map\s*=\s*(['\"])cuda\1", "device_map='auto'", fixed_code)
        fixed_code = re_module.sub(r"device_map\s*=\s*\{\s*(['\"])\1\s*:\s*(['\"])cuda\2\s*\}", "device_map='auto'", fixed_code)
        memory_offload_wrapper = f'''
import os as _ar3_os
import json as _ar3_json
_ar3_os.environ.setdefault("AR3_ENABLE_RAM_OFFLOAD", "1")
_ar3_os.environ.setdefault("AR3_RAM_OFFLOAD_DIR", {ram_offload_dir!r})
_ar3_os.environ.setdefault("AR3_TRANSFORMERS_MAX_MEMORY_JSON", {max_memory_json!r})
_ar3_os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
_ar3_os.makedirs(_ar3_os.environ["AR3_RAM_OFFLOAD_DIR"], exist_ok=True)
try:
    import transformers as _ar3_transformers
    def _ar3_transformers_max_memory():
        try:
            raw = _ar3_json.loads(_ar3_os.environ.get("AR3_TRANSFORMERS_MAX_MEMORY_JSON", "{{}}"))
        except Exception:
            raw = {{"0": "6GiB", "cpu": "48GiB"}}
        if not isinstance(raw, dict):
            return raw
        normalized = {{}}
        for key, value in raw.items():
            if isinstance(key, str) and key.isdigit():
                normalized[int(key)] = value
            else:
                normalized[key] = value
        return normalized

    def _ar3_patch_loader(_cls):
        _orig = getattr(_cls, "from_pretrained", None)
        if _orig is None or getattr(_orig, "_ar3_ram_offload_patched", False):
            return
        def _from_pretrained_with_ram_offload(*args, **kwargs):
            device_map = kwargs.get("device_map")
            if device_map in (None, "cuda") or device_map == {{"": "cuda"}}:
                kwargs["device_map"] = "auto"
            kwargs.setdefault("low_cpu_mem_usage", True)
            kwargs.setdefault("offload_state_dict", True)
            kwargs.setdefault("offload_folder", _ar3_os.environ["AR3_RAM_OFFLOAD_DIR"])
            if "max_memory" not in kwargs:
                kwargs["max_memory"] = _ar3_transformers_max_memory()
            return _orig(*args, **kwargs)
        _from_pretrained_with_ram_offload._ar3_ram_offload_patched = True
        _cls.from_pretrained = _from_pretrained_with_ram_offload
    for _name in ("AutoModel", "AutoModelForCausalLM", "AutoModelForSeq2SeqLM", "AutoModelForMaskedLM"):
        _cls = getattr(_ar3_transformers, _name, None)
        if _cls is not None:
            _ar3_patch_loader(_cls)
except Exception as _ar3_offload_patch_error:
    print("ar3_ram_offload_patch_warning=" + repr(_ar3_offload_patch_error))
'''
        fixed_code = memory_offload_wrapper + fixed_code

    # ── Patch: Handle LLaDA transformers 5.x compatibility ────────────────────
    # LLaDA's custom model code (modeling_llada.py) is missing `all_tied_weights_keys`
    # which breaks from_pretrained in transformers 5.5+. Patch torch.nn.Module to
    # return {} (empty dict) when that attribute is missing, instead of AttributeError.
    # This allows model loading to complete, then we clean up after.
    patch_wrapper = '''
try:
    import torch
    import torch.nn as nn
    import re
    import builtins as _builtins
    _orig_getattr = torch.nn.Module.__getattr__
    def _patched_getattr(self, name, *args, **kwargs):
        if name == 'all_tied_weights_keys':
            return {}
        return _orig_getattr(self, name, *args, **kwargs)
    torch.nn.Module.__getattr__ = _patched_getattr
except ModuleNotFoundError:
    torch = None
'''
    needs_llada_patch = any(token in fixed_code for token in ('import torch', 'from torch', 'transformers', 'from_pretrained', 'LLaDA', 'llada'))
    if needs_llada_patch:
        fixed_code = patch_wrapper + fixed_code
    if fixed_code != code:
        log(f"Format-string coercion applied",
            thread_id=threading.current_thread().name)

    code_file = str(Path(context.get('scratch_dir') or context['workbench_dir']) / f"gpu_code_{int(time.time()*1000)}.py")
    with open(code_file, 'w') as f:
        f.write(fixed_code)

    try:
        result = subprocess.run(
            ['python3', code_file],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=context['workbench_dir'],
            env=context['env'],
        )
        try:
            os.unlink(code_file)
        except Exception:
            pass

        if result.returncode == 0:
            output = result.stdout.strip()
            if torch_prep_output:
                output = (torch_prep_output + '\n' + output).strip()
            return {
                'success': True,
                'output': output,
                'error': None,
            }
        else:
            # Check for SyntaxError or IndentationError — try auto-fix once
            stderr = result.stderr.strip()
            if 'SyntaxError' in stderr or 'IndentationError' in stderr:
                log(f"Syntax/IndentationError detected, attempting auto-fix",
                    thread_id=threading.current_thread().name)
                fixed_once = auto_fix_code(fixed_code)
                if fixed_once != fixed_code:
                    log(f"Auto-fix applied (patch already in fixed_code), retrying execution",
                        thread_id=threading.current_thread().name)
                    with open(code_file, 'w') as f:
                        # NOTE: fixed_code already has patch_wrapper prepended.
                        # auto_fix_code was called on it, so fixed_once has both.
                        # Write fixed_once directly — no need to re-add wrapper.
                        f.write(fixed_once)
                    result = subprocess.run(
                        ['python3', code_file],
                        capture_output=True,
                        text=True,
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
                            'error': 'Auto-fix failed:\n' + stderr + '\n\nAfter auto-fix:\n' + result.stderr.strip(),
                        }
                return {
                    'success': False,
                    'output': result.stdout.strip(),
                    'error': 'SyntaxError/IndentationError — auto-fix could not resolve:\n' + stderr,
                }
            # Check for missing package — auto-install and retry once
            if result.returncode != 0:
                stderr = result.stderr.strip()
                # Detect missing module: "ModuleNotFoundError: No module named 'foo'"
                missing = re_module.search(r"No module named '(\w+)'", stderr)
                if missing:
                    pkg = missing.group(1)
                    repair = missing_module_install_command(pkg, context)
                    if not repair.get('success'):
                        log(f"Missing module '{pkg}' was not auto-installable: {repair.get('error')}",
                            thread_id=threading.current_thread().name)
                        return {
                            'success': False,
                            'output': result.stdout.strip(),
                            'error': f"Missing module '{pkg}' could not be auto-installed: {repair.get('error')}",
                        }
                    log(f"Missing module '{pkg}' detected, attempting pip install: " + ' '.join(shlex.quote(d) for d in repair['deps']),
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
            result = execute_quantized_code(code, timeout=timeout, context=context_info)

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
        if preparation_manifest:
            # Keep the manifest attached through evidence validation so the worker
            # can enforce the dynamically discovered grading/success criteria,
            # not just the static CUDA/prose contract.
            result['preparationManifest'] = preparation_manifest
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
        'expected evidence fields', 'success criteria thresholds', 'grading criteria',
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

    completed_at = datetime.now().isoformat()
    stored_result = {
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
        'completedAt': completed_at,
    }
    terminal_status = classify_terminal_job_status(result)

    with queue_lock:
        results = read_results()
        results[job_id] = stored_result
        write_results(results)

        queue = read_queue()
        for j in queue:
            if j['jobId'] == job_id:
                j['status'] = terminal_status
                j['completedAt'] = completed_at
                break
        write_queue(queue)

    update_prisma_gpu_job_status(
        job_id,
        terminal_status,
        stored_result,
        'GPU worker completed job' if terminal_status == 'completed' else f'GPU worker finished job with {terminal_status}',
    )

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
