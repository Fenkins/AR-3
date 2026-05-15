#!/usr/bin/env python3
"""Regression tests for the Vast.ai single-instance launch guard."""

import importlib.util
import json
import tempfile
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "vast-ai-launch-v3.py"


def load_launcher():
    spec = importlib.util.spec_from_file_location("vast_ai_launch_v3", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_recorded_active_instance_blocks_launch():
    launcher = load_launcher()
    with tempfile.TemporaryDirectory() as tmp:
        active_file = Path(tmp) / "active_instance.json"
        active_file.write_text(json.dumps({
            "instance_id": "123",
            "contract_id": "123",
            "status": "running",
            "gpu_name": "RTX 3060",
        }))
        launcher.ACTIVE_INSTANCE_FILE = str(active_file)
        launcher.get_active_ar3_instances = lambda: []
        try:
            launcher.enforce_single_instance(replace=False)
        except SystemExit as exc:
            assert exc.code == 1
        else:
            raise AssertionError("expected active instance record to block launch")


def test_replace_allows_recorded_active_instance():
    launcher = load_launcher()
    with tempfile.TemporaryDirectory() as tmp:
        active_file = Path(tmp) / "active_instance.json"
        active_file.write_text(json.dumps({
            "instance_id": "123",
            "contract_id": "123",
            "status": "running",
        }))
        launcher.ACTIVE_INSTANCE_FILE = str(active_file)
        launcher.get_active_ar3_instances = lambda: []
        launcher.enforce_single_instance(replace=True)


def test_parse_raw_instances_filters_ar3_labels():
    launcher = load_launcher()
    raw = json.dumps({
        "instances": [
            {"id": 1, "label": "AR-3-Research", "status": "running"},
            {"id": 2, "label": "unrelated", "status": "running"},
        ]
    })
    parsed = launcher.parse_instances(raw)
    assert len(parsed) == 2
    launcher.runvast = lambda *args, **kwargs: raw
    launcher.ACTIVE_INSTANCE_FILE = "/tmp/nonexistent-ar3-active-instance.json"
    active = launcher.get_active_ar3_instances()
    assert active == [{"id": "1", "label": "AR-3-Research", "status": "running"}]


if __name__ == "__main__":
    test_recorded_active_instance_blocks_launch()
    test_replace_allows_recorded_active_instance()
    test_parse_raw_instances_filters_ar3_labels()
    print("vast launcher guard tests passed")
