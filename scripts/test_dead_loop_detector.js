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

const repeatedNoisyMetricCompletion = (id, accuracy = 0.42, grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: 'No measurable improvement over baseline.',
  steps: [{
    status: 'COMPLETED',
    result: [
      `started_at=2026-05-15T16:37:0${id}Z artifact=/tmp/ar3-workbenches/${id}/metrics.json`,
      JSON.stringify({
        metrics: {
          accuracy,
          cuda_available: true,
          elapsed_ms: 1000 + id.charCodeAt(0),
          artifact_path: `/tmp/ar3-workbenches/${id}/metrics.json`,
        },
      }),
    ].join('\n'),
  }],
})

const repeatedLooseMetricCompletion = (id, accuracy = 0.42, grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: 'No measurable improvement over baseline.',
  steps: [{
    status: 'COMPLETED',
    result: [
      `started_at=2026-05-15T16:37:0${id}Z artifact_path=/tmp/ar3-workbenches/${id}/metrics.json elapsed_ms=${1000 + id.charCodeAt(0)}`,
      `accuracy: ${accuracy}`,
      'cuda_available=true',
    ].join('\n'),
  }],
})

const repeatedPythonDictMetricCompletion = (id, accuracy = 0.42, grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: 'No measurable improvement over baseline.',
  steps: [{
    status: 'COMPLETED',
    result: [
      `started_at=2026-05-15T16:37:0${id}Z artifact=/tmp/ar3-workbenches/${id}/metrics.json`,
      `metrics={'accuracy': ${accuracy}, 'cuda_available': True, 'elapsed_ms': ${1000 + id.charCodeAt(0)}, 'artifact_path': '/tmp/ar3-workbenches/${id}/metrics.json'}`,
    ].join('\n'),
  }],
})

const repeatedNestedMetricCompletion = (id, loss = 0.31, grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: 'No measurable improvement over baseline.',
  steps: [{
    status: 'COMPLETED',
    result: JSON.stringify({
      metrics: {
        evaluation: {
          loss,
          accuracy: 0.42,
        },
        layers: [
          { cosine_similarity: 0.77 },
          { cosine_similarity: 0.81 },
        ],
        cuda: {
          available: true,
          device: 'NVIDIA A100',
        },
        runtime: {
          elapsed_ms: 1000 + id.charCodeAt(0),
          artifact_path: `/tmp/ar3-workbenches/${id}/metrics.json`,
        },
      },
    }),
  }],
})

const repeatedNamedMetricRowCompletion = (id, rows, grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: 'No measurable improvement over baseline.',
  steps: [{
    status: 'COMPLETED',
    result: JSON.stringify({
      metrics: rows,
      run_id: `job-${id}`,
      artifact_path: `/tmp/ar3-workbenches/${id}/metrics.json`,
    }),
  }],
})

const completedWithoutProgressEvidence = (id, grade = 0) => ({
  id,
  stageId: 'stage_3',
  name: `Implementation ${id}`,
  status: 'COMPLETED',
  grade,
  feedback: null,
  steps: [{
    status: 'COMPLETED',
    result: `completed without numeric evidence ${id}`,
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

const repeatedDynamicFailureMode = (id) => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: 'ModuleNotFoundError: no module named transformers',
  steps: [{
    status: 'FAILED',
    result: 'GPU worker failed before executable code was captured',
  }],
})

const repeatedJsonCommandFailure = (id, dependencies = []) => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: 'GPU worker rejected runtime output',
  steps: [{
    status: 'FAILED',
    result: JSON.stringify({
      action: 'run_python',
      dependencies,
      code: [
        'import json',
        'import torch',
        'print(json.dumps({"cuda_available": torch.cuda.is_available(), "metric": 0.1}))',
      ].join('\n'),
    }),
  }],
})

const repeatedPythonDictCommandFailure = (id, dependencies = ['torch==2.4.0', 'transformers==4.45.0']) => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: 'GPU worker rejected Python-literal runtime output',
  steps: [{
    status: 'FAILED',
    result: [
      "{'action': 'run_python',",
      " 'dependencies': [" + dependencies.map(dep => "'" + dep + "'").join(', ') + "],",
      " 'model_ids': ['GSAI-ML/LLaDA-8B-Base'],",
      " 'workbenchReuseKey': 'llada-base',",
      " 'code': 'import json\\nimport torch\\nprint(json.dumps({\"cuda_available\": torch.cuda.is_available(), \"metric\": 0.1}))'}",
    ].join('\n'),
  }],
})

