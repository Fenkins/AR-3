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
    .replace(/\b(?:runtime|api|gpu|worker|contract)[-_][a-z0-9_.-]+\b/g, match => {
      const family = match.split(/[-_]/, 1)[0]
      return `${family}<id>`
    })
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

function metricObjectCandidates(text: string): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = []
  for (const candidate of jsonObjectCandidates(text)) {
    addMetricObjectCandidate(candidates, candidate)
  }

  const inlineMetrics = text.match(/metrics\s*=\s*(\{[^\n\r]+\})/gi) || []
  for (const match of inlineMetrics) {
    const objectText = match.replace(/^metrics\s*=\s*/i, '')
    addMetricObjectCandidate(candidates, objectText)
  }

  return candidates
}

function addMetricObjectCandidate(candidates: Record<string, unknown>[], objectText: string): void {
  const parsed = parseMetricObjectCandidate(objectText)
  if (!parsed) return
  candidates.push(parsed)
  const metrics = parsed.metrics
  if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) {
    candidates.push(metrics as Record<string, unknown>)
  }
}

function parseMetricObjectCandidate(objectText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(objectText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {}

  const jsonLike = pythonLiteralObjectToJson(objectText)
  if (!jsonLike) return null
  try {
    const parsed = JSON.parse(jsonLike)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function pythonLiteralObjectToJson(objectText: string): string | null {
  const source = String(objectText || '').trim()
  if (!source.startsWith('{') || !source.endsWith('}')) return null
  if (hasUnsafePythonLiteralSyntax(source)) return null
  return source
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, value) => JSON.stringify(value.replace(/\\'/g, "'")))
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
}

function hasUnsafePythonLiteralSyntax(source: string): boolean {
  let inString: '\'' | '"' | null = null
  let escaped = false

  for (const ch of source) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === inString) {
        inString = null
      }
      continue
    }

    if (ch === '\'' || ch === '"') {
      inString = ch
      continue
    }
    if (!/[\s\w{}\[\],.:+\/\-<>=~!]/.test(ch)) return true
  }

  return Boolean(inString || escaped)
}

function normalizeMetricValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Number(value.toPrecision(8)).toString()
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed).toPrecision(8).replace(/(?:\.0+|(?<=\d)0+)$/, '')
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase()
  }
  return null
}

function isEphemeralMetricKey(key: string): boolean {
  return /(?:^|_)(?:job|run|id|uuid|path|file|artifact|timestamp|created|updated|duration|elapsed|seconds|time_ms|latency_ms|success|ok|status|state|exit_code|returncode|return_code)(?:$|_)/i.test(key)
}

function normalizeMetricKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-z0-9_.]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function extractMetricSignatureText(value: string): string | null {
  const entries: string[] = []
  for (const candidate of metricObjectCandidates(value)) {
    entries.push(...metricEntriesFromObject(candidate))
  }

  for (const entry of looseMetricEntries(value)) {
    entries.push(entry)
  }

  for (const entry of markdownMetricTableEntries(value)) {
    entries.push(entry)
  }

  const uniqueEntries = Array.from(new Set(entries)).sort()
  return uniqueEntries.length ? uniqueEntries.join('\n') : null
}

