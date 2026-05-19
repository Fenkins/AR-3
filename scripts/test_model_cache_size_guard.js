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

console.log('model cache size guard tests passed')
