#!/usr/bin/env python3
"""Regression checks for GPU routing stage semantics."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "lib" / "gpu-command-contract.ts").read_text()


def test_gpu_enabled_spaces_route_proposition_verification_through_worker():
    assert "export function shouldRouteStageThroughGpu" in SOURCE, "shouldRouteStageThroughGpu function missing"
    for stage in ["Investigation", "Proposition", "Planning", "Implementation", "Testing", "Verification"]:
        assert stage in SOURCE, f"{stage} is not explicitly GPU-routed for GPU spaces"
    assert "GPU_SPACE_ROUTED_STAGES.has(stageName)" in SOURCE
    assert "spaceUseGpu" in SOURCE


if __name__ == "__main__":
    test_gpu_enabled_spaces_route_proposition_verification_through_worker()
    print("GPU routing contract tests passed")