function metricEntriesFromObject(value: Record<string, unknown>, prefix: string = '', depth: number = 0): string[] {
  const entries: string[] = []
  const namedMetricEntry = metricEntryFromNamedRow(value, prefix)
  if (namedMetricEntry) return [namedMetricEntry]

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase()
    if (!key || isEphemeralMetricKey(key)) continue

    const path = prefix ? `${prefix}.${key}` : key
    const normalizedValue = normalizeMetricValue(rawValue)
    if (normalizedValue !== null) {
      entries.push(`${path}=${normalizedValue}`)
      continue
    }

    if (typeof rawValue === 'string' && isMetricTextField(key)) {
      entries.push(...metricEntriesFromEmbeddedText(rawValue, path, depth + 1))
      continue
    }

    if (Array.isArray(rawValue)) {
      rawValue.forEach((item, index) => {
        const itemValue = normalizeMetricValue(item)
        if (itemValue !== null) {
          entries.push(`${path}[${index}]=${itemValue}`)
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const namedMetricEntry = metricEntryFromNamedRow(item as Record<string, unknown>, path)
          if (namedMetricEntry) {
            entries.push(namedMetricEntry)
          } else {
            entries.push(...metricEntriesFromObject(item as Record<string, unknown>, `${path}[${index}]`, depth + 1))
          }
        } else if (typeof item === 'string' && isMetricTextField(key)) {
          entries.push(...metricEntriesFromEmbeddedText(item, `${path}[${index}]`, depth + 1))
        }
      })
      continue
    }

    if (rawValue && typeof rawValue === 'object') {
      entries.push(...metricEntriesFromObject(rawValue as Record<string, unknown>, path, depth + 1))
    }
  }
  return entries
}

function isMetricTextField(key: string): boolean {
  return /^(?:stdout|stderr|output|result|results|log|logs|message|text|summary)$/.test(key)
}

function metricEntriesFromEmbeddedText(text: string, prefix: string, depth: number): string[] {
  if (depth > 3) return []

  const entries: string[] = []
  for (const candidate of metricObjectCandidates(text)) {
    entries.push(...metricEntriesFromObject(candidate, prefix, depth + 1))
  }

  for (const entry of looseMetricEntries(text)) {
    entries.push(`${prefix}.${entry}`)
  }

  return entries
}

function metricEntryFromNamedRow(value: Record<string, unknown>, prefix: string = ''): string | null {
  const rawName = firstString(
    value.name,
    value.metric,
    value.metricName,
    value.metric_name,
    value.key,
    value.label
  )
  if (!rawName) return null

  const rawMetricValue = value.value
    ?? value.metricValue
    ?? value.metric_value
    ?? value.score
    ?? value.result
    ?? value.measurement
  const normalizedValue = normalizeMetricValue(rawMetricValue)
  if (normalizedValue === null) return null

  const name = normalizeMetricKey(rawName)
  if (!name || isEphemeralMetricKey(name)) return null

  return `${prefix ? `${prefix}.` : ''}${name}=${normalizedValue}`
}

function looseMetricEntries(text: string): string[] {
  const entries: string[] = []
  const metricPattern = /(?:^|[\s,;])([a-zA-Z][a-zA-Z0-9_.-]{1,80}(?:[ -][a-zA-Z0-9_.-]{1,40}){0,4})\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false)\b/gi
  for (const match of String(text || '').matchAll(metricPattern)) {
    const key = normalizeMetricKey(match[1])
    if (isEphemeralMetricKey(key)) continue
    const normalizedValue = normalizeMetricValue(match[2])
    if (normalizedValue === null) continue
    entries.push(`${key}=${normalizedValue}`)
  }
  return entries
}

function markdownMetricTableEntries(text: string): string[] {
  const lines = String(text || '').split(/\r?\n/)
  const entries: string[] = []

  for (let i = 0; i < lines.length - 2; i += 1) {
    const header = markdownTableCells(lines[i])
    const separator = markdownTableCells(lines[i + 1])
    if (!header || !separator || !separator.every(cell => /^:?-{3,}:?$/.test(cell.trim()))) continue

    const normalizedHeader = header.map(normalizeMetricKey)
    const nameIndex = normalizedHeader.findIndex(key => /^(?:metric|metric_name|name|key|label)$/.test(key))
    const valueIndex = normalizedHeader.findIndex(key => /^(?:value|score|result|measurement)$/.test(key))
    if (nameIndex === -1 || valueIndex === -1) continue

    for (let rowIndex = i + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownTableCells(lines[rowIndex])
      if (!row || row.length < Math.max(nameIndex, valueIndex) + 1) break

      const metricName = normalizeMetricKey(row[nameIndex])
      if (!metricName || isEphemeralMetricKey(metricName)) continue

      const normalizedValue = normalizeMetricValue(row[valueIndex])
      if (normalizedValue === null) continue
      entries.push(`${metricName}=${normalizedValue}`)
    }
  }

  return entries
}

