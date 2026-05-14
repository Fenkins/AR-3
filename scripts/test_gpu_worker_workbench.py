#!/usr/bin/env python3
import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = REPO_ROOT / "scripts" / "gpu_worker.py"

spec = importlib.util.spec_from_file_location("gpu_worker", WORKER_PATH)
assert spec is not None and spec.loader is not None
gpu_worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu_worker)


def test_prepare_workbench_is_stable_per_space_and_sets_cache_env():
    root = tempfile.mkdtemp(prefix="ar3-worker-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        job = {"jobId": "gpu_space-123_1", "spaceId": "space 123", "spaceName": "My Space"}
        ctx1 = gpu_worker.prepare_workbench(job)
        ctx2 = gpu_worker.prepare_workbench({**job, "jobId": "gpu_space-123_2"})

        assert ctx1["workbench_dir"] == ctx2["workbench_dir"]
        assert Path(ctx1["workbench_dir"]).is_dir()
        assert ctx1["env"]["AR3_WORKBENCH_DIR"] == ctx1["workbench_dir"]
        assert ctx1["env"]["HF_HOME"].startswith(ctx1["workbench_dir"])
        assert ctx1["env"]["TRANSFORMERS_CACHE"].startswith(ctx1["workbench_dir"])
        assert "python-packages" in ctx1["env"].get("PYTHONPATH", "")
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_strategy4_line_assembly_does_not_crash_on_markdown_headers():
    prompt = """
### Candidate implementation
    import json
    import os
    value = {"cwd": os.getcwd()}
    print(json.dumps(value))
"""
    command = gpu_worker.extract_gpu_command(prompt)
    assert command["action"] == "run_python"
    assert "import json" in command["code"]
    assert "Candidate implementation" not in command["code"]


def test_extract_preparation_manifest_from_context_and_prompt():
    manifest = {
        "schemaVersion": "ar3.preparation-manifest.v1",
        "dependencies": [{"name": "numpy", "required": True}],
        "smokeTests": [{"name": "manifest-smoke", "command": "python -c 'print(123)'", "timeoutSeconds": 5}],
        "workbench": {"reuseKey": "bench-a"},
    }
    job = {
        "context": '{"preparationManifest": ' + __import__("json").dumps(manifest) + '}',
        "prompt": "prose [PREPARATION_MANIFEST_VALIDATED]: {}",
    }
    extracted = gpu_worker.extract_preparation_manifest(job)
    assert extracted["workbench"]["reuseKey"] == "bench-a"
    assert extracted["dependencies"][0]["name"] == "numpy"


def test_run_manifest_smoke_tests_executes_in_workbench_and_records_manifest_file():
    root = tempfile.mkdtemp(prefix="ar3-worker-manifest-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        job = {"jobId": "gpu_space-manifest_1", "spaceId": "space manifest"}
        context = gpu_worker.prepare_workbench(job)
        manifest = {
            "dependencies": [],
            "smokeTests": [
                {
                    "name": "writes-artifact",
                    "command": "python -c \"from pathlib import Path; import os; Path(os.environ['AR3_ARTIFACTS_DIR'], 'smoke.txt').write_text('ok'); print('SMOKE_OK')\"",
                    "expectedEvidence": ["SMOKE_OK"],
                    "timeoutSeconds": 10,
                }
            ],
        }
        result = gpu_worker.prepare_manifest_environment(manifest, context)
        assert result["success"] is True, result
        assert "SMOKE_OK" in result["output"]
        assert Path(context["workbench_dir"], "preparation_manifest.json").is_file()
        assert Path(context["artifacts_dir"], "smoke.txt").read_text() == "ok"
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_safe_smoke_command_uses_current_python_interpreter():
    argv, err = gpu_worker._safe_smoke_command("python -c 'print(1)'")
    assert err is None
    assert argv[0] == sys.executable


def test_safe_smoke_command_converts_python_heredoc_to_inline_code():
    command = """python - <<PY
import json
print(json.dumps({"ok": True}))
PY"""
    argv, err = gpu_worker._safe_smoke_command(command)
    assert err is None
    assert argv == [sys.executable, "-c", 'import json\nprint(json.dumps({"ok": True}))']


def test_required_model_without_smoke_test_does_not_block_research_execution():
    root = tempfile.mkdtemp(prefix="ar3-worker-empty-model-smoke-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_resolve = gpu_worker.resolve_manifest_models
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        gpu_worker.resolve_manifest_models = lambda manifest, context, timeout=900: {
            "success": True,
            "output": "model_resolve example/tiny-model exit=0\nresolved from cache",
            "error": None,
        }
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-empty-smoke_1", "spaceId": "space empty smoke"})
        manifest = {
            "models": [{"id": "example/tiny-model", "source": "huggingface", "required": True}],
            "dependencies": [],
            "smokeTests": [],
        }
        result = gpu_worker.prepare_manifest_environment(manifest, context)
        assert result["success"] is True, result
        assert "model_smoke example/tiny-model skipped" in result["output"]
    finally:
        gpu_worker.resolve_manifest_models = old_resolve
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_huggingface_models_are_resolved_into_workbench_before_smoke_tests():
    root = tempfile.mkdtemp(prefix="ar3-worker-model-resolve-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_run = gpu_worker.subprocess.run
    os.environ["AR3_WORKBENCH_ROOT"] = root
    calls = []

    class FakeCompleted:
        returncode = 0
        stdout = '{"repo_id":"example/tiny-model","local_dir":"/tmp/fake-model","downloaded_files":["config.json"],"ok":true}'
        stderr = ""

    def fake_run(cmd, *args, **kwargs):
        if isinstance(cmd, list) and len(cmd) >= 3 and cmd[1] == "-c" and "AR3_MODEL_ID" in cmd[2]:
            calls.append((cmd, kwargs))
            return FakeCompleted()
        return old_run(cmd, *args, **kwargs)

    gpu_worker.subprocess.run = fake_run
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-model_1", "spaceId": "space model"})
        manifest = {
            "models": [
                {
                    "id": "example/tiny-model",
                    "source": "huggingface",
                    "required": True,
                    "files": ["config.json"],
                    "smokeTest": "python -c \"from pathlib import Path; import os; Path(os.environ['AR3_ARTIFACTS_DIR'], 'model-smoke.txt').write_text('model ok'); print('MODEL_SMOKE_OK')\"",
                }
            ],
            "dependencies": [],
            "smokeTests": [],
        }
        result = gpu_worker.prepare_manifest_environment(manifest, context)
        assert result["success"] is True, result
        assert calls, "expected HuggingFace resolver subprocess before smoke test"
        assert calls[0][1]["env"]["AR3_MODEL_ID"] == "example/tiny-model"
        assert calls[0][1]["env"]["AR3_MODEL_ALLOW_PATTERNS"] == '["config.json"]'
        assert "model_resolve example/tiny-model exit=0" in result["output"]
        assert "model_smoke example/tiny-model exit=0" in result["output"]
        assert "MODEL_SMOKE_OK" in result["output"]
        assert Path(context["artifacts_dir"], "model-smoke.txt").read_text() == "model ok"
    finally:
        gpu_worker.subprocess.run = old_run
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_fstring_item_coercion_does_not_cross_other_braces():
    root = tempfile.mkdtemp(prefix="ar3-worker-fstring-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-fstring_1", "spaceId": "space fstring"})
        code = """
class Value:
    def item(self):
        return 1.23456
sharp = 'low'
gpu_name = 'unit-test-gpu-contract'
dynamic_merged = Value()
print(f'Sharpness {sharp}: merged norm = {dynamic_merged.item():.4f}; gpu_name={gpu_name}')
"""
        result = gpu_worker.execute_python_code(code, context=context, dependencies=[])
        assert result["success"] is True, result
        assert "Sharpness low: merged norm = 1.2346" in result["output"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_execute_python_code_injects_missing_common_stdlib_imports():
    root = tempfile.mkdtemp(prefix="ar3-worker-stdlib-import-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-stdlib_1", "spaceId": "space stdlib"})
        code = """
cuda_available = False
result = {"status": "ok", "cuda_available": cuda_available, "cwd_name": pathlib.Path(os.getcwd()).name}
print(json.dumps(result, sort_keys=True))
"""
        result = gpu_worker.execute_python_code(code, context=context, dependencies=[])
        assert result["success"] is True, result
        assert '"status": "ok"' in result["output"]
        assert '"cwd_name":' in result["output"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_repair_torch_workbench_removes_poisoned_cuda_packages_and_reinstalls_cu124():
    root = tempfile.mkdtemp(prefix="ar3-worker-torch-repair-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_run = gpu_worker.subprocess.run
    os.environ["AR3_WORKBENCH_ROOT"] = root
    calls = []

    class FakeCompleted:
        def __init__(self, returncode=0, stdout="", stderr=""):
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr

    def fake_run(cmd, *args, **kwargs):
        calls.append((cmd, kwargs))
        if cmd[:3] == [sys.executable, "-c", gpu_worker.TORCH_CUDA_SMOKE_CODE]:
            assert "/usr/local/cuda/lib64" not in kwargs["env"].get("LD_LIBRARY_PATH", "")
            if len([c for c, _ in calls if c[:3] == [sys.executable, "-c", gpu_worker.TORCH_CUDA_SMOKE_CODE]]) == 1:
                return FakeCompleted(1, "", "ImportError: undefined symbol: __nvJitLinkComplete_12_4")
            return FakeCompleted(0, '{"torch_cuda_available": true, "cuda_device": "unit-test-gpu"}', "")
        if cmd[:3] == [sys.executable, "-m", "pip"]:
            return FakeCompleted(0, "installed cu124", "")
        return old_run(cmd, *args, **kwargs)

    gpu_worker.subprocess.run = fake_run
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-torch_1", "spaceId": "space torch"})
        packages = Path(context["packages_dir"])
        for name in ["torch", "nvidia", "triton", "torch-2.6.0.dist-info"]:
            (packages / name).mkdir(parents=True)
        result = gpu_worker.ensure_torch_cuda_workbench(context, force=True)
        assert result["success"] is True, result
        assert result["repaired"] is True
        assert "__nvJitLinkComplete_12_4" in result["output"]
        assert not (packages / "torch").exists()
        assert not (packages / "nvidia").exists()
        pip_calls = [cmd for cmd, _ in calls if cmd[:3] == [sys.executable, "-m", "pip"]]
        assert pip_calls, "expected repair to reinstall torch CUDA wheels"
        assert "--index-url" in pip_calls[0]
        assert "https://download.pytorch.org/whl/cu124" in pip_calls[0]
        assert "torch==2.5.1" in pip_calls[0]
    finally:
        gpu_worker.subprocess.run = old_run
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_validation_rejects_pretty_printed_contract_failure_after_gpu_smoke_json():
    output = """
torch_cuda_smoke initial exit=0
{"cuda_device": "NVIDIA GeForce RTX 3060", "torch_cuda_available": true}
{
  "contract_failure_reason": "response did not parse as the required JSON object",
  "gpu": {
    "cuda_available": true,
    "gpu_name": "NVIDIA GeForce RTX 3060"
  }
}
"""
    result = gpu_worker.validate_execution_result_evidence({"success": True, "output": output, "error": None})
    assert result["success"] is False
    assert "contract_failure_reason" in result["error"]


def test_process_job_marks_validation_failures_as_failed_validation():
    root = tempfile.mkdtemp(prefix="ar3-worker-status-test-")
    old_queue = gpu_worker.JOB_QUEUE_FILE
    old_results = gpu_worker.JOB_RESULTS_FILE
    old_execute = gpu_worker.execute_gpu_command
    try:
        queue_path = Path(root, "jobs.json")
        results_path = Path(root, "results.json")
        gpu_worker.JOB_QUEUE_FILE = str(queue_path)
        gpu_worker.JOB_RESULTS_FILE = str(results_path)
        queue_path.write_text(__import__("json").dumps([{"jobId": "job-validation", "status": "validating_evidence"}]))

        def fake_execute(job, timeout):
            return {
                "success": False,
                "output": "{}",
                "error": "Experiment output self-reported contract_failure_reason: bad contract",
            }

        gpu_worker.execute_gpu_command = fake_execute
        result = gpu_worker.process_job({"jobId": "job-validation"}, timeout=1)
        assert result["success"] is False
        queue = __import__("json").loads(queue_path.read_text())
        assert queue[0]["status"] == "failed_validation"
        stored = __import__("json").loads(results_path.read_text())["job-validation"]
        assert stored["success"] is False
    finally:
        gpu_worker.execute_gpu_command = old_execute
        gpu_worker.JOB_QUEUE_FILE = old_queue
        gpu_worker.JOB_RESULTS_FILE = old_results
        shutil.rmtree(root, ignore_errors=True)


def test_get_pending_jobs_reclaims_stale_inflight_jobs_without_results():
    root = tempfile.mkdtemp(prefix="ar3-worker-stale-claim-test-")
    old_queue = gpu_worker.JOB_QUEUE_FILE
    old_results = gpu_worker.JOB_RESULTS_FILE
    old_config = gpu_worker.GPU_CONFIG_FILE
    try:
        queue_path = Path(root, "jobs.json")
        results_path = Path(root, "results.json")
        config_path = Path(root, "config.json")
        gpu_worker.JOB_QUEUE_FILE = str(queue_path)
        gpu_worker.JOB_RESULTS_FILE = str(results_path)
        gpu_worker.GPU_CONFIG_FILE = str(config_path)
        config_path.write_text('{"maxConcurrent": 2, "jobTimeout": 3600}')
        results_path.write_text('{}')
        queue_path.write_text(__import__("json").dumps([
            {"jobId": "stale-install", "status": "installing_dependencies", "updatedAt": "2000-01-01T00:00:00"},
            {"jobId": "fresh-pending", "status": "pending"},
            {"jobId": "terminal-fail", "status": "failed_runtime", "updatedAt": "2000-01-01T00:00:00"},
        ]))

        claimed = gpu_worker.get_pending_jobs()
        claimed_ids = {job["jobId"] for job in claimed}
        assert claimed_ids == {"stale-install", "fresh-pending"}
        queue = __import__("json").loads(queue_path.read_text())
        statuses = {job["jobId"]: job["status"] for job in queue}
        assert statuses["stale-install"] == "claimed"
        assert statuses["fresh-pending"] == "claimed"
        assert statuses["terminal-fail"] == "failed_runtime"
    finally:
        gpu_worker.JOB_QUEUE_FILE = old_queue
        gpu_worker.JOB_RESULTS_FILE = old_results
        gpu_worker.GPU_CONFIG_FILE = old_config
        shutil.rmtree(root, ignore_errors=True)


def test_execute_python_code_rejects_placeholders_before_running():
    root = tempfile.mkdtemp(prefix="ar3-worker-placeholder-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-placeholder_1", "spaceId": "space placeholder"})
        marker = Path(context["artifacts_dir"], "should-not-exist.txt")
        code = """
from pathlib import Path
import os
# TODO: replace this placeholder with the actual GPU experiment
Path(os.environ['AR3_ARTIFACTS_DIR'], 'should-not-exist.txt').write_text('bad')
print('accuracy=1.0')
"""
        result = gpu_worker.execute_python_code(code, context=context, dependencies=[])
        assert result["success"] is False, result
        assert "placeholder" in result["error"].lower()
        assert not marker.exists()
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    test_prepare_workbench_is_stable_per_space_and_sets_cache_env()
    test_strategy4_line_assembly_does_not_crash_on_markdown_headers()
    test_extract_preparation_manifest_from_context_and_prompt()
    test_run_manifest_smoke_tests_executes_in_workbench_and_records_manifest_file()
    test_safe_smoke_command_uses_current_python_interpreter()
    test_huggingface_models_are_resolved_into_workbench_before_smoke_tests()
    test_fstring_item_coercion_does_not_cross_other_braces()
    test_execute_python_code_injects_missing_common_stdlib_imports()
    test_repair_torch_workbench_removes_poisoned_cuda_packages_and_reinstalls_cu124()
    test_validation_rejects_pretty_printed_contract_failure_after_gpu_smoke_json()
    test_process_job_marks_validation_failures_as_failed_validation()
    test_get_pending_jobs_reclaims_stale_inflight_jobs_without_results()
    test_execute_python_code_rejects_placeholders_before_running()
    print("gpu worker workbench tests passed")
