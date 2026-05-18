#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'research-engine.ts')
const contractPath = path.join(__dirname, '..', 'lib', 'gpu-command-contract.ts')
const fullSource = fs.readFileSync(sourcePath, 'utf8')
const contractSource = fs.readFileSync(contractPath, 'utf8')
const contractStart = contractSource.indexOf('export function assessGpuStepCompletion')
const contractEnd = contractSource.indexOf('\nexport function extractPersistablePreparationManifest', contractStart)
const helperStart = fullSource.indexOf('export function formatCompletedGpuJobStepResult')
const helperEnd = fullSource.indexOf('\nasync function reconcileCompletedGpuJobsForRunningSteps', helperStart)
if (contractStart === -1 || contractEnd === -1 || helperStart === -1 || helperEnd === -1) {
  throw new Error('GPU resume reconciliation helpers are missing')
}

const source = contractSource.slice(contractStart, contractEnd) + '\n' + fullSource.slice(helperStart, helperEnd)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const {
  assessGpuStepCompletion,
  formatCompletedGpuJobStepResult,
  gpuJobMatchesRunningStep,
  runningVariantIsStaleWithoutActiveStep,
  runningStepIsStaleWithoutGpuJob,
} = m.exports

const job = {
  jobId: 'gpu_space_123',
  submittedAt: new Date('2026-05-17T21:42:52Z'),
  prompt: '{"action":"run_python","code":"step_description = \"download weights\""}',
  resultJson: JSON.stringify({
    success: true,
    jobId: 'gpu_space_123',
    code: 'print("cuda_available=true")',
    output: '{"cuda_available":true,"artifact":"metrics.json"}',
  }),
}

const resultText = formatCompletedGpuJobStepResult(job)
assert.match(resultText, /\[GPU Execution Result\] job:gpu_space_123/)
assert.match(resultText, /\[CODE\]\nprint\("cuda_available=true"\)/)
assert.equal(assessGpuStepCompletion(resultText).valid, true)

const failedRuntimeJob = {
  jobId: 'gpu_space_failed_runtime',
  submittedAt: new Date('2026-05-17T21:44:00Z'),
  prompt: '{"action":"run_python","code":"raise RuntimeError(\"boom\")"}',
  resultJson: JSON.stringify({
    success: false,
    jobId: 'gpu_space_failed_runtime',
    code: 'raise RuntimeError("boom")',
    error: 'RuntimeError: boom',
  }),
}

const failedRuntimeText = formatCompletedGpuJobStepResult(failedRuntimeJob)
assert.match(failedRuntimeText, /\[GPU Execution Error\] job:gpu_space_failed_runtime: RuntimeError: boom/)
assert.match(failedRuntimeText, /\[CODE\]\nraise RuntimeError\("boom"\)/)
assert.equal(
  gpuJobMatchesRunningStep(
    { description: 'download weights', name: 'Download weights', updatedAt: new Date('2026-05-17T21:42:00Z') },
    job,
  ),
  true,
)
assert.equal(
  gpuJobMatchesRunningStep(
    { description: 'different step', name: 'Other', updatedAt: new Date('2026-05-17T21:42:00Z') },
    job,
  ),
  false,
)
assert.equal(
  gpuJobMatchesRunningStep(
    { description: 'different step', name: 'Other', updatedAt: new Date('2026-05-17T21:42:00Z') },
    job,
    { allowTimingFallback: true },
  ),
  true,
)
assert.equal(
  gpuJobMatchesRunningStep(
    { description: 'download weights', name: 'Download weights', updatedAt: new Date('2026-05-17T21:50:00Z') },
    job,
  ),
  false,
)

const codeOnlyJob = {
  jobId: 'gpu_space_456',
  submittedAt: new Date('2026-05-17T21:43:30Z'),
  prompt: '{"action":"run_python","dependencies":["torch"],"code":"print({\\\"cuda_available\\\": true})"}',
  resultJson: JSON.stringify({
    success: true,
    jobId: 'gpu_space_456',
    code: 'print("downloaded_files")',
    output: '{"downloaded_files":["model-00001-of-00006.safetensors"],"local_dir":"/tmp/model"}',
  }),
}

