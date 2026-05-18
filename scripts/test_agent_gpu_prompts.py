#!/usr/bin/env python3
"""Regression checks for GPU-routed agent prompt defaults.

These tests intentionally parse the TypeScript route source as text so they can run
without a Next.js test harness. The contract being guarded is that every research
role which can become a GPU-routed stage has an explicit gpuPromptVariant that
requires strict run_python JSON instead of prose/thinking output.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ROUTE = ROOT / "app" / "api" / "agents" / "route.ts"
SOURCE = ROUTE.read_text()

GPU_ROUTED_ROLES = [
    "INVESTIGATION",
    "PROPOSITION",
    "PLANNING",
    "IMPLEMENTATION",
    "TESTING",
    "VERIFICATION",
]


def _role_block(role: str) -> str:
    match = re.search(rf"  {role}: \{{(.*?)\n  \}}", SOURCE, re.S)
    assert match, f"missing ROLE_PROMPTS block for {role}"
    return match.group(1)


def test_gpu_routed_roles_have_strict_run_python_prompts():
    for role in GPU_ROUTED_ROLES:
        block = _role_block(role)
        assert "gpuPromptVariant" in block, f"{role} lacks gpuPromptVariant"
        assert '{"action":"run_python"' in block, f"{role} prompt does not require run_python JSON"
        assert "no markdown, no prose, no <think> tags" in block, f"{role} prompt does not reject prose/thinking text"


def test_proposition_prompt_demands_executable_experiment_not_rationale():
    block = _role_block("PROPOSITION")
    assert "proposition" in block.lower()
    assert "executable" in block.lower()
    assert "structured JSON metrics" in block
    assert "Do not output rationale-only prose" in block


if __name__ == "__main__":
    test_gpu_routed_roles_have_strict_run_python_prompts()
    test_proposition_prompt_demands_executable_experiment_not_rationale()
    print("agent GPU prompt contract tests passed")
