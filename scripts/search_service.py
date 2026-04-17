#!/usr/bin/env python3
"""
Lightweight search service for AR-3 research pipeline.
Provides model/repository discovery via HuggingFace, GitHub, and arXiv APIs.
Runs on internal port 4000, proxied through Next.js /api/search
"""

import json
import time
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
import urllib.request
import urllib.error

logging.basicConfig(level=logging.INFO, format='%(asctime)s [SearchService] %(message)s')
log = logging.getLogger()

HF_API = "https://huggingface.co/api"
GH_API = "https://api.github.com"
ARXIV_API = "http://export.arxiv.org/api"

# In-memory cache to avoid repeated searches (cache for 5 minutes)
_cache = {}
_CACHE_TTL = 300

def make_request(url, headers=None, timeout=10):
    """Make HTTP request with error handling"""
    h = headers or {}
    h.setdefault('User-Agent', 'AR-3-Research-Pipeline/1.0')
    h.setdefault('Accept', 'application/json')
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'error': f'HTTP {e.code}', 'message': e.read().decode('utf-8', errors='replace')}
    except Exception as e:
        return {'error': str(e)}


def search_huggingface(query, limit=5):
    """Search HuggingFace models by text query"""
    cache_key = f'hf:{query}:{limit}'
    if cache_key in _cache and time.time() - _cache[cache_key]['ts'] < _CACHE_TTL:
        log.info(f"Cache hit for HF search: {query}")
        return _cache[cache_key]['result']

    url = f"{HF_API}/models?search={urllib.parse.quote(query)}&sort=downloads&direction=-1&limit={limit}"
    data = make_request(url, timeout=15)
    if 'error' in data:
        return data

    results = []
    for m in (data if isinstance(data, list) else []):
        results.append({
            'id': m.get('id', ''),
            'downloads': m.get('downloads', 0),
            'likes': m.get('likes', 0),
            'tags': m.get('tags', [])[:5],
            'model_name': m.get('modelId', m.get('id', '')),
            'url': f"https://huggingface.co/{m.get('id', '')}",
            'download_url': f"https://huggingface.co/{m.get('id', '')}/resolve/main",
            'pipeline_tag': m.get('pipeline_tag', ''),
        })

    _cache[cache_key] = {'result': results, 'ts': time.time()}
    return results


def search_github(query, limit=5):
    """Search GitHub repositories by query"""
    cache_key = f'gh:{query}:{limit}'
    if cache_key in _cache and time.time() - _cache[cache_key]['ts'] < _CACHE_TTL:
        return _cache[cache_key]['result']

    # GitHub API requires auth for higher rate limits — use public endpoint
    url = f"{GH_API}/search/repositories?q={urllib.parse.quote(query)}&sort=stars&order=desc&per_page={limit}"
    data = make_request(url, timeout=15)
    if 'error' in data:
        return data

    results = []
    for r in (data.get('items', []) if 'items' in data else []):
        results.append({
            'name': r.get('name', ''),
            'full_name': r.get('full_name', ''),
            'description': r.get('description', ''),
            'stars': r.get('stargazers_count', 0),
            'language': r.get('language', ''),
            'url': r.get('html_url', ''),
            'clone_url': r.get('clone_url', ''),
            'updated': r.get('updated_at', ''),
        })

    _cache[cache_key] = {'result': results, 'ts': time.time()}
    return results


def search_arxiv(query, limit=5):
    """Search arXiv for research papers"""
    cache_key = f'arxiv:{query}:{limit}'
    if cache_key in _cache and time.time() - _cache[cache_key]['ts'] < _CACHE_TTL:
        return _cache[cache_key]['result']

    url = f"{ARXIV_API}/query?search_query=all:{urllib.parse.quote(query)}&start=0&max_results={limit}&sortBy=relevance"
    try:
        import xml.etree.ElementTree as ET
        req = urllib.request.Request(url, headers={'User-Agent': 'AR-3/1.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            root = ET.fromstring(resp.read())
        ns = {'atom': 'http://www.w3.org/2005/Atom', 'arxiv': 'http://arxiv.org/schemas/atom'}
        results = []
        for entry in root.findall('atom:entry', ns)[:limit]:
            results.append({
                'title': entry.find('atom:title', ns).text.replace('\n', ' ').strip() if entry.find('atom:title', ns) is not None else '',
                'summary': entry.find('atom:summary', ns).text.replace('\n', ' ').strip()[:300] + '...' if entry.find('atom:summary', ns) is not None else '',
                'published': entry.find('atom:published', ns).text[:10] if entry.find('atom:published', ns) is not None else '',
                'url': entry.find('atom:id', ns).text if entry.find('atom:id', ns) is not None else '',
                'pdf_url': entry.find('atom:link[@title=\"pdf\"]', ns).attrib.get('href', '') if entry.find('atom:link[@title="pdf"]', ns) is not None else '',
                'authors': [a.find('atom:name', ns).text for a in entry.findall('atom:author', ns) if a.find('atom:name', ns) is not None][:3],
            })
        _cache[cache_key] = {'result': results, 'ts': time.time()}
        return results
    except Exception as e:
        return {'error': str(e)}


def search_all(query, limit=5):
    """Search all sources and return combined results"""
    log.info(f"Searching all sources for: {query}")
    return {
        'huggingface': search_huggingface(query, limit),
        'github': search_github(query, limit),
        'arxiv': search_arxiv(query, limit),
        'query': query,
        'timestamp': time.time(),
    }


class SearchHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        log.info(f"{self.address_string()} - {format % args}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/health':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
            return

        if parsed.path == '/search':
            params = parse_qs(parsed.query)
            query = params.get('q', [''])[0]
            source = params.get('source', ['all'])[0]
            limit = int(params.get('limit', ['5'])[0])

            if not query:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'q parameter required'}).encode())
                return

            if source == 'hf' or source == 'huggingface':
                results = search_huggingface(query, limit)
            elif source == 'gh' or source == 'github':
                results = search_github(query, limit)
            elif source == 'arxiv':
                results = search_arxiv(query, limit)
            else:
                results = search_all(query, limit)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(results, indent=2).encode())
            return

        # Default: 404
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b'Not Found')


def main():
    port = 4000
    server = HTTPServer(('127.0.0.1', port), SearchHandler)
    log.info(f"Search service listening on http://127.0.0.1:{port}")
    log.info("Endpoints:")
    log.info("  GET /search?q=<query>&source=<hf|github|arxiv|all>&limit=<N>")
    log.info("  GET /health")
    server.serve_forever()


if __name__ == '__main__':
    main()
