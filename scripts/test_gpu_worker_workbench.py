#!/usr/bin/env python3
import importlib.util
import json
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
        assert ctx1["env"]["TMPDIR"].startswith(ctx1["workbench_dir"])
        assert ctx1["env"]["TMP"] == ctx1["env"]["TMPDIR"]
        assert ctx1["env"]["TEMP"] == ctx1["env"]["TMPDIR"]
        assert ctx1["env"]["AR3_SCRATCH_DIR"] == ctx1["scratch_dir"]
        assert ctx1["env"]["AR3_MODEL_SCRATCH_DIR"] == ctx1["model_scratch_dir"]
        assert Path(ctx1["scratch_dir"]).is_dir()
        assert Path(ctx1["model_scratch_dir"]).is_dir()
        assert "python-packages" in ctx1["env"].get("PYTHONPATH", "")
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_prepare_workbench_enables_ram_offload_from_job_context():
    root = tempfile.mkdtemp(prefix="ar3-worker-offload-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({
            "jobId": "gpu_space-offload_1",
            "spaceId": "space offload",
            "context": '{"memoryOffload":{"enabled":true,"mode":"system_ram_transformers_offload"}}',
        })

        assert context["memory_offload_enabled"] is True
        assert Path(context["ram_offload_dir"]).is_dir()
        assert context["env"]["AR3_ENABLE_RAM_OFFLOAD"] == "1"
        assert context["env"]["AR3_RAM_OFFLOAD_DIR"] == context["ram_offload_dir"]
        assert "expandable_segments" in context["env"]["PYTORCH_CUDA_ALLOC_CONF"]
        assert '"cpu": "48GiB"' in context["env"]["AR3_TRANSFORMERS_MAX_MEMORY_JSON"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_ram_offload_wrapper_normalizes_transformers_max_memory_device_keys():
    root = tempfile.mkdtemp(prefix="ar3-worker-offload-wrapper-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({
            "jobId": "gpu_space-offload-wrapper_1",
            "spaceId": "space offload wrapper",
            "context": '{"memoryOffload":{"enabled":true,"mode":"system_ram_transformers_offload"}}',
        })
        fake_pkg = Path(context["packages_dir"], "transformers")
        fake_pkg.mkdir(parents=True)
        fake_pkg.joinpath("__init__.py").write_text(
            "class AutoModelForCausalLM:\n"
            "    @classmethod\n"
            "    def from_pretrained(cls, *args, **kwargs):\n"
            "        return kwargs\n"
        )

        result = gpu_worker.execute_python_code(
            "import json\n"
            "from transformers import AutoModelForCausalLM\n"
            "kwargs = AutoModelForCausalLM.from_pretrained('fake/model')\n"
            "print(json.dumps({\n"
            "  'cuda_available': True,\n"
            "  'gpu_name': 'fake GPU',\n"
            "  'device_map': kwargs.get('device_map'),\n"
            "  'max_memory_key_types': [type(k).__name__ for k in kwargs.get('max_memory', {}).keys()],\n"
            "  'max_memory_keys': [str(k) for k in kwargs.get('max_memory', {}).keys()],\n"
            "}))\n",
            timeout=10,
            context=context,
            dependencies=[],
            job_id="gpu_space-offload-wrapper_1",
        )

        assert result["success"] is True, result
        payload = json.loads(result["output"])
        assert payload["device_map"] == "auto"
        assert payload["max_memory_key_types"][0] == "int"
        assert payload["max_memory_keys"] == ["0", "cpu"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_experiment_code_rejects_unmanaged_tmp_model_paths():
    code = (
        "import json\n"
        "import torch\n"
        "model_dir = '/tmp/multi_instance_models/instance_0'\n"
        "print(json.dumps({'cuda_available': torch.cuda.is_available(), 'gpu_name': 'test'}))\n"
    )

    result = gpu_worker.validate_executable_experiment_code(code)

    assert result["ok"] is False
    assert "unmanaged absolute /tmp path" in result["error"]
    assert "/tmp/multi_instance_models/instance_0" in result["error"]


def test_experiment_code_allows_managed_workbench_tmp_paths():
    code = (
        "import json\n"
        "import torch\n"
        "artifact = '/tmp/ar3-workbenches/space/artifacts/metrics.json'\n"
        "print(json.dumps({'cuda_available': torch.cuda.is_available(), 'gpu_name': 'test', 'artifact': artifact}))\n"
    )

    result = gpu_worker.validate_executable_experiment_code(code)

    assert result["ok"] is True, result


def test_install_declared_dependencies_reuses_verified_workbench_record():
    root = tempfile.mkdtemp(prefix="ar3-worker-dep-cache-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-cache_1", "spaceId": "space cache"})
        dependency = {"name": "fake-ar3-package", "importName": "ar3_fake_cached_dependency"}
        Path(context["packages_dir"], "ar3_fake_cached_dependency.py").write_text("VALUE = 1\n")
        Path(context["workbench_dir"], "installed_dependencies.json").write_text(json.dumps({
            "success": False,
            "declared": [dependency],
            "normalized": ["fake-ar3-package"],
            "pipArgs": [],
            "error": "previous reinstall timed out after this dependency was already importable",
        }))

        result = gpu_worker.install_declared_dependencies([dependency], context, job_id="gpu_space-cache_1")

        assert result["success"] is True
        assert "cached_dependencies=" in result["output"]
        assert "verified_imports=ar3_fake_cached_dependency" in result["output"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_install_declared_dependencies_skips_reinstall_when_imports_already_available_after_dependency_set_changes():
    root = tempfile.mkdtemp(prefix="ar3-worker-dep-superset-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-superset_1", "spaceId": "space superset"})
        Path(context["packages_dir"], "ar3_fake_cached_dependency.py").write_text("VALUE = 1\n")
        Path(context["packages_dir"], "ar3_fake_new_dependency.py").write_text("VALUE = 2\n")
        Path(context["workbench_dir"], "installed_dependencies.json").write_text(json.dumps({
            "success": True,
            "declared": [{"name": "fake-ar3-package", "importName": "ar3_fake_cached_dependency"}],
            "normalized": ["fake-ar3-package"],
            "pipArgs": [],
            "error": None,
        }))

        result = gpu_worker.install_declared_dependencies([
            {"name": "fake-ar3-package", "importName": "ar3_fake_cached_dependency"},
            {"name": "fake-ar3-new-package", "importName": "ar3_fake_new_dependency"},
        ], context, job_id="gpu_space-superset_1")

        assert result["success"] is True
        assert "cached_dependencies=" in result["output"]
        assert "ar3_fake_cached_dependency" in result["output"]
        assert "ar3_fake_new_dependency" in result["output"]
        updated = json.loads(Path(context["workbench_dir"], "installed_dependencies.json").read_text())
        assert updated["normalized"] == ["fake-ar3-package", "fake-ar3-new-package"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_install_declared_dependencies_does_not_reconcile_changed_version_spec_from_import_only():
    root = tempfile.mkdtemp(prefix="ar3-worker-dep-version-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-version_1", "spaceId": "space version"})
        Path(context["packages_dir"], "ar3_fake_versioned_dependency.py").write_text("VALUE = 1\n")
        Path(context["workbench_dir"], "installed_dependencies.json").write_text(json.dumps({
            "success": True,
            "declared": [{"name": "fake-ar3-versioned-package", "importName": "ar3_fake_versioned_dependency"}],
            "normalized": ["fake-ar3-versioned-package"],
            "pipArgs": [],
            "error": None,
        }))

        result = gpu_worker.install_declared_dependencies([
            {"name": "fake-ar3-versioned-package==9.9.9", "importName": "ar3_fake_versioned_dependency"},
        ], context, timeout=2, job_id="gpu_space-version_1")

        assert result["success"] is False
        assert "No matching distribution" in result.get("error", "") or "Could not find" in result.get("error", "")
        updated = json.loads(Path(context["workbench_dir"], "installed_dependencies.json").read_text())
        assert updated["success"] is False
        assert updated["normalized"] == ["fake-ar3-versioned-package==9.9.9"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_disk_pressure_snapshot_includes_workbench_root_and_model_cache_sizes():
    root = tempfile.mkdtemp(prefix="ar3-worker-disk-pressure-test-")
    model_cache = tempfile.mkdtemp(prefix="ar3-model-cache-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_model_cache = os.environ.get("AR3_MODEL_CACHE_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    os.environ["AR3_MODEL_CACHE_ROOT"] = model_cache
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-disk_1", "spaceId": "space disk"})
        Path(context["workbench_dir"], "artifact.bin").write_bytes(b"x" * 11)
        other_workbench = Path(root, "other-space")
        other_workbench.mkdir()
        Path(other_workbench, "larger-artifact.bin").write_bytes(b"z" * 29)
        Path(model_cache, "model.bin").write_bytes(b"y" * 13)

        snapshot = gpu_worker.collect_workbench_disk_pressure(context)

        assert snapshot["ok"] is True
        assert snapshot["workbenchRoot"] == root
        assert snapshot["modelCacheRoot"] == model_cache
        assert snapshot["workbenchBytes"] >= 11
        assert snapshot["workbenchRootBytes"] >= snapshot["workbenchBytes"]
        assert snapshot["largestWorkbenchDirs"][0]["path"] == str(other_workbench)
        assert snapshot["largestWorkbenchDirs"][0]["bytes"] == 29
        assert "modifiedAt" in snapshot["largestWorkbenchDirs"][0]
        assert snapshot["modelCacheBytes"] == 13
        assert isinstance(snapshot["freeBytes"], int)
        assert isinstance(snapshot["usedPercent"], float)
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        if old_model_cache is None:
            os.environ.pop("AR3_MODEL_CACHE_ROOT", None)
        else:
            os.environ["AR3_MODEL_CACHE_ROOT"] = old_model_cache
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(model_cache, ignore_errors=True)


def test_prune_stale_workbenches_removes_old_siblings_and_preserves_current():
    root = tempfile.mkdtemp(prefix="ar3-worker-prune-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_max = os.environ.get("AR3_WORKBENCH_PRUNE_MAX_BYTES")
    old_age = os.environ.get("AR3_WORKBENCH_PRUNE_MIN_AGE_SECONDS")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    os.environ["AR3_WORKBENCH_PRUNE_MAX_BYTES"] = "20"
    os.environ["AR3_WORKBENCH_PRUNE_MIN_AGE_SECONDS"] = "0"
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-prune_1", "spaceId": "space prune"})
        current = Path(context["workbench_dir"])
        Path(current, "current.bin").write_bytes(b"x" * 11)
        stale = Path(root, "old-space")
        stale.mkdir()
        Path(stale, "old.bin").write_bytes(b"z" * 29)

        result = gpu_worker.prune_stale_workbenches(context)

        assert result["enabled"] is True
        assert result["deleted"][0]["path"] == str(stale)
        assert current.is_dir()
        assert not stale.exists()
        assert result["rootBytesAfter"] >= 11
        assert result["rootBytesAfter"] < result["rootBytesBefore"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        if old_max is None:
            os.environ.pop("AR3_WORKBENCH_PRUNE_MAX_BYTES", None)
        else:
            os.environ["AR3_WORKBENCH_PRUNE_MAX_BYTES"] = old_max
        if old_age is None:
            os.environ.pop("AR3_WORKBENCH_PRUNE_MIN_AGE_SECONDS", None)
        else:
            os.environ["AR3_WORKBENCH_PRUNE_MIN_AGE_SECONDS"] = old_age
        shutil.rmtree(root, ignore_errors=True)


def test_prune_stale_workbenches_reports_within_limits_without_deleting():
    root = tempfile.mkdtemp(prefix="ar3-worker-prune-noop-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_max = os.environ.get("AR3_WORKBENCH_PRUNE_MAX_BYTES")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    os.environ["AR3_WORKBENCH_PRUNE_MAX_BYTES"] = str(1024 * 1024)
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-prune-noop_1", "spaceId": "space prune noop"})
        sibling = Path(root, "kept-space")
        sibling.mkdir()
        Path(sibling, "kept.bin").write_bytes(b"z" * 29)

        result = gpu_worker.prune_stale_workbenches(context)

        assert result["reason"] == "within_limits"
        assert result["deleted"] == []
        assert sibling.is_dir()
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        if old_max is None:
            os.environ.pop("AR3_WORKBENCH_PRUNE_MAX_BYTES", None)
        else:
            os.environ["AR3_WORKBENCH_PRUNE_MAX_BYTES"] = old_max
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
        history_path = Path(context["workbench_dir"], "preparation_run_history.json")
        assert history_path.is_file()
        history = __import__("json").loads(history_path.read_text())
        assert len(history) == 1
        assert history[0]["success"] is True
        assert "SMOKE_OK" in history[0]["outputTail"]
        assert f"preparation_run_history={history_path}" in result["output"]
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


def test_manifest_preparation_history_records_validation_failures():
    root = tempfile.mkdtemp(prefix="ar3-worker-manifest-history-fail-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-manifest-fail_1", "spaceId": "space manifest fail"})
        manifest = {
            "dependencies": [],
            "smokeTests": [
                {
                    "name": "missing-evidence",
                    "command": "python -c 'print(\"ONLY_THIS\")'",
                    "expectedEvidence": ["MISSING_EVIDENCE"],
                    "timeoutSeconds": 10,
                }
            ],
        }
        result = gpu_worker.prepare_manifest_environment(manifest, context)
        assert result["success"] is False, result
        assert "missing expected evidence" in result["error"]
        history_path = Path(context["workbench_dir"], "preparation_run_history.json")
        history = __import__("json").loads(history_path.read_text())
        assert len(history) == 1
        assert history[0]["success"] is False
        assert "MISSING_EVIDENCE" in history[0]["error"]
        assert "ONLY_THIS" in history[0]["outputTail"]
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


def test_safe_smoke_command_accepts_env_wrapped_python():
    argv, err = gpu_worker._safe_smoke_command(
        "env CUDA_VISIBLE_DEVICES=0 python -c 'print(1)'"
    )
    assert err is None
    assert argv[:3] == ["env", "CUDA_VISIBLE_DEVICES=0", sys.executable]
    assert argv[3:] == ["-c", "print(1)"]


def test_safe_smoke_command_accepts_timeout_wrapped_python():
    argv, err = gpu_worker._safe_smoke_command(
        "timeout 30s python -c 'print(1)'"
    )
    assert err is None
    assert argv[:3] == ["timeout", "30s", sys.executable]
    assert argv[3:] == ["-c", "print(1)"]


def test_safe_smoke_command_rejects_destructive_shell_even_without_typescript_validation():
    argv, err = gpu_worker._safe_smoke_command(
        "bash -lc 'rm -rf /tmp/ar3-workbenches && python smoke_test.py'"
    )
    assert argv is None
    assert "destructive" in err


def test_manifest_torch_dependencies_are_smoked_and_repaired_before_manifest_smoke_tests():
    root = tempfile.mkdtemp(prefix="ar3-worker-manifest-torch-repair-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_install = gpu_worker.install_declared_dependencies
    old_resolve = gpu_worker.resolve_manifest_models
    old_ensure = gpu_worker.ensure_torch_cuda_workbench
    old_run = gpu_worker.subprocess.run
    os.environ["AR3_WORKBENCH_ROOT"] = root
    ensured = {"called": False}

    class FakeCompleted:
        returncode = 0
        stdout = "TORCH_SMOKE_OK"
        stderr = ""

    def fake_run(cmd, *args, **kwargs):
        if isinstance(cmd, list) and len(cmd) >= 3 and cmd[1] == "-c" and "import torch" in cmd[2]:
            assert ensured["called"], "manifest smoke test ran before torch CUDA repair/smoke"
            return FakeCompleted()
        return old_run(cmd, *args, **kwargs)

    try:
        gpu_worker.install_declared_dependencies = lambda deps, context, timeout=900, job_id='': {"success": True, "output": "installed", "error": None}
        gpu_worker.resolve_manifest_models = lambda manifest, context, timeout=900: {"success": True, "output": "", "error": None}

        def fake_ensure(context, force=False, timeout=600):
            ensured["called"] = True
            return {"success": True, "output": "torch_cuda_smoke initial exit=0", "error": None}

        gpu_worker.ensure_torch_cuda_workbench = fake_ensure
        gpu_worker.subprocess.run = fake_run
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-manifest-torch_1", "spaceId": "space manifest torch"})
        manifest = {
            "dependencies": ["torch"],
            "smokeTests": [{"name": "torch-smoke", "command": "python -c 'import torch; print(\"TORCH_SMOKE_OK\")'"}],
        }
        result = gpu_worker.prepare_manifest_environment(manifest, context)
        assert result["success"] is True, result
        assert ensured["called"] is True
        assert "torch_cuda_smoke initial exit=0" in result["output"]
    finally:
        gpu_worker.install_declared_dependencies = old_install
        gpu_worker.resolve_manifest_models = old_resolve
        gpu_worker.ensure_torch_cuda_workbench = old_ensure
        gpu_worker.subprocess.run = old_run
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        shutil.rmtree(root, ignore_errors=True)


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


def test_validation_rejects_preparation_probe_plus_unstructured_prose():
    output = """
torch_cuda_smoke initial exit=0
{"cuda_device": "NVIDIA GeForce RTX 3060", "torch_cuda_available": true}
{"type":"autonomous_preparation_manifest","contract_failure_reason":"JSON action must be run_python","gpu":{"cuda_available":true,"gpu_name":"NVIDIA GeForce RTX 3060"}}
=== INVESTIGATION ===
GPU WORKBENCH VERIFICATION
PyTorch version: 2.5.1+cu124
CUDA available: True
GPU: NVIDIA GeForce RTX 3060
### RESEARCH_JSON_OUTPUT ###
{"research_complete": true, "key_findings": ["prose-only research"], "recommended_approach": "try later"}
"""
    result = gpu_worker.validate_execution_result_evidence({"success": True, "output": output, "error": None})
    assert result["success"] is False
    assert "structured runtime GPU evidence" in result["error"]


def test_validation_accepts_preparation_probe_with_setup_metadata_json():
    output = """
disk_pressure={"ok": true, "freeBytes": 123456789}
workbench_prune={"deleted": [], "errors": []}
cuda_driver_preflight={"ok": true, "status": "cuda_compute_ready"}
model_resolution:
model_cache_root=/opt/AR-3/model_cache
model_resolve GSAI-ML/LLaDA-8B-Base exit=0
STDOUT:
{"ok": true, "repo_id": "GSAI-ML/LLaDA-8B-Base", "local_dir": "/opt/AR-3/model_cache/llada", "downloaded_files": ["config.json"]}
STDERR:
model_resolution_file=/tmp/ar3-workbenches/ode/model_resolution.json
{"type":"autonomous_preparation_manifest","contract_failure_reason":"JSON action must be run_python","gpu":{"cuda_available":true,"gpu_name":"NVIDIA GeForce RTX 3060"},"workbench":"/tmp/ar3-workbenches/ode","recommended_experiment":{"metrics":["cuda_available","trajectory_cosine_similarity"]}}
"""
    result = gpu_worker.validate_execution_result_evidence({"success": True, "output": output, "error": None})
    assert result["success"] is True
    assert result["error"] is None


def test_validation_rejects_manifest_model_steps_without_local_artifact_or_load_attempt():
    result = gpu_worker.validate_execution_result_evidence({
        "success": True,
        "preparationManifest": {
            "models": [
                {"id": "GSAI-ML/LLaDA-8B-Base", "source": "huggingface", "required": True},
            ],
            "gradingCriteria": [
                "It must print JSON evidence including GPU availability, model/dependency status, and measurable metrics.",
            ],
        },
        "output": json.dumps({
            "type": "deterministic_gpu_experiment",
            "cuda_available": True,
            "gpu_name": "NVIDIA GeForce GTX 1080 Ti",
            "model_metadata": [{"id": "GSAI-ML/LLaDA-8B-Base", "safetensors_count": 6}],
            "model_load_attempts": [],
            "research_metrics": {"trajectory_cosine_similarity": 0.95},
        }),
    })

    assert result["success"] is False
    assert "required model" in result["error"].lower()


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


def test_execute_gpu_command_stops_when_preparation_exhausts_disk_space():
    root = tempfile.mkdtemp(prefix="ar3-worker-post-prep-disk-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_collect = gpu_worker.collect_workbench_disk_pressure
    old_preflight = gpu_worker.run_cuda_driver_preflight
    old_prepare_manifest = gpu_worker.prepare_manifest_environment
    old_execute_python = gpu_worker.execute_python_code
    os.environ["AR3_WORKBENCH_ROOT"] = root
    calls = {"disk": 0, "executed": False}

    def fake_collect(context):
        calls["disk"] += 1
        if calls["disk"] == 1:
            return {"ok": True, "freeBytes": 5 * 1024**3, "phase": "before_preparation"}
        return {
            "ok": False,
            "freeBytes": 512 * 1024**2,
            "warning": "low disk space after preparation",
            "phase": "after_preparation",
        }

    try:
        gpu_worker.collect_workbench_disk_pressure = fake_collect
        gpu_worker.run_cuda_driver_preflight = lambda: {"ok": True, "status": "cuda_compute_ready"}
        gpu_worker.prepare_manifest_environment = lambda manifest, context, timeout=900, job_id='': {
            "success": True,
            "output": "downloaded model into cache",
            "error": None,
        }

        def fake_execute_python(*args, **kwargs):
            calls["executed"] = True
            return {"success": True, "output": '{"cuda_available": true}', "error": None}

        gpu_worker.execute_python_code = fake_execute_python
        result = gpu_worker.execute_gpu_command({
            "jobId": "gpu_space-post-prep-disk_1",
            "spaceId": "space post prep disk",
            "stageName": "Implementation",
            "prompt": __import__("json").dumps({
                "action": "run_python",
                "dependencies": [],
                "code": "import json\nimport torch\nprint(json.dumps({'cuda_available': True, 'gpu_name': 'unit-test'}))",
            }),
            "context": __import__("json").dumps({
                "preparationManifest": {
                    "dependencies": [],
                    "smokeTests": [],
                    "workbench": {"reuseKey": "post-prep-disk"},
                }
            }),
        }, timeout=30)

        assert result["success"] is False, result
        assert "after GPU job preparation" in result["error"]
        assert result["diskPressure"]["phase"] == "before_preparation"
        assert result["diskPressureAfterPreparation"]["phase"] == "after_preparation"
        assert "disk_pressure_after_preparation" in result["output"]
        assert calls["executed"] is False
    finally:
        gpu_worker.collect_workbench_disk_pressure = old_collect
        gpu_worker.run_cuda_driver_preflight = old_preflight
        gpu_worker.prepare_manifest_environment = old_prepare_manifest
        gpu_worker.execute_python_code = old_execute_python
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
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


def test_torch_cuda_env_prefers_workbench_wheel_libs_and_removes_cuda_compat():
    root = tempfile.mkdtemp(prefix="ar3-worker-torch-ld-test-")
    old_root = os.environ.get("AR3_WORKBENCH_ROOT")
    old_ld = os.environ.get("LD_LIBRARY_PATH")
    os.environ["AR3_WORKBENCH_ROOT"] = root
    os.environ["LD_LIBRARY_PATH"] = os.pathsep.join([
        "/usr/local/cuda/compat",
        "/usr/local/cuda/lib64",
        "/usr/local/cuda/targets/x86_64-linux/lib",
        "/usr/local/nvidia/lib",
    ])
    try:
        context = gpu_worker.prepare_workbench({"jobId": "gpu_space-torch-ld_1", "spaceId": "space torch ld"})
        packages_dir = Path(context["packages_dir"])
        expected_wheel_libs = [
            packages_dir / "nvidia" / "nvjitlink" / "lib",
            packages_dir / "nvidia" / "cusparse" / "lib",
            packages_dir / "nvidia" / "cublas" / "lib",
        ]
        for lib_dir in expected_wheel_libs:
            lib_dir.mkdir(parents=True, exist_ok=True)

        torch_env = gpu_worker._torch_cuda_runtime_env(context)
        ld_parts = torch_env["LD_LIBRARY_PATH"].split(os.pathsep)

        assert ld_parts[:3] == [str(path) for path in expected_wheel_libs]
        assert "/usr/local/cuda/compat" not in ld_parts
        assert "/usr/local/cuda/lib64" not in ld_parts
        assert "/usr/local/cuda/targets/x86_64-linux/lib" not in ld_parts
        assert "/usr/local/nvidia/lib" in ld_parts
    finally:
        if old_root is None:
            os.environ.pop("AR3_WORKBENCH_ROOT", None)
        else:
            os.environ["AR3_WORKBENCH_ROOT"] = old_root
        if old_ld is None:
            os.environ.pop("LD_LIBRARY_PATH", None)
        else:
            os.environ["LD_LIBRARY_PATH"] = old_ld
        shutil.rmtree(root, ignore_errors=True)



if __name__ == "__main__":
    test_prepare_workbench_is_stable_per_space_and_sets_cache_env()
    test_prepare_workbench_enables_ram_offload_from_job_context()
    test_ram_offload_wrapper_normalizes_transformers_max_memory_device_keys()
    test_install_declared_dependencies_reuses_verified_workbench_record()
    test_install_declared_dependencies_skips_reinstall_when_imports_already_available_after_dependency_set_changes()
    test_install_declared_dependencies_does_not_reconcile_changed_version_spec_from_import_only()
    test_strategy4_line_assembly_does_not_crash_on_markdown_headers()
    test_extract_preparation_manifest_from_context_and_prompt()
    test_run_manifest_smoke_tests_executes_in_workbench_and_records_manifest_file()
    test_manifest_preparation_history_records_validation_failures()
    test_safe_smoke_command_uses_current_python_interpreter()
    test_safe_smoke_command_converts_python_heredoc_to_inline_code()
    test_safe_smoke_command_accepts_env_wrapped_python()
    test_safe_smoke_command_accepts_timeout_wrapped_python()
    test_safe_smoke_command_rejects_destructive_shell_even_without_typescript_validation()
    test_manifest_torch_dependencies_are_smoked_and_repaired_before_manifest_smoke_tests()
    test_huggingface_models_are_resolved_into_workbench_before_smoke_tests()
    test_fstring_item_coercion_does_not_cross_other_braces()
    test_execute_python_code_injects_missing_common_stdlib_imports()
    test_repair_torch_workbench_removes_poisoned_cuda_packages_and_reinstalls_cu124()
    test_validation_rejects_pretty_printed_contract_failure_after_gpu_smoke_json()
    test_validation_rejects_preparation_probe_plus_unstructured_prose()
    test_validation_accepts_preparation_probe_with_setup_metadata_json()
    test_validation_rejects_manifest_model_steps_without_local_artifact_or_load_attempt()
    test_process_job_marks_validation_failures_as_failed_validation()
    test_execute_gpu_command_stops_when_preparation_exhausts_disk_space()
    test_get_pending_jobs_reclaims_stale_inflight_jobs_without_results()
    test_execute_python_code_rejects_placeholders_before_running()
    test_torch_cuda_env_prefers_workbench_wheel_libs_and_removes_cuda_compat()
    print("gpu worker workbench tests passed")