const repeatedPythonDictCommandWithManifest = (id, manifestContext = {}) => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: 'GPU worker rejected Python-literal runtime output with manifest context',
  steps: [{
    status: 'FAILED',
    result: [
      "{'action': 'run_python',",
      " 'dependencies': [],",
      " 'preparation_manifest': " + JSON.stringify(manifestContext).replace(/\"/g, "'") + ',',
      " 'code': 'import json\\nimport torch\\nprint(json.dumps({\"cuda_available\": torch.cuda.is_available(), \"metric\": 0.1}))'}",
    ].join('\n'),
  }],
})

const repeatedFencedCodeFailure = (id, error, fence = 'python') => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: error,
  steps: [{
    status: 'FAILED',
    result: [
      'GPU worker captured weak-model prose with executable code:',
      '```' + fence,
      'import json',
      'import torch',
      'print(json.dumps({"cuda_available": torch.cuda.is_available(), "metric": 0.1}))',
      '```',
    ].join('\n'),
  }],
})

const repeatedJsonCommandWithModels = (id, modelContext = {}) => ({
  id,
  stageId: 'stage_3',
  name: 'Implementation ' + id,
  status: 'FAILED',
  failureMode: 'RUNTIME_' + id,
  feedback: 'GPU worker rejected runtime output',
  steps: [{
    status: 'FAILED',
    result: JSON.stringify({
      action: 'run_python',
      dependencies: ['torch==2.4.0'],
      code: [
        'import json',
        'import torch',
        'print(json.dumps({"cuda_available": torch.cuda.is_available(), "metric": 0.1}))',
      ].join('\n'),
      ...modelContext,
    }),
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
  const first = variantFailureSignature(repeatedDynamicFailureMode('a'))
  const second = variantFailureSignature(repeatedDynamicFailureMode('b'))
  assert.equal(first, second, 'dynamic failureMode ids should not split identical failure signatures')
}

{
  const assessment = assessDeadLoop([
    repeatedDynamicFailureMode('a'),
    repeatedDynamicFailureMode('b'),
    repeatedDynamicFailureMode('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /same normalized failure signature/)
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
  const first = variantCodeSignature(repeatedFencedCodeFailure('a', 'ModuleNotFoundError: no module named transformers'))
  const second = variantCodeSignature(repeatedFencedCodeFailure('b', 'CUDA out of memory while allocating tensor', 'py'))
  assert.equal(first, second, 'same fenced executable code should create the same signature despite different runtime errors')
}

{
  const assessment = assessDeadLoop([
    repeatedFencedCodeFailure('a', 'ModuleNotFoundError: no module named transformers'),
    repeatedFencedCodeFailure('b', 'CUDA out of memory while allocating tensor', 'py'),
    repeatedFencedCodeFailure('c', 'FileNotFoundError: missing artifact', 'code'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /same normalized executable code signature/)
}

{
  const first = variantCodeSignature(repeatedJsonCommandFailure('a', ['torch==2.4.0', 'transformers==4.45.0']))
  const second = variantCodeSignature(repeatedJsonCommandFailure('b', ['transformers==4.45.0', 'torch==2.4.0']))
  assert.equal(first, second, 'dependency order should not create a new executable signature')
}

{
  const first = variantCodeSignature(repeatedPythonDictCommandFailure('a', ['torch==2.4.0', 'transformers==4.45.0']))
  const second = variantCodeSignature(repeatedPythonDictCommandFailure('b', ['transformers==4.45.0', 'torch==2.4.0']))
  assert.equal(first, second, 'Python-literal GPU command dependency order should not create a new executable signature')
}

{
  const first = variantCodeSignature(repeatedJsonCommandFailure('a', ['torch==2.4.0']))
  const second = variantCodeSignature(repeatedJsonCommandFailure('b', ['torch==2.5.0']))
  assert.notEqual(first, second, 'changed dependency pins should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedPythonDictCommandFailure('a', ['torch==2.4.0']))
  const second = variantCodeSignature(repeatedPythonDictCommandFailure('b', ['torch==2.5.0']))
  assert.notEqual(first, second, 'changed Python-literal dependency pins should reset repeated executable signatures')
}

{
  const assessment = assessDeadLoop([
    repeatedPythonDictCommandFailure('a'),
    repeatedPythonDictCommandFailure('b'),
    repeatedPythonDictCommandFailure('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /same normalized executable code signature/)
}

{
  const first = variantCodeSignature(repeatedPythonDictCommandWithManifest('a', {
    models: [{ id: 'GSAI-ML/LLaDA-8B-Base', source: 'huggingface' }],
    dependencies: [{ name: 'torch', versionSpec: '==2.4.0', importName: 'torch' }],
    workbench: { reuseKey: 'llada-base' },
  }))
  const second = variantCodeSignature(repeatedPythonDictCommandWithManifest('b', {
    dependencies: [{ importName: 'torch', versionSpec: '==2.4.0', name: 'torch' }],
    models: [{ source: 'huggingface', id: 'GSAI-ML/LLaDA-8B-Base' }],
    workbench: { reuseKey: 'llada-base' },
  }))
  assert.equal(first, second, 'Python-literal nested manifest context should normalize order')
}

{
  const first = variantCodeSignature(repeatedPythonDictCommandWithManifest('a', {
    models: [{ id: 'GSAI-ML/LLaDA-8B-Base', source: 'huggingface' }],
    dependencies: [{ name: 'torch', versionSpec: '==2.4.0', importName: 'torch' }],
    workbench: { reuseKey: 'llada-base' },
  }))
  const second = variantCodeSignature(repeatedPythonDictCommandWithManifest('b', {
    models: [{ id: 'Dream-org/Dream-v0-Base', source: 'huggingface' }],
    dependencies: [{ name: 'torch', versionSpec: '==2.4.0', importName: 'torch' }],
    workbench: { reuseKey: 'dream-base' },
  }))
  assert.notEqual(first, second, 'changed Python-literal nested manifest context should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', { model_ids: ['GSAI-ML/LLaDA-8B-Base'] }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', { model_ids: ['GSAI-ML/LLaDA-8B-Base'] }))
  assert.equal(first, second, 'same explicit model ids should create the same executable signature')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', { model_ids: ['GSAI-ML/LLaDA-8B-Base'] }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', { model_ids: ['Dream-org/Dream-v0-Base'] }))
  assert.notEqual(first, second, 'changed model ids should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      models: [{ id: 'GSAI-ML/LLaDA-8B-Base', source: 'huggingface' }],
      dependencies: [{ name: 'torch', versionSpec: '==2.4.0', importName: 'torch' }],
      workbench: { reuseKey: 'llada-base' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      models: [{ id: 'Dream-org/Dream-v0-Base', source: 'huggingface' }],
      dependencies: [{ name: 'torch', versionSpec: '==2.4.0', importName: 'torch' }],
      workbench: { reuseKey: 'dream-base' },
    },
  }))
  assert.notEqual(first, second, 'changed nested manifest model/workbench context should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      huggingface: [
        { model_id: 'GSAI-ML/LLaDA-8B-Base', revision: 'main' },
        { id: 'Dream-org/Dream-v0-Base' },
      ],
      installed_dependencies: ['Transformers==4.45.0', 'torch==2.4.0'],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      installed_dependencies: ['torch==2.4.0', 'transformers==4.45.0'],
      huggingface: [
        { id: 'dream-org/dream-v0-base' },
        { model_id: 'gsai-ml/llada-8b-base', revision: 'refs/heads/main' },
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  assert.equal(first, second, 'huggingface and installed dependency order/case should not create a new executable signature')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      huggingface: [{ model_id: 'GSAI-ML/LLaDA-8B-Base' }],
      installed_dependencies: ['torch==2.4.0'],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      huggingface: [{ model_id: 'Dream-org/Dream-v0-Base' }],
      installed_dependencies: ['torch==2.4.0'],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  assert.notEqual(first, second, 'changed huggingface model rows should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    dependencies: [],
    preparation_manifest: {
      dependencies: [
        { name: 'torch', versionSpec: '==2.4.0', importName: 'torch' },
        { package: 'transformers', version: '>=4.45.0', import: 'transformers' },
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    dependencies: [],
    preparation_manifest: {
      dependencies: [
        { package: 'transformers', version: '>=4.45.0', import: 'transformers' },
        { name: 'torch', versionSpec: '==2.4.0', importName: 'torch' },
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  assert.equal(first, second, 'structured manifest dependency order should not create a new executable signature')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    dependencies: [],
    preparation_manifest: {
      dependencies: [{ name: 'torch', versionSpec: '==2.4.0', importName: 'torch' }],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    dependencies: [],
    preparation_manifest: {
      dependencies: [{ name: 'torch', versionSpec: '==2.5.0', importName: 'torch' }],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  assert.notEqual(first, second, 'changed structured manifest dependency specs should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      smokeTests: [
        { name: 'model-smoke', command: 'python smoke_model.py', expectedEvidence: ['model_or_error', 'cuda_available'] },
        { name: 'metrics-smoke', command: 'python collect_metrics.py', expectedEvidence: ['metrics_json'] },
      ],
      workbench: { reuseKey: 'shared-workbench', expectedArtifacts: ['metrics.json', 'stdout.log'] },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      smokeTests: [
        { name: 'metrics-smoke', command: 'python collect_metrics.py', expectedEvidence: ['metrics_json'] },
        { name: 'model-smoke', command: 'python smoke_model.py', expectedEvidence: ['cuda_available', 'model_or_error'] },
      ],
      workbench: { reuseKey: 'shared-workbench', expectedArtifacts: ['stdout.log', 'metrics.json'] },
    },
  }))
  assert.equal(first, second, 'smoke test and artifact order should not create a new executable signature')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      smokeTests: [{ name: 'model-smoke', command: 'python smoke_model.py', expectedEvidence: ['cuda_available'] }],
      workbench: { reuseKey: 'shared-workbench', expectedArtifacts: ['metrics.json'] },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      smokeTests: [{ name: 'model-smoke', command: 'python smoke_model_v2.py', expectedEvidence: ['cuda_available'] }],
      workbench: { reuseKey: 'shared-workbench', expectedArtifacts: ['metrics.json'] },
    },
  }))
  assert.notEqual(first, second, 'changed smoke-test command should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      smokeTests: [{ name: 'model-smoke', command: 'python smoke_model.py', expectedEvidence: ['cuda_available'] }],
      workbench: { reuseKey: 'shared-workbench', expectedArtifacts: ['metrics.json'] },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      smokeTests: [{ name: 'model-smoke', command: 'python smoke_model.py', expectedEvidence: ['cuda_available'] }],
      workbench: { reuseKey: 'shared-workbench', expectedArtifacts: ['metrics.json', 'model_status.json'] },
    },
  }))
  assert.notEqual(first, second, 'changed expected artifacts should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      workbench: { reuseKey: 'shared-workbench' },
      preparation_run_history: [
        {
          success: false,
          error: 'MISSING_EVIDENCE: expected METRICS_JSON in /tmp/ar3-workbenches/a/stdout.log',
          outputTail: 'preparation_manifest=/tmp/ar3-workbenches/a/preparation_manifest.json\npreparation_run_history=/tmp/ar3-workbenches/a/preparation_run_history.json',
        },
      ],
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      workbench: { reuseKey: 'shared-workbench' },
      preparation_run_history: [
        {
          success: false,
          error: 'MISSING_EVIDENCE: expected METRICS_JSON in /tmp/ar3-workbenches/b/stdout.log',
          outputTail: 'preparation_manifest=/tmp/ar3-workbenches/b/preparation_manifest.json\npreparation_run_history=/tmp/ar3-workbenches/b/preparation_run_history.json',
        },
      ],
    },
  }))
  assert.equal(first, second, 'ephemeral workbench paths in run history should not create new executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      workbench: { reuseKey: 'shared-workbench' },
      preparation_run_history: [
        { success: false, error: 'MISSING_EVIDENCE: expected METRICS_JSON' },
      ],
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      workbench: { reuseKey: 'shared-workbench' },
      preparation_run_history: [
        { success: false, error: 'ModuleNotFoundError: no module named transformers' },
      ],
    },
  }))
  assert.notEqual(first, second, 'changed run-history failure context should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      workbench: { reuseKey: 'shared-workbench' },
      preparation_run_history: [
        { success: true, outputTail: 'metrics={"accuracy":0.42,"elapsed_ms":1000,"artifact_path":"/tmp/ar3-workbenches/a/metrics.json"}' },
      ],
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      workbench: { reuseKey: 'shared-workbench' },
      preparation_run_history: [
        { success: true, outputTail: 'metrics={"accuracy":0.44,"elapsed_ms":2000,"artifact_path":"/tmp/ar3-workbenches/b/metrics.json"}' },
      ],
    },
  }))
  assert.notEqual(first, second, 'changed run-history metric evidence should reset repeated executable signatures')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      gradingCriteria: [
        'Require metrics.json to report accuracy and cuda_available evidence',
        'Check stdout for model_id and dependency versions',
      ],
      successCriteria: [
        { name: 'accuracy floor', metric: 'accuracy', threshold: '>= 0.42', evidence: 'metrics.json' },
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      successCriteria: [
        { evidence: 'metrics.json', threshold: '>= 0.42', metric: 'accuracy', name: 'accuracy floor' },
      ],
      gradingCriteria: [
        'Check stdout for model_id and dependency versions',
        'Require metrics.json to report accuracy and cuda_available evidence',
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  assert.equal(first, second, 'grading and success criteria order should not create a new executable signature')
}

{
  const first = variantCodeSignature(repeatedJsonCommandWithModels('a', {
    preparation_manifest: {
      gradingCriteria: ['Require metrics.json to report accuracy and cuda_available evidence'],
      successCriteria: [
        { name: 'accuracy floor', metric: 'accuracy', threshold: '>= 0.42', evidence: 'metrics.json' },
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  const second = variantCodeSignature(repeatedJsonCommandWithModels('b', {
    preparation_manifest: {
      gradingCriteria: ['Require metrics.json to report loss and cuda_available evidence'],
      successCriteria: [
        { name: 'loss ceiling', metric: 'loss', threshold: '<= 0.31', evidence: 'metrics.json' },
      ],
      workbench: { reuseKey: 'shared-workbench' },
    },
  }))
  assert.notEqual(first, second, 'changed grading and success criteria should reset repeated executable signatures')
}

{
  const assessment = assessDeadLoop([
    repeatedJsonCommandFailure('a', ['torch==2.4.0']),
    repeatedJsonCommandFailure('b', ['torch==2.5.0']),
    repeatedJsonCommandFailure('c', ['torch==2.6.0']),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
  assert.match(assessment.reason, /varied executable code|varied failure signatures|not enough failed variants/)
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

{
  const first = variantProgressSignature(repeatedNoisyMetricCompletion('a'))
  const second = variantProgressSignature(repeatedNoisyMetricCompletion('b'))
  assert.equal(first, second, 'same metrics should create the same progress signature despite noisy runtime fields')
}

{
  const assessment = assessDeadLoop([
    repeatedNoisyMetricCompletion('a'),
    repeatedNoisyMetricCompletion('b'),
    repeatedNoisyMetricCompletion('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedNoisyMetricCompletion('a', 0.42),
    repeatedNoisyMetricCompletion('b', 0.43),
    repeatedNoisyMetricCompletion('c', 0.44),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const first = variantProgressSignature(repeatedLooseMetricCompletion('a'))
  const second = variantProgressSignature(repeatedLooseMetricCompletion('b'))
  assert.equal(first, second, 'loose key/value metrics should create the same progress signature despite noisy runtime fields')
}

{
  const assessment = assessDeadLoop([
    repeatedLooseMetricCompletion('a'),
    repeatedLooseMetricCompletion('b'),
    repeatedLooseMetricCompletion('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedLooseMetricCompletion('a', 0.42),
    repeatedLooseMetricCompletion('b', 0.43),
    repeatedLooseMetricCompletion('c', 0.44),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const first = variantProgressSignature(repeatedPythonDictMetricCompletion('a'))
  const second = variantProgressSignature(repeatedPythonDictMetricCompletion('b'))
  assert.equal(first, second, 'Python-style metric dicts should create the same progress signature despite noisy runtime fields')
}

{
  const assessment = assessDeadLoop([
    repeatedPythonDictMetricCompletion('a'),
    repeatedPythonDictMetricCompletion('b'),
    repeatedPythonDictMetricCompletion('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedPythonDictMetricCompletion('a', 0.42),
    repeatedPythonDictMetricCompletion('b', 0.43),
    repeatedPythonDictMetricCompletion('c', 0.44),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const first = variantProgressSignature(repeatedNestedMetricCompletion('a'))
  const second = variantProgressSignature(repeatedNestedMetricCompletion('b'))
  assert.equal(first, second, 'nested metrics should create the same progress signature despite noisy nested runtime fields')
}

{
  const assessment = assessDeadLoop([
    repeatedNestedMetricCompletion('a'),
    repeatedNestedMetricCompletion('b'),
    repeatedNestedMetricCompletion('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedNestedMetricCompletion('a', 0.31),
    repeatedNestedMetricCompletion('b', 0.28),
    repeatedNestedMetricCompletion('c', 0.25),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const first = variantProgressSignature(repeatedNamedMetricRowCompletion('a', [
    { name: 'accuracy', value: 0.42 },
    { metric: 'loss', score: 0.31 },
  ]))
  const second = variantProgressSignature(repeatedNamedMetricRowCompletion('b', [
    { metric: 'loss', score: 0.31 },
    { name: 'accuracy', value: 0.42 },
  ]))
  assert.equal(first, second, 'named metric row order should not create a new progress signature')
}

{
  const first = variantProgressSignature(repeatedNamedMetricRowCompletion('a', [
    { name: 'accuracy', value: 0.42 },
  ]))
  const second = variantProgressSignature(repeatedNamedMetricRowCompletion('b', [
    { name: 'loss', value: 0.42 },
  ]))
  assert.notEqual(first, second, 'named metric rows should include the metric identity, not only the value')
}

{
  const first = variantProgressSignature(repeatedNamedMetricRowCompletion('a', [
    { metric_name: 'accuracy', metric_value: 0.42 },
  ]))
  const second = variantProgressSignature(repeatedNamedMetricRowCompletion('b', [
    { metric_name: 'loss', metric_value: 0.42 },
  ]))
  assert.notEqual(first, second, 'metric_name/metric_value rows should keep the metric identity')
}

{
  const first = variantProgressSignature(repeatedNamedMetricRowCompletion('a', [
    { metricName: 'accuracy', metricValue: 0.42 },
  ]))
  const second = variantProgressSignature(repeatedNamedMetricRowCompletion('b', [
    { metricName: 'accuracy', metricValue: 0.42 },
  ]))
  assert.equal(first, second, 'metricName/metricValue rows should create stable progress signatures')
}

{
  const assessment = assessDeadLoop([
    repeatedNamedMetricRowCompletion('a', [{ name: 'accuracy', value: 0.42 }]),
    repeatedNamedMetricRowCompletion('b', [{ name: 'accuracy', value: 0.42 }]),
    repeatedNamedMetricRowCompletion('c', [{ name: 'accuracy', value: 0.42 }]),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedCount, 3)
  assert.match(assessment.reason, /no grade improvement/)
}

{
  const assessment = assessDeadLoop([
    repeatedNamedMetricRowCompletion('a', [{ name: 'accuracy', value: 0.42 }]),
    repeatedNamedMetricRowCompletion('b', [{ name: 'accuracy', value: 0.43 }]),
    repeatedNamedMetricRowCompletion('c', [{ name: 'accuracy', value: 0.44 }]),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

{
  const assessment = assessDeadLoop([
    completedWithoutProgressEvidence('a'),
    completedWithoutProgressEvidence('b'),
    completedWithoutProgressEvidence('c'),
  ], 'stage_3')
  assert.equal(assessment.stuck, true)
  assert.equal(assessment.repeatedSignature, 'completed-without-metric-progress-evidence')
  assert.match(assessment.reason, /without normalized metric evidence/)
}

{
  const assessment = assessDeadLoop([
    completedWithoutProgressEvidence('a', 10),
    completedWithoutProgressEvidence('b', 20),
    completedWithoutProgressEvidence('c', 30),
  ], 'stage_3')
  assert.equal(assessment.stuck, false)
}

console.log('dead-loop detector tests passed')
