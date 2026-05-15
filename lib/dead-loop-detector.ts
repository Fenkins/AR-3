import { createHash } from 'crypto'

type VariantLike = {
  id?: string
  stageId?: string
  name?: string
  status?: string
  grade?: number | null
  feedback?: string | null
  failureMode?: string | null
  steps?: Array<{
    status?: string
    result?: string | null
    feedback?: string | null
  }>
}

export type DeadLoopAssessment =
  | { stuck: false; reason: string; repeatedSignature?: string; repeatedCount?: number }
  | { stuck: true; reason: string; repeatedSignature: string; repeatedCount: number }

const DEFAULT_REPEAT_THRESHOLD = 3

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeFailureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[a-f0-9]{8,}\b/g, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
    .replace(/\/tmp\/[^\s'\"]+/g, '<tmp-path>')
    .replace(/gpu_[a-z0-9_.-]+/g, '<gpu-job>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
}

export function variantFailureSignature(variant: VariantLike): string | null {
  if (variant.status !== 'FAILED') return null

  const failedSteps = Array.isArray(variant.steps)
    ? variant.steps.filter(step => step.status === 'FAILED')
    : []
  const stepText = failedSteps
    .map(step => [step.feedback, step.result].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
  const raw = [
    variant.stageId || '',
    variant.failureMode || '',
    variant.feedback || '',
    stepText,
  ].filter(Boolean).join(' | ')

  const normalized = normalizeFailureText(raw || 'failed-without-diagnostics')
  return hashText(normalized)
}

export function assessDeadLoop(
  variants: VariantLike[],
  stageId: string,
  repeatThreshold: number = DEFAULT_REPEAT_THRESHOLD
): DeadLoopAssessment {
  const stageVariants = variants.filter(variant => variant.stageId === stageId)
  const completed = stageVariants.filter(variant => variant.status === 'COMPLETED')
  if (completed.length > 0) {
    const grades = completed
      .map(variant => typeof variant.grade === 'number' ? variant.grade : null)
      .filter((grade): grade is number => grade !== null)
    const bestGrade = grades.length ? Math.max(...grades) : null
    if (bestGrade === null || bestGrade > 0) {
      return { stuck: false, reason: 'stage has completed variants with progress evidence' }
    }
  }

  const failures = stageVariants
    .filter(variant => variant.status === 'FAILED')
    .map(variant => variantFailureSignature(variant))
    .filter((signature): signature is string => Boolean(signature))
  if (failures.length < repeatThreshold) {
    return { stuck: false, reason: 'not enough failed variants to establish a dead loop' }
  }

  const counts = new Map<string, number>()
  for (const signature of failures) {
    counts.set(signature, (counts.get(signature) || 0) + 1)
  }
  const repeated = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]
  if (repeated && repeated[1] >= repeatThreshold) {
    return {
      stuck: true,
      repeatedSignature: repeated[0],
      repeatedCount: repeated[1],
      reason: `Dead-loop detector found ${repeated[1]} failed ${stageId} variants with the same normalized failure signature ${repeated[0]}. Pausing so the next retry can change prompts, dependencies, or preparation evidence instead of repeating the same failure.`,
    }
  }

  return { stuck: false, reason: 'failed variants have varied failure signatures' }
}
