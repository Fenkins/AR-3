#!/usr/bin/env python3
"""Regression checks for GPU routing stage semantics."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "lib" / "gpu-command-contract.ts").read_text()


def test_gpu_enabled_spaces_route_all_research_stages_through_worker():
    assert "export function shouldRouteStageThroughGpu" in SOURCE, "shouldRouteStageThroughGpu function missing"
    routed_block = SOURCE.split("const GPU_SPACE_ROUTED_STAGES", 1)[1].split("])\n", 1)[0]
    for stage in ["Investigation", "Proposition", "Planning", "Implementation", "Testing", "Verification"]:
        assert f"'{stage}'" in routed_block, f"{stage} is not explicitly GPU-routed for GPU spaces"
    assert "GPU_SPACE_ROUTED_STAGES.has(stageName)" in SOURCE
    assert "spaceUseGpu" in SOURCE


if __name__ == "__main__":
    test_gpu_enabled_spaces_route_all_research_stages_through_worker()
    print("GPU routing contract tests passed")
