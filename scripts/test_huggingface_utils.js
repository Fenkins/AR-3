#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'huggingface-utils.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.filename = sourcePath
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { parseHuggingFaceDownloads, buildSnapshotDownloadInvocation, buildCurlDownloadInvocation } = m.exports

function names(downloads) {
  return downloads.map((d) => d.downloadUrl).sort()
}

{
  const downloads = parseHuggingFaceDownloads(`
downloads:
- https://huggingface.co/GSAI-ML/LLaDA-8B-Base/resolve/main/model-00001-of-00006.safetensors
- GSAI-ML/LLaDA-8B-Base
`)
  assert.deepStrictEqual(names(downloads), [
    'https://huggingface.co/GSAI-ML/LLaDA-8B-Base',
  ])
  assert(!names(downloads).includes('https://huggingface.co/LLaDA-8B-Base/resolve'), 'must not parse URL path fragments as model IDs')
  assert(!names(downloads).includes('https://huggingface.co/main/model-00001-of-00006.safetensors'), 'must not parse file path fragments as model IDs')
}

{
  const downloads = parseHuggingFaceDownloads(`
downloads:
- https://huggingface.co/ssslakter/LLaDA-8B-Base/resolve/main/model-00001-of-00006.safetensors
`)
  assert.deepStrictEqual(downloads.map((d) => d.downloadUrl), [
    'https://huggingface.co/ssslakter/LLaDA-8B-Base',
  ])
  assert.strictEqual(downloads[0].description, 'ssslakter/LLaDA-8B-Base snapshot')
}

{
  const invocation = buildSnapshotDownloadInvocation('owner/model-name', '/tmp/cache dir', 'secret-token')
  assert.strictEqual(invocation.command, 'python3')
  assert.deepStrictEqual(invocation.args, ['-c', 'from huggingface_hub import snapshot_download; import sys; print(snapshot_download(repo_id=sys.argv[1], local_files_only=False))', 'owner/model-name'])
  assert.strictEqual(invocation.env.HF_HUB_CACHE, '/tmp/cache dir')
  assert.strictEqual(invocation.env.HF_TOKEN, 'secret-token')
}

{
  const invocation = buildCurlDownloadInvocation('https://huggingface.co/owner/model/resolve/main/a b.safetensors', '/tmp/a b.safetensors', 'secret-token')
  assert.strictEqual(invocation.command, 'curl')
  assert.deepStrictEqual(invocation.args, ['-L', '-H', 'Authorization: Bearer secret-token', '-o', '/tmp/a b.safetensors', 'https://huggingface.co/owner/model/resolve/main/a b.safetensors'])
}

console.log('huggingface-utils tests passed')
