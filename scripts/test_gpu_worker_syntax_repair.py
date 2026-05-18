#!/usr/bin/env python3
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('gpu_worker', Path(__file__).with_name('gpu_worker.py'))
gpu_worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu_worker)


def test_repairs_newline_join_literal():
    broken = 'model_ids = discover_model_ids(research_goal + "\n".join(search_terms))'
    # Simulate the malformed code emitted by JSON/LLM escaping: quote, physical newline, quote.join
    broken = broken.replace('"\\n"', '"\n"')
    fixed = gpu_worker.repair_embedded_newline_string_literals(broken)
    assert '"\\n".join(search_terms)' in fixed
    compile(fixed, '<fixed>', 'exec')


def test_repairs_newline_concat_literal():
    broken = 'model_ids = discover_model_ids(research_goal + "\n" + step_description)'
    # Simulate the malformed code emitted by JSON/LLM escaping: quote, physical newline, quote +
    broken = broken.replace('"\\n"', '"\n"')
    fixed = gpu_worker.repair_embedded_newline_string_literals(broken)
    assert '"\\n" + step_description' in fixed
    compile(fixed, '<fixed>', 'exec')


def test_auto_fix_repairs_newline_without_corrupting_multiline_dict():
    broken = '''
def query_huggingface():
    item = {"model_id": "owner/model", "status_code": 200}
    item.update({
        "private": False,
        "pipeline_tag": "text-generation",
        "config_files": ["config.json"],
    })
    model_ids = discover_model_ids(research_goal + "\n" + step_description)
    print(item, model_ids)
'''
    broken = broken.replace('"\\n"', '"\n"')
    fixed = gpu_worker.auto_fix_code(broken)
    assert 'item.update({)}' not in fixed
    assert '"\\n" + step_description' in fixed
    compile(fixed, '<fixed>', 'exec')


def test_leaves_normal_code_unchanged():
    code = 'print("hello")\nitems = ["a", "b"]\n'
    assert gpu_worker.repair_embedded_newline_string_literals(code) == code


def test_repairs_torch_cuda_device_total_mem_alias():
    code = "props = torch.cuda.get_device_properties(0)\nprint(props.total_mem)\n"
    fixed = gpu_worker.repair_common_torch_api_mistakes(code)
    assert "props.total_memory" in fixed
    assert "props.total_mem)" not in fixed


def test_auto_fix_applies_torch_cuda_device_total_mem_alias():
    code = "props = torch.cuda.get_device_properties(0)\nprint(props.total_mem)\n"
    fixed = gpu_worker.auto_fix_code(code)
    assert "props.total_memory" in fixed
    assert "props.total_mem)" not in fixed


def test_repairs_duplicated_vram_variable_name():
    code = (
        "SINGLE_MODEL_VRAM_GIB = 14\n"
        "FREE_VRAM_GIB = 8\n"
        "MAX_CONCURRENT_INSTANCES = int(FREE_VRAM_GIB / SINGLE_MODEL_VRAM_VRAM_GIB) "
        "if SINGLE_MODEL_VRAM_VRAM_GIB > 0 else 0\n"
        "print(MAX_CONCURRENT_INSTANCES)\n"
    )
    fixed = gpu_worker.repair_common_torch_api_mistakes(code)
    assert "SINGLE_MODEL_VRAM_VRAM_GIB" not in fixed
    namespace = {}
    exec(fixed, namespace)
    assert namespace["MAX_CONCURRENT_INSTANCES"] == 0


def test_auto_fix_repairs_malformed_dict_value_format_spec():
    broken = "metrics = {'agreement': consensus_result['avg_agreement']:.3f, 'loss': stats['loss']:.4f}\nprint(metrics)\n"
    fixed = gpu_worker.auto_fix_code(broken)
    assert "round(consensus_result['avg_agreement'], 3)" in fixed
    assert "round(stats['loss'], 4)" in fixed
    compile(fixed, '<fixed>', 'exec')


def test_repairs_optional_gpu_info_boolean_lookup():
    code = "gpu_info = {'gpu_memory_total_mb': 12288}\nvalue = gpu_info['can_load_2x_8b_model_fp16']\n"
    fixed = gpu_worker.repair_common_gpu_info_key_assumptions(code)
    assert "gpu_info.get('can_load_2x_8b_model_fp16', False)" in fixed
    namespace = {}
    exec(fixed, namespace)


def test_injects_missing_defaultdict_import():
    code = "groups = defaultdict(list)\ngroups['a'].append(1)\nprint(dict(groups))\n"
    fixed = gpu_worker.inject_missing_common_stdlib_imports(code)
    assert fixed.startswith('from collections import defaultdict\n')
    namespace = {}
    exec(fixed, namespace)


def test_injects_json_numpy_scalar_encoder_patch():
    code = (
        "import json\n"
        "import numpy as np\n"
        "payload = {'ok': np.bool_(True), 'score': np.float32(0.25), 'shape': np.array([1, 2])}\n"
        "encoded = json.dumps(payload, sort_keys=True)\n"
    )
    fixed = gpu_worker.inject_json_numpy_scalar_encoder_patch(code)
    assert "_ar3_json_default" in fixed
    import sys
    import types

    class FakeGeneric:
        def __init__(self, value):
            self.value = value
        def item(self):
            return self.value

    class FakeArray:
        def __init__(self, value):
            self.value = value
        def tolist(self):
            return self.value

    fake_numpy = types.SimpleNamespace(
        generic=FakeGeneric,
        ndarray=FakeArray,
        bool_=lambda value: FakeGeneric(bool(value)),
        float32=lambda value: FakeGeneric(float(value)),
        array=lambda value: FakeArray(value),
    )
    previous_numpy = sys.modules.get('numpy')
    sys.modules['numpy'] = fake_numpy
    namespace = {}
    try:
        exec(fixed, namespace)
        assert namespace["encoded"] == '{"ok": true, "score": 0.25, "shape": [1, 2]}'
    finally:
        if previous_numpy is None:
            sys.modules.pop('numpy', None)
        else:
            sys.modules['numpy'] = previous_numpy


if __name__ == '__main__':
    test_repairs_newline_join_literal()
    test_repairs_newline_concat_literal()
    test_auto_fix_repairs_newline_without_corrupting_multiline_dict()
    test_leaves_normal_code_unchanged()
    test_repairs_torch_cuda_device_total_mem_alias()
    test_auto_fix_applies_torch_cuda_device_total_mem_alias()
    test_repairs_duplicated_vram_variable_name()
    test_auto_fix_repairs_malformed_dict_value_format_spec()
    test_repairs_optional_gpu_info_boolean_lookup()
    test_injects_missing_defaultdict_import()
    test_injects_json_numpy_scalar_encoder_patch()
    print('gpu worker syntax repair tests passed')