function markdownTableCells(line: string): string[] | null {
  const trimmed = String(line || '').trim()
  if (!trimmed.includes('|')) return null
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
  return cells.length >= 2 ? cells : null
}

function isStatusOnlyWorkerOutput(value: string): boolean {
  const trimmed = String(value || '').trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  if (extractMetricSignatureText(trimmed)) return false

  for (const candidate of jsonObjectCandidates(trimmed)) {
    const parsed = parseMetricObjectCandidate(candidate)
    if (!parsed) continue
    const keys = Object.keys(parsed).map(key => key.trim().toLowerCase())
    if (keys.some(key => /^(?:success|ok|status|state|exit_code|returncode|return_code|output|stdout|stderr|error)$/.test(key))) {
      return true
    }
  }

  return false
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
  if (stepText && completedSteps.every(step => isStatusOnlyWorkerOutput([step.result, step.feedback].filter(Boolean).join(' ')))) {
    return null
  }
  const metricText = completedSteps
    .map(step => [step.result, step.feedback].filter(Boolean).join('\n'))
    .map(extractMetricSignatureText)
    .filter((signature): signature is string => Boolean(signature))
    .join('\n')
  if (metricText) return hashText([variant.stageId || '', metricText].filter(Boolean).join('\n'))

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

function variantMetricProgressSignature(variant: VariantLike): string | null {
  if (variant.status !== 'COMPLETED') return null

  const completedSteps = Array.isArray(variant.steps)
    ? variant.steps.filter(step => step.status === 'COMPLETED')
    : []
  const metricText = completedSteps
    .map(step => [step.result, step.feedback].filter(Boolean).join('\n'))
    .map(extractMetricSignatureText)
    .filter((signature): signature is string => Boolean(signature))
    .join('\n')

  return metricText ? hashText([variant.stageId || '', metricText].filter(Boolean).join('\n')) : null
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
  const dependencies = collectDependencyContext(value)
    .filter(Boolean)
    .sort()
  return dependencies.length ? JSON.stringify(dependencies) : ''
}

function collectDependencyContext(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const dependencies: string[] = []
  for (const dependency of value) {
    if (typeof dependency === 'string') {
      dependencies.push(dependency)
      continue
    }
    if (!dependency || typeof dependency !== 'object') continue
    const row = dependency as Record<string, any>
    const name = firstString(row.name, row.package, row.pip, row.pipPackage, row.pip_package)
    if (!name) continue
    const versionSpec = firstString(row.versionSpec, row.version_spec, row.version, row.constraint)
    const importName = firstString(row.importName, row.import_name, row.import)
    dependencies.push([
      name,
      versionSpec ? `version=${versionSpec}` : '',
      importName ? `import=${importName}` : '',
    ].filter(Boolean).join('|'))
  }
  return dependencies
    .map(dependency => dependency.trim().toLowerCase())
    .filter(Boolean)
}

function collectInstalledDependencyContext(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((dependency): dependency is string => typeof dependency === 'string')
    .map(dependency => dependency.trim().toLowerCase())
    .filter(Boolean)
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function normalizeStringList(values: unknown[]): string {
  const normalized = Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)))
    .sort()
  return normalized.length ? JSON.stringify(normalized) : ''
}

function collectArtifactContext(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const source = value as Record<string, any>
  const values: string[] = []
  for (const key of ['artifact', 'artifact_path', 'artifactPath', 'output_path', 'outputPath']) {
    if (typeof source[key] === 'string') values.push(source[key])
  }
  for (const key of ['artifacts', 'artifact_paths', 'artifactPaths', 'expectedArtifacts']) {
    if (Array.isArray(source[key])) values.push(...source[key].filter((item: unknown): item is string => typeof item === 'string'))
  }
  for (const key of ['expected_artifacts', 'output_paths']) {
    if (Array.isArray(source[key])) values.push(...source[key].filter((item: unknown): item is string => typeof item === 'string'))
  }
  if (source.workbench && typeof source.workbench === 'object') {
    values.push(...collectArtifactContext(source.workbench))
  }
  return values
}

