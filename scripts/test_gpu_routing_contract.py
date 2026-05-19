#!/usr/bin/env python3
"""Regression checks for GPU routing stage semantics."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_SOURCE = (ROOT / "lib" / "gpu-command-contract.ts").read_text()
ENGINE_SOURCE = (ROOT / "lib" / "research-engine.ts").read_text()


def _routed_block() -> str:
    return CONTRACT_SOURCE.split("const GPU_SPACE_ROUTED_STAGES", 1)[1].split("])\n", 1)[0]


def test_gpu_enabled_spaces_route_all_research_stages_through_worker():
    assert "export function shouldRouteStageThroughGpu" in CONTRACT_SOURCE, "shouldRouteStageThroughGpu function missing"
    routed_block = _routed_block()
    for stage in ["Investigation", "Proposition", "Planning", "Implementation", "Testing", "Verification"]:
        assert f"'{stage}'" in routed_block, f"{stage} must be explicitly GPU-routed for GPU spaces"
    assert "stageGpuEnabled || GPU_SPACE_ROUTED_STAGES.has(stageName)" in CONTRACT_SOURCE
    assert "spaceUseGpu && (stageGpuEnabled || GPU_SPACE_ROUTED_STAGES.has(stageName))" in CONTRACT_SOURCE


def test_investigation_default_stage_is_gpu_enabled():
    investigation_block = ENGINE_SOURCE.split("name: 'Investigation'", 1)[1].split("name: 'Proposition'", 1)[0]
    assert "gpuEnabled: true" in investigation_block
    assert "gpuEnabled: false" not in investigation_block


if __name__ == "__main__":
    test_gpu_enabled_spaces_route_all_research_stages_through_worker()
    test_investigation_default_stage_is_gpu_enabled()
    print("GPU routing contract tests passed")
