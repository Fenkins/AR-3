#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'gpu-step-display.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)
const { parseGpuStepResult, previewStepResult } = m.exports

const legacy = '{"action":"run_python","dependencies":["requests","huggingface-hub","numpy"],"code":"print(1)"}\n\n[GPU Execution Result] job:gpu_123\n[CODE]\nprint("secret code")\n[/CODE]\n{"cuda_available":true,"gasket_score":0.73,"baseline_score":0.41}'
const parsed = parseGpuStepResult(legacy)
assert.equal(parsed.isGpu, true)
assert.equal(parsed.jobId, 'gpu_123')
assert.equal(parsed.ok, true)
assert.equal(parsed.code.trim(), 'print("secret code")')
assert.ok(parsed.output.includes('"gasket_score":0.73'))
assert.ok(!parsed.output.includes('"action":"run_python"'))
assert.equal(previewStepResult(legacy), 'GPU OK — gpu_123 — cuda_available=true, gasket_score=0.73, baseline_score=0.41')

const modern = '[GPU Execution Result] job:gpu_456\n[CODE]\nprint("x")\n[/CODE]\n[OUTPUT]\n{"cuda_available":true,"projection_residual":0.12}'
assert.equal(previewStepResult(modern), 'GPU OK — gpu_456 — cuda_available=true, projection_residual=0.12')

const nonGpu = 'plain text result that should be shortened'
assert.equal(previewStepResult(nonGpu, 12), 'plain text …')

console.log('gpu step display tests passed')