function collectModelContext(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const source = value as Record<string, any>
  const values: string[] = []
  for (const key of ['model', 'model_id', 'modelId', 'repo', 'repo_id', 'repoId', 'checkpoint', 'checkpoint_path', 'checkpointPath']) {
    if (typeof source[key] === 'string') values.push(source[key])
  }
  for (const key of ['model_ids', 'modelIds', 'model_paths', 'modelPaths', 'checkpoints']) {
    if (Array.isArray(source[key])) values.push(...source[key].filter((item: unknown): item is string => typeof item === 'string'))
  }
  if (Array.isArray(source.models)) {
    for (const model of source.models) {
      if (typeof model === 'string') {
        values.push(model)
      } else if (model && typeof model === 'object') {
        const row = model as Record<string, any>
        for (const key of ['id', 'model_id', 'modelId', 'repo', 'repo_id', 'repoId', 'path', 'localPath', 'local_path']) {
          if (typeof row[key] === 'string') values.push(row[key])
        }
      }
    }
  }
  if (Array.isArray(source.huggingface)) {
    for (const model of source.huggingface) {
      if (!model || typeof model !== 'object') continue
      const row = model as Record<string, any>
      for (const key of ['id', 'model_id', 'modelId', 'repo', 'repo_id', 'repoId']) {
        if (typeof row[key] === 'string') values.push(row[key])
      }
    }
  }
  return values
}

function collectSmokeTestContext(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const source = value as Record<string, any>
  const smokeTests = source.smokeTests || source.smoke_tests
  if (!Array.isArray(smokeTests)) return []

  const values: string[] = []
  for (const test of smokeTests) {
    if (typeof test === 'string') {
      values.push(test)
      continue
    }
    if (!test || typeof test !== 'object') continue
    const row = test as Record<string, any>
    const command = firstString(row.command, row.test)
    const evidence = Array.isArray(row.expectedEvidence)
      ? normalizeStringList(row.expectedEvidence)
      : Array.isArray(row.expected_evidence)
        ? normalizeStringList(row.expected_evidence)
        : firstString(row.expectedEvidence, row.expected_evidence)
    values.push([
      firstString(row.name),
      command ? `command=${command}` : '',
      evidence ? `evidence=${evidence}` : '',
    ].filter(Boolean).join('|'))
  }
  return values
}

function collectGradingContext(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const source = value as Record<string, any>
  const values: string[] = []

  for (const key of ['gradingCriteria', 'grading_criteria', 'evaluationCriteria', 'evaluation_criteria']) {
    const criteria = source[key]
    if (!Array.isArray(criteria)) continue
    for (const criterion of criteria) {
      if (typeof criterion === 'string') {
        const normalized = normalizeProgressText(criterion)
        if (normalized) values.push(normalized)
        continue
      }
      if (!criterion || typeof criterion !== 'object') continue
      const row = criterion as Record<string, any>
      const text = firstString(row.name, row.criterion, row.description, row.evidence, row.metric, row.field)
      const normalized = normalizeProgressText(text || '')
      if (normalized) values.push(normalized)
    }
  }

  for (const key of ['successCriteria', 'success_criteria']) {
    const criteria = source[key]
    if (!Array.isArray(criteria)) continue
    for (const criterion of criteria) {
      if (!criterion || typeof criterion !== 'object') continue
      const row = criterion as Record<string, any>
      const normalized = [
        firstString(row.name) ? `name=${normalizeProgressText(firstString(row.name) || '')}` : '',
        firstString(row.metric) ? `metric=${normalizeProgressText(firstString(row.metric) || '')}` : '',
        firstString(row.threshold) ? `threshold=${normalizeProgressText(firstString(row.threshold) || '')}` : '',
        firstString(row.evidence, row.expectedEvidence, row.expected_evidence, row.field)
          ? `evidence=${normalizeProgressText(firstString(row.evidence, row.expectedEvidence, row.expected_evidence, row.field) || '')}`
          : '',
      ].filter(Boolean).join('|')
      if (normalized) values.push(normalized)
    }
  }

  return values
}

