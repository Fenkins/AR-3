#!/usr/bin/env python3
"""Regression tests for the internal AR-3 search service HTTP contract."""
from types import SimpleNamespace
import importlib.util
from pathlib import Path

module_path = Path(__file__).with_name('search_service.py')
spec = importlib.util.spec_from_file_location('search_service', module_path)
assert spec is not None and spec.loader is not None
search_service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search_service)

class DummyHandler(search_service.SearchHandler):
    def __init__(self, path):
        self.path = path
        self.status = None
        self.headers = []
        self.wfile = SimpleNamespace(data=b'', write=lambda b: setattr(self.wfile, 'data', self.wfile.data + b))

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        self.headers.append((key, value))

    def end_headers(self):
        pass


def test_healthz_alias_matches_health():
    handler = DummyHandler('/healthz')
    handler.do_GET()
    assert handler.status == 200
    assert handler.wfile.data == b'OK'


def main():
    test_healthz_alias_matches_health()
    print('search_service contract tests passed')

if __name__ == '__main__':
    main()
