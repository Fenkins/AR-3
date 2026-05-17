#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'research-engine.ts')
const fullSource = fs.readFileSync(sourcePath, 'utf8')
const start = fullSource.indexOf('export function gpuJobPollTimeoutMsFromConfig')
if (start === -1) throw new Error('gpuJobPollTimeoutMsFromConfig export is missing')
const end = fullSource.indexOf('\nfunction readGpuJobPollTimeoutMs', start)
if (end === -1) throw new Error('readGpuJobPollTimeoutMs function should follow gpuJobPollTimeoutMsFromConfig')

const source = fullSource.slice(start, end)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)
const { gpuJobPollTimeoutMsFromConfig } = m.exports

assert.equal(gpuJobPollTimeoutMsFromConfig({ jobTimeout: 18000 }), 18000000)
assert.equal(gpuJobPollTimeoutMsFromConfig({ jobTimeout: 60 }), 300000)
assert.equal(gpuJobPollTimeoutMsFromConfig({ jobTimeout: 'bad' }), 300000)
assert.equal(gpuJobPollTimeoutMsFromConfig(null), 300000)

assert.doesNotMatch(fullSource, /Job did not complete within 5 minutes/)
assert.match(fullSource, /readGpuJobPollTimeoutMs\(\)/)

console.log('gpu poll timeout config tests passed')
