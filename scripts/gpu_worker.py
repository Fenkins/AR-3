Total output lines: 2170

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
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
JOB_RESULTS_FILE = '/tmp/gpu_results.json'
GPU_CONFIG_FILE = '/tmp/gpu_config.json'
GPU_INFO_FILE = '/tmp/gpu_info.json'
POLL_INTERVAL = 3  # seconds
DEFAULT_MAX_CONCURRENT = 1
DEFAULT_JOB_TIMEOUT = 3600  # 1 hour default
DEFAULT_WORKBENCH_ROOT = '/tmp/ar3-workbenches'
DEFAULT_MODEL_CACHE_ROOT = '/opt/AR-3/model_cache'
DEFAULT_DISK_WARN_FREE_BYTES = 8 * 1024**3
DEFAULT_DISK_FAIL_FREE_BYTES = 2 * 1024**3

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
        normalized = torch_pins.get(dep_name, dep)
        if dep_name in torch_pins:
            needs_pytorch_cu124 = True
        if normalized not in seen:
            deps.append(normalized)
            seen.add(normalized)

    pip_args = []
    if needs_pytorch_cu124:
        pip_args.extend(['--index-url', 'https://download.pytorch.org/whl/cu124', '--extra-index-url', 'https://pypi.org/simple'])
    return {'success': True, 'deps': deps, 'pip_args': pip_args, 'error': None}


MISSING_MODULE_PACKAGE_ALIASES = PYTHON_IMPORT_PACKAGE_ALIASES


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
        '--upgrade', *normalized['pip_args'], '--target', context['packages_dir'], *deps,
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


def _without_cuda_toolkit_ld_path(env: dict) -> dict:
    """Return env with CUDA toolkit libs removed so PyTorch wheel nvidia libs win."""
    cleaned = dict(env)
    parts = [p for p in cleaned.get('LD_LIBRARY_PATH', '').split(os.pathsep) if p and p != '/usr/local/cuda/lib64']
    cleaned['LD_LIBRARY_PATH'] = os.pathsep.join(parts)
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
    torch_env = _without_cuda_toolkit_ld_path(context['env'])
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

…13428 tokens truncated…t).strip()
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
        disk_pressure = collect_workbench_disk_pressure(context_info)
        if disk_pressure.get('warning'):
            log(disk_pressure['warning'], thread_id=tid)
        preparation_manifest = extract_preparation_manifest(job)
        result_metadata = {
            'workbenchDir': context_info['workbench_dir'],
            'artifactsDir': context_info['artifacts_dir'],
            'dependencies': gpu_command.get('dependencies', []),
            'preparationManifestApplied': bool(preparation_manifest),
            'diskPressure': disk_pressure,
        }
        disk_pressure_output = 'disk_pressure=' + json.dumps(disk_pressure, sort_keys=True)
        if not disk_pressure.get('ok', True):
            return {
                'success': False,
                'output': disk_pressure_output,
                'error': 'Insufficient free disk space for GPU job preparation',
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
        result['output'] = (disk_pressure_output + '\n' + result.get('output', '')).strip()
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
