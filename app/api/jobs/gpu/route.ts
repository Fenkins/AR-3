import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'
import fs from 'fs'
import path from 'path'

// File-based job queue (stored in /tmp/gpu_jobs.json on the Vast.ai instance)
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

interface GPUJob {
  jobId: string
  spaceId: string
  stageName: string
  prompt: string
  context: string
  submittedAt: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

interface GPUResult {
  jobId: string
  output: string
  error?: string
  tokensUsed?: number
  cost?: number
  completedAt: string
}

function readQueue(): GPUJob[] {
  try {
    if (!fs.existsSync(JOB_QUEUE_FILE)) return []
    return JSON.parse(fs.readFileSync(JOB_QUEUE_FILE, 'utf-8'))
  } catch { return [] }
}

function writeQueue(jobs: GPUJob[]) {
  fs.writeFileSync(JOB_QUEUE_FILE, JSON.stringify(jobs, null, 2))
}

function readResults(): Record<string, GPUResult> {
  try {
    if (!fs.existsSync(JOB_RESULTS_FILE)) return {}
    return JSON.parse(fs.readFileSync(JOB_RESULTS_FILE, 'utf-8'))
  } catch { return {} }
}

function writeResults(results: Record<string, GPUResult>) {
  fs.writeFileSync(JOB_RESULTS_FILE, JSON.stringify(results, null, 2))
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

  const jobId = searchParams.get('jobId')

  if (!jobId) {
    return NextResponse.json({ error: 'jobId required' }, { status: 400 })
  }

  const results = readResults()
  const result = results[jobId]

  if (!result) {
    // Check if job is still in queue
    const queue = readQueue()
    const job = queue.find(j => j.jobId === jobId)
    if (job) {
      return NextResponse.json({ status: job.status })
    }
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json({ status: 'completed', result })
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

    const jobId = `gpu_${spaceId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    const job: GPUJob = {
      jobId,
      spaceId,
      stageName,
      prompt,
      context: context || '',
      submittedAt: new Date().toISOString(),
      status: 'pending',
    }

    const queue = readQueue()
    queue.push(job)
    writeQueue(queue)

    return NextResponse.json({ jobId, status: 'pending', message: 'GPU job queued' })
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

// DELETE: clear GPU jobs for a space (called when space is deleted/stopped)
export async function DELETE(request: NextRequest) {
  const spaceId = new URL(request.url).searchParams.get('spaceId')
  if (!spaceId) {
    return NextResponse.json({ error: 'spaceId required' }, { status: 400 })
  }

  const queue = readQueue()
  const initialLen = queue.length
  const remaining = queue.filter(j => j.spaceId !== spaceId)
  const removed = initialLen - remaining.length

  if (removed > 0) {
    writeQueue(remaining)
  }

  return NextResponse.json({ removed, message: `Removed ${removed} GPU jobs for space ${spaceId}` })
}
