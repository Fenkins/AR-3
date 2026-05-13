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


if __name__ == "__main__":
    test_prose_only_prompt_is_invalid()
    test_json_run_python_prompt_is_accepted()
    print("gpu_worker contract tests passed")
