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


def test_leaves_normal_code_unchanged():
    code = 'print("hello")\nitems = ["a", "b"]\n'
    assert gpu_worker.repair_embedded_newline_string_literals(code) == code


if __name__ == '__main__':
    test_repairs_newline_join_literal()
    test_repairs_newline_concat_literal()
    test_leaves_normal_code_unchanged()
    print('gpu worker syntax repair tests passed')
