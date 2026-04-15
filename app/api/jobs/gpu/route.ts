import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'
import fs from 'fs'
import path from 'path'

// File-based job queue (stored in /tmp/gpu_jobs.json on the Vast.ai instance)
const JOB_QUEUE_FILE = '/tmp/gpu_jobs.json'
const JOB_RESULTS_FILE = '/tmp/gpu_results.json'

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

// GET: poll for job result
export async function GET(request: NextRequest) {
  // Skip auth for internal server-side calls (no auth header = internal)
  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth
  }

  const { searchParams } = new URL(request.url)
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
