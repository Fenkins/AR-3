#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

function loadTs(relativePath) {
  const sourcePath = path.join(__dirname, '..', relativePath)
  const source = fs.readFileSync(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const m = new Module(sourcePath, module)
  m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
  const originalRequire = m.require.bind(m)
  m.require = (id) => {
    if (id === './prisma') return { prisma: { $executeRaw: async () => 0 } }
    if (id === './huggingface-utils') return {
      buildCurlDownloadInvocation: () => ({}),
      buildSnapshotDownloadInvocation: () => ({}),
      isHuggingFaceRepoUrl: () => false,
      modelIdFromHuggingFaceRepoUrl: () => '',
    }
    if (id === './secret-redaction') return { redactSecrets: (x) => String(x) }
    return originalRequire(id)
  }
  m._compile(compiled, sourcePath)
  return m.exports
}

const { clampModelCacheFileSize } = loadTs('lib/model-cache.ts')

assert.equal(typeof clampModelCacheFileSize, 'function', 'model-cache must export a reusable fileSize guard')
assert.equal(clampModelCacheFileSize(16_038_195_604), 2_147_483_647, 'large model snapshots must be clamped before Prisma Int reads/writes')
assert.equal(clampModelCacheFileSize(42), 42)
assert.equal(clampModelCacheFileSize(-10), 0)
assert.equal(clampModelCacheFileSize(Number.NaN), 0)


const { validateLoadableSnapshotPath } = loadTs('lib/model-cache.ts')

assert.equal(typeof validateLoadableSnapshotPath, 'function', 'model-cache must export loadable snapshot validation')
const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ar3-model-cache-guard-'))
try {
  const good = path.join(tmpRoot, 'good')
  fs.mkdirSync(good)
  fs.writeFileSync(path.join(good, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { 'layer.a': 'model-00001-of-00002.safetensors', 'layer.b': 'model-00002-of-00002.safetensors' } }))
  fs.writeFileSync(path.join(good, 'model-00001-of-00002.safetensors'), 'a')
  fs.writeFileSync(path.join(good, 'model-00002-of-00002.safetensors'), 'b')
  assert.deepEqual(validateLoadableSnapshotPath(good), { ok: true }, 'complete sharded snapshots should be accepted')

  const missing = path.join(tmpRoot, 'missing')
  fs.mkdirSync(missing)
  fs.writeFileSync(path.join(missing, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { 'layer.a': 'model-00001-of-00002.safetensors', 'layer.b': 'model-00002-of-00002.safetensors' } }))
  fs.writeFileSync(path.join(missing, 'model-00001-of-00002.safetensors'), 'a')
  const missingResult = validateLoadableSnapshotPath(missing)
  assert.equal(missingResult.ok, false, 'missing sharded snapshot files must be rejected before ModelCache is marked COMPLETED')
  assert.match(missingResult.reason, /missing_shards=1/)

  const incomplete = path.join(tmpRoot, 'incomplete')
  fs.mkdirSync(incomplete)
  fs.writeFileSync(path.join(incomplete, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { 'layer.a': 'model-00001-of-00001.safetensors' } }))
  fs.writeFileSync(path.join(incomplete, 'model-00001-of-00001.safetensors.incomplete'), 'partial')
  const incompleteResult = validateLoadableSnapshotPath(incomplete)
  assert.equal(incompleteResult.ok, false, 'incomplete HF snapshot files must be rejected before ModelCache is marked COMPLETED')
  assert.match(incompleteResult.reason, /incomplete_downloads=1/)


  const traversal = path.join(tmpRoot, 'traversal')
  fs.mkdirSync(traversal)
  fs.writeFileSync(path.join(tmpRoot, 'outside.safetensors'), 'outside')
  fs.writeFileSync(path.join(traversal, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { 'layer.a': '../outside.safetensors' } }))
  const traversalResult = validateLoadableSnapshotPath(traversal)
  assert.equal(traversalResult.ok, false, 'snapshot index shard paths must not escape the snapshot directory')
  assert.match(traversalResult.reason, /unsafe_shard_path/)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log('model cache size guard tests passed')

