export const PREPARATION_MANIFEST_SCHEMA_VERSION = 'ar3.preparation-manifest.v1'

export type PreparationModel = {
  id: string
  source: 'huggingface' | 'github' | 'url' | 'local' | 'none'
  purpose: string
  required: boolean
  smokeTest?: string
}

export type PreparationDependency = {
  name: string
  purpose: string
  required: boolean
  importName?: string
  versionSpec?: string
}

export type PreparationResource = {
  kind: 'gpu' | 'dataset' | 'file' | 'service' | 'web' | 'other'
  name: string
  purpose: string
  required: boolean
}

export type PreparationSmokeTest = {
  name: string
  command: string
  expectedEvidence: string[]
  timeoutSeconds: number
}

export type PreparationSuccessCriterion = {
  name: string
  metric: string
  threshold: string
  evidence: string
}

export type PreparationManifest = {
  schemaVersion: string
  researchType: string
  objective: string
  models: PreparationModel[]
  dependencies: PreparationDependency[]
  resources: PreparationResource[]
  smokeTests: PreparationSmokeTest[]
  gradingCriteria: string[]
  successCriteria?: PreparationSuccessCriterion[]
  workbench: {
    reuseKey: string
    expectedArtifacts: string[]
  }
}

type ValidationOk = { ok: true; manifest: PreparationManifest; errors: [] }
type ValidationErr = { ok: false; errors: string[] }
export type PreparationManifestValidation = ValidationOk | ValidationErr

const VAGUE_DEPENDENCIES = new Set(['stuff', 'things', 'dependencies', 'packages', 'libs', 'libraries', 'requirements', 'misc'])
const VAGUE_PURPOSES = new Set(['stuff', 'things', 'misc', 'needed', 'required', 'useful'])
const VAGUE_GRADING_CRITERIA = new Set([
  'works',
  'it works',
  'good results',
  'better results',
  'improve performance',
  'performance improves',
  'successful',
  'success',
  'quality',
  'useful',
  'interesting',
])
const SMOKE_TEST_EXECUTABLES = new Set(['python', 'python3', 'pytest', 'node', 'npm', 'npx', 'bash', 'sh', 'nvidia-smi'])
const RESOURCE_KINDS = new Set(['gpu', 'dataset', 'file', 'service', 'web', 'other'])
const PROSE_COMMAND_MARKERS = /\b(?:please|should|could|would|try to|somehow|maybe|probably|manually|then inspect|as needed)\b/i
const DESTRUCTIVE_COMMAND_MARKERS = /\b(?:rm\s+-rf|mkfs|shutdown|reboot|poweroff|halt|dd\s+if=|:>\s*\/)\b/i
const EPHEMERAL_PATH_MARKERS = /^(?:\/tmp\/|\/var\/tmp\/|\/dev\/shm\/|file:\/\/)/i
const PATH_TRAVERSAL_MARKERS = /(?:^|\/)\.\.(?:\/|$)/
const GRADING_ANCHOR_STOPWORDS = new Set([
  'and',
  'are',
  'check',
  'checks',
  'concrete',
  'contain',
  'contains',
  'exact',
  'include',
  'includes',
  'must',
  'the',
  'with',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validHuggingFaceRepoId(id: string): boolean {
  // HF repo IDs are owner/name. Reject URL fragments like LLaDA-8B-Base/re
  // by requiring an owner and a meaningful repo name, not a path suffix.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{1,95}$/.test(id)) return false
  const [, repo] = id.split('/')
  if (['resolve', 'blob', 'tree', 'raw', 'main', 're'].includes(repo.toLowerCase())) return false
  return true
}

function validPackageSpec(name: string): boolean {
  const trimmed = name.trim()
  if (VAGUE_DEPENDENCIES.has(trimmed.toLowerCase())) return false
  const versionClause = '(?:==|!=|~=|>=|<=|>|<)\\s*[A-Za-z0-9.*+!_:-]+'
  const packageSpecPattern = new RegExp(
    `^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\\[[A-Za-z0-9_,.-]+\\])?(?:\\s*${versionClause}(?:\\s*,\\s*${versionClause})*)?$`
  )
  return packageSpecPattern.test(trimmed)
}

function validImportName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value.trim())
}

