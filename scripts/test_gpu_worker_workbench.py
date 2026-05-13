#!/usr/bin/env python3
import importlib.util
import os
import shutil
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


if __name__ == "__main__":
    test_prepare_workbench_is_stable_per_space_and_sets_cache_env()
    test_strategy4_line_assembly_does_not_crash_on_markdown_headers()
    print("gpu worker workbench tests passed")