function normalizeWorkbenchContext(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const source = value as Record<string, any>
  const workbench = source.workbench
  if (workbench && typeof workbench === 'object' && typeof workbench.reuseKey === 'string') {
    return workbench.reuseKey.trim().toLowerCase()
  }
  if (workbench && typeof workbench === 'object' && typeof workbench.reuse_key === 'string') {
    return workbench.reuse_key.trim().toLowerCase()
  }
  if (typeof source.workbenchReuseKey === 'string') return source.workbenchReuseKey.trim().toLowerCase()
  if (typeof source.workbench_reuse_key === 'string') return source.workbench_reuse_key.trim().toLowerCase()
  return ''
}

function normalizeRunHistoryText(value: string): string {
  return normalizeProgressText(value)
    .replace(/preparation_manifest=<tmp-path>/g, 'preparation_manifest=<path>')
    .replace(/preparation_run_history=<tmp-path>/g, 'preparation_run_history=<path>')
}

function collectRunHistoryContext(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const source = value as Record<string, any>
  const rows = [
    source.runHistory,
    source.run_history,
    source.preparationRunHistory,
    source.preparation_run_history,
    source.previousRuns,
    source.previous_runs,
    source.priorRuns,
    source.prior_runs,
  ].find(Array.isArray)
  if (!Array.isArray(rows)) return []

  const values: string[] = []
  for (const row of rows.slice(-5)) {
    if (typeof row === 'string') {
      const normalized = normalizeRunHistoryText(row)
      if (normalized) values.push(normalized)
      continue
    }
    if (!row || typeof row !== 'object') continue
    const entry = row as Record<string, any>
    const success = typeof entry.success === 'boolean' ? `success=${entry.success}` : ''
    const status = firstString(entry.status, entry.state)
    const error = firstString(entry.error, entry.failure, entry.failureReason, entry.failure_reason)
    const output = firstString(entry.outputTail, entry.output_tail, entry.output, entry.stdoutTail, entry.stdout_tail)
    const metrics = extractMetricSignatureText([output, entry.metrics ? JSON.stringify({ metrics: entry.metrics }) : ''].filter(Boolean).join('\n'))
    const normalized = [
      success,
      status ? `status=${status.trim().toLowerCase()}` : '',
      error ? `error=${normalizeRunHistoryText(error)}` : '',
      output ? `output=${normalizeRunHistoryText(output)}` : '',
      metrics ? `metrics=${metrics}` : '',
    ].filter(Boolean).join('|')
    if (normalized) values.push(normalized)
  }
  return values
}

function normalizeCommandContext(parsed: Record<string, any>): string {
  const nestedManifest = parsed.preparation_manifest || parsed.preparationManifest || parsed.manifest
  const normalizedDependencies = normalizeStringList([
    ...collectDependencyContext(parsed.dependencies),
    ...collectInstalledDependencyContext(parsed.installed_dependencies),
    ...collectInstalledDependencyContext(parsed.installedDependencies),
    ...collectDependencyContext(nestedManifest?.dependencies),
    ...collectInstalledDependencyContext(nestedManifest?.installed_dependencies),
    ...collectInstalledDependencyContext(nestedManifest?.installedDependencies),
  ])
  const normalizedModels = normalizeStringList([
    ...collectModelContext(parsed),
    ...collectModelContext(nestedManifest),
  ])
  const normalizedSmokeTests = normalizeStringList([
    ...collectSmokeTestContext(parsed),
    ...collectSmokeTestContext(nestedManifest),
  ])
  const normalizedArtifacts = normalizeStringList([
    ...collectArtifactContext(parsed),
    ...collectArtifactContext(nestedManifest),
  ])
  const normalizedRunHistory = normalizeStringList([
    ...collectRunHistoryContext(parsed),
    ...collectRunHistoryContext(nestedManifest),
  ])
  const normalizedGrading = normalizeStringList([
    ...collectGradingContext(parsed),
    ...collectGradingContext(nestedManifest),
  ])
  const workbenchContext = normalizeWorkbenchContext(nestedManifest) || normalizeWorkbenchContext(parsed)
  return [
    normalizedDependencies ? `dependencies=${normalizedDependencies}` : '',
    normalizedModels ? `models=${normalizedModels}` : '',
    normalizedSmokeTests ? `smoke_tests=${normalizedSmokeTests}` : '',
    normalizedArtifacts ? `artifacts=${normalizedArtifacts}` : '',
    normalizedRunHistory ? `run_history=${normalizedRunHistory}` : '',
    normalizedGrading ? `grading=${normalizedGrading}` : '',
    workbenchContext ? `workbench=${workbenchContext}` : '',
  ].filter(Boolean).join('\n')
}

