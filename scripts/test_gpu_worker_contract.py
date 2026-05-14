#!/usr/bin/env python3
"""Regression tests for GPU worker command extraction contract."""

import importlib.util
import json
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


def test_versioned_torch_dependency_is_pinned_instead_of_rejected():
    normalized = gpu_worker.normalize_declared_dependencies(['torch>=2.0.0'])
    assert normalized['success'] is True
    assert normalized['deps'] == ['torch==2.5.1']
    assert 'https://download.pytorch.org/whl/cu124' in normalized['pip_args']


def test_declared_stdlib_modules_are_not_pip_installed():
    normalized = gpu_worker.normalize_declared_dependencies(['torch', 'os', 'subprocess', 'json'])
    assert 'torch==2.5.1' in normalized['deps']
    assert 'os' not in normalized['deps']
    assert 'subprocess' not in normalized['deps']
    assert 'json' not in normalized['deps']


def test_deprecated_sklearn_dependency_is_rewritten_to_scikit_learn():
    normalized = gpu_worker.normalize_declared_dependencies(['sklearn>=0.0', 'numpy'])
    assert normalized['success'] is True
    assert 'scikit-learn' in normalized['deps']
    assert all(not dep.startswith('sklearn') for dep in normalized['deps'])
    assert 'numpy' in normalized['deps']


def test_install_dependencies_upgrades_existing_workbench_packages(monkeypatch, tmp_path):
    captured = {}

    class Result:
        returncode = 0
        stdout = 'ok'
        stderr = ''

    def fake_run(cmd, **kwargs):
        captured['cmd'] = cmd
        return Result()

    monkeypatch.setattr(gpu_worker.subprocess, 'run', fake_run)
    context = {'packages_dir': str(tmp_path / 'packages'), 'env': {}}
    result = gpu_worker.install_declared_dependencies(['torch'], context)
    assert result['success'] is True
    assert '--upgrade' in captured['cmd']
    assert 'torch==2.5.1' in captured['cmd']


def test_worker_queue_status_tracks_preparation_install_execution_and_validation(tmp_path, monkeypatch):
    queue_file = tmp_path / 'gpu_jobs.json'
    monkeypatch.setattr(gpu_worker, 'JOB_QUEUE_FILE', str(queue_file))
    monkeypatch.setenv("AR3_WORKBENCH_ROOT", str(tmp_path / "workbenches"))

    job = {
        "jobId": "job-status-lifecycle",
        "spaceId": "space-status-test",
        "spaceName": "Status Test",
        "stageName": "Implementation",
        "prompt": json.dumps({
            "action": "run_python",
            "dependencies": ["torch"],
            "code": "import torch\nprint({'cuda_available': torch.cuda.is_available(), 'gpu_name': 'test gpu'})",
        }),
    }
    queue_file.write_text(json.dumps([{**job, "status": "claimed"}]))
    observed = []

    original_write_queue = gpu_worker.write_queue

    def tracking_write_queue(jobs):
        observed.append(jobs[0]["status"])
        original_write_queue(jobs)

    class RunResult:
        returncode = 0
        stdout = "{'cuda_available': True, 'gpu_name': 'test gpu'}"
        stderr = ""

    monkeypatch.setattr(gpu_worker, 'write_queue', tracking_write_queue)
    monkeypatch.setattr(gpu_worker.subprocess, 'run', lambda *args, **kwargs: RunResult())

    result = gpu_worker.execute_gpu_command(job, timeout=30)

    assert result["success"] is True
    assert observed == [
        "preparing_workbench",
        "installing_dependencies",
        "running_experiment",
        "validating_evidence",
    ]


def test_self_reported_contract_failure_is_rejected_after_execution(tmp_path, monkeypatch):
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


def test_autonomous_preparation_manifest_contract_reason_is_preserved_as_probe_evidence():
    result = gpu_worker.validate_execution_result_evidence({
        "success": True,
        "error": None,
        "output": json.dumps({
            "type": "autonomous_preparation_manifest",
            "contract_failure_reason": "JSON action must be run_python",
            "gpu": {"cuda_available": True, "gpu_name": "test gpu"},
        }),
    })
    assert result["success"] is True
    assert result["error"] is None


def test_successful_output_must_contain_runtime_gpu_evidence():
    result = gpu_worker.validate_execution_result_evidence({
        "success": True,
        "output": "experiment completed successfully",
        "error": None,
    })
    assert result["success"] is False
    assert "runtime GPU evidence" in result["error"]


def json_escape(value: str) -> str:
    import json
    return json.dumps(value)


if __name__ == "__main__":
    test_prose_only_prompt_is_invalid()
    test_json_run_python_prompt_is_accepted()
    test_cpu_only_experiment_is_rejected_before_execution()
    test_gpu_probe_experiment_is_accepted_before_execution()
    print("gpu_worker contract tests passed")
