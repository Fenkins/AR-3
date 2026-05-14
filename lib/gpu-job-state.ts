export const GPU_JOB_STATUSES = [
  'queued',
  'preparing_workbench',
  'installing_dependencies',
  'running_experiment',
  'validating_evidence',
  'failed_validation',
  'failed_runtime',
  'completed',
  'cancelled',
] as const

export type GpuJobStatus = typeof GPU_JOB_STATUSES[number]

export type GpuJobEvent = {
  at: string
  fromStatus?: GpuJobStatus
  toStatus: GpuJobStatus
  message: string
}

export type GpuWorkerResult = {
  jobId: string
  output: string
  code?: string
  error?: string | null
  success?: boolean
  tokensUsed?: number
  cost?: number
  completedAt: string
  workbenchDir?: string | null
  artifactsDir?: string | null
  dependencies?: string[]
}

export type GpuJobRecord = {
  jobId: string
  spaceId: string
  stageName: string
  prompt: string
  context: string
  submittedAt: string
  updatedAt: string
  status: GpuJobStatus
  events: GpuJobEvent[]
  result?: GpuWorkerResult
}

type GpuJobInput = {
  spaceId: string
  stageName: string
  prompt: string
  context?: string
}

const TRANSITIONS: Record<GpuJobStatus, GpuJobStatus[]> = {
  queued: ['preparing_workbench', 'running_experiment', 'failed_validation', 'cancelled'],
  preparing_workbench: ['installing_dependencies', 'running_experiment', 'failed_validation', 'failed_runtime', 'cancelled'],
  installing_dependencies: ['running_experiment', 'failed_validation', 'failed_runtime', 'cancelled'],
  running_experiment: ['validating_evidence', 'completed', 'failed_runtime', 'cancelled'],
  validating_evidence: ['completed', 'failed_runtime', 'cancelled'],
  failed_validation: [],
  failed_runtime: [],
  completed: [],
  cancelled: [],
}

export function isGpuJobStatus(value: string): value is GpuJobStatus {
  return (GPU_JOB_STATUSES as readonly string[]).includes(value)
}

export function isValidGpuJobTransition(from: GpuJobStatus, to: GpuJobStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function slugForJobId(value: string): string {
  return String(value || 'space')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80) || 'space'
}

export function buildGpuJobRecord(input: GpuJobInput, now = new Date(), nonce = Math.random().toString(36).slice(2, 11)): GpuJobRecord {
  const submittedAt = now.toISOString()
  const jobId = `gpu_${slugForJobId(input.spaceId)}_${now.getTime()}_${nonce}`
  return {
    jobId,
    spaceId: input.spaceId,
    stageName: input.stageName,
    prompt: input.prompt,
    context: input.context || '',
    submittedAt,
    updatedAt: submittedAt,
    status: 'queued',
    events: [{ at: submittedAt, toStatus: 'queued', message: 'GPU job queued' }],
  }
}

export function transitionGpuJob(job: GpuJobRecord, toStatus: GpuJobStatus, message: string, at = new Date().toISOString()): GpuJobRecord {
  if (job.status !== toStatus && !isValidGpuJobTransition(job.status, toStatus)) {
    throw new Error(`Invalid GPU job transition ${job.status} -> ${toStatus}`)
  }
  return {
    ...job,
    status: toStatus,
    updatedAt: at,
    events: [
      ...(job.events || []),
      { at, fromStatus: job.status, toStatus, message },
    ],
  }
}

export function applyWorkerResultToJob(job: GpuJobRecord, result: GpuWorkerResult): GpuJobRecord {
  const toStatus: GpuJobStatus = result.error || result.success === false ? 'failed_runtime' : 'completed'
  const base = ['queued', 'preparing_workbench', 'installing_dependencies', 'running_experiment'].includes(job.status)
    ? { ...job, status: 'validating_evidence' as GpuJobStatus }
    : job
  return {
    ...transitionGpuJob(base, toStatus, result.error ? 'GPU worker reported runtime failure' : 'GPU worker completed job', result.completedAt),
    result,
  }
}

type WorkerQueueState = {
  jobId?: string
  status?: string
  claimedAt?: string
  startedAt?: string
  updatedAt?: string
}

const WORKER_STATUS_MESSAGES: Record<GpuJobStatus, string> = {
  queued: 'GPU job queued',
  preparing_workbench: 'GPU worker claimed job and is preparing the persistent workbench',
  installing_dependencies: 'GPU worker is installing declared dependencies into the workbench cache',
  running_experiment: 'GPU worker is running experiment code',
  validating_evidence: 'GPU worker is validating runtime evidence before completion',
  failed_validation: 'GPU job failed validation',
  failed_runtime: 'GPU worker reported runtime failure',
  completed: 'GPU worker completed job',
  cancelled: 'GPU job cancelled',
}

function mapWorkerQueueStatus(workerStatus: string): GpuJobStatus | null {
  if (workerStatus === 'claimed') return 'preparing_workbench'
  if (workerStatus === 'running') return 'running_experiment'
  if (isGpuJobStatus(workerStatus)) return workerStatus
  return null
}

export function applyWorkerQueueStateToJob(job: GpuJobRecord, workerJob: WorkerQueueState | null | undefined): GpuJobRecord {
  if (!workerJob || workerJob.jobId !== job.jobId || job.result) return job

  const mappedStatus = mapWorkerQueueStatus(String(workerJob.status || ''))

  if (!mappedStatus || job.status === mappedStatus) return job
  if (!isValidGpuJobTransition(job.status, mappedStatus)) return job

  const at = workerJob.updatedAt || workerJob.startedAt || workerJob.claimedAt || new Date().toISOString()
  return transitionGpuJob(job, mappedStatus, WORKER_STATUS_MESSAGES[mappedStatus], at)
}

export function workerQueueJob(job: GpuJobRecord) {
  return {
    jobId: job.jobId,
    spaceId: job.spaceId,
    stageName: job.stageName,
    prompt: job.prompt,
    context: job.context || '',
    submittedAt: job.submittedAt,
    status: job.status === 'queued' ? 'pending' : job.status,
  }
}

export function pruneFileQueueForSpace<T extends { spaceId?: string }>(queue: T[], spaceId: string): { remaining: T[]; removed: number } {
  const remaining = queue.filter((job) => job.spaceId !== spaceId)
  return { remaining, removed: queue.length - remaining.length }
}

export function parseJobEvents(raw: string | null | undefined): GpuJobEvent[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function parseWorkerResult(raw: string | null | undefined): GpuWorkerResult | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
