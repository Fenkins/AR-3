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


if __name__ == '__main__':
    test_repairs_newline_join_literal()
    test_repairs_newline_concat_literal()
    test_auto_fix_repairs_newline_without_corrupting_multiline_dict()
    test_leaves_normal_code_unchanged()
    print('gpu worker syntax repair tests passed')
