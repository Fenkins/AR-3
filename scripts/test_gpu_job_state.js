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
} = m.exports

assert.deepStrictEqual(GPU_JOB_STATUSES, ['queued', 'preparing', 'running', 'failed_validation', 'failed_runtime', 'completed', 'cancelled'])
assert.equal(isValidGpuJobTransition('queued', 'preparing'), true)
assert.equal(isValidGpuJobTransition('preparing', 'running'), true)
assert.equal(isValidGpuJobTransition('running', 'completed'), true)
assert.equal(isValidGpuJobTransition('running', 'failed_runtime'), true)
assert.equal(isValidGpuJobTransition('completed', 'running'), false)
assert.equal(isValidGpuJobTransition('cancelled', 'queued'), false)

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
  assert.equal(completed.events.at(-1).toStatus, 'completed')

  const failed = applyWorkerResultToJob(job, {
    jobId: job.jobId,
    output: '',
    error: 'Traceback: boom',
    completedAt: '2026-05-13T00:02:00Z',
  })
  assert.equal(failed.status, 'failed_runtime')
  assert.equal(failed.result.error, 'Traceback: boom')
}

{
  const job = buildGpuJobRecord({ spaceId: 'spaceA', stageName: 'Investigation', prompt: 'p', context: '' }, new Date('2026-05-13T00:00:00Z'), 'n')
  const claimed = applyWorkerQueueStateToJob(job, {
    jobId: job.jobId,
    status: 'claimed',
    claimedAt: '2026-05-13T00:00:10Z',
  })
  assert.equal(claimed.status, 'preparing')
  assert.equal(claimed.updatedAt, '2026-05-13T00:00:10Z')
  assert.equal(claimed.events.at(-1).toStatus, 'preparing')
  assert.match(claimed.events.at(-1).message, /claimed/i)

  const running = applyWorkerQueueStateToJob(claimed, {
    jobId: job.jobId,
    status: 'running',
    startedAt: '2026-05-13T00:01:00Z',
  })
  assert.equal(running.status, 'running')
  assert.equal(running.updatedAt, '2026-05-13T00:01:00Z')
  assert.equal(running.events.at(-1).toStatus, 'running')
  assert.match(running.events.at(-1).message, /running/i)
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