function validVersionSpec(value: string): boolean {
  const trimmed = value.trim()
  const versionClause = '(?:==|!=|~=|>=|<=|>|<)\\s*[A-Za-z0-9.*+!_:-]+'
  return new RegExp(`^${versionClause}(?:\\s*,\\s*${versionClause})*$`).test(trimmed)
}

function validGradingCriterion(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ')
  if (normalized.length < 12) return false
  if (VAGUE_GRADING_CRITERIA.has(normalized)) return false

  return /\b(json|metric|metrics|score|loss|accuracy|acc|f1|precision|recall|latency|throughput|runtime|seconds|cuda|gpu|vram|memory|artifact|artifacts|stdout|stderr|file|path|model|dependency|dependencies|smoke|failure|error|exception|evidence|measurement|tensor|shape|count|version)\b|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/i.test(value)
}

function validEvidenceField(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3) return false
  if (VAGUE_GRADING_CRITERIA.has(trimmed.toLowerCase())) return false
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(trimmed) || validGradingCriterion(trimmed)
}

function validNumericThreshold(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return /^(>=|>|<=|<|=|==)\s*-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(normalized) ||
    /\b(at least|minimum|min|greater than|more than|above|at most|maximum|max|less than|below|under|no more than|equals?|equal to)\b\s*-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.test(normalized)
}

function evidenceAnchorTokens(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, ' ')
  const tokens = new Set<string>()
  for (const raw of normalized.match(/[a-z][a-z0-9_.-]*/g) || []) {
    const parts = raw.split(/[._-]+/).filter(Boolean)
    for (const part of [raw, ...parts]) {
      const token = part.replace(/s$/, '')
      if (token.length >= 3 && !GRADING_ANCHOR_STOPWORDS.has(token)) tokens.add(token)
    }
  }
  return Array.from(tokens)
}

function gradingCriterionHasEvidenceAnchor(criterion: string, anchors: Set<string>): boolean {
  if (anchors.size === 0) return true
  return evidenceAnchorTokens(criterion).some(token => anchors.has(token))
}

function commandStartsWithExecutable(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const firstToken = trimmed.match(/^([A-Za-z0-9_.-]+)/)?.[1]
  if (firstToken && SMOKE_TEST_EXECUTABLES.has(firstToken)) return true

  // Permit common environment wrappers only when the wrapped command is also explicit.
  const wrapped = trimmed.match(/^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*|timeout\s+\d+[smh]?\s+)([A-Za-z0-9_.-]+)/)
  return Boolean(wrapped?.[1] && SMOKE_TEST_EXECUTABLES.has(wrapped[1]))
}

function validSmokeTestCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length < 4) return false
  if (PROSE_COMMAND_MARKERS.test(trimmed)) return false
  if (DESTRUCTIVE_COMMAND_MARKERS.test(trimmed)) return false
  return commandStartsWithExecutable(trimmed)
}

function validWorkbenchReuseKey(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3 || trimmed.length > 80) return false
  if (EPHEMERAL_PATH_MARKERS.test(trimmed) || PATH_TRAVERSAL_MARKERS.test(trimmed)) return false
  return /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i.test(trimmed)
}

function validExpectedArtifactName(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3 || trimmed.length > 160) return false
  if (EPHEMERAL_PATH_MARKERS.test(trimmed) || PATH_TRAVERSAL_MARKERS.test(trimmed)) return false
  if (/^[a-z]+:\/\//i.test(trimmed)) return false
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(trimmed)
}

function pushStringError(errors: string[], path: string, value: unknown) {
  if (!nonEmptyString(value)) errors.push(`${path} must be a non-empty string`)
}

