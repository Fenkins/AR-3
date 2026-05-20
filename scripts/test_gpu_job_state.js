#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'gpu-job-state.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.filename = sourcePath
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const {
  GPU_JOB_STATUSES,
  isValidGpuJobTransition,
  buildGpuJobRecord,
  applyWorkerResultToJob,
  applyWorkerQueueStateToJob,
  pruneFileQueueForSpace,
  validateGpuJobInput,
  normalizeGpuJobInput,
} = m.exports

assert.deepStrictEqual(GPU_JOB_STATUSES, ['queued', 'preparing_workbench', 'installing_dependencies', 'running_experiment', 'validating_evidence', 'failed_validation', 'failed_runtime', 'completed', 'cancelled'])
assert.equal(isValidGpuJobTransition('queued', 'preparing_workbench'), true)
assert.equal(isValidGpuJobTransition('preparing_workbench', 'installing_dependencies'), true)
assert.equal(isValidGpuJobTransition('installing_dependencies', 'running_experiment'), true)
assert.equal(isValidGpuJobTransition('running_experiment', 'validating_evidence'), true)
assert.equal(isValidGpuJobTransition('validating_evidence', 'completed'), true)
assert.equal(isValidGpuJobTransition('validating_evidence', 'failed_validation'), true)
assert.equal(isValidGpuJobTransition('running_experiment', 'failed_runtime'), true)
assert.equal(isValidGpuJobTransition('completed', 'running_experiment'), false)
assert.equal(isValidGpuJobTransition('cancelled', 'queued'), false)


{
  const valid = validateGpuJobInput({ spaceId: 'spaceA', stageName: 'HeartbeatProbe', prompt: '{"action":"run_python","code":"print(1)","dependencies":[]}' })
  assert.deepStrictEqual(valid.errors, [])
  const normalized = normalizeGpuJobInput({ spaceId: 'spaceA', stageName: 'HeartbeatProbe', prompt: { action: 'run_python', code: 'print(1)', dependencies: [] } })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.value.prompt, '{"action":"run_python","code":"print(1)","dependencies":[]}')
  assert.deepStrictEqual(normalized.value.promptObject, { action: 'run_python', code: 'print(1)', dependencies: [] })
  const invalidObject = normalizeGpuJobInput({ spaceId: 'spaceA', stageName: 'HeartbeatProbe', prompt: { action: 'shell', code: 'print(1)' } })
  assert.equal(invalidObject.ok, false)
  assert.match(invalidObject.errors.join(' '), /prompt.action must be run_python/i)
}

{
  const job = buildGpuJobRecord({
    spaceId: 'space 1',
    stageName: 'Implementation',
    prompt: 'run experiment',
    context: 'context',
  }, new Date('2026-05-13T00:00:00Z'), 'abc123')
  assert.equal(job.jobId, 'gpu_space-1_1778630400000_abc123')
  assert.equal(job.status, 'queued')
  assert.equal(job.events.length, 1)
  assert.equal(job.events[0].toStatus, 'queued')
}