function findQuotedValueForKey(text: string, key: string): string | null {
  const keyPattern = new RegExp(`['"]${key}['"]\\s*:`, 'g')
  let match: RegExpExecArray | null
  while ((match = keyPattern.exec(text)) !== null) {
    let index = match.index + match[0].length
    while (/\s/.test(text[index] || '')) index += 1
    const quote = text[index]
    if (quote !== '\'' && quote !== '"') continue

    let value = ''
    let escaped = false
    for (let i = index + 1; i < text.length; i++) {
      const ch = text[i]
      if (escaped) {
        value += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === quote) return value
      value += ch
    }
  }
  return null
}

function findStringArrayForKey(text: string, key: string): string[] {
  const keyPattern = new RegExp(`['"]${key}['"]\\s*:\\s*\\[`, 'g')
  const match = keyPattern.exec(text)
  if (!match) return []

  const values: string[] = []
  let index = match.index + match[0].length
  while (index < text.length) {
    while (/[\s,]/.test(text[index] || '')) index += 1
    if (text[index] === ']') return values
    const quote = text[index]
    if (quote !== '\'' && quote !== '"') return values

    let value = ''
    let escaped = false
    for (let i = index + 1; i < text.length; i++) {
      const ch = text[i]
      if (escaped) {
        value += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === quote) {
        values.push(value)
        index = i + 1
        break
      }
      value += ch
    }
    if (escaped) return values
  }

  return values
}

function extractPythonRunCommand(text: string): Record<string, any> | null {
  const action = findQuotedValueForKey(text, 'action')
  const code = findQuotedValueForKey(text, 'code')
  if (action !== 'run_python' || !code?.trim()) return null

  const command: Record<string, any> = { action, code }
  const dependencies = findStringArrayForKey(text, 'dependencies')
  if (dependencies.length) command.dependencies = dependencies
  const installedDependencies = findStringArrayForKey(text, 'installed_dependencies')
  if (installedDependencies.length) command.installed_dependencies = installedDependencies
  const modelIds = findStringArrayForKey(text, 'model_ids')
  if (modelIds.length) command.model_ids = modelIds
  const modelPaths = findStringArrayForKey(text, 'model_paths')
  if (modelPaths.length) command.model_paths = modelPaths

  const workbenchReuseKey = findQuotedValueForKey(text, 'workbenchReuseKey')
  if (workbenchReuseKey) command.workbenchReuseKey = workbenchReuseKey

  return command
}

