#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'research-engine.ts')
let source = fs.readFileSync(sourcePath, 'utf8')
const start = source.indexOf('export function summarizeModelDownloadStatuses')
if (start === -1) throw new Error('summarizeModelDownloadStatuses export is missing')
const end = source.indexOf('\n/**', start + 1)
source = source.slice(start, end === -1 ? undefined : end)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)
const { summarizeModelDownloadStatuses } = m.exports

{
  const result = summarizeModelDownloadStatuses([
    { downloadUrl: 'u1', status: 'COMPLETED', createdAt: new Date('2026-01-01') },
    { downloadUrl: 'u2', status: 'FAILED', createdAt: new Date('2026-01-01') },
  ], ['u1', 'u2'])
  assert.equal(result.allDone, true)
  assert.deepEqual(result.failedUrls, ['u2'])
  assert.deepEqual(result.missingUrls, [])
}

{
  const result = summarizeModelDownloadStatuses([
    { downloadUrl: 'u1', status: 'DOWNLOADING', createdAt: new Date('2026-01-01') },
  ], ['u1', 'u2'])
  assert.equal(result.allDone, false)
  assert.deepEqual(result.pendingUrls, ['u1'])
  assert.deepEqual(result.missingUrls, ['u2'])
}

{
  const result = summarizeModelDownloadStatuses([
    { downloadUrl: 'u1', status: 'FAILED', createdAt: new Date('2026-01-01') },
    { downloadUrl: 'u1', status: 'COMPLETED', createdAt: new Date('2026-01-02') },
  ], ['u1'])
  assert.equal(result.allDone, true)
  assert.deepEqual(result.failedUrls, [])
}

console.log('model download status tests passed')
