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

const { assessDeadLoop, variantFailureSignature, variantProgressSignature, variantCodeSignature } = m.exports

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

const repeatedNonImprovingCompletion = (id, metric = '0.1000', grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: 'No measurable improvement over baseline.',
  steps: [{
    status: 'COMPLETED',
    result: `workbench=/tmp/ar3-workbenches/${id}/run.py job=job-${id} metrics={\"accuracy\":${metric},\"cuda_available\":true}`,
  }],
})

const repeatedCodeFailure = (id, error) => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: error,
  steps: [{
    status: 'FAILED',
    result: '[GPU Execution Error] job:gpu_space_' + id + ': ' + error + '\n' +
      '[CODE]\n' +
      'import json\n' +
      'import torch\n' +
      'print(json.dumps({"cuda_available": torch.cuda.is_available(), "metric": 0.1}))\n' +
      '[/CODE]',
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
  const first = variantCodeSignature(repeatedCodeFailure('a', 'ModuleNotFoundError: no module named transformers'))
  const second = variantCodeSignature(repeatedCodeFailure('b', 'CUDA out of memory while allocating tensor'))
  assert.equal(first, second, 'same executable code should create the same code signature despite different runtime errors')
}

{
  const assessment = assessDeadLoop([
    repeatedCodeFailure('a', 'ModuleNotFoundError: no module named transformers'),
    repeatedCodeFailure('b', 'CUDA out of memory while allocating tensor'),
    repeatedCodeFailure('c', 'FileNotFoundError: missing artifact'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /same normalized executable code signature/)
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

{
  const first = variantProgressSignature(repeatedNonImprovingCompletion('a'))
  const second = variantProgressSignature(repeatedNonImprovingCompletion('b'))
  assert.equal(first, second, 'ephemeral paths and job ids should not create new progress signatures')
}

{
  const assessment = assessDeadLoop([
    repeatedNonImprovingCompletion('a'),
    repeatedNonImprovingCompletion('b'),
    repeatedNonImprovingCompletion('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedNonImprovingCompletion('a', '0.1000', 42),
    repeatedNonImprovingCompletion('b', '0.1000', 42),
    repeatedNonImprovingCompletion('c', '0.1000', 42),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedNonImprovingCompletion('a', '0.1000', 10),
    repeatedNonImprovingCompletion('b', '0.1000', 20),
    repeatedNonImprovingCompletion('c', '0.1000', 30),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const assessment = assessDeadLoop([
    repeatedNonImprovingCompletion('a', '0.1000'),
    repeatedNonImprovingCompletion('b', '0.2000'),
    repeatedNonImprovingCompletion('c', '0.3000'),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

console.log('dead-loop detector tests passed')