function normalizePreparationManifest(value: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...value }

  if (Array.isArray(normalized.models)) {
    normalized.models = normalized.models.map((model: unknown) => {
      if (!isPlainObject(model)) return model
      const id = model.id ?? model.modelId ?? model.repoId ?? model.huggingFaceId
      return {
        ...model,
        id,
        source: model.source ?? (nonEmptyString(id) && validHuggingFaceRepoId(id) ? 'huggingface' : 'url'),
        required: typeof model.required === 'boolean' ? model.required : true,
      }
    })
  }

  if (Array.isArray(normalized.dependencies)) {
    normalized.dependencies = normalized.dependencies.map((dep: unknown) => {
      if (!isPlainObject(dep)) return dep
      return {
        ...dep,
        name: dep.name ?? dep.package ?? dep.pip ?? dep.pipPackage,
        required: typeof dep.required === 'boolean' ? dep.required : true,
      }
    })
  }

  if (Array.isArray(normalized.resources)) {
    normalized.resources = normalized.resources.map((resource: unknown) => {
      if (!isPlainObject(resource)) return resource
      const kind = resource.kind ?? (RESOURCE_KINDS.has(String(resource.resourceType)) ? resource.resourceType : 'other')
      return {
        ...resource,
        kind,
        name: resource.name ?? resource.specification ?? resource.resourceType ?? 'resource',
        required: typeof resource.required === 'boolean' ? resource.required : true,
      }
    })
  }

  if (Array.isArray(normalized.smokeTests)) {
    normalized.smokeTests = normalized.smokeTests.map((test: unknown, i: number) => {
      if (!isPlainObject(test)) return test
      const evidence = test.expectedEvidence
      return {
        ...test,
        name: test.name ?? `smoke-${i + 1}`,
        command: test.command ?? test.test,
        expectedEvidence: Array.isArray(evidence) ? evidence : (nonEmptyString(evidence) ? [evidence] : evidence),
        timeoutSeconds: typeof test.timeoutSeconds === 'number' ? test.timeoutSeconds : 300,
      }
    })
  }

  if (Array.isArray(normalized.gradingCriteria)) {
    normalized.gradingCriteria = normalized.gradingCriteria.map((criterion: unknown) => {
      if (nonEmptyString(criterion)) return criterion
      if (isPlainObject(criterion)) {
        return [criterion.criterion, criterion.evidence].filter(nonEmptyString).join(' — ')
      }
      return criterion
    })
  }

  const successCriteria = normalized.successCriteria ?? normalized.success_criteria
  if (Array.isArray(successCriteria)) {
    normalized.successCriteria = successCriteria.map((criterion: unknown, i: number) => {
      if (nonEmptyString(criterion)) {
        return {
          name: `success-${i + 1}`,
          metric: criterion,
          threshold: '',
          evidence: criterion,
        }
      }
      if (!isPlainObject(criterion)) return criterion
      return {
        ...criterion,
        name: criterion.name ?? criterion.criterion ?? criterion.metric ?? `success-${i + 1}`,
        metric: criterion.metric ?? criterion.field ?? criterion.key,
        threshold: criterion.threshold ?? criterion.target ?? criterion.minimum ?? criterion.max,
        evidence: criterion.evidence ?? criterion.expectedEvidence ?? criterion.expected_evidence ?? criterion.metric ?? criterion.field,
      }
    })
    delete normalized.success_criteria
  }

  if (!isPlainObject(normalized.workbench)) {
    normalized.workbench = {
      reuseKey: `${String(normalized.researchType || 'research')}-workbench`,
      expectedArtifacts: ['stdout', 'metrics.json', 'preparation_manifest.json'],
    }
  }

  return normalized
}