function extractExecutableSignatureText(value: string): string | null {
  const text = String(value || '')
  const codeBlock = text.match(/\[CODE\]\s*([\s\S]*?)\s*\[\/CODE\]/i)
  if (codeBlock?.[1]?.trim()) return codeBlock[1]

  const fencedCodeBlock = text.match(/(^|\n)\s*```(?:python|py|code)?\s*\n([\s\S]*?)\n\s*```/i)
  if (fencedCodeBlock?.[2]?.trim()) return fencedCodeBlock[2]

  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed?.action === 'run_python' && typeof parsed.code === 'string' && parsed.code.trim()) {
        const normalizedCode = normalizeCodeText(parsed.code)
        const normalizedContext = normalizeCommandContext(parsed)
        return [normalizedCode, normalizedContext]
          .filter(Boolean)
          .join('\n---COMMAND-CONTEXT---\n')
      }
    } catch {
      const parsed = parseMetricObjectCandidate(candidate)
      if (parsed?.action === 'run_python' && typeof parsed.code === 'string' && parsed.code.trim()) {
        const normalizedCode = normalizeCodeText(parsed.code)
        const normalizedContext = normalizeCommandContext(parsed)
        return [normalizedCode, normalizedContext]
          .filter(Boolean)
          .join('\n---COMMAND-CONTEXT---\n')
      }
    }
  }

  const pythonCommand = extractPythonRunCommand(text)
  if (pythonCommand) {
    const normalizedCode = normalizeCodeText(pythonCommand.code)
    const normalizedContext = normalizeCommandContext(pythonCommand)
    return [normalizedCode, normalizedContext]
      .filter(Boolean)
      .join('\n---COMMAND-CONTEXT---\n')
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


function textIsGpuContractTerminalFailure(value: string): boolean {
  const haystack = String(value || '').toLowerCase()
  return /gpu[_ -]?(contract|completion|validation)/i.test(haystack)
    || haystack.includes('[gpu contract failed]')
    || haystack.includes('[gpu completion invalid]')
    || haystack.includes('strict executable gpu evidence')
    || haystack.includes('required model manifest evidence')
    || haystack.includes('model_load_attempts')
}

function isGpuContractTerminalFailure(variant: VariantLike): boolean {
  const haystack = [
    variant.failureMode || '',
    variant.feedback || '',
    ...(Array.isArray(variant.steps)
      ? variant.steps.map(step => [step.result, step.feedback].filter(Boolean).join('\n'))
      : []),
  ].join('\n')

  return textIsGpuContractTerminalFailure(haystack)
}

export function shouldRegenerateTerminalFailedStage(
  variants: VariantLike[],
  stageId: string,
): boolean {
  const stageVariants = variants.filter(variant => variant.stageId === stageId)
  if (stageVariants.length === 0) return false

  return stageVariants.every(variant => {
    const status = String(variant.status || '').toUpperCase()
    if (!['FAILED', 'PENDING_REVIEW'].includes(status)) return false
    const steps = Array.isArray(variant.steps) ? variant.steps : []
    if (steps.length === 0) return isGpuContractTerminalFailure(variant)
    return steps.every(step => {
      if (String(step.status || '').toUpperCase() !== 'FAILED') return false
      return textIsGpuContractTerminalFailure([step.result, step.feedback].filter(Boolean).join('\n'))
    })
  })
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
    const lowestGrade = grades.length ? Math.min(...grades) : null
    const highestGrade = grades.length ? Math.max(...grades) : null
    const hasGradeImprovement = lowestGrade !== null && highestGrade !== null && highestGrade > lowestGrade
    const metricProgressCount = completed
      .map(variantMetricProgressSignature)
      .filter((signature): signature is string => Boolean(signature))
      .length
    const noMetricProgressDeadLoop = (): DeadLoopAssessment => ({
      stuck: true,
      repeatedSignature: 'completed-without-metric-progress-evidence',
      repeatedCount: completed.length,
      reason: `Dead-loop detector found ${completed.length} completed ${stageId} variants without normalized metric evidence and no grade improvement. Pausing so the next retry produces concrete metrics, grading evidence, or a changed preparation manifest instead of accepting generic completions.`,
    })

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

      if (completed.length >= repeatThreshold && metricProgressCount === 0 && !hasGradeImprovement && (bestGrade === null || bestGrade <= 0)) {
        return noMetricProgressDeadLoop()
      }

      return { stuck: false, reason: 'stage has completed variants with progress evidence' }
    }

    if (completed.length >= repeatThreshold && metricProgressCount === 0 && !hasGradeImprovement && (bestGrade === null || bestGrade <= 0)) {
      return noMetricProgressDeadLoop()
    }
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
    return { stuck: false, reason: 'stage has varied executable code or command context signatures' }
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