assert.equal(
  gpuJobMatchesRunningStep(
    { description: 'Download all model weights', name: 'Download model files', updatedAt: new Date('2026-05-17T21:43:00Z') },
    codeOnlyJob,
  ),
  false,
)
assert.equal(
  gpuJobMatchesRunningStep(
    { description: 'Download all model weights', name: 'Download model files', updatedAt: new Date('2026-05-17T21:43:00Z') },
    codeOnlyJob,
    { allowTimingFallback: true },
  ),
  true,
)
assert.equal(
  runningStepIsStaleWithoutGpuJob(
    { status: 'RUNNING', description: 'Download all model weights', name: 'Download model files', updatedAt: new Date('2026-05-17T21:43:00Z') },
    [codeOnlyJob],
    new Date('2026-05-17T22:00:00Z').getTime(),
    10 * 60 * 1000,
    { allowTimingFallback: true },
  ),
  false,
)

assert.equal(
  runningStepIsStaleWithoutGpuJob(
    { status: 'RUNNING', description: 'call provider then run GPU', name: 'Provider step', updatedAt: new Date('2026-05-17T21:00:00Z') },
    [],
    new Date('2026-05-17T21:20:01Z').getTime(),
  ),
  true,
)
assert.equal(
  runningStepIsStaleWithoutGpuJob(
    { status: 'RUNNING', description: 'download weights', name: 'Download weights', updatedAt: new Date('2026-05-17T21:42:00Z') },
    [job],
    new Date('2026-05-17T22:00:00Z').getTime(),
  ),
  false,
)
assert.equal(
  runningStepIsStaleWithoutGpuJob(
    { status: 'RUNNING', description: 'too fresh', name: 'Fresh', updatedAt: new Date('2026-05-17T21:59:00Z') },
    [],
    new Date('2026-05-17T22:00:00Z').getTime(),
  ),
  false,
)

assert.equal(
  runningVariantIsStaleWithoutActiveStep(
    { status: 'RUNNING', updatedAt: new Date('2026-05-17T21:00:00Z') },
    [
      { status: 'FAILED', updatedAt: new Date('2026-05-17T21:05:00Z') },
      { status: 'PENDING', updatedAt: new Date('2026-05-17T21:05:00Z') },
    ],
    [],
    new Date('2026-05-17T21:20:01Z').getTime(),
  ),
  true,
)
assert.equal(
  runningVariantIsStaleWithoutActiveStep(
    { status: 'RUNNING', updatedAt: new Date('2026-05-17T21:00:00Z') },
    [{ status: 'PENDING', updatedAt: new Date('2026-05-17T21:05:00Z') }],
    [{ status: 'running_experiment' }],
    new Date('2026-05-17T21:20:01Z').getTime(),
  ),
  false,
)
assert.equal(
  runningVariantIsStaleWithoutActiveStep(
    { status: 'RUNNING', updatedAt: new Date('2026-05-17T21:00:00Z') },
    [
      { status: 'RUNNING', updatedAt: new Date('2026-05-17T21:05:00Z') },
      { status: 'PENDING', updatedAt: new Date('2026-05-17T21:05:00Z') },
    ],
    [],
    new Date('2026-05-17T21:20:01Z').getTime(),
  ),
  false,
)

assert.match(fullSource, /reconcileCompletedGpuJobsForRunningSteps\(spaceId\)/)
assert.match(fullSource, /status: \{ in: \['completed', 'failed_runtime', 'failed_validation'\] \}/)
assert.match(fullSource, /\[resumeSpace\] Reconciled/)
assert.match(fullSource, /recoverStaleRunningStepsWithoutGpuJobs\(spaceId\)/)
assert.match(fullSource, /\[resumeSpace\] Recovered/)
assert.match(fullSource, /recoverStaleRunningVariantsWithoutActiveSteps\(spaceId\)/)
assert.match(fullSource, /\[resumeSpace\] Recovered .*stale RUNNING variant/)
assert.match(fullSource, /\[startBackgroundLoop\] Reconciled/)
assert.match(fullSource, /\[startBackgroundLoop\] Recovered/)

console.log('gpu resume reconciliation tests passed')
