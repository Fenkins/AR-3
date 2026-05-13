import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'
import {
  applyWorkerResultToJob,
  buildGpuJobRecord,
  GpuJobRecord,
  GpuJobStatus,
  isGpuJobStatus,
  parseJobEvents,
  parseWorkerResult,
  pruneFileQueueForSpace,
  workerQueueJob,
} from '@/lib/gpu-job-state'
import fs from 'fs'

export const dynamic = 'force-dynamic'

// Legacy worker bridge. The Python GPU worker still polls these files; the API
// now treats Prisma as the source of truth and mirrors queued jobs/results here
// until the worker can read from the DB directly.
const JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
const JOB_RESULTS_FILE = '/tmp/gpu_results.json'
const GPU_CONFIG_FILE = '/tmp/gpu_config.json'

interface GPUConfig {
  maxConcurrent: number
  jobTimeout: number
}

function getGPUConfig(): GPUConfig {
  try {
    if (!fs.existsSync(GPU_CONFIG_FILE)) {
      return { maxConcurrent: 1, jobTimeout: 3600 }
    }
    return JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf-8'))
  } catch {
    return { maxConcurrent: 1, jobTimeout: 3600 }
  }
}

function writeGPUConfig(config: GPUConfig) {
  fs.writeFileSync(GPU_CONFIG_FILE, JSON.stringify(config, null, 2))
}

