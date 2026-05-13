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

export type PreparationManifest = {
  schemaVersion: string
  researchType: string
  objective: string
  models: PreparationModel[]
  dependencies: PreparationDependency[]
  resources: PreparationResource[]
  smokeTests: PreparationSmokeTest[]
  gradingCriteria: string[]
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
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*(\[[A-Za-z0-9_,.-]+\])?([<>=!~]=?.+)?$/.test(trimmed)
}

function pushStringError(errors: string[], path: string, value: unknown) {
  if (!nonEmptyString(value)) errors.push(`${path} must be a non-empty string`)
}

export function validatePreparationManifest(value: unknown): PreparationManifestValidation {
  const errors: string[] = []
  if (!isPlainObject(value)) return { ok: false, errors: ['manifest must be a JSON object'] }

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
    if (typeof dep.required !== 'boolean') errors.push(`dependencies[${i}].required must be boolean`)
  })

  const resources = Array.isArray(value.resources) ? value.resources : []
  if (!Array.isArray(value.resources)) errors.push('resources must be an array')
  resources.forEach((resource, i) => {
    if (!isPlainObject(resource)) {
      errors.push(`resources[${i}] must be an object`)
      return
    }
    pushStringError(errors, `resources[${i}].name`, resource.name)
    pushStringError(errors, `resources[${i}].purpose`, resource.purpose)
    if (typeof resource.required !== 'boolean') errors.push(`resources[${i}].required must be boolean`)
  })

  const smokeTests = Array.isArray(value.smokeTests) ? value.smokeTests : []
  if (!Array.isArray(value.smokeTests)) errors.push('smokeTests must be an array')
  if (smokeTests.length === 0) errors.push('smokeTests must contain at least one executable test')
  smokeTests.forEach((test, i) => {
    if (!isPlainObject(test)) {
      errors.push(`smokeTests[${i}] must be an object`)
      return
    }
    pushStringError(errors, `smokeTests[${i}].name`, test.name)
    if (!nonEmptyString(test.command) || !/(python|pytest|node|bash|sh|nvidia-smi)/.test(test.command)) {
      errors.push(`smokeTests[${i}].command must be an executable command`)
    }
    if (!Array.isArray(test.expectedEvidence) || test.expectedEvidence.length === 0 || !test.expectedEvidence.every(nonEmptyString)) {
      errors.push(`smokeTests[${i}].expectedEvidence must list concrete evidence fields`)
    }
    if (typeof test.timeoutSeconds !== 'number' || test.timeoutSeconds < 5 || test.timeoutSeconds > 86400) {
      errors.push(`smokeTests[${i}].timeoutSeconds must be between 5 and 86400`)
    }
  })

  if (!Array.isArray(value.gradingCriteria) || value.gradingCriteria.length === 0 || !value.gradingCriteria.every(nonEmptyString)) {
    errors.push('gradingCriteria must contain at least one concrete criterion')
  }

  if (!isPlainObject(value.workbench)) {
    errors.push('workbench must be an object')
  } else {
    pushStringError(errors, 'workbench.reuseKey', value.workbench.reuseKey)
    if (!Array.isArray(value.workbench.expectedArtifacts) || !value.workbench.expectedArtifacts.every(nonEmptyString)) {
      errors.push('workbench.expectedArtifacts must be an array of artifact names')
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: value as PreparationManifest, errors: [] }
}

export function extractPreparationManifestCandidate(text: string): unknown {
  const stripped = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const candidates = [stripped]
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
      return JSON.parse(candidate)
    } catch {}
  }
  return null
}

export function buildPreparationRetryMessage(originalGoal: string, errors: string[]): string {
  return `Your preparation manifest was rejected by AR-3's validator.\n\nOriginal goal:\n${originalGoal}\n\nValidation errors:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReturn ONLY JSON matching schemaVersion ${PREPARATION_MANIFEST_SCHEMA_VERSION}. No markdown, no prose, no code fences. Include concrete model IDs, pip package specs, executable smokeTests, evidence fields, gradingCriteria, and a reusable workbench key.`
}

export function buildPreparationManifestInstructions(researchGoal: string): string {
  return `Prepare this research goal for executable GPU work:\n${researchGoal}\n\nReturn ONLY JSON with schemaVersion ${PREPARATION_MANIFEST_SCHEMA_VERSION}. Required top-level fields: researchType, objective, models, dependencies, resources, smokeTests, gradingCriteria, workbench. Every required HuggingFace model must have an owner/model id and a smokeTest. Every dependency must be a concrete pip package spec with purpose. Every smokeTest must be an executable command and list expectedEvidence.`
}
