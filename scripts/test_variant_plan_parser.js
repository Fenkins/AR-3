#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'variant-engine.ts')
let source = fs.readFileSync(sourcePath, 'utf8')
// Isolate the parser helper from heavy runtime imports for a fast unit test.
const start = source.indexOf('export function parseGeneratedVariantPlan')
if (start === -1) {
  throw new Error('parseGeneratedVariantPlan export is missing')
}
const end = source.indexOf('\nexport async function generateVariants', start)
source = source.slice(start, end === -1 ? undefined : end)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { parseGeneratedVariantPlan } = m.exports

{
  const content = `
<think>private reasoning should be ignored</think>
## METADATA
name: Latent Gasket Fusion
description: Couple identical diffusion-language-model streams at inference time and measure whether latent synchronization improves output quality.
downloads: none

## STEPS
1. Load two identical LLaDA-8B-Base model references from the validated manifest.
2. Create a shared latent gasket tensor and log its initial norm.
3. Run one tiny denoising smoke pass and save logits for both streams.
4. Apply an ODE-style coupling update between stream latents.
5. Compare baseline and coupled token confidence metrics.
`
  const parsed = parseGeneratedVariantPlan(content, 25)
  assert.equal(parsed.name, 'Latent Gasket Fusion')
  assert.match(parsed.description, /diffusion-language-model/)
  assert.equal(parsed.downloadsText, 'none')
  assert.equal(parsed.validSteps.length, 5)
  assert.equal(parsed.validSteps[0], 'Load two identical LLaDA-8B-Base model references from the validated manifest.')
}

{
  const content = `
METADATA
VARIANT_NAME: Vector ODE Probe
DESCRIPTION: Probe whether the coupling vector can be updated during inference.
DOWNLOADS: none
STEPS
- step_1: Build a minimal executable PyTorch probe.
- step_2: Write metrics to AR3_ARTIFACTS_DIR.
- step_3: Assert the coupled result changes from baseline.
- step_4: Record stdout evidence for grader.
- step_5: Return a compact JSON summary.
`
  const parsed = parseGeneratedVariantPlan(content, 25)
  assert.equal(parsed.name, 'Vector ODE Probe')
  assert.equal(parsed.validSteps.length, 5)
  assert.equal(parsed.validSteps[1], 'Write metrics to AR3_ARTIFACTS_DIR.')
}

{
  const fallbackSource = fs.readFileSync(sourcePath, 'utf8')
  assert.ok(fallbackSource.includes("stageConfig.name === 'Investigation') return `${action} for ${term}: run a GPU-backed probe"), 'Investigation fallback steps must ask for executable GPU-backed probes')
  assert.ok(!fallbackSource.includes("stageConfig.name === 'Investigation') return `${action} for ${term}: synthesize prior evidence"), 'Investigation fallback must not advance on prose-only synthesis')
}

console.log('variant plan parser tests passed')
