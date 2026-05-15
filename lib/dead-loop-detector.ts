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

function normalizeProgressText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[a-f0-9]{8,}\b/g, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<timestamp>')
    .replace(/\/tmp\/[^\s'\"]+/g, '<tmp-path>')
    .replace(/gpu_[a-z0-9_.-]+/g, '<gpu-job>')
    .replace(/job[-_][a-z0-9_.-]+/g, '<job-id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600)
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

export function variantProgressSignature(variant: VariantLike): string | null {
  if (variant.status !== 'COMPLETED') return null

  const completedSteps = Array.isArray(variant.steps)
    ? variant.steps.filter(step => step.status === 'COMPLETED')
    : []
  const stepText = completedSteps
    .map(step => [step.result, step.feedback].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
  const raw = [
    variant.stageId || '',
    variant.failureMode || '',
    variant.feedback || '',
    stepText,
  ].filter(Boolean).join(' | ')

  if (!raw.trim()) return null
  const normalized = normalizeProgressText(raw)
  return normalized ? hashText(normalized) : null
}

function jsonObjectCandidates(text: string): string[] {
  const source = String(text || '')
  const candidates: string[] = []
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < source.length; i++) {
      const ch = source[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          candidates.push(source.slice(start, i + 1))
          break
        }
      }
    }
  }
  return candidates
}

function normalizeCodeText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\/tmp\/[^\s'"]+/g, '<tmp-path>')
    .replace(/gpu_[a-z0-9_.-]+/gi, '<gpu-job>')
    .trim()
    .slice(0, 20000)
}

function normalizeDependencies(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const dependencies = value
    .filter((dependency): dependency is string => typeof dependency === 'string')
    .map(dependency => dependency.trim().toLowerCase())
    .filter(Boolean)
    .sort()
  return dependencies.length ? JSON.stringify(dependencies) : ''
}

function extractExecutableSignatureText(value: string): string | null {
  const text = String(value || '')
  const codeBlock = text.match(/\[CODE\]\s*([\s\S]*?)\s*\[\/CODE\]/i)
  if (codeBlock?.[1]?.trim()) return codeBlock[1]

  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed?.action === 'run_python' && typeof parsed.code === 'string' && parsed.code.trim()) {
        const normalizedCode = normalizeCodeText(parsed.code)
        const normalizedDependencies = normalizeDependencies(parsed.dependencies)
        return [normalizedCode, normalizedDependencies ? `dependencies=${normalizedDependencies}` : '']
          .filter(Boolean)
          .join('\n---COMMAND-CONTEXT---\n')
      }
    } catch {}
  }

  return null
}

export function variantCodeSignature(variant: VariantLike): string | null {
  const texts = [
    variant.feedback || '',
    ...(Array.isArray(variant.steps)
      ? variant.steps.map(step => [step.result, step.feedback].filter(Boolean).join('\n'))
      : []),
  ]

  for (const value of texts) {
    const code = extractExecutableSignatureText(value)
    if (!code) continue
    const normalized = normalizeCodeText(code)
    if (normalized) return hashText(normalized)
  }
  return null
}

export function assessDeadLoop(
  variants: VariantLike[],
  stageId: string,
  repeatThreshold: number = DEFAULT_REPEAT_THRESHOLD
): DeadLoopAssessment {
  const stageVariants = variants.filter(variant => variant.stageId === stageId)
  const completed = stageVariants.filter(variant => variant.status === 'COMPLETED')
  if (completed.length > 0) {
    const progressBySignature = new Map<string, VariantLike[]>()
    for (const variant of completed) {
      const signature = variantProgressSignature(variant)
      if (!signature) continue
      const matches = progressBySignature.get(signature) || []
      matches.push(variant)
      progressBySignature.set(signature, matches)
    }

    if (progressBySignature.size > 0) {
      const repeatedProgress = Array.from(progressBySignature.entries()).sort((a, b) => b[1].length - a[1].length)[0]
      if (repeatedProgress && repeatedProgress[1].length >= repeatThreshold) {
        const grades = repeatedProgress[1]
          .map(variant => typeof variant.grade === 'number' ? variant.grade : null)
          .filter((grade): grade is number => grade !== null)
        const lowestGrade = grades.length ? Math.min(...grades) : null
        const highestGrade = grades.length ? Math.max(...grades) : null
        const hasGradeImprovement = lowestGrade !== null && highestGrade !== null && highestGrade > lowestGrade

        if (!hasGradeImprovement) {
          return {
            stuck: true,
            repeatedSignature: repeatedProgress[0],
            repeatedCount: repeatedProgress[1].length,
            reason: `Dead-loop detector found ${repeatedProgress[1].length} completed ${stageId} variants with the same normalized output signature ${repeatedProgress[0]} and no grade improvement. Pausing so the next retry changes the experiment, grading evidence, or preparation manifest instead of repeating the same non-improving result.`,
          }
        }
      }

      return { stuck: false, reason: 'stage has completed variants with progress evidence' }
    }

    const grades = completed
      .map(variant => typeof variant.grade === 'number' ? variant.grade : null)
      .filter((grade): grade is number => grade !== null)
    const bestGrade = grades.length ? Math.max(...grades) : null
    if (bestGrade === null || bestGrade > 0) {
      return { stuck: false, reason: 'stage has completed variants with progress evidence' }
    }
  }

  const codeSignatures = stageVariants
    .filter(variant => variant.status === 'COMPLETED' || variant.status === 'FAILED')
    .map(variant => variantCodeSignature(variant))
    .filter((signature): signature is string => Boolean(signature))
  if (codeSignatures.length >= repeatThreshold) {
    const codeCounts = new Map<string, number>()
    for (const signature of codeSignatures) {
      codeCounts.set(signature, (codeCounts.get(signature) || 0) + 1)
    }
    const repeatedCode = Array.from(codeCounts.entries()).sort((a, b) => b[1] - a[1])[0]
    if (repeatedCode && repeatedCode[1] >= repeatThreshold) {
      return {
        stuck: true,
        repeatedSignature: repeatedCode[0],
        repeatedCount: repeatedCode[1],
        reason: 'Dead-loop detector found ' + repeatedCode[1] + ' ' + stageId + ' variants with the same normalized executable code signature ' + repeatedCode[0] + '. Pausing so the next retry changes the implementation, preparation manifest, or grading target instead of rerunning identical code.',
      }
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
