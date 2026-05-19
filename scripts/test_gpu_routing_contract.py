#!/usr/bin/env python3
"""Regression checks for GPU routing stage semantics."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_SOURCE = (ROOT / "lib" / "gpu-command-contract.ts").read_text()
ENGINE_SOURCE = (ROOT / "lib" / "research-engine.ts").read_text()


def _routed_block() -> str:
    return CONTRACT_SOURCE.split("const GPU_SPACE_ROUTED_STAGES", 1)[1].split("])\n", 1)[0]


def test_gpu_enabled_spaces_route_only_executable_stages_through_worker():
    assert "export function shouldRouteStageThroughGpu" in CONTRACT_SOURCE, "shouldRouteStageThroughGpu function missing"
    routed_block = _routed_block()
    for stage in ["Implementation", "Testing", "Verification"]:
        assert f"'{stage}'" in routed_block, f"{stage} must be explicitly GPU-routed for GPU spaces"
    for stage in ["Investigation", "Proposition", "Planning"]:
        assert f"'{stage}'" not in routed_block, f"{stage} must stay non-GPU even when a space enables GPU"
    assert "stageGpuEnabled || GPU_SPACE_ROUTED_STAGES.has(stageName)" not in CONTRACT_SOURCE
    assert "spaceUseGpu && GPU_SPACE_ROUTED_STAGES.has(stageName)" in CONTRACT_SOURCE


def test_investigation_default_stage_is_not_gpu_enabled():
    investigation_block = ENGINE_SOURCE.split("name: 'Investigation'", 1)[1].split("name: 'Proposition'", 1)[0]
    assert "gpuEnabled: false" in investigation_block
    assert "gpuEnabled: true" not in investigation_block



def test_research_engine_applies_deterministic_selection_for_preparation_capable_stages():
    assert "selectedSubmission.ok && selectedSubmission.fallbackUsed" not in ENGINE_SOURCE
    assert "gpuSubmissionUsedFallback = selectedSubmission.fallbackUsed" in ENGINE_SOURCE
    assert "GPU_CONTRACT_DETERMINISTIC_EXPERIMENT_FALLBACK" in ENGINE_SOURCE


if __name__ == "__main__":
    test_gpu_enabled_spaces_route_only_executable_stages_through_worker()
    test_investigation_default_stage_is_not_gpu_enabled()
    print("GPU routing contract tests passed")
