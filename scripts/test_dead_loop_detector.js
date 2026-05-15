#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'dead-loop-detector.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.filename = sourcePath
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { assessDeadLoop, variantFailureSignature } = m.exports

const repeatedFailure = (id, suffix = '') => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'FAILED',
  failureMode: 'GPU_CONTRACT',
  feedback: `Strict GPU code contract failed for job gpu_space_177000_${id}: JSON action must be run_python ${suffix}`,
  steps: [{
    status: 'FAILED',
    result: `Traceback in /tmp/ar3-workbenches/${id}/run.py: line 42: response did not parse`,
  }],
})

{
  const first = variantFailureSignature(repeatedFailure('a', 'retry 1'))
  const second = variantFailureSignature(repeatedFailure('b', 'retry 2'))
  assert.equal(first, second, 'ephemeral ids and numbers should not create new failure signatures')
}

{
  const assessment = assessDeadLoop([
    repeatedFailure('a'),
    repeatedFailure('b'),
    repeatedFailure('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /same normalized failure signature/)
}

{
  const assessment = assessDeadLoop([
    repeatedFailure('a'),
    { ...repeatedFailure('b'), feedback: 'ModuleNotFoundError: no module named transformers' },
    { ...repeatedFailure('c'), feedback: 'CUDA out of memory while allocating tensor' },
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const assessment = assessDeadLoop([
    repeatedFailure('a'),
    repeatedFailure('b'),
    repeatedFailure('c'),
    { id: 'ok', stageId: 'stage_3', status: 'COMPLETED', grade: 71, steps: [] },
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
  assert.match(assessment.reason, /progress evidence/)
}

console.log('dead-loop detector tests passed')
