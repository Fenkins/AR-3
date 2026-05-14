#!/usr/bin/env python3
"""Regression tests for GPU worker command extraction contract."""

import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gpu_worker", ROOT / "gpu_worker.py")
gpu_worker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(gpu_worker)


def test_prose_only_prompt_is_invalid():
    command = gpu_worker.extract_gpu_command(
        "I would probably train a model here, compare results, and report metrics later."
    )
    assert command["action"] == "invalid"
    assert "No executable GPU command" in command["error"]


def test_json_run_python_prompt_is_accepted():
    command = gpu_worker.extract_gpu_command(
        '{"action":"run_python","dependencies":[],"code":"import json\\nresult = {\\"accuracy\\": 1.0}\\nprint(json.dumps(result))"}'
    )
    assert command["action"] == "run_python"
    assert "print" in command["code"]


def test_cpu_only_experiment_is_rejected_before_execution():
    validation = gpu_worker.validate_executable_experiment_code(
        "import json\n"
        "result = {\"accuracy\": 1.0, \"loss\": 0.0}\n"
        "print(json.dumps(result))\n"
    )
    assert validation["ok"] is False
    assert "GPU/CUDA" in validation["error"]


def test_gpu_probe_experiment_is_accepted_before_execution():
    validation = gpu_worker.validate_executable_experiment_code(
        "import json\n"
        "import torch\n"
        "result = {\"cuda_available\": torch.cuda.is_available()}\n"
        "print(json.dumps(result))\n"
    )
    assert validation["ok"] is True


def test_bare_torch_dependency_is_pinned_to_cuda_12_4_wheel_index():
    normalized = gpu_worker.normalize_declared_dependencies(['torch', 'transformers'])
    assert 'torch==2.5.1' in normalized['deps']
    assert normalized['deps'].count('torch==2.5.1') == 1
    assert 'transformers' in normalized['deps']
    assert 'https://download.pytorch.org/whl/cu124' in normalized['pip_args']


def test_self_reported_contract_failure_output_fails_job(tmp_path, monkeypatch):
    monkeypatch.setenv("AR3_WORKBENCH_ROOT", str(tmp_path / "workbenches"))
    code = (
        "import json\n"
        "reason = 'code contains ' + 'place' + 'holder/pseudo' + 'code markers'\n"
        "result = {\"cuda_available\": True, \"gpu_name\": \"test gpu\", \"contract_failure_reason\": reason}\n"
        "print(json.dumps(result))\n"
    )
    result = gpu_worker.execute_gpu_command({
        "jobId": "job-self-reported-contract-failure",
        "spaceId": "space-contract-test",
        "spaceName": "Contract Test",
        "stageName": "Implementation",
        "prompt": '{"action":"run_python","dependencies":[],"code":' + json_escape(code) + '}',
    }, timeout=30)
    assert result["success"] is False
    assert "contract_failure_reason" in result["error"]


def json_escape(value: str) -> str:
    import json
    return json.dumps(value)


if __name__ == "__main__":
    test_prose_only_prompt_is_invalid()
    test_json_run_python_prompt_is_accepted()
    test_cpu_only_experiment_is_rejected_before_execution()
    test_gpu_probe_experiment_is_accepted_before_execution()
    print("gpu_worker contract tests passed")