function readQueue(): any[] {
  try {
    if (!fs.existsSync(JOB_QUEUE_FILE)) return []
    const parsed = JSON.parse(fs.readFileSync(JOB_QUEUE_FILE, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function writeQueue(jobs: any[]) {
  fs.writeFileSync(JOB_QUEUE_FILE, JSON.stringify(jobs, null, 2))
}

function readResults(): Record<string, any> {
  try {
    if (!fs.existsSync(JOB_RESULTS_FILE)) return {}
    const parsed = JSON.parse(fs.readFileSync(JOB_RESULTS_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function gpuJobDelegate(): any | null {
  return (prisma as any).gpuJob || null
}

function rowToRecord(row: any): GpuJobRecord {
  const status = isGpuJobStatus(row.status) ? row.status : 'queued'
  return {
    jobId: row.jobId,
    spaceId: row.spaceId,
    stageName: row.stageName,
    prompt: row.prompt,
    context: row.context || '',
    submittedAt: row.submittedAt instanceof Date ? row.submittedAt.toISOString() : String(row.submittedAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt || row.submittedAt),
    status,
    events: parseJobEvents(row.eventsJson),
    result: parseWorkerResult(row.resultJson),
  }
}

function dbDataFromRecord(record: GpuJobRecord) {
  return {
    jobId: record.jobId,
    spaceId: record.spaceId,
    stageName: record.stageName,
    prompt: record.prompt,
    context: record.context || '',
    status: record.status,
    submittedAt: new Date(record.submittedAt),
    resultJson: record.result ? JSON.stringify(record.result) : null,
    eventsJson: JSON.stringify(record.events || []),
  }
}

async function createDbJob(record: GpuJobRecord) {
  const delegate = gpuJobDelegate()
  if (!delegate) return null
  return delegate.create({ data: dbDataFromRecord(record) })
}

async function updateDbJob(record: GpuJobRecord) {
  const delegate = gpuJobDelegate()
  if (!delegate) return null
  return delegate.update({
    where: { jobId: record.jobId },
    data: {
      status: record.status,
      resultJson: record.result ? JSON.stringify(record.result) : null,
      eventsJson: JSON.stringify(record.events || []),
    },
  })
}

async function getDbJob(jobId: string): Promise<GpuJobRecord | null> {
  const delegate = gpuJobDelegate()
  if (!delegate) return null
  const row = await delegate.findUnique({ where: { jobId } })
  return row ? rowToRecord(row) : null
}

async function syncWorkerResultToDb(jobId: string): Promise<GpuJobRecord | null> {
  const record = await getDbJob(jobId)
  if (!record || record.result) return record
  const result = readResults()[jobId]
  if (!result) return record
  const completedAt = result.completedAt || new Date().toISOString()
  const updated = applyWorkerResultToJob(record, { ...result, jobId, completedAt })
  await updateDbJob(updated)
  return updated
}

async function syncAllWorkerResultsForSpace(spaceId: string): Promise<void> {
  const delegate = gpuJobDelegate()
  if (!delegate) return
  const rows = await delegate.findMany({ where: { spaceId }, orderBy: { submittedAt: 'desc' }, take: 100 })
  const results = readResults()
  for (const row of rows) {
    if (row.resultJson || !results[row.jobId]) continue
    const record = rowToRecord(row)
    const result = results[row.jobId]
    const updated = applyWorkerResultToJob(record, { ...result, jobId: row.jobId, completedAt: result.completedAt || new Date().toISOString() })
    await updateDbJob(updated)
  }
}

function mirrorJobToFileQueue(record: GpuJobRecord) {
  const queue = readQueue()
  if (!queue.some((job) => job.jobId === record.jobId)) {
    queue.push(workerQueueJob(record))
    writeQueue(queue)
  }
}

function responseForRecord(record: GpuJobRecord) {
  if (record.result) {
    const completed = record.status === 'completed'
    return {
      status: completed ? 'completed' : record.status,
      result: { success: completed, ...record.result },
      job: record,
      error: record.result.error,
    }
  }
  return { status: record.status === 'queued' ? 'pending' : record.status, job: record }
}

// GET: poll for job result OR get GPU config
export async function GET(request: NextRequest) {
  // Skip auth for internal server-side calls (no auth header = internal)
  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth
  }

  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')

  if (action === 'config') {
    return NextResponse.json({ config: getGPUConfig() })
  }

  // GET ?action=bySpace&spaceId=xxx — return all GPU results/jobs for a space
  if (action === 'bySpace') {
    const spaceId = searchParams.get('spaceId')
    if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

    const delegate = gpuJobDelegate()
    if (delegate) {
      await syncAllWorkerResultsForSpace(spaceId)
      const rows = await delegate.findMany({ where: { spaceId }, orderBy: { submittedAt: 'desc' }, take: 100 })
      return NextResponse.json({ results: rows.map(rowToRecord) })
    }

    const results = readResults()
    const spaceResults = Object.entries(results)
      .filter(([jobId]) => jobId.includes(spaceId))
      .map(([jobId, r]) => ({ jobId, ...r }))
      .sort((a: any, b: any) => (b.completedAt || '').localeCompare(a.completedAt || ''))
    return NextResponse.json({ results: spaceResults })
  }

  const jobId = searchParams.get('jobId')

  if (!jobId) {
    return NextResponse.json({ error: 'jobId required' }, { status: 400 })
  }

  const dbRecord = await syncWorkerResultToDb(jobId)
  if (dbRecord) return NextResponse.json(responseForRecord(dbRecord))

  // Legacy fallback while deployments migrate.
  const results = readResults()
  const result = results[jobId]

  if (!result) {
    const queue = readQueue()
    const job = queue.find(j => j.jobId === jobId)
    if (job) {
      return NextResponse.json({ status: job.status })
    }
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json({ status: result.success === false || result.error ? 'failed_runtime' : 'completed', result })
}

// POST: submit a GPU job
export async function POST(request: NextRequest) {
  // Skip auth for internal server-side calls
  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth
  }

  try {
    const body = await request.json()
    const { spaceId, stageName, prompt, context } = body

    if (!spaceId || !stageName || !prompt) {
      return NextResponse.json({ error: 'spaceId, stageName, and prompt required' }, { status: 400 })
    }

    const record = buildGpuJobRecord({ spaceId, stageName, prompt, context: context || '' })
    await createDbJob(record)
    mirrorJobToFileQueue(record)

    return NextResponse.json({ jobId: record.jobId, status: 'pending', job: record, message: 'GPU job queued' })
  } catch (error) {
    console.error('[GPU Jobs API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT: update GPU config (admin only)
export async function PUT(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  
  const auth = await authMiddleware(request)
  if ('json' in auth) return auth
  
  if (auth.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { maxConcurrent, jobTimeout } = body

    const config = getGPUConfig()
    
    if (maxConcurrent !== undefined) {
      config.maxConcurrent = Math.max(1, Math.min(16, parseInt(maxConcurrent, 10) || 1))
    }
    if (jobTimeout !== undefined) {
      config.jobTimeout = Math.max(60, Math.min(86400, parseInt(jobTimeout, 10) || 3600))
    }

    writeGPUConfig(config)

    return NextResponse.json({ config, message: 'GPU config updated' })
  } catch (error) {
    console.error('[GPU Config API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE: cancel GPU jobs for a space (called when space is deleted/stopped)
export async function DELETE(request: NextRequest) {
  const spaceId = new URL(request.url).searchParams.get('spaceId')
  if (!spaceId) {
    return NextResponse.json({ error: 'spaceId required' }, { status: 400 })
  }

  const { remaining, removed } = pruneFileQueueForSpace(readQueue(), spaceId)
  if (removed > 0) writeQueue(remaining)

  let dbRemoved = 0
  const delegate = gpuJobDelegate()
  if (delegate) {
    const result = await delegate.updateMany({
      where: { spaceId, status: { in: ['queued', 'preparing', 'running'] } },
      data: { status: 'cancelled' as GpuJobStatus },
    })
    dbRemoved = result.count || 0
  }

  return NextResponse.json({ removed: Math.max(removed, dbRemoved), fileRemoved: removed, dbRemoved, message: `Cancelled GPU jobs for space ${spaceId}` })
}
