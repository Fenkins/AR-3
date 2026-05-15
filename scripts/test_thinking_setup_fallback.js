#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
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

const { buildFallbackThinkingSetupResponse } = loadTs('lib/thinking-setup.ts')

{
  const response = buildFallbackThinkingSetupResponse(
    'Investigate ODE-based latent trajectory models',
    new Error('Request timed out.')
  )

  assert.equal(response.tokensUsed, 0)
  assert.equal(response.cost, 0)
  assert.ok(response.content.includes('deterministic fallback'))
  assert.ok(response.content.includes('Investigation'))
  assert.ok(response.content.includes('Implementation'))
  assert.ok(response.content.includes('ODE'))
  assert.ok(response.content.includes('Request timed out'))
}

{
  const response = buildFallbackThinkingSetupResponse('x'.repeat(1000), new Error('secret stack\n at foo'))
  assert.ok(response.content.length < 1800, 'fallback setup analysis should stay concise')
  assert.ok(!response.content.includes('\n at foo'), 'fallback should not expose stack traces')
}

console.log('thinking setup fallback tests passed')
