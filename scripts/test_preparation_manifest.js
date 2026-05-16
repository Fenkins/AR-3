#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'preparation-manifest.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.filename = sourcePath
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { validatePreparationManifest, buildPreparationRetryMessage, extractPreparationManifestCandidate, PREPARATION_MANIFEST_SCHEMA_VERSION } = m.exports

function validManifest(overrides = {}) {
  return {
    schemaVersion: PREPARATION_MANIFEST_SCHEMA_VERSION,
    researchType: 'diffusion_language_model',
    objective: 'Run a small executable GPU smoke test for LLaDA-style masked diffusion decoding.',
    models: [
      {
        id: 'GSAI-ML/LLaDA-8B-Base',
        source: 'huggingface',
        purpose: 'base model under investigation',
        required: true,
        smokeTest: 'Load config/tokenizer and run a tiny forward pass or fail with a precise access/VRAM reason.',
      },
    ],
    dependencies: [
      { name: 'torch', purpose: 'CUDA tensor execution', required: true, importName: 'torch' },
      { name: 'transformers', purpose: 'load tokenizer/model configs', required: true, importName: 'transformers' },
    ],
    resources: [{ kind: 'gpu', name: 'cuda', purpose: 'execute smoke tests', required: true }],
    smokeTests: [
      {
        name: 'cuda-and-model-smoke-test',
        command: 'python smoke_test.py',
        expectedEvidence: ['cuda_available', 'model_or_error', 'metric_json'],
        timeoutSeconds: 300,
      },
    ],
    gradingCriteria: ['stdout contains JSON metrics', 'failures include exact unresolved model/dependency'],
    workbench: { reuseKey: 'llada-base', expectedArtifacts: ['smoke_test.py', 'metrics.json'] },
    ...overrides,
  }
}

{
  const result = validatePreparationManifest(validManifest())
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.manifest.models[0].id, 'GSAI-ML/LLaDA-8B-Base')
}

{
  const bad = validManifest({
    models: [{ id: 'LLaDA-8B-Base/re', source: 'huggingface', purpose: 'bad URL fragment', required: true }],
    dependencies: [{ name: 'stuff', purpose: 'things', required: true }],
    smokeTests: [],
  })
  const result = validatePreparationManifest(bad)
  assert.equal(result.ok, false)
  assert(result.errors.some((e) => e.includes('models[0].id')), result.errors.join('\n'))
  assert(result.errors.some((e) => e.includes('dependencies[0].name')), result.errors.join('\n'))
  assert(result.errors.some((e) => e.includes('smokeTests')), result.errors.join('\n'))
}

