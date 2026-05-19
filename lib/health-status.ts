import { execFileSync } from 'child_process'
import { prisma } from './prisma'

export type HealthLevel = 'healthy' | 'degraded'

export type HealthSnapshot = {
  nowMs: number
  webProcess: boolean
  gpuWorkerProcess: boolean
  searchProcess: boolean
  cloudflaredProcess: boolean
  gpu: {
    available: boolean
    name?: string | null
    torchCudaAvailable?: boolean | null
    error?: string | null
  }
  db: {
    ok: boolean
    activeSpaces: number
    queuedJobs: number
    runningJobs: number
    staleRunningJobs: number
    failedRecentJobs: number
    error?: string | null
  }
  publicHttp?: {
    ok: boolean
    status?: number | null
    error?: string | null
  }
}

export type HealthSummary = HealthSnapshot & {
  status: HealthLevel
  issues: string[]
}

export type PublicHealthPayload = {
  status: HealthLevel
  ok: boolean
}

const ACTIVE_GPU_STATUSES = [
  'queued',
  'preparing_workbench',
  'installing_dependencies',
  'running_experiment',
  'validating_evidence',
]

function shouldRequireCloudflared(): boolean {
  return ['1', 'true', 'yes'].includes(String(process.env.AR3_REQUIRE_CLOUDFLARED || '').toLowerCase())
}

function processRunning(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore', timeout: 1000 })
    return true
  } catch {
    return false
  }
}

function queryGpu(): HealthSnapshot['gpu'] {
  try {
    const raw = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim().split('\n')[0]?.trim() || ''
    return { available: Boolean(raw), name: raw || null, torchCudaAvailable: null }
  } catch (error: any) {
    return { available: false, name: null, torchCudaAvailable: null, error: error?.message || 'nvidia-smi failed' }
  }
}

async function queryDb(nowMs: number): Promise<HealthSnapshot['db']> {
  try {
    const staleCutoff = new Date(nowMs - 60 * 60 * 1000)
    const gpuDelegate = (prisma as any).gpuJob
    const [activeSpaces, queuedJobs, runningJobs, staleRunningJobs, failedRecentJobs] = await Promise.all([
      prisma.space.count({ where: { status: { in: ['RUNNING', 'INITIALIZING'] } } }),
      gpuDelegate ? gpuDelegate.count({ where: { status: 'queued' } }) : Promise.resolve(0),
      gpuDelegate ? gpuDelegate.count({ where: { status: { in: ACTIVE_GPU_STATUSES } } }) : Promise.resolve(0),
      gpuDelegate ? gpuDelegate.count({ where: { status: { in: ACTIVE_GPU_STATUSES }, updatedAt: { lt: staleCutoff } } }) : Promise.resolve(0),
      gpuDelegate ? gpuDelegate.count({ where: { status: { in: ['failed_validation', 'failed_runtime'] }, updatedAt: { gt: new Date(nowMs - 6 * 60 * 60 * 1000) } } }) : Promise.resolve(0),
    ])
    return { ok: true, activeSpaces, queuedJobs, runningJobs, staleRunningJobs, failedRecentJobs }
  } catch (error: any) {
    return {
      ok: false,
      activeSpaces: 0,
      queuedJobs: 0,
      runningJobs: 0,
      staleRunningJobs: 0,
      failedRecentJobs: 0,
      error: error?.message || 'database health query failed',
    }
  }
}

export function summarizeHealthSnapshot(snapshot: HealthSnapshot): HealthSummary {
  const issues: string[] = []
  if (!snapshot.webProcess) issues.push('web_process_missing')
  if (!snapshot.gpuWorkerProcess) issues.push('gpu_worker_process_missing')
  if (!snapshot.searchProcess) issues.push('search_process_missing')
  if (shouldRequireCloudflared() && !snapshot.cloudflaredProcess) issues.push('cloudflared_process_missing')
  if (!snapshot.gpu.available) issues.push('gpu_unavailable')
  if (snapshot.gpu.torchCudaAvailable === false) issues.push('torch_cuda_unavailable')
  if (!snapshot.db.ok) issues.push('database_unavailable')
  if (snapshot.db.staleRunningJobs > 0) issues.push('stale_gpu_jobs_present')
  if (snapshot.db.failedRecentJobs > 0) issues.push('recent_gpu_job_failures')
  if (snapshot.publicHttp && !snapshot.publicHttp.ok) issues.push('public_http_unhealthy')

  return {
    ...snapshot,
    status: issues.length ? 'degraded' : 'healthy',
    issues,
  }
}

export function publicHealthPayload(summary: HealthSummary): PublicHealthPayload {
  return { status: summary.status, ok: summary.status === 'healthy' }
}

export async function collectHealthStatus(): Promise<HealthSummary> {
  const nowMs = Date.now()
  return summarizeHealthSnapshot({
    nowMs,
    webProcess: processRunning('next-server|next start'),
    gpuWorkerProcess: processRunning('scripts/gpu_worker.py|gpu_worker.py'),
    searchProcess: processRunning('scripts/search_service.py|search_service.py'),
    cloudflaredProcess: processRunning('cloudflared tunnel'),
    gpu: queryGpu(),
    db: await queryDb(nowMs),
  })
}
