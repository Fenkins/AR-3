#!/usr/bin/env node
const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const outDir = '/tmp/ar3-strict-gpu-contract-test'
fs.rmSync(outDir, { recursive: true, force: true })
childProcess.execFileSync(
  path.join(repoRoot, 'node_modules/.bin/tsc'),
  [
    'lib/gpu-command-contract.ts',
    '--target', 'ES2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir', outDir,
  ],
  { cwd: repoRoot, stdio: 'inherit' }
)

const contract = require(path.join(outDir, 'gpu-command-contract.js'))

function testExtractsJsonAfterUnclosedThink() {
  const response = '<think>I will reason, but the model forgot to close the tag.\n{"action":"run_python","dependencies":["torch"],"code":"import json\\nimport torch\\nresult = {\\"cuda\\": torch.cuda.is_available()}\\nprint(json.dumps(result))\\nassert isinstance(result, dict)"}'
  const extracted = contract.extractStrictGpuCommand(response)
  assert.equal(extracted.ok, true, extracted.reason)
  assert.equal(extracted.command.action, 'run_python')
  assert.deepEqual(extracted.command.dependencies, ['torch'])
  assert.match(extracted.command.code, /torch\.cuda\.is_available/)
}

function testFallbackPreparationCommandIsExecutableAndPromptIndependent() {
  const fallback = contract.buildAutonomousPreparationCommand({
    researchGoal: 'Research whether org/example-model can run on this GPU with a small smoke test.',
    stepDescription: 'Prepare models, dependencies, smoke tests, and grading criteria',
    stageName: 'Investigation',
    reason: 'response did not parse as the required JSON object',
  })
  assert.equal(fallback.action, 'run_python')
  assert.ok(Array.isArray(fallback.dependencies))
  assert.ok(fallback.dependencies.includes('requests'))
  assert.match(fallback.code, /def discover_model_ids/)
  assert.match(fallback.code, /torch\.cuda\.is_available/)
  assert.match(fallback.code, /print\(json\.dumps/)
  assert.doesNotMatch(fallback.code, /TODO|placeholder|pseudocode|\.\.\./i)

  const extracted = contract.extractStrictGpuCommand(JSON.stringify(fallback))
  assert.equal(extracted.ok, true, extracted.reason)
}

function testPreparationStageWithValidatedManifestSubmitsExecutableFallbackInsteadOfRawManifestJson() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    llmResponse: JSON.stringify({
      schemaVersion: 'ar3.preparation-manifest.v1',
      researchType: 'model-behavior',
      objective: 'prepare workbench',
      models: [],
      dependencies: [],
      resources: [],
      smokeTests: [{ name: 'gpu', command: 'python smoke.py', expectedEvidence: ['cuda_available'], timeoutSeconds: 30 }],
      gradingCriteria: ['prints JSON evidence'],
      workbench: { reuseKey: 'model-behavior', expectedArtifacts: ['metrics.json'] },
    }),
    researchGoal: 'Explore an arbitrary model with GPU evidence.',
    stepDescription: 'Validated preparation manifest',
    manifestValidatedThisCycle: true,
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.equal(selected.command.action, 'run_python')
  assert.match(selected.command.code, /autonomous_preparation_manifest/)
  assert.equal(selected.fallbackUsed, true)
  assert.match(selected.reason, /preparation manifest/i)
}

function testAutonomousPreparationFallbackIsLimitedToPreparationStages() {
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Investigation'), true)
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Planning'), true)
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Implementation'), false)
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Testing'), false)
}

function testFallbackUsesWorkerProvidedWorkbenchDirectory() {
  const fallback = contract.buildAutonomousPreparationCommand({
    researchGoal: 'Any arbitrary model research goal',
    stepDescription: 'Prepare reusable sandbox',
    stageName: 'Planning',
    reason: 'invalid model output',
  })
  assert.match(fallback.code, /AR3_WORKBENCH_DIR/)
  assert.doesNotMatch(fallback.code, /research_goal\[:80\]/)
}

function testAutonomousPreparationFallbackDoesNotCompleteExperimentSteps() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Investigation',
    fallbackUsed: true,
    success: true,
    output: JSON.stringify({
      type: 'autonomous_preparation_manifest',
      contract_failure_reason: 'code contains placeholder/pseudocode markers',
      gpu: { cuda_available: true },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /preparation probe/i)
  assert.match(assessed.reason, /not a completed executable experiment/i)
}

function testPreparationProbeShapeIsInvalidEvenIfFallbackFlagIsLost() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Investigation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'autonomous_preparation_manifest',
      contract_failure_reason: 'response did not parse as the required JSON object',
      gpu: { cuda_available: true },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /preparation probe/i)
}

function testLongProseOutputIsNotValidGpuEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: 'This experiment would compare several approaches and then report whether the idea is promising. It contains no JSON metrics, files, numeric measurements, artifacts, GPU facts, or stdout evidence from executable work.',
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /measurable evidence/i)
}

function testJsonMetricsOutputIsValidGpuEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({ accuracy: 0.91, loss: 0.12, cuda_available: true }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

testExtractsJsonAfterUnclosedThink()
testFallbackPreparationCommandIsExecutableAndPromptIndependent()
testPreparationStageWithValidatedManifestSubmitsExecutableFallbackInsteadOfRawManifestJson()
testAutonomousPreparationFallbackIsLimitedToPreparationStages()
testFallbackUsesWorkerProvidedWorkbenchDirectory()
testAutonomousPreparationFallbackDoesNotCompleteExperimentSteps()
testPreparationProbeShapeIsInvalidEvenIfFallbackFlagIsLost()
testLongProseOutputIsNotValidGpuEvidence()
testJsonMetricsOutputIsValidGpuEvidence()
console.log('strict gpu contract tests passed')
