#!/usr/bin/env python3
"""Focused tests for gpu_worker.validate_execution_result_evidence.

These tests isolate the evidence gate from the queue, workbench, dependency
installer, and GPU runtime. The goal is to lock down the contract between
autonomous preparation, fake prose output, and real experiment evidence.
"""

import importlib.util
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = REPO_ROOT / "scripts" / "gpu_worker.py"

spec = importlib.util.spec_from_file_location("gpu_worker", WORKER_PATH)
assert spec is not None and spec.loader is not None
gpu_worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu_worker)


def validate(output: str, success: bool = True, preparation_manifest: dict | None = None) -> dict:
    payload = {
        "success": success,
        "output": output,
        "error": None if success else "already failed",
    }
    if preparation_manifest is not None:
        payload["preparationManifest"] = preparation_manifest
    return gpu_worker.validate_execution_result_evidence(payload)


def assert_pass(name: str, output: str) -> None:
    result = validate(output)
    assert result["success"] is True, f"{name} should pass: {result}"
    assert result.get("error") is None, f"{name} should not set error: {result}"


def assert_fail(name: str, output: str, expected: str) -> None:
    result = validate(output)
    assert result["success"] is False, f"{name} should fail: {result}"
    assert expected in (result.get("error") or ""), f"{name} wrong error: {result}"


def test_failed_results_are_not_rewritten() -> None:
    result = validate("{}", success=False)
    assert result["success"] is False
    assert result["error"] == "already failed"


def test_real_structured_gpu_evidence_passes() -> None:
    assert_pass(
        "real structured gpu evidence",
        '{"cuda_available": true, "gpu_name": "RTX 2060 SUPER", "metric": 0.42}',
    )


def test_plain_success_without_gpu_evidence_fails() -> None:
    assert_fail(
        "plain success without evidence",
        "experiment finished successfully but did not print runtime device evidence",
        "missing runtime GPU evidence",
    )


def test_contract_failure_after_smoke_fails() -> None:
    assert_fail(
        "contract failure after worker smoke",
        """
torch_cuda_smoke initial exit=0
{"cuda_device": "NVIDIA GeForce RTX 2060 SUPER", "torch_cuda_available": true}
{"contract_failure_reason": "model emitted prose instead of JSON command", "gpu": {"cuda_available": true}}
""",
        "contract_failure_reason",
    )


def test_preparation_probe_with_only_setup_metadata_passes() -> None:
    assert_pass(
        "preparation probe plus setup metadata",
        """
disk_pressure={"ok": true, "freeBytes": 5544332211}
workbench_prune={"deleted": [], "errors": []}
cuda_driver_preflight={"ok": true, "status": "cuda_compute_ready"}
{"ok": true, "repo_id": "GSAI-ML/LLaDA-8B-Base", "local_dir": "/tmp/model", "downloaded_files": ["config.json"]}
{"type":"autonomous_preparation_manifest","contract_failure_reason":"JSON action must be run_python","gpu":{"cuda_available":true,"gpu_name":"RTX 2060 SUPER"},"recommended_experiment":{"metrics":["cuda_available","trajectory_cosine_similarity"]}}
""",
    )


def test_preparation_probe_with_fake_research_summary_fails() -> None:
    assert_fail(
        "preparation probe plus fake research summary",
        """
{"cuda_device": "NVIDIA GeForce RTX 2060 SUPER", "torch_cuda_available": true}
{"type":"autonomous_preparation_manifest","contract_failure_reason":"JSON action must be run_python","gpu":{"cuda_available":true}}
{"research_complete": true, "key_findings": ["looked plausible"], "recommended_approach": "continue"}
""",
        "structured runtime GPU evidence",
    )