{
  const job = buildGpuJobRecord({ spaceId: 'spaceA', stageName: 'Testing', prompt: 'p', context: '' }, new Date('2026-05-13T00:00:00Z'), 'n')
  const completed = applyWorkerResultToJob(job, {
    jobId: job.jobId,
    output: '{"metric": 1}',
    code: 'print(1)',
    completedAt: '2026-05-13T00:01:00Z',
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.output, '{"metric": 1}')
  assert.deepStrictEqual(completed.events.map((event) => event.toStatus), ['queued', 'validating_evidence', 'completed'])
  assert.equal(completed.events.at(-2).fromStatus, 'queued')
  assert.match(completed.events.at(-2).message, /validating runtime evidence/i)
  assert.equal(completed.events.at(-1).toStatus, 'completed')

  const failed = applyWorkerResultToJob(job, {
    jobId: job.jobId,
    output: '',
    error: 'Traceback: boom',
    completedAt: '2026-05-13T00:02:00Z',
  })
  assert.equal(failed.status, 'failed_runtime')
  assert.equal(failed.result.error, 'Traceback: boom')
  assert.deepStrictEqual(failed.events.map((event) => event.toStatus), ['queued', 'validating_evidence', 'failed_runtime'])

  const failedValidation = applyWorkerResultToJob(job, {
    jobId: job.jobId,
    output: '{"contract_failure_reason":"bad"}',
    error: 'Experiment output self-reported contract_failure_reason: bad',
    success: false,
    completedAt: '2026-05-13T00:03:00Z',
  })
  assert.equal(failedValidation.status, 'failed_validation')
  assert.equal(failedValidation.result.error, 'Experiment output self-reported contract_failure_reason: bad')
}

{
  const job = buildGpuJobRecord({ spaceId: 'spaceA', stageName: 'Testing', prompt: 'p', context: '' }, new Date('2026-05-13T00:00:00Z'), 'n')
  const validating = applyWorkerQueueStateToJob(job, {
    jobId: job.jobId,
    status: 'validating_evidence',
    updatedAt: '2026-05-13T00:00:30Z',
  })
  const completed = applyWorkerResultToJob(validating, {
    jobId: job.jobId,
    output: '{"metric": 1, "cuda_available": true}',
    completedAt: '2026-05-13T00:01:00Z',
  })
  assert.deepStrictEqual(completed.events.map((event) => event.toStatus), ['queued', 'validating_evidence', 'completed'])
}

{
  const job = buildGpuJobRecord({ spaceId: 'spaceA', stageName: 'Investigation', prompt: 'p', context: '' }, new Date('2026-05-13T00:00:00Z'), 'n')
  const claimed = applyWorkerQueueStateToJob(job, {
    jobId: job.jobId,
    status: 'claimed',
    claimedAt: '2026-05-13T00:00:10Z',
  })
  assert.equal(claimed.status, 'preparing_workbench')
  assert.equal(claimed.updatedAt, '2026-05-13T00:00:10Z')
  assert.equal(claimed.events.at(-1).toStatus, 'preparing_workbench')
  assert.match(claimed.events.at(-1).message, /claimed/i)

  const directInstalling = applyWorkerQueueStateToJob(job, {
    jobId: job.jobId,
    status: 'installing_dependencies',
    updatedAt: '2026-05-13T00:00:20Z',
  })
  assert.equal(directInstalling.status, 'installing_dependencies')
  assert.equal(directInstalling.updatedAt, '2026-05-13T00:00:20Z')
  assert.equal(directInstalling.events.at(-1).toStatus, 'installing_dependencies')

  const installing = applyWorkerQueueStateToJob(claimed, {
    jobId: job.jobId,
    status: 'installing_dependencies',
    updatedAt: '2026-05-13T00:00:30Z',
  })
  assert.equal(installing.status, 'installing_dependencies')
  assert.equal(installing.updatedAt, '2026-05-13T00:00:30Z')

  const running = applyWorkerQueueStateToJob(installing, {
    jobId: job.jobId,
    status: 'running_experiment',
    startedAt: '2026-05-13T00:01:00Z',
  })
  assert.equal(running.status, 'running_experiment')
  assert.equal(running.updatedAt, '2026-05-13T00:01:00Z')
  assert.equal(running.events.at(-1).toStatus, 'running_experiment')
  assert.match(running.events.at(-1).message, /running/i)

  const validating = applyWorkerQueueStateToJob(running, {
    jobId: job.jobId,
    status: 'validating_evidence',
    updatedAt: '2026-05-13T00:02:00Z',
  })
  assert.equal(validating.status, 'validating_evidence')
  assert.equal(validating.updatedAt, '2026-05-13T00:02:00Z')

  const failedValidation = applyWorkerQueueStateToJob(validating, {
    jobId: job.jobId,
    status: 'failed_validation',
    updatedAt: '2026-05-13T00:02:30Z',
  })
  assert.equal(failedValidation.status, 'failed_validation')
  assert.equal(failedValidation.updatedAt, '2026-05-13T00:02:30Z')
  assert.equal(failedValidation.events.at(-1).toStatus, 'failed_validation')
}

{
  const queue = [
    { jobId: 'gpu_spaceA_1_x', spaceId: 'spaceA' },
    { jobId: 'gpu_spaceB_1_x', spaceId: 'spaceB' },
    { jobId: 'gpu_spaceA_2_x', spaceId: 'spaceA' },
  ]
  const { remaining, removed } = pruneFileQueueForSpace(queue, 'spaceA')
  assert.equal(removed, 2)
  assert.deepStrictEqual(remaining.map((j) => j.spaceId), ['spaceB'])
}

console.log('gpu job state tests passed')