{
  const retry = buildPreparationRetryMessage('Original goal', ['models[0].id is not a valid HuggingFace repo id', 'smokeTests must not be empty'])
  assert.match(retry, /Original goal/)
  assert.match(retry, /models\[0\]\.id/)
  assert.match(retry, /Return ONLY JSON/)
  assert.match(retry, /measurable evidence/)
  assert.doesNotMatch(retry, /```/)
}

{
  const wrapped = `Here is the manifest:\n\`\`\`json\n${JSON.stringify(validManifest())}\n\`\`\``
  const extracted = extractPreparationManifestCandidate(wrapped)
  const result = validatePreparationManifest(extracted)
  assert.equal(result.ok, true, result.errors.join('\n'))
}

{
  const aliasManifest = validManifest()
  aliasManifest.models = [{ modelId: 'GSAI-Research/LLaDA-8B-Base', purpose: 'primary target', smokeTest: 'python -c "print(1)"' }]
  aliasManifest.dependencies = [{ package: 'torch>=2.0.0', purpose: 'tensor execution' }]
  aliasManifest.resources = [{ resourceType: 'gpu-memory', specification: '12GB VRAM', purpose: 'load model' }]
  aliasManifest.smokeTests = [{ test: 'python -c "print(1)"', expectedEvidence: 'prints 1' }]
  aliasManifest.gradingCriteria = [{ criterion: 'Code runs', evidence: 'stdout contains cuda_available' }]
  delete aliasManifest.workbench
  const result = validatePreparationManifest(aliasManifest)
  assert.equal(result.ok, true)
  assert.equal(result.manifest.models[0].id, 'GSAI-Research/LLaDA-8B-Base')
  assert.equal(result.manifest.models[0].source, 'huggingface')
  assert.equal(result.manifest.dependencies[0].name, 'torch>=2.0.0')
  assert.equal(result.manifest.smokeTests[0].command, 'python -c "print(1)"')
}

{
  const nested = validManifest({ objective: 'Nested manifest carried by run_python command.' })
  const command = {
    action: 'run_python',
    dependencies: ['torch', 'transformers'],
    preparation_manifest: nested,
    code: 'import json\nimport torch\nprint(json.dumps({"cuda_available": torch.cuda.is_available()}))',
  }
  assert.deepStrictEqual(extractPreparationManifestCandidate(JSON.stringify(command)), nested)
}

{
  const nested = validManifest({ objective: 'Camel-case nested manifest carried by run_python command.' })
  const command = {
    action: 'run_python',
    preparationManifest: nested,
    code: 'import json\nimport torch\nprint(json.dumps({"cuda_available": torch.cuda.is_available()}))',
  }
  assert.deepStrictEqual(extractPreparationManifestCandidate(JSON.stringify(command)), nested)
}

{
  const bad = validManifest({
    gradingCriteria: ['works', 'better results', 'interesting'],
  })
  const result = validatePreparationManifest(bad)
  assert.equal(result.ok, false)
  assert(result.errors.some((e) => e.includes('gradingCriteria[0]')), result.errors.join('\n'))
  assert(result.errors.some((e) => e.includes('concrete evidence')), result.errors.join('\n'))
}

{
  const result = validatePreparationManifest(validManifest({
    smokeTests: [{
      name: 'prose-placeholder',
      command: 'please run python somehow and inspect the output',
      expectedEvidence: ['cuda_available'],
      timeoutSeconds: 300,
    }],
  }))
  assert.equal(result.ok, false)
  assert(result.errors.some((e) => e.includes('smokeTests[0].command')), result.errors.join('\n'))
}

{
  const result = validatePreparationManifest(validManifest({
    smokeTests: [{
      name: 'destructive-shell',
      command: 'bash -lc "rm -rf /tmp/ar3-workbench && python smoke_test.py"',
      expectedEvidence: ['cuda_available'],
      timeoutSeconds: 300,
    }],
  }))
  assert.equal(result.ok, false)
  assert(result.errors.some((e) => e.includes('destructive')), result.errors.join('\n'))
}

{
  const result = validatePreparationManifest(validManifest({
    smokeTests: [{
      name: 'env-wrapped-python',
      command: 'env CUDA_VISIBLE_DEVICES=0 python -c "import json; print(json.dumps({\\\"cuda_available\\\": False}))"',
      expectedEvidence: ['cuda_available'],
      timeoutSeconds: 300,
    }],
    gradingCriteria: ['stdout contains cuda_available evidence'],
  }))
  assert.equal(result.ok, true, result.errors.join('\n'))
}

{
  const result = validatePreparationManifest(validManifest({
    gradingCriteria: [
      'stdout contains JSON metrics with cuda_available and tensor_sum',
      'model_metadata includes HuggingFace status_code or a precise failure error',
      'artifacts include deterministic_gpu_experiment_metrics.json path',
    ],
  }))
  assert.equal(result.ok, true, result.errors.join('\n'))
}

{
  const result = validatePreparationManifest(validManifest({
    smokeTests: [{
      name: 'trajectory-metrics',
      command: 'python smoke_test.py',
      expectedEvidence: ['cuda_available', 'trajectory_cosine_similarity'],
      timeoutSeconds: 300,
    }],
    workbench: { reuseKey: 'llada-base', expectedArtifacts: ['trajectory_metrics.json'] },
    gradingCriteria: [
      'trajectory_cosine_similarity metric improves over baseline',
      'trajectory_metrics.json artifact path is reported',
    ],
  }))
  assert.equal(result.ok, true, result.errors.join('\n'))
}

{
  const result = validatePreparationManifest(validManifest({
    smokeTests: [{
      name: 'cuda-only',
      command: 'python smoke_test.py',
      expectedEvidence: ['cuda_available'],
      timeoutSeconds: 300,
    }],
    workbench: { reuseKey: 'llada-base', expectedArtifacts: ['cuda_probe.json'] },
    gradingCriteria: ['bleu_score improves over baseline'],
  }))
  assert.equal(result.ok, false)
  assert(result.errors.some((e) => e.includes('gradingCriteria[0]') && e.includes('smokeTests.expectedEvidence')), result.errors.join('\n'))
}

console.log('preparation manifest tests passed')
