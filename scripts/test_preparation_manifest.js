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
  assert.doesNotMatch(retry, /```/)
}

{
  const wrapped = `Here is the manifest:\n\`\`\`json\n${JSON.stringify(validManifest())}\n\`\`\``
  const extracted = extractPreparationManifestCandidate(wrapped)
  const result = validatePreparationManifest(extracted)
  assert.equal(result.ok, true, result.errors.join('\n'))
}

console.log('preparation manifest tests passed')