def test_preparation_probe_with_unknown_non_evidence_json_fails() -> None:
    assert_fail(
        "preparation probe plus unknown json",
        """
{"cuda_device": "NVIDIA GeForce RTX 2060 SUPER", "torch_cuda_available": true}
{"type":"autonomous_preparation_manifest","contract_failure_reason":"JSON action must be run_python","gpu":{"cuda_available":true}}
{"notes": ["this is not runtime evidence"], "confidence": 0.2}
""",
        "structured runtime GPU evidence",
    )


def test_preparation_probe_then_real_experiment_evidence_passes() -> None:
    assert_pass(
        "preparation probe plus real experiment evidence",
        """
{"type":"autonomous_preparation_manifest","contract_failure_reason":"JSON action must be run_python","gpu":{"cuda_available":true}}
{"cuda_available": true, "gpu_name": "RTX 2060 SUPER", "trajectory_cosine_similarity": 0.73}
""",
    )


def test_non_preparation_job_cannot_pass_on_model_resolution_smoke_only() -> None:
    assert_fail(
        "model resolution smoke only",
        """
preparation_manifest=/tmp/ar3-workbenches/space/preparation_manifest.json
torch_cuda_workbench:
torch_cuda_smoke initial exit=0
{"cuda_device": "NVIDIA GeForce RTX 2060 SUPER", "cuda_tensor_sum": 1.0, "torch_cuda_available": true}
model_resolution:
model_smoke GSAI-ML/LLaDA-8B-Base skipped: no smoke test command supplied; model resolution evidence accepted
smoke_test torch_cuda_smoke exit=0
{"cuda_available": true, "device": "cuda:0", "sum": 1.0}
""",
        "only showed preparation/model-resolution smoke evidence",
    )


def test_preparation_manifest_expected_evidence_is_enforced() -> None:
    manifest = {
        "smokeTests": [
            {"expectedEvidence": ["trajectory_cosine_similarity", "loss"]},
        ],
    }
    result = validate(
        '{"cuda_available": true, "gpu_name": "RTX 3060", "trajectory_cosine_similarity": 0.72}',
        preparation_manifest=manifest,
    )
    assert result["success"] is False
    assert "expected evidence fields" in (result.get("error") or "")
    assert "loss" in (result.get("error") or "")


def test_preparation_manifest_success_thresholds_are_enforced() -> None:
    manifest = {
        "successCriteria": [
            {"metric": "trajectory_cosine_similarity", "threshold": ">= 0.8"},
        ],
    }
    result = validate(
        '{"cuda_available": true, "gpu_name": "RTX 3060", "trajectory_cosine_similarity": 0.72}',
        preparation_manifest=manifest,
    )
    assert result["success"] is False
    assert "success criteria thresholds" in (result.get("error") or "")


def test_preparation_manifest_criteria_pass_with_concrete_metrics() -> None:
    manifest = {
        "smokeTests": [
            {"expectedEvidence": ["trajectory_cosine_similarity", "loss"]},
        ],
        "successCriteria": [
            {"metric": "trajectory_cosine_similarity", "threshold": ">= 0.7"},
        ],
    }
    result = validate(
        '{"cuda_available": true, "gpu_name": "RTX 3060", "trajectory_cosine_similarity": 0.72, "loss": 0.31}',
        preparation_manifest=manifest,
    )
    assert result["success"] is True, result


if __name__ == "__main__":
    test_failed_results_are_not_rewritten()
    test_real_structured_gpu_evidence_passes()
    test_plain_success_without_gpu_evidence_fails()
    test_contract_failure_after_smoke_fails()
    test_preparation_probe_with_only_setup_metadata_passes()
    test_preparation_probe_with_fake_research_summary_fails()
    test_preparation_probe_with_unknown_non_evidence_json_fails()
    test_preparation_probe_then_real_experiment_evidence_passes()
    test_non_preparation_job_cannot_pass_on_model_resolution_smoke_only()
    test_preparation_manifest_expected_evidence_is_enforced()
    test_preparation_manifest_success_thresholds_are_enforced()
    test_preparation_manifest_criteria_pass_with_concrete_metrics()
    print("gpu evidence gate isolated tests passed")
