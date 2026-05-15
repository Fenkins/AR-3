#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'space-api-shape.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { normalizeSpaceForClient, normalizeVariantForClient } = m.exports

{
  const dbVariant = {
    id: 'variant-1',
    name: 'Probe variant',
    VariantStep: [
      { id: 'step-1', name: 'Run GPU smoke', order: 1 },
      { id: 'step-2', name: 'Summarize evidence', order: 2 },
    ],
  }
  const normalized = normalizeVariantForClient(dbVariant)
  assert.deepEqual(normalized.steps.map(s => s.id), ['step-1', 'step-2'])
  assert.ok(Array.isArray(normalized.steps), 'client variants must always expose steps[]')
}

{
  const malformedVariant = { id: 'variant-2', name: 'No relation yet' }
  const normalized = normalizeVariantForClient(malformedVariant)
  assert.deepEqual(normalized.steps, [])
}

{
  const dbSpace = {
    id: 'space-1',
    name: 'Fresh test space',
    Experiment: [{ id: 'exp-1' }],
    Breakthrough: [{ id: 'break-1' }],
    Variant: [{ id: 'variant-3', VariantStep: [{ id: 'step-3' }] }],
  }
  const normalized = normalizeSpaceForClient(dbSpace)
  assert.deepEqual(normalized.experiments.map(e => e.id), ['exp-1'])
  assert.deepEqual(normalized.breakthroughs.map(b => b.id), ['break-1'])
  assert.deepEqual(normalized.variants.map(v => v.id), ['variant-3'])
  assert.deepEqual(normalized.variants[0].steps.map(s => s.id), ['step-3'])
}

console.log('space api shape tests passed')
