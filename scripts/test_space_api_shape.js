#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
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
  m._compile(compiled, sourcePath)
  return m.exports
}

const { normalizeSpaceForClient, normalizeVariantForClient } = loadTs('lib/space-api-shape.ts')
const { removeSpaceWorkbenchDirs } = loadTs('lib/space-cleanup.ts')

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
    currentCycle: 50,
    Experiment: [
      { id: 'exp-1', phase: 'IMPLEMENTATION', status: 'COMPLETED', cycleNumber: 1 },
      { id: 'exp-2', phase: 'EVALUATION', status: 'FAILED', cycleNumber: 1 },
    ],
    Breakthrough: [{ id: 'break-1' }],
    Variant: [{ id: 'variant-3', cycleNumber: 1, VariantStep: [{ id: 'step-3' }] }],
    _count: { Experiment: 12, Breakthrough: 2, ModelCache: 5 },
  }
  const normalized = normalizeSpaceForClient(dbSpace)
  assert.deepEqual(normalized.experiments.map(e => e.id), ['exp-1', 'exp-2'])
  assert.deepEqual(normalized.breakthroughs.map(b => b.id), ['break-1'])
  assert.deepEqual(normalized.variants.map(v => v.id), ['variant-3'])
  assert.deepEqual(normalized.variants[0].steps.map(s => s.id), ['step-3'])
  assert.equal(normalized._count.experiments, 12)
  assert.equal(normalized._count.breakthroughs, 2)
  assert.equal(normalized._count.modelCaches, 5)
  assert.equal(normalized.displayCycle, 1)
  assert.equal(normalized.completedCycleCount, 0)
  assert.equal(normalized.cycleSummary.persistedCurrentCycle, 50)
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar3-workbenches-test-'))
  const removedSpace = 'cmp-space-cleanup'
  const keepSpace = 'cmp-space-keep'
  const removedDir = path.join(root, `${removedSpace}-91148a70`)
  const namedRemovedDir = path.join(root, `${removedSpace}-research-workbench`)
  const keepDir = path.join(root, `${keepSpace}-91148a70`)
  const unrelatedDir = path.join(root, 'general-research')
  for (const dir of [removedDir, namedRemovedDir, keepDir, unrelatedDir]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'marker.txt'), dir)
  }

  const result = removeSpaceWorkbenchDirs(removedSpace, root)
  assert.equal(result.removed.length, 2)
  assert.ok(!fs.existsSync(removedDir), 'hashed workbench for deleted space should be removed')
  assert.ok(!fs.existsSync(namedRemovedDir), 'named workbench for deleted space should be removed')
  assert.ok(fs.existsSync(keepDir), 'other space workbench must not be removed')
  assert.ok(fs.existsSync(unrelatedDir), 'shared/unrelated workbench must not be removed')
}

console.log('space api shape tests passed')
