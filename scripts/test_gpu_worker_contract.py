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


def test_declared_import_alias_dependencies_are_rewritten_to_pip_packages():
    normalized = gpu_worker.normalize_declared_dependencies([
        'PIL>=10.0',
        'cv2',
        'yaml',
        'skimage',
        'sentence_transformers>=2.7',
        'dotenv',
    ])
    assert normalized['success'] is True
    assert normalized['deps'] == [
        'Pillow>=10.0',
        'opencv-python-headless',
        'PyYAML',
        'scikit-image',
        'sentence-transformers>=2.7',
        'python-dotenv',
    ]


def test_manifest_dependency_aliases_are_normalized_like_typescript_manifest():
    normalized = gpu_worker.normalize_declared_dependencies([
        {'package': 'torch', 'version': '>=2.0.0', 'import': 'torch'},
        {'pipPackage': 'sklearn>=0.0', 'purpose': 'legacy alias from weak manifest'},
    ])
    assert normalized['success'] is True
    assert normalized['deps'] == ['torch==2.5.1', 'scikit-learn']
    assert 'https://download.pytorch.org/whl/cu124' in normalized['pip_args']


def test_manifest_dependency_plain_version_becomes_valid_pip_spec():
    normalized = gpu_worker.normalize_declared_dependencies([
        {'package': 'transformers', 'version': '4.45.2'},
        {'name': 'accelerate', 'versionSpec': '>=0.33.0'},
    ])
    assert normalized['success'] is True
    assert normalized['deps'] == ['transformers==4.45.2', 'accelerate>=0.33.0']


def test_manifest_dependency_import_name_without_package_becomes_pip_package():
    normalized = gpu_worker.normalize_declared_dependencies([
        {'importName': 'sklearn.metrics', 'purpose': 'score model output', 'required': True},
        {'import_name': 'matplotlib.pyplot', 'versionSpec': '>=3.8', 'purpose': 'plot metrics'},
        {'module': 'yaml', 'purpose': 'load config'},
    ])
    assert normalized['success'] is True
    assert normalized['deps'] == ['scikit-learn', 'matplotlib>=3.8', 'PyYAML']


def test_dotted_import_dependency_string_uses_top_level_package():
    normalized = gpu_worker.normalize_declared_dependencies(['matplotlib.pyplot', 'numpy.linalg'])
    assert normalized['success'] is True
    assert normalized['deps'] == ['matplotlib', 'numpy']


def test_manifest_model_resolution_uses_shared_cache_root(monkeypatch, tmp_path):
    shared_cache = tmp_path / 'shared-model-cache'
    context = {'workbench_dir': str(tmp_path / 'workbench'), 'env': {}}
    monkeypatch.setenv('AR3_MODEL_CACHE_ROOT', str(shared_cache))

    local_dir = gpu_worker._manifest_model_local_dir('org/test-model', context)

    assert local_dir.parent == shared_cache
    assert local_dir.name.startswith('org-test-model-')
    assert len(local_dir.name.rsplit('-', 1)[-1]) == 10


def test_missing_module_auto_install_reuses_dependency_normalization(tmp_path):
    context = {'packages_dir': str(tmp_path / 'packages')}
    repair = gpu_worker.missing_module_install_command('torch', context)
    assert repair['success'] is True
    assert 'torch==2.5.1' in repair['deps']
    assert 'https://download.pytorch.org/whl/cu124' in repair['cmd']
    assert '--upgrade' in repair['cmd']


def test_missing_module_auto_install_maps_common_import_aliases(tmp_path):
    context = {'packages_dir': str(tmp_path / 'packages')}
    repair = gpu_worker.missing_module_install_command('cv2', context)
    assert repair['success'] is True
    assert repair['deps'] == ['opencv-python-headless']


def test_missing_module_auto_install_maps_ml_import_aliases(tmp_path):
    context = {'packages_dir': str(tmp_path / 'packages')}
    repair = gpu_worker.missing_module_install_command('sentence_transformers', context)
    assert repair['success'] is True
    assert repair['deps'] == ['sentence-transformers']


def test_missing_stdlib_module_is_not_auto_installed(tmp_path):
    context = {'packages_dir': str(tmp_path / 'packages')}
    repair = gpu_worker.missing_module_install_command('json', context)
    assert repair['success'] is False
    assert 'not a pip-installable dependency' in repair['error']


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


def test_install_dependencies_records_workbench_dependency_manifest(monkeypatch, tmp_path):
    class Result:
        returncode = 0
        stdout = 'installed'
        stderr = ''

    monkeypatch.setattr(gpu_worker.subprocess, 'run', lambda *args, **kwargs: Result())
    context = {'packages_dir': str(tmp_path / 'packages'), 'workbench_dir': str(tmp_path), 'env': {}}
    result = gpu_worker.install_declared_dependencies([{'package': 'numpy'}], context)
    record_path = tmp_path / 'installed_dependencies.json'
    record = json.loads(record_path.read_text())

    assert result['success'] is True
    assert f'installed_dependencies={record_path}' in result['output']
    assert record['success'] is True
    assert record['normalized'] == ['numpy']
    assert record['declared'] == [{'package': 'numpy'}]


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


def test_process_job_persists_disk_pressure_metadata(tmp_path, monkeypatch):
    queue_file = tmp_path / 'gpu_jobs.json'
    results_file = tmp_path / 'gpu_results.json'
    job = {'jobId': 'job-disk-pressure', 'status': 'claimed'}
    queue_file.write_text(json.dumps([job]))
    results_file.write_text('{}')

    monkeypatch.setattr(gpu_worker, 'JOB_QUEUE_FILE', str(queue_file))
    monkeypatch.setattr(gpu_worker, 'JOB_RESULTS_FILE', str(results_file))
    monkeypatch.setattr(gpu_worker, 'execute_gpu_command', lambda _job, timeout=30: {
        'success': True,
        'output': 'cuda_available=true',
        'error': None,
        'code': 'print("cuda_available=true")',
        'workbenchDir': '/tmp/ar3-workbenches/space',
        'artifactsDir': '/tmp/ar3-workbenches/space/artifacts',
        'dependencies': [],
        'preparationManifestApplied': False,
        'diskPressure': {'ok': True, 'freeBytes': 1234},
    })

    gpu_worker.process_job(job, timeout=30)
    stored = json.loads(results_file.read_text())['job-disk-pressure']

    assert stored['diskPressure'] == {'ok': True, 'freeBytes': 1234}


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
