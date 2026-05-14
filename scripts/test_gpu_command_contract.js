#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const vm = require('vm')

function loadTsModule(relativePath) {
  const filePath = path.join(__dirname, '..', relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const context = vm.createContext({ require, module, exports: module.exports, console })
  vm.runInContext(output, context, { filename: filePath })
  return module.exports
}

const { buildAutonomousPreparationCommand } = loadTsModule('lib/gpu-command-contract.ts')

function testAutonomousPreparationUsesNvidiaSmiFallback() {
  const command = buildAutonomousPreparationCommand({
    researchGoal: 'benchmark arbitrary transformer on the available GPU',
    stepDescription: 'prepare reusable workbench and validate GPU visibility',
    stageName: 'Investigation',
    reason: 'manifest validated',
  })

  assert.strictEqual(command.action, 'run_python')
  assert.ok(command.code.includes('nvidia-smi'), 'preparation probe must query nvidia-smi, not rely only on torch')
  assert.ok(command.code.includes('nvidia_smi'), 'preparation JSON should expose nvidia_smi evidence')
  assert.ok(command.code.includes('torch_cuda_available'), 'preparation JSON should distinguish torch CUDA from driver-level GPU visibility')
}

testAutonomousPreparationUsesNvidiaSmiFallback()
console.log('gpu-command-contract tests passed')