export function validatePreparationManifest(value: unknown): PreparationManifestValidation {
  const errors: string[] = []
  if (!isPlainObject(value)) return { ok: false, errors: ['manifest must be a JSON object'] }
  value = normalizePreparationManifest(value)

  if (value.schemaVersion !== PREPARATION_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal ${PREPARATION_MANIFEST_SCHEMA_VERSION}`)
  }
  pushStringError(errors, 'researchType', value.researchType)
  pushStringError(errors, 'objective', value.objective)

  const models = Array.isArray(value.models) ? value.models : []
  if (!Array.isArray(value.models)) errors.push('models must be an array')
  models.forEach((model, i) => {
    if (!isPlainObject(model)) {
      errors.push(`models[${i}] must be an object`)
      return
    }
    pushStringError(errors, `models[${i}].id`, model.id)
    if (model.source === 'huggingface' && nonEmptyString(model.id) && !validHuggingFaceRepoId(model.id)) {
      errors.push(`models[${i}].id must be a valid HuggingFace repo id like owner/model, not a URL/path fragment`)
    }
    if (!['huggingface', 'github', 'url', 'local', 'none'].includes(String(model.source))) {
      errors.push(`models[${i}].source must be one of huggingface, github, url, local, none`)
    }
    pushStringError(errors, `models[${i}].purpose`, model.purpose)
    if (typeof model.required !== 'boolean') errors.push(`models[${i}].required must be boolean`)
    if (model.required === true && !nonEmptyString(model.smokeTest)) {
      errors.push(`models[${i}].smokeTest is required for required models`)
    }
  })

  const dependencies = Array.isArray(value.dependencies) ? value.dependencies : []
  if (!Array.isArray(value.dependencies)) errors.push('dependencies must be an array')
  dependencies.forEach((dep, i) => {
    if (!isPlainObject(dep)) {
      errors.push(`dependencies[${i}] must be an object`)
      return
    }
    if (!nonEmptyString(dep.name) || !validPackageSpec(dep.name)) {
      errors.push(`dependencies[${i}].name must be a concrete pip package spec, not a vague placeholder`)
    }
    if (!nonEmptyString(dep.purpose) || VAGUE_PURPOSES.has(dep.purpose.trim().toLowerCase())) {
      errors.push(`dependencies[${i}].purpose must explain why the package is needed`)
    }
    if (dep.importName !== undefined && (!nonEmptyString(dep.importName) || !validImportName(dep.importName))) {
      errors.push(`dependencies[${i}].importName must be a concrete Python import path like torch or transformers.models`)
    }
    if (dep.versionSpec !== undefined && (!nonEmptyString(dep.versionSpec) || !validVersionSpec(dep.versionSpec))) {
      errors.push(`dependencies[${i}].versionSpec must be a pip version constraint like >=2.4.0 or ==4.45.*`)
    }
    if (typeof dep.required !== 'boolean') errors.push(`dependencies[${i}].required must be boolean`)
  })

  const resources = Array.isArray(value.resources) ? value.resources : []
  if (!Array.isArray(value.resources)) errors.push('resources must be an array')
  resources.forEach((resource, i) => {
    if (!isPlainObject(resource)) {
      errors.push(`resources[${i}] must be an object`)
      return
    }
    if (!RESOURCE_KINDS.has(String(resource.kind))) {
      errors.push(`resources[${i}].kind must be one of gpu, dataset, file, service, web, other`)
    }
    pushStringError(errors, `resources[${i}].name`, resource.name)
    pushStringError(errors, `resources[${i}].purpose`, resource.purpose)
    if (typeof resource.required !== 'boolean') errors.push(`resources[${i}].required must be boolean`)
  })

  const smokeTests = Array.isArray(value.smokeTests) ? value.smokeTests : []
  if (!Array.isArray(value.smokeTests)) errors.push('smokeTests must be an array')
  if (smokeTests.length === 0) errors.push('smokeTests must contain at least one executable test')
  const evidenceAnchors = new Set<string>()
  smokeTests.forEach((test, i) => {
    if (!isPlainObject(test)) {
      errors.push(`smokeTests[${i}] must be an object`)
      return
    }
    pushStringError(errors, `smokeTests[${i}].name`, test.name)
    if (!nonEmptyString(test.command) || !validSmokeTestCommand(test.command)) {
      errors.push(`smokeTests[${i}].command must start with an allowed executable command, not prose or destructive shell text`)
    }
    if (!Array.isArray(test.expectedEvidence) || test.expectedEvidence.length === 0 || !test.expectedEvidence.every(nonEmptyString)) {
      errors.push(`smokeTests[${i}].expectedEvidence must list concrete evidence fields`)
    } else {
      for (const item of test.expectedEvidence) {
        if (!validEvidenceField(String(item))) {
          errors.push(`smokeTests[${i}].expectedEvidence must list concrete evidence fields, metrics, artifacts, stdout/stderr facts, or precise failure evidence`)
          break
        }
        evidenceAnchorTokens(String(item)).forEach(token => evidenceAnchors.add(token))
      }
    }
    if (typeof test.timeoutSeconds !== 'number' || test.timeoutSeconds < 5 || test.timeoutSeconds > 86400) {
      errors.push(`smokeTests[${i}].timeoutSeconds must be between 5 and 86400`)
    }
  })

  if (!Array.isArray(value.gradingCriteria) || value.gradingCriteria.length === 0 || !value.gradingCriteria.every(nonEmptyString)) {
    errors.push('gradingCriteria must contain at least one concrete criterion')
  } else {
    value.gradingCriteria.forEach((criterion, i) => {
      if (!validGradingCriterion(String(criterion))) {
        errors.push(`gradingCriteria[${i}] must name concrete evidence, metrics, artifacts, model/dependency checks, GPU/runtime facts, or failure modes`)
      }
    })
  }

  const successCriteria = Array.isArray(value.successCriteria) ? value.successCriteria : []
  if (value.successCriteria !== undefined && !Array.isArray(value.successCriteria)) {
    errors.push('successCriteria must be an array when provided')
  }
  successCriteria.forEach((criterion, i) => {
    if (!isPlainObject(criterion)) {
      errors.push(`successCriteria[${i}] must be an object with metric, threshold, and evidence`)
      return
    }
    if (!nonEmptyString(criterion.name)) errors.push(`successCriteria[${i}].name must be a non-empty string`)
    if (!nonEmptyString(criterion.metric) || !validEvidenceField(String(criterion.metric))) {
      errors.push(`successCriteria[${i}].metric must name a concrete measurable output field`)
    }
    if (!nonEmptyString(criterion.threshold) || !validNumericThreshold(String(criterion.threshold))) {
      errors.push(`successCriteria[${i}].threshold must be a numeric threshold like >= 0.75`)
    }
    if (!nonEmptyString(criterion.evidence) || !validEvidenceField(String(criterion.evidence))) {
      errors.push(`successCriteria[${i}].evidence must name concrete output evidence`)
    }
  })

  if (!isPlainObject(value.workbench)) {
    errors.push('workbench must be an object')
  } else {
    if (!nonEmptyString(value.workbench.reuseKey) || !validWorkbenchReuseKey(value.workbench.reuseKey)) {
      errors.push('workbench.reuseKey must be a stable slug, not a temp path, URL, traversal path, or vague placeholder')
    }
    if (!Array.isArray(value.workbench.expectedArtifacts) || value.workbench.expectedArtifacts.length === 0 || !value.workbench.expectedArtifacts.every(nonEmptyString)) {
      errors.push('workbench.expectedArtifacts must be a non-empty array of artifact names')
    } else {
      for (const artifact of value.workbench.expectedArtifacts) {
        if (!validExpectedArtifactName(String(artifact))) {
          errors.push('workbench.expectedArtifacts must contain stable relative artifact names, not temp paths, URLs, or traversal paths')
        }
        evidenceAnchorTokens(String(artifact)).forEach(token => evidenceAnchors.add(token))
      }
    }
  }

  if (Array.isArray(value.gradingCriteria) && value.gradingCriteria.every(nonEmptyString)) {
    value.gradingCriteria.forEach((criterion, i) => {
      if (!gradingCriterionHasEvidenceAnchor(String(criterion), evidenceAnchors)) {
        errors.push(`gradingCriteria[${i}] must reference evidence named by smokeTests.expectedEvidence or workbench.expectedArtifacts`)
      }
    })
  }

  if (successCriteria.length > 0) {
    successCriteria.forEach((criterion, i) => {
      if (!isPlainObject(criterion)) return
      if (nonEmptyString(criterion.metric) && !gradingCriterionHasEvidenceAnchor(criterion.metric, evidenceAnchors)) {
        errors.push(`successCriteria[${i}].metric must reference evidence named by smokeTests.expectedEvidence or workbench.expectedArtifacts`)
      }
      if (nonEmptyString(criterion.evidence) && !gradingCriterionHasEvidenceAnchor(criterion.evidence, evidenceAnchors)) {
        errors.push(`successCriteria[${i}].evidence must reference evidence named by smokeTests.expectedEvidence or workbench.expectedArtifacts`)
      }
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: value as PreparationManifest, errors: [] }
}

function preparationManifestFromParsedJson(parsed: unknown): unknown {
  if (isPlainObject(parsed)) {
    const nested = parsed.preparation_manifest ?? parsed.preparationManifest ?? parsed.manifest
    if (isPlainObject(nested) && nested.schemaVersion === PREPARATION_MANIFEST_SCHEMA_VERSION) {
      return nested
    }
  }
  return parsed
}

export function extractPreparationManifestCandidate(text: string): unknown {
  const stripped = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const candidates = [stripped]

  try {
    return preparationManifestFromParsedJson(JSON.parse(stripped))
  } catch {}

  const jsonBlock = String(text || '').match(/```json\s*([\s\S]*?)```/i)
  if (jsonBlock?.[1]) candidates.push(jsonBlock[1].trim())

  const source = stripped || String(text || '')
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
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(source.slice(start, i + 1))
          break
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isPlainObject(parsed)) {
        const nested = parsed.preparation_manifest ?? parsed.preparationManifest ?? parsed.manifest
        if (isPlainObject(nested) && nested.schemaVersion === PREPARATION_MANIFEST_SCHEMA_VERSION) {
          return nested
        }
      }
      return parsed
    } catch {}
  }
  return null
}

export function buildPreparationRetryMessage(originalGoal: string, errors: string[]): string {
  return `Your preparation manifest was rejected by AR-3's validator.\n\nOriginal goal:\n${originalGoal}\n\nValidation errors:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReturn ONLY JSON matching schemaVersion ${PREPARATION_MANIFEST_SCHEMA_VERSION}. No markdown, no prose, no code fences. Include concrete model IDs, pip package specs, executable smokeTests, evidence fields, gradingCriteria tied to measurable evidence, optional successCriteria with numeric thresholds, and a reusable workbench key.`
}

export function buildPreparationManifestInstructions(researchGoal: string): string {
  return `Prepare this research goal for executable GPU work:\n${researchGoal}\n\nReturn ONLY JSON with schemaVersion ${PREPARATION_MANIFEST_SCHEMA_VERSION}. Required top-level fields: researchType, objective, models, dependencies, resources, smokeTests, gradingCriteria, workbench. Optional successCriteria entries must include name, metric, numeric threshold, and evidence. Every required HuggingFace model must have an owner/model id and a smokeTest. Every dependency must be a concrete pip package spec with purpose. Every smokeTest must be an executable command and list expectedEvidence. Every grading criterion must name concrete evidence, metrics, artifacts, model/dependency checks, GPU/runtime facts, or failure modes.`
}
