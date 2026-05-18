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
  function testRequire(name) {
    if (name === './prisma') return { prisma: {} }
    return require(name)
  }
  const context = vm.createContext({ require: testRequire, module, exports: module.exports, console, process })
  vm.runInContext(output, context, { filename: filePath })
  return module.exports
}

const { summarizeHealthSnapshot, publicHealthPayload } = loadTsModule('lib/health-status.ts')

function testHealthStatusUsesStaticPrismaImportForBundledRoute() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/health-status.ts'), 'utf8')
  assert.ok(source.includes("import { prisma } from './prisma'"))
  assert.ok(!source.includes("require('./prisma')"))
}

function testHealthySnapshotRequiresWebWorkerGpuAndDb() {
  const summary = summarizeHealthSnapshot({
    nowMs: 10_000,
    webProcess: true,
    gpuWorkerProcess: true,
    searchProcess: true,
    cloudflaredProcess: true,
    gpu: { available: true, name: 'NVIDIA GeForce GTX 1080 Ti', torchCudaAvailable: true },
    db: { ok: true, activeSpaces: 1, queuedJobs: 0, runningJobs: 1, staleRunningJobs: 0, failedRecentJobs: 0 },
    publicHttp: { ok: true, status: 200 },
  })
  assert.strictEqual(summary.status, 'healthy')
  assert.strictEqual(summary.issues.length, 0)
}

function testDegradedSnapshotFlagsMissingGpuWorkerAndStaleJobs() {
  const summary = summarizeHealthSnapshot({
    nowMs: 10_000,
    webProcess: true,
    gpuWorkerProcess: false,
    searchProcess: true,
    cloudflaredProcess: true,
    gpu: { available: true, name: 'NVIDIA GeForce GTX 1080 Ti', torchCudaAvailable: true },
    db: { ok: true, activeSpaces: 1, queuedJobs: 2, runningJobs: 1, staleRunningJobs: 1, failedRecentJobs: 0 },
    publicHttp: { ok: true, status: 200 },
  })
  assert.strictEqual(summary.status, 'degraded')
  assert.ok(summary.issues.includes('gpu_worker_process_missing'))
  assert.ok(summary.issues.includes('stale_gpu_jobs_present'))
}

function testPublicHealthPayloadDoesNotExposeInternalDetails() {
  const summary = summarizeHealthSnapshot({
    nowMs: 10_000,
    webProcess: false,
    gpuWorkerProcess: false,
    searchProcess: true,
    cloudflaredProcess: true,
    gpu: { available: false, error: 'driver failed' },
    db: { ok: false, activeSpaces: 0, queuedJobs: 9, runningJobs: 3, staleRunningJobs: 1, failedRecentJobs: 2, error: 'db path details' },
  })
  const payload = publicHealthPayload(summary)
  assert.strictEqual(payload.status, 'degraded')
  assert.strictEqual(payload.ok, false)
  assert.strictEqual(Object.keys(payload).sort().join(','), 'ok,status')
}

testHealthStatusUsesStaticPrismaImportForBundledRoute()
testHealthySnapshotRequiresWebWorkerGpuAndDb()
testDegradedSnapshotFlagsMissingGpuWorkerAndStaleJobs()
testPublicHealthPayloadDoesNotExposeInternalDetails()
console.log('health-status tests passed')
