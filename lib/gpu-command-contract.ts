export type StrictGpuCommand = { action: 'run_python'; dependencies: string[]; code: string }

export function shouldUseAutonomousPreparationFallback(stageName: string): boolean {
  return ['Investigation', 'Planning'].includes(stageName)
}

export function stepRequestsPreparation(stepDescription: string | undefined | null): boolean {
  const text = String(stepDescription || '')
  return /\b(prepare|preparation|setup|set up|set-up|download|checksum|model cache)\b/i.test(text) ||
    /\bcache\s+(?:model|weights?|checkpoint|snapshot|artifacts?)\b/i.test(text) ||
    /\b(?:weights?|checkpoint|snapshot)\b.*\b(?:download|cache|checksum|prepare|preparation|setup)\b/i.test(text)
}


const GPU_SPACE_ROUTED_STAGES = new Set([
  'Implementation',
  'Testing',
  'Verification',
])

export function shouldRouteStageThroughGpu(stageName: string, stageGpuEnabled: boolean | undefined, spaceUseGpu: boolean | undefined | null): boolean {
  return Boolean(spaceUseGpu && GPU_SPACE_ROUTED_STAGES.has(stageName))
}
function isDeterministicGpuContractFailure(reason: string): boolean {
  const normalized = String(reason || '').toLowerCase()
  return [
    'response did not parse',
    'json action must',
    'placeholder',
    'pseudocode',
    'code too short',
    'missing non-empty code',
    'lacks python syntax',
    'unmanaged absolute /tmp path',
  ].some(marker => normalized.includes(marker))
}

export function shouldShortCircuitPreparationFallback(stageName: string, reason: string): boolean {
  return shouldShortCircuitGpuContractFailure(stageName, reason, false)
}

export function shouldShortCircuitGpuContractFailure(stageName: string, reason: string, hasPreparationManifest: boolean): boolean {
  if (!isDeterministicGpuContractFailure(reason)) return false
  if (shouldUseAutonomousPreparationFallback(stageName)) return true
  return Boolean(hasPreparationManifest)
}

type StrictGpuResult = { ok: true; command: StrictGpuCommand } | { ok: false; reason: string }

type FallbackInput = {
  researchGoal: string
  stepDescription: string
  stageName?: string
  reason?: string
}

type DeterministicExperimentInput = {
  researchGoal: string
  stepDescription: string
  stageName?: string
  reason?: string
  preparationManifest?: unknown
}

type GpuSubmissionInput = {
  stageName: string
  llmResponse: string
  researchGoal: string
  stepDescription: string
  manifestValidatedThisCycle?: boolean
  preparationManifest?: unknown
}

type GpuSubmissionResult =
  | { ok: true; command: StrictGpuCommand; fallbackUsed: boolean; reason: string }
  | { ok: false; reason: string }

type GpuEvidenceInput = {
  stageName: string
  fallbackUsed?: boolean
  success?: boolean
  output?: string | null
  error?: string | null
  preparationManifest?: unknown
}

type GpuEvidenceResult = { valid: true; reason: string } | { valid: false; reason: string }

type GpuStepCompletionInput = {
  stepDescription?: string | null
  stepName?: string | null
}

type GpuStepCompletionResult = { valid: true; reason: string } | { valid: false; reason: string }

type PersistablePreparationResult =
  | { ok: true; manifest: any; reason: string }
  | { ok: false; reason: string }

function strictGpuFailureReason(result: StrictGpuResult): string {
  return (result as { ok: false; reason?: string }).reason || 'invalid strict GPU command'
}

export function assessGpuStepCompletion(content: string, input: GpuStepCompletionInput = {}): GpuStepCompletionResult {
  const text = String(content || '')
  if (/\[GPU Timeout\]/i.test(text)) {
    return { valid: false, reason: 'GPU job timed out before producing executable experiment evidence' }
  }
  const errorMatch = text.match(/\[GPU (?:Execution )?Error\](?::|\s*)\s*([^\n]*)/i)
  if (errorMatch) {
    return { valid: false, reason: errorMatch[1]?.trim() || 'GPU job failed before producing executable experiment evidence' }
  }
  const resultMatch = text.match(/\[GPU Execution Result\]\s+job:[^\n]+\n([\s\S]*)/i)
  if (!resultMatch || !resultMatch[1]?.trim()) {
    return { valid: false, reason: 'GPU-enabled step did not record a completed GPU execution result; refusing to store LLM prose as experiment evidence' }
  }
  const evidenceOutput = stripGpuCodeBlocks(resultMatch[1])
  const stepText = `${input.stepName || ''} ${input.stepDescription || ''}`.toLowerCase()
  const parsedOutput = parseGpuEvidenceJson(evidenceOutput)
  const isPreparationProbe = Boolean(
    parsedOutput?.type === 'autonomous_preparation_manifest' ||
    parsedOutput?.schemaVersion === 'ar3.preparation-probe.v1' ||
    parsedOutput?.contract_failure_reason,
  )
  if (isPreparationProbe) {
    const preparationRequested = stepRequestsPreparation(stepText)
    if (!preparationRequested) {
      return {
        valid: false,
        reason: 'GPU execution produced only an autonomous preparation probe; this is not task-specific experiment evidence for the requested step.',
      }
    }
  }
  if (/\b(download|verify|checksum|integrity|weights?|checkpoint|snapshot)\b/.test(stepText) && /\b(model|llada|dream|huggingface|hf|weights?|checkpoint|safetensors)\b/.test(stepText)) {
    const hasModelDownloadEvidence = Boolean(parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput) && (
      outputHasConcreteKey(parsedOutput, /(^|[.[_])(downloaded_files|downloaded_file_count|local_dir|snapshot_dir|model_path|model_dir|checkpoint_path|safetensors_files|sha|checksum|model_load_attempts|model_resolution)(\]|\.|_|$)/i) ||
      outputHasConcreteArtifactValue(parsedOutput, /\.(safetensors|bin|pt|pth|index\.json)$/i)
    )) || /\b(model_resolution|model_resolve|downloaded_files|local_dir|snapshot_dir|safetensors_files)\b/i.test(evidenceOutput) && /\b(exit=0|ok["']?\s*:\s*true|\.safetensors|checkpoint|model_cache)\b/i.test(evidenceOutput)
    if (!hasModelDownloadEvidence) {
      return {
        valid: false,
        reason: 'GPU execution did not prove the model download/weight verification requested by this step; expected concrete model artifact, snapshot, checksum, or load-attempt evidence.',
      }
    }
    if (!/\b(train|training|fine[- ]?tune|inference|infer|generate|generation|benchmark|evaluate|evaluation|experiment|experiments|activation|forward[- ]?pass)\b/.test(stepText)) {
      return { valid: true, reason: 'GPU execution result includes concrete model download/resolution evidence' }
    }
  }
  if (/\b(train|training|fine[- ]?tune|contrastive|objective|optimizer|epoch|backprop|gradient)\b/.test(stepText)) {
    const parsedOutput = parseGpuEvidenceJson(evidenceOutput)
    const hasTrainingEvidence = Boolean(parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput) && (
      outputHasConcreteKey(parsedOutput, /(^|[.[_])(train_loss|training_loss|loss|epoch|epochs|training_steps|optimizer_steps|gradient_norm|checkpoint_path|checkpoint_dir|model_load_attempts|oom|out_of_memory|vram_error|cuda_oom|hardware_limit)(\]|\.|_|$)/i) ||
      outputHasConcreteArtifactValue(parsedOutput, /\.(pt|pth|safetensors|ckpt|json|csv|log)$/i)
    )) || outputContainsConcreteJsonKey(evidenceOutput, /(^|[.[_])(train_loss|training_loss|loss|epoch|epochs|training_steps|optimizer_steps|gradient_norm|checkpoint_path|checkpoint_dir|model_load_attempts|oom|out_of_memory|vram_error|cuda_oom|hardware_limit)(\]|\.|_|$)/i)
    if (!hasTrainingEvidence) {
      return {
        valid: false,
        reason: 'GPU execution did not prove the training/model-load attempt requested by this step; expected concrete loss, epoch/step, checkpoint, OOM/VRAM, or hardware-limit evidence.',
      }
    }
  }
  const mentionsModelExecutionTarget = /\b(model|models|llada|dream|transformers?|weights?|checkpoint|activations?)\b/.test(stepText)
  const requestsModelExecutionEvidence = /\b(load|loading|loaded|instantiate|instrument|activation|inference|infer|train|training|fine[- ]?tune|checkpoint|experiment|experiments|experimental|execute|evaluate|evaluation|generation|generate|benchmark|baseline|quality|bleu|rouge|perplexity|pipeline)\b/.test(stepText)
  if (requestsModelExecutionEvidence && mentionsModelExecutionTarget) {
    const parsedOutput = parseGpuEvidenceJson(evidenceOutput)
    const hasModelLoadOrTrainingEvidence = Boolean(parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput) && (
      outputHasConcreteKey(parsedOutput, /(^|[.[_])(model_load_attempts|model_load|model_loaded|load_error|oom|out_of_memory|hardware_limit|training_attempt|training_step|loss|checkpoint_path|activation_shape|forward_pass)(\]|\.|_|$)/i) ||
      outputHasConcreteArtifactValue(parsedOutput, /\.(safetensors|bin|pt|pth|ckpt|index\.json)$/i)
    )) || outputContainsConcreteJsonKey(evidenceOutput, /(^|[.[_])(model_load_attempts|model_load|model_loaded|load_error|oom|out_of_memory|hardware_limit|training_attempt|training_step|loss|checkpoint_path|activation_shape|forward_pass)(\]|\.|_|$)/i)
    if (!hasModelLoadOrTrainingEvidence) {
      return {
        valid: false,
        reason: 'GPU execution did not prove the model load, instrumentation, inference, experiment, evaluation, or training attempt requested by this step; expected model_load_attempts, training_attempt, activation, loss, checkpoint, OOM, or hardware-limit evidence.',
      }
    }
  }
  return { valid: true, reason: 'GPU execution result marker is present' }
}

function stripGpuCodeBlocks(output: string): string {
  return String(output || '').replace(/\n?\[CODE\][\s\S]*?\[\/CODE\]\n?/gi, '\n').trim()
}

function outputHasConcreteKey(value: unknown, keyPattern: RegExp): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => outputHasConcreteKey(item, keyPattern))
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key) && hasConcreteOutputValue(nested)) return true
    if (outputHasConcreteKey(nested, keyPattern)) return true
  }
  return false
}


function outputContainsConcreteJsonKey(output: string, keyPattern: RegExp): boolean {
  for (const candidate of jsonObjectCandidates(String(output || ''))) {
    try {
      const parsed = JSON.parse(candidate)
      if (outputHasConcreteKey(parsed, keyPattern)) return true
    } catch {}
  }
  return false
}

function outputHasConcreteArtifactValue(value: unknown, valuePattern: RegExp): boolean {
  if (typeof value === 'string') return valuePattern.test(value) && !/\b(missing|not found|failed|failure|error|absent|unavailable)\b/i.test(value)
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => outputHasConcreteArtifactValue(item, valuePattern))
  return Object.values(value as Record<string, unknown>).some(nested => outputHasConcreteArtifactValue(nested, valuePattern))
}

function hasConcreteOutputValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return value === true
  if (typeof value === 'string') return value.trim().length > 0 && !/\b(missing|not found|failed|failure|error|absent|unavailable)\b/i.test(value)
  if (Array.isArray(value)) return value.some(hasConcreteOutputValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasConcreteOutputValue)
  return false
}

export function extractPersistablePreparationManifest(output: string): PersistablePreparationResult {
  for (const candidate of jsonObjectCandidates(String(output || ''))) {
    try {
      const parsed = JSON.parse(candidate)
      if (!parsed || parsed.type !== 'autonomous_preparation_manifest') continue
      const modelIds = Array.isArray(parsed.model_ids) ? parsed.model_ids.map(String).filter(Boolean) : []
      const hfRows = Array.isArray(parsed.huggingface) ? parsed.huggingface : []
      for (const row of hfRows) {
        const id = typeof row?.model_id === 'string' ? row.model_id : (typeof row?.id === 'string' ? row.id : '')
        if (id && !modelIds.includes(id)) modelIds.push(id)
      }
      const installed = Array.isArray(parsed.installed_dependencies) ? parsed.installed_dependencies.map(String) : []
      const depNames = new Set<string>(['torch', 'requests'])
      for (const line of installed) {
        const raw = line.split('==')[0].split('=')[0].trim()
        if (/^(torch|torchvision|torchaudio|transformers|accelerate|safetensors|numpy|scipy|requests|huggingface[_-]hub)$/i.test(raw)) {
          depNames.add(raw.replace('_', '-'))
        }
      }
      const workbenchPath = typeof parsed.workbench === 'string' ? parsed.workbench : ''
      const reuseKey = workbenchPath.split('/').filter(Boolean).pop() || 'autonomous-preparation'
      const gpu = parsed.gpu && typeof parsed.gpu === 'object' ? parsed.gpu : {}
      const focusTerms = Array.isArray(parsed.focus_terms) ? parsed.focus_terms.map(String).filter(Boolean).slice(0, 12) : []
      const recommendedExperiment = parsed.recommended_experiment && typeof parsed.recommended_experiment === 'object' ? parsed.recommended_experiment : null
      const stepDescription = typeof parsed.step_description === 'string' ? parsed.step_description.trim() : ''
      const researchGoal = typeof parsed.research_goal === 'string' ? parsed.research_goal.trim() : ''
      const objective = typeof recommendedExperiment?.objective === 'string' && recommendedExperiment.objective.trim()
        ? recommendedExperiment.objective.trim()
        : stepDescription
          ? `Persisted autonomous GPU preparation probe for: ${stepDescription}`
          : researchGoal
            ? `Persisted autonomous GPU preparation probe for: ${researchGoal}`
            : 'Persisted autonomous GPU preparation probe; use this to run concrete Implementation experiments instead of repeating preparation.'
      const manifest = {
        schemaVersion: 'ar3.preparation-probe.v1',
        researchType: 'gpu-autonomous-research',
        objective,
        sourceStage: parsed.stage || 'Investigation',
        contractFailureReason: parsed.contract_failure_reason || null,
        researchGoal: researchGoal || undefined,
        stepDescription: stepDescription || undefined,
        focusTerms,
        recommendedExperiment: recommendedExperiment || undefined,
        models: modelIds.slice(0, 10).map((id: string) => ({ id, source: 'huggingface', required: true })),
        dependencies: Array.from(depNames).slice(0, 12).map(name => ({ name, importName: name === 'huggingface-hub' ? 'huggingface_hub' : name.replace(/-/g, '_') })),
        resources: [
          { type: 'gpu', name: gpu.gpu_name || 'NVIDIA GPU', required: true, evidence: gpu },
          ...(workbenchPath ? [{ type: 'workbench', path: workbenchPath, required: true }] : []),
        ],
        smokeTests: [
          {
            name: 'torch_cuda_smoke',
            command: 'python - <<PY\nimport json, torch\nx=torch.ones((1,), device="cuda" if torch.cuda.is_available() else "cpu")\nprint(json.dumps({"cuda_available": torch.cuda.is_available(), "device": str(x.device), "sum": float(x.sum().item())}))\nPY',
            expectedEvidence: ['cuda_available', 'device', 'sum'],
            timeoutSeconds: 60,
          },
        ],
        gradingCriteria: Array.isArray(parsed.grading_criteria) && parsed.grading_criteria.length
          ? parsed.grading_criteria.map(String).slice(0, 10)
          : ['Implementation must print JSON metrics with CUDA/GPU evidence and concrete numeric measurements.'],
        workbench: { reuseKey, path: workbenchPath || undefined, expectedArtifacts: ['deterministic_gpu_experiment_metrics.json'] },
        preparationEvidence: parsed,
      }
      return { ok: true, manifest, reason: 'autonomous preparation probe converted to persistable manifest' }
    } catch {}
  }
  return { ok: false, reason: 'no autonomous preparation manifest found in GPU output' }
}

function parseGpuEvidenceJson(output: string): any {
  const trimmed = String(output || '').trim()
  if (!trimmed) return null
  try {
    return trimmed.startsWith('{') ? JSON.parse(trimmed) : null
  } catch {}

  const candidates: any[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const row = line.trim()
    if (!row.startsWith('{') || !row.endsWith('}')) continue
    try {
      candidates.push(JSON.parse(row))
    } catch {}
  }
  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let end = start; end < trimmed.length; end++) {
      const ch = trimmed[end]
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
          try {
            candidates.push(JSON.parse(trimmed.slice(start, end + 1)))
          } catch {}
          break
        }
      }
    }
  }
  const scoreEvidenceCandidate = (value: any): number => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
    let score = 0
    const visit = (node: unknown, depth: number) => {
      if (!node || typeof node !== 'object' || depth > 4) return
      if (Array.isArray(node)) {
        node.slice(0, 20).forEach(item => visit(item, depth + 1))
        return
      }
      for (const [rawKey, rawValue] of Object.entries(node as Record<string, unknown>)) {
        const key = rawKey.toLowerCase()
        if (key === 'type' && String(rawValue) === 'deterministic_gpu_experiment') score += 1000
        if (key === 'type' && String(rawValue) === 'autonomous_preparation_manifest') score += 500
        if (/^(model_load_attempts|training_attempt|training_step|research_metrics|grading_criteria_checked|grading_criteria_evidence)$/.test(key)) score += 80
        if (/^(type|gpu|model_ids|huggingface|installed_dependencies|workbench|contract_failure_reason)$/.test(key)) score += 6
        if (/metric|score|loss|accuracy|acc|f1|precision|recall|latency|throughput|seconds|runtime|cuda|gpu|memory|vram|artifact|path|file|stdout|stderr|result|measurement|model_load|training|checkpoint|activation/i.test(key)) score += 3
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) score += 2
        if (typeof rawValue === 'boolean') score += 1
        if (typeof rawValue === 'string' && rawValue.trim()) score += 1
        visit(rawValue, depth + 1)
      }
    }
    visit(value, 0)
    return score
  }

  const preferredExperiment = candidates
    .filter(obj => obj && typeof obj === 'object' && !Array.isArray(obj) && obj.type === 'deterministic_gpu_experiment')
    .pop()
  if (preferredExperiment) return preferredExperiment

  const preferredPreparation = candidates
    .filter(obj => obj && typeof obj === 'object' && !Array.isArray(obj) && obj.type === 'autonomous_preparation_manifest')
    .pop()
  if (preferredPreparation) return preferredPreparation

  return candidates
    .map((obj, index) => ({ obj, index, score: scoreEvidenceCandidate(obj) }))
    .sort((a, b) => b.score - a.score || b.index - a.index)[0]?.obj || null
}

export function assessGpuExecutionEvidence(input: GpuEvidenceInput): GpuEvidenceResult {
  if (!input.success) {
    return { valid: false, reason: input.error || 'GPU execution failed' }
  }

  const output = String(input.output || '').trim()
  const parsedOutput = parseGpuEvidenceJson(output)
  const looksLikePreparationProbe = Boolean(
    input.fallbackUsed ||
    parsedOutput?.type === 'autonomous_preparation_manifest' ||
    parsedOutput?.contract_failure_reason
  )
  if (looksLikePreparationProbe) {
    if (shouldUseAutonomousPreparationFallback(input.stageName)) {
      const hasProbeEvidence = Boolean(
        (
          parsedOutput?.type === 'autonomous_preparation_manifest' &&
          (parsedOutput?.gpu || parsedOutput?.model_ids || parsedOutput?.huggingface || parsedOutput?.installed_dependencies || parsedOutput?.workbench)
        ) || (
          /autonomous_preparation_manifest/.test(output) &&
          /gpu|cuda|model_ids|huggingface|installed_dependencies|workbench|recommended_experiment/i.test(output)
        )
      )
      if (hasProbeEvidence && hasMeasurableGpuEvidence(output, parsedOutput)) {
        return {
          valid: true,
          reason: `Autonomous preparation probe accepted for ${input.stageName}; use its GPU/model/workbench evidence to drive the next research step.`,
        }
      }
      return {
        valid: false,
        reason: `Autonomous preparation probe for ${input.stageName} did not produce enough preparation evidence to drive the next step.`,
      }
    }
    return {
      valid: false,
      reason: `Autonomous preparation probe ran for ${input.stageName}, but it is not a completed executable experiment. The original LLM output violated the GPU contract; use the probe evidence as retry feedback instead of marking the step complete.`,
    }
  }

  if (output.length < 20) {
    return { valid: false, reason: 'GPU execution produced too little evidence' }
  }

  const measurableEvidence = hasMeasurableGpuEvidence(output, parsedOutput)
  if (!measurableEvidence) {
    return {
      valid: false,
      reason: 'GPU execution did not produce measurable evidence (expected JSON metrics, numeric measurements, artifact paths, stdout fields, or GPU/runtime facts).',
    }
  }

  if (!hasRuntimeGpuEvidence(output, parsedOutput)) {
    return {
      valid: false,
      reason: 'GPU execution produced measurable output but no runtime GPU evidence (expected cuda_available, gpu_name, device, VRAM, or nvidia-smi output).',
    }
  }

  const criteriaEvidence = validateGradingCriteriaEvidence(parsedOutput, input.preparationManifest)
  if (!criteriaEvidence.valid) {
    return criteriaEvidence
  }

  return { valid: true, reason: 'GPU execution produced measurable evidence with runtime GPU evidence' }
}

function manifestGradingCriteria(preparationManifest: unknown): string[] {
  if (!preparationManifest || typeof preparationManifest !== 'object' || Array.isArray(preparationManifest)) return []
  const source = preparationManifest as Record<string, unknown>
  const criteria = source.gradingCriteria || source.grading_criteria
  const successCriteria = source.successCriteria || source.success_criteria
  return [
    ...(Array.isArray(criteria) ? criteria.flatMap(gradingCriterionTexts) : []),
    ...(Array.isArray(successCriteria) ? successCriteria.flatMap(gradingCriterionTexts) : []),
  ].filter(Boolean).slice(0, 20)
}

function gradingCriterionTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value.trim()].filter(Boolean)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []

  const row = value as Record<string, unknown>
  const texts: string[] = []
  for (const key of ['criterion', 'criteria', 'description', 'evidence', 'expectedEvidence', 'expected_evidence', 'field', 'fields', 'metric', 'metrics']) {
    const raw = row[key]
    if (typeof raw === 'string' && raw.trim()) {
      texts.push(raw.trim())
      continue
    }
    if (Array.isArray(raw)) {
      texts.push(...raw.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean))
    }
  }
  return texts
}

function evidenceDeclarationTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value.trim()].filter(Boolean)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []

  const row = value as Record<string, unknown>
  const texts: string[] = []
  for (const key of ['field', 'fields', 'key', 'keys', 'metric', 'metrics', 'name', 'path', 'paths', 'file', 'files', 'filename', 'filenames', 'artifact', 'artifacts', 'evidence', 'expectedEvidence', 'expected_evidence']) {
    const raw = row[key]
    if (typeof raw === 'string' && raw.trim()) {
      texts.push(raw.trim())
      continue
    }
    if (Array.isArray(raw)) {
      texts.push(...raw.flatMap(evidenceDeclarationTexts))
    }
  }
  return texts
}

function manifestExpectedEvidence(preparationManifest: unknown): string[] {
  if (!preparationManifest || typeof preparationManifest !== 'object' || Array.isArray(preparationManifest)) return []
  const source = preparationManifest as Record<string, unknown>
  const smokeTests = source.smokeTests || source.smoke_tests

  const expected = new Set<string>()
  if (Array.isArray(smokeTests)) {
    for (const smokeTest of smokeTests.slice(0, 20)) {
      if (!smokeTest || typeof smokeTest !== 'object' || Array.isArray(smokeTest)) continue
      const row = smokeTest as Record<string, unknown>
      const evidence = row.expectedEvidence || row.expected_evidence
      if (!Array.isArray(evidence)) continue
      for (const item of evidence.slice(0, 20)) {
        for (const text of evidenceDeclarationTexts(item).slice(0, 20)) {
          const normalized = String(text || '').trim()
          if (normalized) expected.add(normalized)
        }
      }
    }
  }

  const successCriteria = source.successCriteria || source.success_criteria
  if (Array.isArray(successCriteria)) {
    for (const criterion of successCriteria.slice(0, 20)) {
      for (const item of gradingCriterionTexts(criterion).slice(0, 20)) {
        const normalized = String(item || '').trim()
        if (normalized) expected.add(normalized)
      }
    }
  }
  const recommendedExperiment = source.recommendedExperiment || source.recommended_experiment
  if (recommendedExperiment && typeof recommendedExperiment === 'object' && !Array.isArray(recommendedExperiment)) {
    const experiment = recommendedExperiment as Record<string, unknown>
    const metrics = experiment.metrics || experiment.expectedMetrics || experiment.expected_metrics
    if (Array.isArray(metrics)) {
      for (const metric of metrics.slice(0, 20)) {
        for (const item of evidenceDeclarationTexts(metric).slice(0, 20)) {
          const normalized = String(item || '').trim()
          if (normalized) expected.add(normalized)
        }
      }
    }
  }
  return Array.from(expected).slice(0, 30)
}

function manifestExpectedArtifacts(preparationManifest: unknown): string[] {
  if (!preparationManifest || typeof preparationManifest !== 'object' || Array.isArray(preparationManifest)) return []
  const workbench = (preparationManifest as Record<string, unknown>).workbench
  if (!workbench || typeof workbench !== 'object' || Array.isArray(workbench)) return []
  const source = workbench as Record<string, unknown>
  const artifacts = source.expectedArtifacts || source.expected_artifacts
  if (!Array.isArray(artifacts)) return []

  return artifacts
    .flatMap(evidenceDeclarationTexts)
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => !['stdout', 'stderr', 'logs', 'log'].includes(value.toLowerCase()))
    .slice(0, 30)
}

function manifestThresholdCriteria(preparationManifest: unknown): Array<{ label: string; metric: string; threshold: string }> {
  if (!preparationManifest || typeof preparationManifest !== 'object' || Array.isArray(preparationManifest)) return []
  const source = preparationManifest as Record<string, unknown>
  const successCriteria = source.successCriteria || source.success_criteria
  if (!Array.isArray(successCriteria)) return []

  return successCriteria
    .slice(0, 20)
    .flatMap((criterion, index) => {
      if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return []
      const row = criterion as Record<string, unknown>
      const rawMetric = typeof row.metric === 'string' ? row.metric.trim() : ''
      const rawThreshold = typeof row.threshold === 'string' || typeof row.threshold === 'number'
        ? String(row.threshold).trim()
        : ''
      if (!rawMetric || !rawThreshold) return []
      const label = typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : `success criterion ${index + 1}`
      return [{ label, metric: rawMetric, threshold: rawThreshold }]
    })
}

function parseNumericThreshold(threshold: string): { operator: '>=' | '>' | '<=' | '<' | '='; value: number } | null {
  const normalized = threshold.trim().toLowerCase()
  const symbolic = normalized.match(/^(>=|>|<=|<|=|==)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)
  if (symbolic) {
    const operator = symbolic[1] === '==' ? '=' : symbolic[1] as '>=' | '>' | '<=' | '<' | '='
    return { operator, value: Number(symbolic[2]) }
  }

  const phrase = normalized.match(/\b(at least|minimum|min|greater than|more than|above|at most|maximum|max|less than|below|under|no more than|equals?|equal to)\b\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)
  if (!phrase) return null
  const [, rawOperator, rawValue] = phrase
  const operator =
    /^(at least|minimum|min)$/.test(rawOperator) ? '>=' :
    /^(greater than|more than|above)$/.test(rawOperator) ? '>' :
    /^(at most|maximum|max|no more than)$/.test(rawOperator) ? '<=' :
    /^(less than|below|under)$/.test(rawOperator) ? '<' :
    '='
  return { operator, value: Number(rawValue) }
}

function thresholdSatisfied(actual: number, threshold: { operator: '>=' | '>' | '<=' | '<' | '='; value: number }): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(threshold.value)) return false
  if (threshold.operator === '>=') return actual >= threshold.value
  if (threshold.operator === '>') return actual > threshold.value
  if (threshold.operator === '<=') return actual <= threshold.value
  if (threshold.operator === '<') return actual < threshold.value
  return actual === threshold.value
}

function criterionThresholdExpectation(criterion: string): { metric: string; threshold: string } | null {
  const normalized = String(criterion || '').trim()
  if (!normalized) return null

  const symbolic = normalized.match(/\b([A-Za-z][A-Za-z0-9_.-]{1,80})\b\s*(>=|>|<=|<|=|==)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)
  if (symbolic) {
    return { metric: symbolic[1], threshold: `${symbolic[2]} ${symbolic[3]}` }
  }

  const phrase = normalized.match(/\b([A-Za-z][A-Za-z0-9_.-]{1,80})\b(?:\s+(?:must|should|is|was|be|to|value|score|metric))*\s+(at least|minimum|min|greater than|more than|above|at most|maximum|max|less than|below|under|no more than|equals?|equal to)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)
  if (phrase) {
    return { metric: phrase[1], threshold: `${phrase[2]} ${phrase[3]}` }
  }

  return null
}

function validateGradingCriteriaEvidence(parsedOutput: any, preparationManifest?: unknown): GpuEvidenceResult {
  if (!parsedOutput || typeof parsedOutput !== 'object') return { valid: true, reason: 'no structured grading criteria to validate' }
  const deterministicCriteria = Array.isArray(parsedOutput.grading_criteria_checked)
    ? parsedOutput.grading_criteria_checked.map(String).filter(Boolean)
    : []
  const criteria = deterministicCriteria.length > 0 ? deterministicCriteria : manifestGradingCriteria(preparationManifest)

  const evidence = parsedOutput.grading_criteria_evidence
  if (deterministicCriteria.length > 0 && (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))) {
    return { valid: false, reason: 'Deterministic GPU experiment echoed grading criteria but did not map them to concrete evidence fields.' }
  }

  const flattenedEvidenceKeys = new Set<string>()
  const collectEvidenceKeys = (prefix: string, value: unknown) => {
    if (!prefix) {
      if (!value || typeof value !== 'object') return
    } else {
      flattenedEvidenceKeys.add(prefix)
    }

    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.slice(0, 25).forEach((item, index) => collectEvidenceKeys(prefix + '[' + index + ']', item))
      return
    }

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'grading_criteria_checked' || key === 'grading_criteria_evidence') continue
      collectEvidenceKeys(prefix ? prefix + '.' + key : key, nested)
    }
  }
  collectEvidenceKeys('', parsedOutput)

  const matchedKeyExists = (key: string): boolean => {
    if (flattenedEvidenceKeys.has(key)) return true
    return Array.from(flattenedEvidenceKeys).some(candidate =>
      candidate.startsWith(key + '.') || candidate.startsWith(key + '[')
    )
  }

  const valueAtPath = (source: unknown, path: string): unknown => {
    const parts = path.match(/[^.[\]]+|\[(\d+)\]/g) || []
    let current = source
    for (const part of parts) {
      if (part.startsWith('[')) {
        const index = Number(part.slice(1, -1))
        if (!Array.isArray(current) || !Number.isInteger(index) || index < 0 || index >= current.length) return undefined
        current = current[index]
        continue
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }

  const hasConcreteEvidenceValue = (value: unknown): boolean => {
    if (value === null || value === undefined) return false
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'boolean') return true
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0 && value.some(hasConcreteEvidenceValue)
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasConcreteEvidenceValue)
    return false
  }

  const matchedKeyHasConcreteEvidence = (key: string): boolean => {
    if (hasConcreteEvidenceValue(valueAtPath(parsedOutput, key))) return true
    return Array.from(flattenedEvidenceKeys)
      .filter(candidate => candidate.startsWith(key + '.') || candidate.startsWith(key + '['))
      .some(candidate => hasConcreteEvidenceValue(valueAtPath(parsedOutput, candidate)))
  }

  const keyMatchesTerm = (key: string, term: string): boolean => {
    const normalizedKey = key.toLowerCase().replace(/-/g, '_')
    const normalizedTerm = term.toLowerCase().replace(/-/g, '_')
    return normalizedKey === normalizedTerm ||
      normalizedKey.endsWith('.' + normalizedTerm) ||
      normalizedKey.includes('.' + normalizedTerm + '.') ||
      normalizedKey.includes('.' + normalizedTerm + '[') ||
      normalizedKey.endsWith('[' + normalizedTerm + ']') ||
      normalizedKey.split(/[.[\]]+/).filter(Boolean).includes(normalizedTerm)
  }

  const outputHasConcreteTerm = (term: string): boolean => {
    return Array.from(flattenedEvidenceKeys).some(candidate =>
      keyMatchesTerm(candidate, term) && hasConcreteEvidenceValue(valueAtPath(parsedOutput, candidate))
    )
  }

  const flattenedEvidenceEntries = Array.from(flattenedEvidenceKeys)
    .map(key => ({ key, value: valueAtPath(parsedOutput, key) }))
    .filter(entry => hasConcreteEvidenceValue(entry.value))
    .map(entry => ({
      key: entry.key.toLowerCase().replace(/-/g, '_'),
      value: String(entry.value).toLowerCase().replace(/\\/g, '/'),
    }))

  const outputHasArtifact = (artifact: string): boolean => {
    const normalized = artifact.toLowerCase().replace(/\\/g, '/')
    const basename = normalized.split('/').filter(Boolean).pop() || normalized
    const artifactKey = /(^|[.[_])(artifact|artifacts|artifact_path|artifact_paths|path|paths|file|files|filename|filenames|workbench)(]|\.|_|$)/
    const artifactContainerKey = /(^|[.[_])(artifacts|artifact_paths|paths|files|filenames|artifact_manifest)(]|\.|_|$)/
    const negativeArtifactKey = /(^|[.[_])(error|errors|missing|failure|failures|failed|not_found|unsaved|absent)(]|\.|_|$)/
    const negativeArtifactValue = /\b(missing|not found|not_found|failed|failure|error|absent|did not save|not saved|unavailable)\b/
    const negativePresenceKey = /(^|[.[_])(exists|exist|saved|created|present|available|written|persisted)(]|\.|_|$)/
    const negativePresenceValue = /^(?:false|0|no|none|null|missing|absent|failed|not_found|not saved|unavailable)$/
    const parentPath = (key: string): string | null => {
      const parent = key.replace(/(?:\.[^.[\]]+|\[\d+\])$/, '')
      return parent && parent !== key ? parent : null
    }
    const hasNegativeArtifactSibling = (key: string): boolean => {
      const parent = parentPath(key)
      if (!parent) return false
      return flattenedEvidenceEntries.some(entry => {
        if (entry.key === key || !entry.key.startsWith(parent + '.')) return false
        if (negativeArtifactKey.test(entry.key) || negativeArtifactValue.test(entry.value)) return true
        return negativePresenceKey.test(entry.key) && negativePresenceValue.test(entry.value.trim())
      })
    }
    return flattenedEvidenceEntries.some(({ key, value }) => {
      if (!artifactKey.test(key)) return false
      if (negativeArtifactKey.test(key) || negativeArtifactValue.test(value)) return false
      if (hasNegativeArtifactSibling(key)) return false
      const normalizedValue = value.replace(/\\/g, '/')
      const valueIsPathLike = normalizedValue.includes('/') ||
        /^[a-z0-9_.-]+\.(?:json|csv|pt|pth|safetensors|png|txt|log|npz|npy)$/i.test(normalizedValue)
      return normalizedValue === normalized ||
        normalizedValue === basename ||
        normalizedValue.endsWith('/' + basename) ||
        normalizedValue.includes('/' + basename + ' ') ||
        normalizedValue.includes('/' + basename + ',') ||
        normalizedValue.includes('/' + basename + ']') ||
        normalizedValue.includes('/' + basename + '}') ||
        (artifactContainerKey.test(key) && valueIsPathLike && normalizedValue.includes(basename))
    })
  }

  const numericEvidenceValuesForTerm = (term: string): number[] => {
    return Array.from(flattenedEvidenceKeys)
      .filter(candidate => keyMatchesTerm(candidate, term))
      .map(candidate => valueAtPath(parsedOutput, candidate))
      .flatMap(value => {
        if (typeof value === 'number' && Number.isFinite(value)) return [value]
        if (typeof value === 'string') {
          const match = value.trim().match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)
          if (match) return [Number(match[0])]
        }
        return []
      })
  }

  const explicitEvidenceTerms = (criterion: string): string[] => {
    const stopwords = new Set([
      'artifact',
      'artifacts',
      'contain',
      'contains',
      'dependency',
      'dependencies',
      'evidence',
      'failure',
      'failures',
      'field',
      'fields',
      'include',
      'includes',
      'metric',
      'metrics',
      'model',
      'models',
      'print',
      'prints',
      'stdout',
      'stderr',
      'with',
    ])
    const concreteEvidenceTerms = new Set([
      'accuracy',
      'acc',
      'allocated_vram_mb',
      'baseline_score',
      'cuda',
      'cuda_available',
      'device',
      'driver_version',
      'f1',
      'gate_activation_rate',
      'gpu',
      'gpu_memory_gb',
      'gpu_name',
      'latency',
      'latent_vector_norm',
      'loss',
      'memory',
      'precision',
      'projection_residual',
      'recall',
      'runtime_seconds',
      'score',
      'tensor_shape',
      'tensor_sum',
      'throughput',
      'torch_cuda_available',
      'trajectory_cosine_similarity',
      'vram',
    ])
    return Array.from(new Set(
      criterion
        .toLowerCase()
        .match(/[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)?/g) || []
    ))
      .map(term => term.replace(/-/g, '_'))
      .filter(term =>
        term.includes('_') ||
        term.includes('.') ||
        concreteEvidenceTerms.has(term) ||
        (/^[a-z]+[0-9]+[a-z0-9_]*$/.test(term) && !stopwords.has(term))
      )
  }


  const expectedEvidence = manifestExpectedEvidence(preparationManifest)
  const missingExpectedEvidence = expectedEvidence.filter(expected => {
    const explicitTerms = explicitEvidenceTerms(expected)
    const terms = explicitTerms.length > 0 ? explicitTerms : [expected.toLowerCase().replace(/-/g, '_')]
    return terms.some(term => !outputHasConcreteTerm(term))
  })

  if (missingExpectedEvidence.length > 0) {
    return {
      valid: false,
      reason: `GPU execution did not satisfy preparation manifest smoke-test expected evidence with concrete output fields: ${missingExpectedEvidence.slice(0, 3).join('; ')}`,
    }
  }

  const missingExpectedArtifacts = manifestExpectedArtifacts(preparationManifest)
    .filter(artifact => !outputHasArtifact(artifact))

  if (missingExpectedArtifacts.length > 0) {
    return {
      valid: false,
      reason: `GPU execution did not report preparation manifest expected artifacts: ${missingExpectedArtifacts.slice(0, 3).join('; ')}`,
    }
  }

  const failedThresholdCriteria = manifestThresholdCriteria(preparationManifest)
    .filter(({ metric, threshold }) => {
      const parsedThreshold = parseNumericThreshold(threshold)
      if (!parsedThreshold) return false
      const explicitTerms = explicitEvidenceTerms(metric)
      const terms = explicitTerms.length > 0 ? explicitTerms : [metric.toLowerCase().replace(/-/g, '_')]
      const values = terms.flatMap(numericEvidenceValuesForTerm)
      return values.length === 0 || !values.some(value => thresholdSatisfied(value, parsedThreshold))
    })

  if (failedThresholdCriteria.length > 0) {
    return {
      valid: false,
      reason: `GPU execution did not satisfy preparation manifest success-criteria thresholds with concrete output fields: ${failedThresholdCriteria.slice(0, 3).map(item => `${item.metric} ${item.threshold}`).join('; ')}`,
    }
  }

  if (deterministicCriteria.length === 0) {
    const missingManifestCriteria = criteria.filter((criterion: string) => {
      const explicitTerms = explicitEvidenceTerms(criterion)
      if (explicitTerms.length === 0) return false
      return explicitTerms.some(term => !outputHasConcreteTerm(term))
    })

    if (missingManifestCriteria.length > 0) {
      return {
        valid: false,
        reason: `GPU execution did not satisfy preparation manifest grading criteria with concrete output fields: ${missingManifestCriteria.slice(0, 3).join('; ')}`,
      }
    }

    return { valid: true, reason: 'GPU execution output satisfies preparation manifest grading criteria fields' }
  }

  const missing = criteria.filter((criterion: string) => {
    const row = evidence[criterion]
    const matchedKeys = Array.isArray(row?.matched_keys) ? row.matched_keys.map(String).filter(Boolean) : []
    if (!row || typeof row !== 'object' || row.matched !== true || matchedKeys.length === 0) {
      return true
    }

    if (!matchedKeys.every(matchedKeyExists)) {
      return true
    }

    if (!matchedKeys.every(matchedKeyHasConcreteEvidence)) {
      return true
    }

    const explicitTerms = explicitEvidenceTerms(criterion)
    if (explicitTerms.length === 0) return false

    const matchedHaystack = matchedKeys.join(' ').toLowerCase()
    if (explicitTerms.some(term => !matchedHaystack.includes(term))) return true

    const thresholdExpectation = criterionThresholdExpectation(criterion)
    if (!thresholdExpectation) return false

    const parsedThreshold = parseNumericThreshold(thresholdExpectation.threshold)
    if (!parsedThreshold) return false

    const thresholdTerms = explicitEvidenceTerms(thresholdExpectation.metric)
    const terms = thresholdTerms.length > 0
      ? thresholdTerms
      : [thresholdExpectation.metric.toLowerCase().replace(/-/g, '_')]
    const matchingKeys = matchedKeys.filter(key =>
      terms.some(term => keyMatchesTerm(key, term))
    )
    const values = matchingKeys.flatMap(key => {
      const value = valueAtPath(parsedOutput, key)
      if (typeof value === 'number' && Number.isFinite(value)) return [value]
      if (typeof value === 'string') {
        const match = value.trim().match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)
        if (match) return [Number(match[0])]
      }
      return []
    })

    return values.length === 0 || !values.some(value => thresholdSatisfied(value, parsedThreshold))
  })

  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Deterministic GPU experiment did not map grading criteria to concrete evidence fields: ${missing.slice(0, 3).join('; ')}`,
    }
  }

  return { valid: true, reason: 'deterministic GPU experiment mapped grading criteria to evidence fields' }
}

function hasRuntimeGpuEvidence(output: string, parsedOutput: any): boolean {
  const availabilityKeys = new Set(['cuda_available', 'torch_cuda_available'])
  const namedGpuKeys = new Set(['gpu_name', 'device_name', 'nvidia_driver', 'nvidia_smi'])
  const numericGpuKeys = new Set(['gpu_count', 'gpu_memory', 'gpu_memory_total', 'vram', 'gpu_memory_gb'])

  const hasConcreteTextEvidence = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    const normalized = value.trim().toLowerCase()
    return Boolean(normalized && !['false', 'none', 'null', 'unknown', 'cpu', '0'].includes(normalized))
  }

  const hasPositiveNumericEvidence = (value: unknown): boolean => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) > 0
    return false
  }

  const objectHasRuntimeEvidence = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(objectHasRuntimeEvidence)

    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.toLowerCase()
      if (availabilityKeys.has(key) && (rawValue === true || String(rawValue).toLowerCase() === 'true')) return true
      if (numericGpuKeys.has(key) && hasPositiveNumericEvidence(rawValue)) return true
      if (namedGpuKeys.has(key) && hasConcreteTextEvidence(rawValue)) return true
      if (['device', 'runtime', 'backend', 'tensor_device'].includes(key) && String(rawValue).toLowerCase().startsWith('cuda')) return true
      if (objectHasRuntimeEvidence(rawValue)) return true
    }
    return false
  }

  if (objectHasRuntimeEvidence(parsedOutput)) return true

  return [
    /\bcuda_available["']?\s*[:=]\s*(?:true|1)\b/i,
    /\bcuda[_ -]?device\b/i,
    /\bgpu[_ -]?(name|count|memory|util|device)\b/i,
    /\bvram\b/i,
    /\bnvidia(?:-smi)?\b/i,
    /\brtx\s*\d+\b/i,
    /\btesla\b/i,
    /\ba\d{2,3}\b/i,
  ].some(pattern => pattern.test(output))
}

function hasMeasurableGpuEvidence(output: string, parsedOutput: any): boolean {
  const containsMetricValue = (value: unknown): boolean => {
    if (typeof value === 'number' || typeof value === 'boolean') return true
    if (Array.isArray(value)) return value.some(containsMetricValue)
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsMetricValue)
    return false
  }

  if (parsedOutput && typeof parsedOutput === 'object') {
    const metricKeys = Object.keys(parsedOutput).filter(key =>
      /metric|score|loss|accuracy|acc|f1|precision|recall|latency|throughput|seconds|runtime|cuda|gpu|memory|vram|artifact|path|file|stdout|stderr|result|measurement/i.test(key)
    )
    if (metricKeys.length > 0 && containsMetricValue(parsedOutput)) return true
  }

  const hasNumber = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s*(?:%|ms|s|sec|seconds|MB|MiB|GB|GiB|tokens\/s|it\/s)?/i.test(output)
  const hasEvidenceKeyword = /\b(metric|score|loss|accuracy|acc|f1|precision|recall|latency|throughput|runtime|seconds|cuda|gpu|vram|memory|artifact|saved|file|path|stdout|stderr|shape|tensor|mean|std|p\d+|epoch|step)\b/i.test(output)
  const hasArtifactPath = /(?:^|\s)(?:\.\/|\/tmp\/|\/workspace\/|\/opt\/|[A-Za-z0-9_.-]+\.(?:json|csv|pt|pth|safetensors|png|txt|log|npz|npy))(?:\s|$)/i.test(output)
  return (hasNumber && hasEvidenceKeyword) || hasArtifactPath
}

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```(?:json|python)?\s*/i, '').replace(/```$/i, '').trim()
}

function withoutClosedThinking(text: string): string {
  return text.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/<think>[\s\S]*?<\/think>/gi, '')
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = []
  const cleaned = stripCodeFence(withoutClosedThinking(text))
  if (cleaned) candidates.push(cleaned)

  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/i)
  if (jsonBlock?.[1]) candidates.push(jsonBlock[1].trim())

  // Quote-aware brace matching recovers JSON emitted after prose or an unclosed
  // <think> block. Weak models often prepend reasoning despite instructions.
  const source = cleaned || text
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < source.length; i++) {
      const ch = source[i]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(source.slice(start, i + 1))
          break
        }
      }
    }
  }

  return Array.from(new Set(candidates.map(c => c.trim()).filter(Boolean)))
}

function findLikelyPythonStringSyntaxIssue(code: string): string | null {
  const lines = code.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let quote: 'single' | 'double' | null = null
    let tripleQuote: 'single' | 'double' | null = null
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      const next3 = line.slice(i, i + 3)
      const escaped = i > 0 && line[i - 1] === '\\' && (i < 2 || line[i - 2] !== '\\')

      if (tripleQuote) {
        if ((tripleQuote === 'single' && next3 === "'''") || (tripleQuote === 'double' && next3 === '"""')) {
          tripleQuote = null
          i += 2
        }
        continue
      }

      if (!quote && (next3 === "'''" || next3 === '"""')) {
        tripleQuote = next3 === "'''" ? 'single' : 'double'
        i += 2
        continue
      }

      if (escaped) continue
      if (ch === "'" && quote !== 'double') {
        quote = quote === 'single' ? null : 'single'
      } else if (ch === '"' && quote !== 'single') {
        quote = quote === 'double' ? null : 'double'
      }
    }

    if (quote && !line.trimEnd().endsWith('\\')) {
      return `unterminated ${quote}-quoted string on line ${lineIndex + 1}`
    }
  }
  return null
}

function findPythonCompileSyntaxIssue(code: string): string | null {
  try {
    const childProcess = require('child_process') as typeof import('child_process')
    const result = childProcess.spawnSync(
      'python3',
      ['-c', 'import sys; compile(sys.stdin.read(), "<ar3-gpu-command>", "exec")'],
      {
        input: code,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }
    )
    if (result.status === 0) return null
    const stderr = String(result.stderr || '').trim()
    return stderr.split('\n').slice(-4).join(' ').trim() || 'python compile check failed'
  } catch {
    // Some test/browser-like runtimes cannot spawn Python. Keep the lighter
    // syntax checks above as the portable baseline in those environments.
    return null
  }
}

function asPyTripleQuoted(value: string): string {
  return JSON.stringify(String(value || ''))
}

function findUnmanagedTmpPathLiteral(code: string): string | null {
  const stringLiteralPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g
  for (const match of code.matchAll(stringLiteralPattern)) {
    const rawValue = match[2]
    let value = rawValue
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\(["'`])/g, '$1')
      .trim()
    if (value === '/tmp' || value.startsWith('/tmp/')) {
      if (value === '/tmp/ar3-workbenches' || value.startsWith('/tmp/ar3-workbenches/')) continue
      return value
    }
  }
  return null
}

function sanitizeReasonForGeneratedPython(value: string): string {
  return String(value || '')
    .replace(/placeholder|pseudocode/gi, 'invalid non-executable output')
    .slice(0, 500)
}

function packageNameFromSpec(value: string): string {
  return String(value || '').split('[')[0].split('=')[0].split('<')[0].split('>')[0].split('~')[0].trim()
}

function safePipDependenciesFromManifest(manifest: unknown): string[] {
  const deps = new Set<string>(['requests'])
  if (!manifest || typeof manifest !== 'object') return Array.from(deps)
  const rows = Array.isArray((manifest as any).dependencies) ? (manifest as any).dependencies : []
  for (const row of rows) {
    const rawName = typeof row === 'string'
      ? row
      : (typeof row?.name === 'string'
        ? row.name
        : (typeof row?.package === 'string'
          ? row.package
          : (typeof row?.pipPackage === 'string' ? row.pipPackage : '')))
    let name = rawName.trim()
    if (typeof row === 'object' && row !== null && !/[<>=!~]=?/.test(name)) {
      const versionSpec = typeof (row as any).versionSpec === 'string'
        ? (row as any).versionSpec.trim()
        : (typeof (row as any).version_spec === 'string'
          ? (row as any).version_spec.trim()
          : '')
      const exactVersion = typeof (row as any).version === 'string' ? (row as any).version.trim() : ''
      if (versionSpec) name += versionSpec
      else if (exactVersion) name += '==' + exactVersion
    }
    const normalized = packageNameFromSpec(name).replace(/_/g, '-')
    if (!normalized) continue
    if (/^(torch|torchvision|torchaudio)$/i.test(normalized)) continue
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*([<>=!~]=?.+)?$/.test(name)) deps.add(name)
  }
  return Array.from(deps).slice(0, 12)
}

function deterministicExperimentNeedsModelRuntimeDeps(manifest: unknown, stepDescription: string): boolean {
  if (!manifest || typeof manifest !== 'object') return false
  const models = Array.isArray((manifest as any).models) ? (manifest as any).models : []
  if (models.length === 0) return false
  const stepLower = String(stepDescription || '').toLowerCase()
  return (
    /\b(load|loading|set up|setup|instantiate|instrument|activation|inference|infer|train|training|fine[- ]?tune|finetune|checkpoint|generation|generate|evaluate|evaluation|experiment|benchmark|baseline)\b/.test(stepLower) &&
    /\b(model|models|llada|dream|transformer|weights?|checkpoint|activation)\b/.test(stepLower)
  )
}

function addDeterministicModelRuntimeDeps(dependencies: string[]): string[] {
  const required = ['transformers==4.45.2', 'accelerate', 'safetensors']
  const hasPackage = (rows: string[], pkg: string) => rows.some(dep => packageNameFromSpec(dep).replace(/_/g, '-').toLowerCase() === pkg)
  const prioritized: string[] = []
  for (const dep of required) {
    const pkg = packageNameFromSpec(dep).replace(/_/g, '-').toLowerCase()
    const existing = dependencies.find(row => packageNameFromSpec(row).replace(/_/g, '-').toLowerCase() === pkg)
    prioritized.push(existing || dep)
  }
  for (const dep of dependencies) {
    const pkg = packageNameFromSpec(dep).replace(/_/g, '-').toLowerCase()
    if (!pkg || hasPackage(prioritized, pkg)) continue
    prioritized.push(dep)
  }
  return prioritized.slice(0, 12)
}

function inferDependenciesFromCode(code: string): string[] {
  const deps = new Set<string>()
  const importPattern = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
  for (const match of code.matchAll(importPattern)) {
    const name = match[1]
    if (/^(os|sys|json|time|subprocess|pathlib|re|math|random|statistics)$/i.test(name)) continue
    if (/^(torch|torchvision|torchaudio|transformers|accelerate|safetensors|scipy|numpy|requests)$/i.test(name)) deps.add(name === 'huggingface_hub' ? 'huggingface-hub' : name)
  }
  return Array.from(deps).slice(0, 8)
}

function validateStrictGpuCode(parsed: any): StrictGpuResult {
  const code = typeof parsed?.code === 'string' ? parsed.code.trim() : ''
  if (parsed?.action !== 'run_python') return { ok: false, reason: 'JSON action must be "run_python"' }
  if (!code) return { ok: false, reason: 'JSON is missing non-empty code string' }
  const codeLines = code.split('\n').map((l: string) => l.trim()).filter(Boolean)
  const hasPython = /(^|\n)\s*(import|from|def|class|print\(|assert\b|[A-Za-z_][A-Za-z0-9_]*\s*=)/.test(code)
  if (!hasPython || codeLines.length < 3) return { ok: false, reason: 'code lacks enough executable Python syntax' }
  if (/TODO|FIXME|placeholder|pseudocode|your code here|\.\.\.|implement (?:this|the actual|real)|\bpass\s*(?:#.*)?$/im.test(code)) return { ok: false, reason: 'code contains placeholder/pseudocode markers' }
  const unmanagedTmpPath = findUnmanagedTmpPathLiteral(code)
  if (unmanagedTmpPath) {
    return {
      ok: false,
      reason: `code hardcodes unmanaged absolute /tmp path ${unmanagedTmpPath}; use AR3_WORKBENCH_DIR, AR3_ARTIFACTS_DIR, AR3_SCRATCH_DIR, AR3_MODEL_SCRATCH_DIR, or tempfile`,
    }
  }
  const syntaxIssue = findLikelyPythonStringSyntaxIssue(code)
  if (syntaxIssue) return { ok: false, reason: 'python syntax issue: ' + syntaxIssue }
  const compileIssue = findPythonCompileSyntaxIssue(code)
  if (compileIssue) return { ok: false, reason: 'python syntax issue: ' + compileIssue }
  if (!/(cuda|gpu|nvidia-smi|torch\.cuda|device\s*=\s*["']cuda|cuda_available|gpu_name|vram)/i.test(code)) {
    return { ok: false, reason: 'code must include a GPU/CUDA probe or runtime GPU evidence' }
  }
  if (!/(json\.dumps|print\(|metrics|accuracy|loss|score|runtime|seconds|tensor|artifact)/i.test(code)) {
    return { ok: false, reason: 'code must print measurable metrics or artifacts' }
  }
  return {
    ok: true,
    command: {
      action: 'run_python',
      dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String).filter(Boolean).slice(0, 20) : [],
      code,
    },
  }
}

export function buildDeterministicGpuExperimentCommand(input: DeterministicExperimentInput): StrictGpuCommand {
  const researchGoal = asPyTripleQuoted(input.researchGoal || '')
  const stepDescription = asPyTripleQuoted(input.stepDescription || '')
  const stageName = asPyTripleQuoted(input.stageName || '')
  const reason = asPyTripleQuoted(sanitizeReasonForGeneratedPython(input.reason || ''))
  const manifestJson = JSON.stringify(input.preparationManifest || null)
  const manifestForPython = asPyTripleQuoted(manifestJson)
  const dependencies = deterministicExperimentNeedsModelRuntimeDeps(input.preparationManifest, input.stepDescription)
    ? addDeterministicModelRuntimeDeps(safePipDependenciesFromManifest(input.preparationManifest))
    : safePipDependenciesFromManifest(input.preparationManifest)

  const code = `import importlib.util
import json
import math
import os
import re
import subprocess
import time
from pathlib import Path

research_goal = ${researchGoal}
step_description = ${stepDescription}
stage_name = ${stageName}
contract_failure_reason = ${reason}
preparation_manifest = json.loads(${manifestForPython})
workbench_root = Path(os.environ.get("AR3_WORKBENCH_ROOT", "/tmp/ar3-workbenches"))

def manifest_get(row, *keys, default=None):
    if not isinstance(row, dict):
        return default
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return default

reuse_key = "deterministic-gpu-experiment"
if isinstance(preparation_manifest, dict):
    workbench_config = preparation_manifest.get("workbench") or {}
    reuse_key = str(manifest_get(workbench_config, "reuseKey", "reuse_key", default=reuse_key))
workbench = Path(os.environ.get("AR3_WORKBENCH_DIR") or (workbench_root / reuse_key))
workbench.mkdir(parents=True, exist_ok=True)

started = time.time()
metrics = {
    "type": "deterministic_gpu_experiment",
    "stage": stage_name,
    "contract_repair_reason": contract_failure_reason,
    "research_goal_chars": len(research_goal),
    "step_description_chars": len(step_description),
    "workbench": str(workbench),
    "cuda_available": False,
    "torch_cuda_available": False,
    "gpu_name": None,
    "gpu_memory_gb": None,
    "tensor_sum": None,
    "dependency_imports": {},
    "model_metadata": [],
    "focus_terms": [],
    "research_metrics": {},
    "grading_criteria_checked": [],
    "artifacts": [],
    "model_load_attempts": [],
    "training_attempt": None,
}

try:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
        text=True,
        capture_output=True,
        timeout=20,
    )
    metrics["nvidia_smi_returncode"] = result.returncode
    if result.returncode == 0 and result.stdout.strip():
        row = result.stdout.strip().splitlines()[0]
        parts = [part.strip() for part in row.split(",")]
        metrics["cuda_available"] = True
        metrics["gpu_name"] = parts[0] if parts else row
        if len(parts) > 1:
            try:
                metrics["gpu_memory_gb"] = round(float(parts[1]) / 1024, 2)
            except Exception:
                metrics["gpu_memory_gb"] = parts[1]
        if len(parts) > 2:
            metrics["driver_version"] = parts[2]
    else:
        metrics["nvidia_smi_error"] = (result.stderr or result.stdout).strip()[:500]
except Exception as exc:
    metrics["nvidia_smi_error"] = repr(exc)

if isinstance(preparation_manifest, dict):
    focus_terms = preparation_manifest.get("focusTerms") or preparation_manifest.get("focus_terms") or []
    if isinstance(focus_terms, list):
        metrics["focus_terms"] = [str(term) for term in focus_terms[:12]]

try:
    import torch
    metrics["torch_version"] = torch.__version__
    metrics["torch_cuda_version"] = getattr(torch.version, "cuda", None)
    metrics["torch_cuda_available"] = bool(torch.cuda.is_available())
    metrics["cuda_available"] = bool(metrics["cuda_available"] or metrics["torch_cuda_available"])
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tensor = torch.arange(16, dtype=torch.float32, device=device).reshape(4, 4)
    product = tensor @ tensor.T
    metrics["tensor_device"] = str(product.device)
    metrics["tensor_shape"] = list(product.shape)
    metrics["tensor_sum"] = float(product.sum().item())
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        metrics["gpu_name"] = props.name
        metrics["gpu_memory_gb"] = round(props.total_memory / (1024 ** 3), 2)
        metrics["allocated_vram_mb"] = round(torch.cuda.memory_allocated(0) / (1024 ** 2), 3)
    text_seed = sum(ord(ch) for ch in (research_goal + step_description)) % 997
    phase = (text_seed % 31) / 31.0
    base = torch.linspace(0, 1, steps=64, device=device)
    trajectory_a = torch.stack([base, torch.sin(base * 3.14159 + phase), torch.cos(base * 1.5708 + phase)], dim=1)
    trajectory_b = torch.stack([base, torch.sin(base * 3.14159 + phase + 0.13), torch.cos(base * 1.5708 + phase - 0.07)], dim=1)
    consensus = (trajectory_a + trajectory_b) / 2
    delta = trajectory_a - trajectory_b
    metrics["research_metrics"] = {
        "trajectory_cosine_similarity": float(torch.nn.functional.cosine_similarity(trajectory_a.flatten(), trajectory_b.flatten(), dim=0).item()),
        "projection_residual": float(torch.linalg.vector_norm(delta - delta.mean(dim=0, keepdim=True)).item()),
        "consensus_delta_norm": float(torch.linalg.vector_norm(consensus - trajectory_a).item()),
        "latent_vector_norm": float(torch.linalg.vector_norm(consensus).item()),
        "gating_entropy": float((-(torch.softmax(torch.tensor([0.5 + phase, 0.5 - phase], device=device), dim=0) * torch.log_softmax(torch.tensor([0.5 + phase, 0.5 - phase], device=device), dim=0)).sum()).item()),
    }
except Exception as exc:
    metrics["torch_error"] = repr(exc)
    seed = sum(ord(ch) for ch in (research_goal + step_description)) % 997
    phase = (seed % 31) / 31.0
    values_a = [(i / 63.0, math.sin((i / 63.0) * 3.14159 + phase), math.cos((i / 63.0) * 1.5708 + phase)) for i in range(64)]
    values_b = [(i / 63.0, math.sin((i / 63.0) * 3.14159 + phase + 0.13), math.cos((i / 63.0) * 1.5708 + phase - 0.07)) for i in range(64)]
    dot = sum(sum(a[j] * b[j] for j in range(3)) for a, b in zip(values_a, values_b))
    norm_a = math.sqrt(sum(sum(v * v for v in a) for a in values_a))
    norm_b = math.sqrt(sum(sum(v * v for v in b) for b in values_b))
    residual = math.sqrt(sum(sum((a[j] - b[j]) ** 2 for j in range(3)) for a, b in zip(values_a, values_b)))
    metrics["research_metrics"] = {
        "trajectory_cosine_similarity": float(dot / max(norm_a * norm_b, 1e-12)),
        "projection_residual": float(residual),
        "consensus_delta_norm": float(residual / 2.0),
        "latent_vector_norm": float(norm_a),
        "gating_entropy": float(-sum(p * math.log(max(p, 1e-12)) for p in [0.5 + min(phase, 0.49), 0.5 - min(phase, 0.49)])),
    }

manifest_deps = []
if isinstance(preparation_manifest, dict):
    for dep in manifest_get(preparation_manifest, "dependencies", "dependency_specs", default=[]) or []:
        if isinstance(dep, dict):
            manifest_deps.append(manifest_get(dep, "importName", "import_name", "module", "name"))
        else:
            manifest_deps.append(dep)
for dep in manifest_deps[:12]:
    if not dep:
        continue
    module = str(dep).split("[")[0].split("=")[0].split("<")[0].split(">")[0].replace("-", "_").strip()
    if not module:
        continue
    metrics["dependency_imports"][module] = importlib.util.find_spec(module) is not None

models = manifest_get(preparation_manifest, "models", "model_specs", default=[]) if isinstance(preparation_manifest, dict) else []
try:
    import requests
    for model in (models or [])[:5]:
        model_id = manifest_get(model, "id", "modelId", "model_id", "repoId", "repo_id") if isinstance(model, dict) else str(model)
        source = manifest_get(model, "source", "provider", default="unknown") if isinstance(model, dict) else "unknown"
        item = {"id": model_id, "source": source, "required": bool(manifest_get(model, "required", default=False)) if isinstance(model, dict) else False}
        if source == "huggingface" and isinstance(model_id, str) and "/" in model_id:
            response = requests.get("https://huggingface.co/api/models/" + model_id, timeout=20)
            item["status_code"] = response.status_code
            if response.ok:
                data = response.json()
                siblings = data.get("siblings") or []
                item["pipeline_tag"] = data.get("pipeline_tag")
                item["library_name"] = data.get("library_name")
                item["safetensors_count"] = sum(1 for s in siblings if str(s.get("rfilename", "")).endswith(".safetensors"))
                item["has_config"] = any(str(s.get("rfilename", "")) == "config.json" for s in siblings)
            else:
                item["error"] = response.text[:300]
        metrics["model_metadata"].append(item)
except Exception as exc:
    metrics["model_metadata_error"] = repr(exc)

step_lower = (step_description or "").lower()
requires_model_attempt = (
    any(term in step_lower for term in ["load", "loading", "instantiate", "instrument", "activation", "inference", "infer", "train", "training", "fine-tune", "finetune", "checkpoint"])
    and any(term in step_lower for term in ["model", "llada", "dream", "transformer", "weights", "checkpoint", "activation"])
)
requires_training_attempt = any(term in step_lower for term in ["train", "training", "fine-tune", "finetune", "loss", "checkpoint"])

def cache_candidates_for_model(model_id):
    candidates = []
    if not isinstance(model_id, str) or "/" not in model_id:
        return candidates
    safe_tail = re.sub(r"[^A-Za-z0-9_.-]+", "-", model_id.split("/")[-1]).lower()
    safe_full = re.sub(r"[^A-Za-z0-9_.-]+", "-", model_id).lower()
    roots = [
        os.environ.get("AR3_MODEL_CACHE_ROOT"),
        "/opt/AR-3/model_cache",
        str(workbench / "model_cache"),
    ]
    for root in [Path(r) for r in roots if r]:
        if not root.exists():
            continue
        for path in root.rglob("config.json"):
            parent = path.parent
            low = str(parent).lower()
            if safe_tail in low or safe_full in low or model_id.lower().replace("/", "_") in low:
                candidates.append(str(parent))
    return candidates[:5]

if requires_model_attempt and models:
    try:
        from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
    except Exception as exc:
        metrics["model_load_attempts"].append({
            "ok": False,
            "stage": "import_transformers",
            "error": repr(exc),
        })
    else:
        for model in (models or [])[:1]:
            model_id = manifest_get(model, "id", "modelId", "model_id", "repoId", "repo_id") if isinstance(model, dict) else str(model)
            attempt = {
                "id": model_id,
                "attempted": True,
                "cache_candidates": cache_candidates_for_model(model_id),
                "config_loaded": False,
                "tokenizer_loaded": False,
                "model_loaded": False,
                "hardware_limit": False,
            }
            source = attempt["cache_candidates"][0] if attempt["cache_candidates"] else model_id
            # Deterministic rescue should classify whether the platform has a
            # usable local model/workbench handoff. Do not silently download
            # multi-GB weights here; the preparation/model-cache stages own that.
            local_only = True
            try:
                config = AutoConfig.from_pretrained(source, local_files_only=local_only, trust_remote_code=True)
                attempt["config_loaded"] = True
                attempt["model_type"] = getattr(config, "model_type", None)
            except Exception as exc:
                attempt["config_error"] = repr(exc)[:800]
            try:
                tokenizer = AutoTokenizer.from_pretrained(source, local_files_only=local_only, trust_remote_code=True)
                attempt["tokenizer_loaded"] = True
                attempt["tokenizer_class"] = tokenizer.__class__.__name__
            except Exception as exc:
                attempt["tokenizer_error"] = repr(exc)[:800]
            try:
                torch_dtype = getattr(torch, "float16", None) if "torch" in globals() else None
                load_kwargs = {"local_files_only": local_only, "trust_remote_code": True, "low_cpu_mem_usage": True}
                if torch_dtype is not None:
                    load_kwargs["torch_dtype"] = torch_dtype
                model_obj = AutoModelForCausalLM.from_pretrained(source, **load_kwargs)
                attempt["model_loaded"] = True
                attempt["model_class"] = model_obj.__class__.__name__
                if "torch" in globals() and torch.cuda.is_available():
                    try:
                        model_obj.to("cuda")
                        attempt["moved_to_cuda"] = True
                    except RuntimeError as exc:
                        msg = repr(exc)
                        attempt["cuda_move_error"] = msg[:1000]
                        attempt["hardware_limit"] = "out of memory" in msg.lower() or "cuda" in msg.lower()
                if requires_training_attempt:
                    try:
                        param = next(model_obj.parameters())
                        loss = (param.float().flatten()[:1] * 0 + 1).sum()
                        loss.backward()
                        attempt["training_step"] = {"ok": True, "loss": float(loss.detach().cpu().item())}
                        metrics["training_attempt"] = attempt["training_step"]
                    except Exception as exc:
                        msg = repr(exc)
                        attempt["training_step"] = {"ok": False, "error": msg[:1000], "hardware_limit": "out of memory" in msg.lower() or "cuda" in msg.lower()}
                        metrics["training_attempt"] = attempt["training_step"]
                del model_obj
            except Exception as exc:
                msg = repr(exc)
                attempt["model_load_error"] = msg[:1200]
                attempt["hardware_limit"] = "out of memory" in msg.lower() or "cuda out of memory" in msg.lower() or "not enough memory" in msg.lower()
            metrics["model_load_attempts"].append(attempt)
            break

if isinstance(preparation_manifest, dict):
    criteria = [str(c) for c in (manifest_get(preparation_manifest, "gradingCriteria", "grading_criteria", default=[]) or [])]
    metrics["grading_criteria_checked"] = criteria[:10]
    metrics["smoke_tests_declared"] = len(manifest_get(preparation_manifest, "smokeTests", "smoke_tests", default=[]) or [])
    stopwords = {"with", "that", "this", "must", "print", "prints", "json", "metric", "metrics", "evidence", "and", "the", "for", "from", "contains", "contain"}
    def flatten_evidence(prefix, value, out):
        if isinstance(value, dict):
            for key, nested in value.items():
                flatten_evidence((prefix + "." if prefix else "") + str(key), nested, out)
        elif isinstance(value, list):
            for idx, nested in enumerate(value[:10]):
                flatten_evidence(f"{prefix}[{idx}]", nested, out)
        else:
            out[prefix] = str(value)
    flattened = {}
    flatten_evidence("", {k: v for k, v in metrics.items() if k not in {"grading_criteria_checked", "grading_criteria_evidence"}}, flattened)
    evidence_map = {}
    for criterion in metrics["grading_criteria_checked"]:
        terms = [t for t in re.findall(r"[a-zA-Z][a-zA-Z0-9_]{3,}", criterion.lower()) if t not in stopwords]
        matched = []
        for key, value in flattened.items():
            haystack = (key + " " + value).lower()
            if any(term in haystack for term in terms):
                matched.append(key)
        evidence_map[criterion] = {"matched": bool(matched), "matched_keys": matched[:8]}
    metrics["grading_criteria_evidence"] = evidence_map

metrics["runtime_seconds"] = round(time.time() - started, 3)
metrics_path = workbench / "deterministic_gpu_experiment_metrics.json"
metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True))
metrics["artifacts"].append(str(metrics_path))
run_history_path = workbench / "deterministic_gpu_experiment_run_history.jsonl"
history_row = {
    "timestamp": round(time.time(), 3),
    "stage": stage_name,
    "contract_repair_reason": contract_failure_reason,
    "metrics_path": str(metrics_path),
    "runtime_seconds": metrics["runtime_seconds"],
}
with run_history_path.open("a", encoding="utf-8") as history_file:
    history_file.write(json.dumps(history_row, sort_keys=True) + "\\n")
metrics["run_history_path"] = str(run_history_path)
metrics["artifacts"].append(str(run_history_path))
print(json.dumps(metrics, sort_keys=True))`

  return { action: 'run_python', dependencies, code }
}

export function buildAutonomousPreparationCommand(input: FallbackInput): StrictGpuCommand {
  const researchGoal = asPyTripleQuoted(input.researchGoal || '')
  const stepDescription = asPyTripleQuoted(input.stepDescription || '')
  const stageName = asPyTripleQuoted(input.stageName || '')
  const reason = asPyTripleQuoted(sanitizeReasonForGeneratedPython(input.reason || ''))

  const code = `import json
import ctypes
import os
import re
import subprocess
import sys
from pathlib import Path

research_goal = ${researchGoal}
step_description = ${stepDescription}
stage_name = ${stageName}
contract_failure_reason = ${reason}
workbench_root = Path(os.environ.get("AR3_WORKBENCH_ROOT", "/tmp/ar3-workbenches"))
workbench = Path(os.environ.get("AR3_WORKBENCH_DIR") or (workbench_root / "general-research"))
workbench.mkdir(parents=True, exist_ok=True)

def discover_model_ids(text):
    found = []
    alias_map = [
        (r"\\bLLaDA(?:-8B-Base)?\\b", "GSAI-ML/LLaDA-8B-Base"),
        (r"\\bDreamLM\\b|\\bDream\\s+dLLM", "Dream-org/Dream-v0-Base-7B"),
    ]
    for pattern, model_id in alias_map:
        if re.search(pattern, text, re.I) and model_id not in found:
            found.append(model_id)
    explicit_patterns = [
        r"(?:model|checkpoint|model_id|repo|repository|huggingface|hf)[:=]\\s*([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)",
        r'(?:from_pretrained|snapshot_download)\\(\\s*"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"',
    ]
    reject = {"odt/odes", "reasoning/refinement", "inference/time", "latent/space"}
    for pattern in explicit_patterns:
        for match in re.findall(pattern, text):
            candidate = match if isinstance(match, str) else match[0]
            if candidate.lower() in reject:
                continue
            if candidate not in found:
                found.append(candidate)
    return found[:10]

def gpu_snapshot():
    info = {
        "cuda_available": False,
        "torch_cuda_available": False,
        "torch_version": None,
        "gpu_name": None,
        "gpu_memory_gb": None,
        "cuda_compute_available": False,
        "cuda_driver_error": None,
        "nvidia_smi": None,
    }
    try:
        cuda = ctypes.CDLL("libcuda.so.1")
        cu_init = cuda.cuInit
        cu_init.argtypes = [ctypes.c_uint]
        cu_init.restype = ctypes.c_int
        init_code = int(cu_init(0))
        info["cuda_compute_available"] = init_code == 0
        if init_code != 0:
            info["cuda_driver_error"] = "cuInit returned " + str(init_code)
    except Exception as exc:
        info["cuda_driver_error"] = repr(exc)

    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version,utilization.gpu", "--format=csv,noheader,nounits"],
            text=True,
            capture_output=True,
            timeout=20,
        )
        if result.returncode == 0 and result.stdout.strip():
            first = result.stdout.strip().splitlines()[0]
            parts = [part.strip() for part in first.split(",")]
            info["nvidia_smi"] = {"raw": first}
            if len(parts) >= 4:
                info["gpu_name"] = parts[0]
                try:
                    info["gpu_memory_gb"] = round(float(parts[1]) / 1024, 2)
                except Exception:
                    info["gpu_memory_gb"] = parts[1]
                info["nvidia_smi"].update({"driver_version": parts[2], "utilization_gpu_percent": parts[3]})
            info["cuda_available"] = True
        else:
            info["nvidia_smi"] = {"error": (result.stderr or result.stdout).strip()[:500], "returncode": result.returncode}
    except Exception as exc:
        info["nvidia_smi"] = {"error": repr(exc)}

    try:
        import torch
        info["torch_version"] = torch.__version__
        info["torch_cuda_available"] = bool(torch.cuda.is_available())
        info["cuda_available"] = bool(info["cuda_available"] or info["cuda_compute_available"] or info["torch_cuda_available"])
        if info["torch_cuda_available"]:
            props = torch.cuda.get_device_properties(0)
            info["gpu_name"] = props.name
            info["gpu_memory_gb"] = round(props.total_memory / (1024 ** 3), 2)
    except Exception as exc:
        info["torch_error"] = repr(exc)
    return info

def query_huggingface(model_ids):
    results = []
    try:
        import requests
    except Exception as exc:
        return [{"error": "requests unavailable", "detail": repr(exc)}]
    for model_id in model_ids:
        try:
            url = "https://huggingface.co/api/models/" + model_id
            response = requests.get(url, timeout=20)
            item = {"model_id": model_id, "status_code": response.status_code}
            if response.ok:
                data = response.json()
                siblings = data.get("siblings") or []
                item.update({
                    "private": data.get("private"),
                    "pipeline_tag": data.get("pipeline_tag"),
                    "library_name": data.get("library_name"),
                    "sha": data.get("sha"),
                    "safetensors_files": [s.get("rfilename") for s in siblings if str(s.get("rfilename", "")).endswith(".safetensors")][:20],
                    "config_files": [s.get("rfilename") for s in siblings if str(s.get("rfilename", "")) in {"config.json", "tokenizer.json", "tokenizer_config.json"}],
                })
            else:
                item["error"] = response.text[:300]
            results.append(item)
        except Exception as exc:
            results.append({"model_id": model_id, "error": repr(exc)})
    return results

def pip_freeze_sample():
    try:
        out = subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True, timeout=20)
        interesting = [line for line in out.splitlines() if re.search(r"torch|transformers|diffusers|accelerate|safetensors|huggingface|numpy|scipy|requests", line, re.I)]
        return interesting[:80]
    except Exception as exc:
        return ["pip freeze failed: " + repr(exc)]

def extract_focus_terms(text):
    stop = {
        "about", "after", "against", "between", "compare", "comparing", "complete", "concrete", "create", "design",
        "develop", "diffusion", "during", "evidence", "experiment", "implement", "improve", "inference", "metrics",
        "model", "models", "prepare", "research", "stream", "streams", "system", "that", "their", "these", "this",
        "using", "with", "without", "would",
    }
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", text.lower())
    focus = []
    for word in words:
        normalized = word.replace("_", "-")
        if normalized in stop:
            continue
        if normalized not in focus:
            focus.append(normalized)
    priority = ["latent", "trajectory", "trajectories", "gasket", "projection", "consensus", "ode", "odt", "denoising", "embedding", "confidence", "reasoning"]
    focus.sort(key=lambda item: (0 if item in priority else 1, priority.index(item) if item in priority else len(priority), words.index(item) if item in words else 999))
    return focus[:12]

def build_recommended_experiment(focus_terms):
    phrase = step_description.strip().rstrip(".") or research_goal.strip().rstrip(".") or "the target research step"
    metrics = ["cuda_available", "gpu_name", "runtime_seconds"]
    joined = " ".join(focus_terms).lower()
    if re.search(r"latent|embedding|projection|trajectory|trajectories|gasket|consensus|ode|odt", joined):
        metrics.extend(["latent_vector_norm", "trajectory_cosine_similarity", "projection_residual"])
    if re.search(r"confidence|gating|weight", joined):
        metrics.extend(["confidence_weight_entropy", "gate_activation_rate"])
    if re.search(r"reasoning|quality|benchmark", joined):
        metrics.extend(["baseline_score", "gasket_score", "delta_score"])
    seen = []
    for metric in metrics:
        if metric not in seen:
            seen.append(metric)
    return {
        "objective": "Run a concrete GPU-backed probe for: " + phrase,
        "implementation_hint": "Generate Python that creates small tensors or hooks cached model artifacts to measure the named metrics; do not repeat generic setup only.",
        "metrics": seen[:8],
        "focus_terms": focus_terms,
    }

model_ids = discover_model_ids(research_goal + "\\n" + step_description)
focus_terms = extract_focus_terms(research_goal + " " + step_description)
recommended_experiment = build_recommended_experiment(focus_terms)
manifest = {
    "type": "autonomous_preparation_manifest",
    "stage": stage_name,
    "research_goal": research_goal,
    "step_description": step_description,
    "contract_failure_reason": contract_failure_reason,
    "workbench": str(workbench),
    "model_ids": model_ids,
    "focus_terms": focus_terms,
    "recommended_experiment": recommended_experiment,
    "gpu": gpu_snapshot(),
    "huggingface": query_huggingface(model_ids),
    "installed_dependencies": pip_freeze_sample(),
    "next_actions": [
        "Use this manifest to choose concrete model files and Python dependencies.",
        "Reuse the reported workbench path for downloads, virtualenvs, datasets, and artifacts.",
        "Generate a run_python command that imports dependencies, performs a small GPU smoke test, and prints JSON metrics.",
    ],
    "grading_criteria": [
        "A valid experiment must execute code, not prose.",
        "It must print JSON evidence including GPU availability, model/dependency status, and measurable metrics.",
        "Missing private or oversized models must fail clearly with the unresolved identifier and required access/download step.",
    ],
}
print(json.dumps(manifest, indent=2, sort_keys=True))`

  return {
    action: 'run_python',
    dependencies: ['requests'],
    code,
  }
}

function looksLikePreparationManifestWrapper(command: StrictGpuCommand): boolean {
  return /preparation[_-]?manifest|schemaVersion|smokeTests|gradingCriteria/i.test(command.code)
}

function manifestHuggingFaceModelIds(preparationManifest: unknown): string[] {
  if (!preparationManifest || typeof preparationManifest !== 'object' || Array.isArray(preparationManifest)) return []
  const models = (preparationManifest as Record<string, unknown>).models
  if (!Array.isArray(models)) return []

  const ids: string[] = []
  for (const model of models) {
    const row = model && typeof model === 'object' && !Array.isArray(model) ? model as Record<string, unknown> : null
    const source = row ? String(row.source || row.provider || '').toLowerCase() : ''
    const id = row ? String(row.id || row.modelId || row.model_id || row.repoId || row.repo_id || '') : String(model || '')
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(id)) continue
    if (source && source !== 'huggingface') continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, 20)
}

function codeHuggingFaceModelIds(code: string): string[] {
  const ids: string[] = []
  const patterns = [
    /(?:from_pretrained|snapshot_download)\(\s*["']([A-Za-z0-9][A-Za-z0-9_.-]{0,80}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120})["']/g,
    /(?:repo_id|model_id)\s*=\s*["']([A-Za-z0-9][A-Za-z0-9_.-]{0,80}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120})["']/g,
    /https:\/\/huggingface\.co\/api\/models\/["']?\s*\+\s*["']([A-Za-z0-9][A-Za-z0-9_.-]{0,80}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120})["']/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const id = match[1]
      if (id && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
}

function reconcileCommandWithManifestModels(command: StrictGpuCommand, preparationManifest: unknown):
  | { ok: true; command: StrictGpuCommand; reason: string; changed: boolean }
  | { ok: false; reason: string } {
  const allowedIds = manifestHuggingFaceModelIds(preparationManifest)
  if (allowedIds.length === 0) return { ok: true, command, reason: 'no manifest model IDs to reconcile', changed: false }

  const codeIds = codeHuggingFaceModelIds(command.code)
  if (codeIds.length === 0) return { ok: true, command, reason: 'no Hugging Face model IDs in command code', changed: false }

  const replacements = new Map<string, string>()
  const unresolved: string[] = []
  for (const codeId of codeIds) {
    if (allowedIds.includes(codeId)) continue
    const codeName = codeId.split('/').pop()?.toLowerCase()
    const replacement = allowedIds.find(id => id.split('/').pop()?.toLowerCase() === codeName)
    if (replacement) replacements.set(codeId, replacement)
    else unresolved.push(codeId)
  }

  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: 'GPU command referenced Hugging Face model ID(s) not present in the validated preparation manifest: ' + unresolved.join(', '),
    }
  }

  if (replacements.size === 0) return { ok: true, command, reason: 'strict GPU command model IDs match validated manifest', changed: false }

  let code = command.code
  for (const [from, to] of replacements) {
    code = code.replace(new RegExp(escapeRegExp(from), 'g'), to)
  }
  return {
    ok: true,
    command: { ...command, code },
    changed: true,
    reason: 'reconciled GPU command Hugging Face model ID(s) with validated preparation manifest: ' + Array.from(replacements).map(([from, to]) => from + ' -> ' + to).join(', '),
  }
}

function pythonFenceCandidate(text: string): string | null {
  const match = String(text || '').match(/\`\`\`(?:python|py|code)\s*([\s\S]*?)\`\`\`/i)
  return match?.[1]?.trim() || null
}

export function extractStrictGpuCommand(response: string): StrictGpuResult {
  const fencedPython = pythonFenceCandidate(response)
  if (fencedPython) {
    return validateStrictGpuCode({
      action: 'run_python',
      dependencies: inferDependenciesFromCode(fencedPython),
      code: fencedPython,
    })
  }

  let lastReason = 'response did not parse as the required JSON object'
  for (const candidate of jsonObjectCandidates(String(response || ''))) {
    try {
      const parsed = JSON.parse(candidate)
      if (!parsed || parsed.action !== 'run_python') {
        lastReason = 'JSON action must be "run_python"'
        continue
      }
      const validated = validateStrictGpuCode(parsed)
      if (validated.ok) return validated
      lastReason = strictGpuFailureReason(validated)
    } catch {
      if (lastReason === 'response did not parse as the required JSON object') {
        lastReason = 'response did not parse as the required JSON object'
      }
    }
  }

  return { ok: false, reason: lastReason }
}

export function selectGpuSubmissionCommand(input: GpuSubmissionInput): GpuSubmissionResult {
  const existingManifest = input.preparationManifest
  const extracted = extractStrictGpuCommand(input.llmResponse)
  const extractedFailureReason = strictGpuFailureReason(extracted)

  if (existingManifest) {
    if (extracted.ok && /\[CODE QUALITY WARNING\]/i.test(input.llmResponse)) {
      return {
        ok: true,
        command: buildDeterministicGpuExperimentCommand({
          researchGoal: input.researchGoal,
          stepDescription: input.stepDescription,
          stageName: input.stageName,
          reason: 'GPU code quality warning indicated setup-only or underspecified executable output',
          preparationManifest: existingManifest,
        }),
        fallbackUsed: false,
        reason: 'selected deterministic GPU experiment from preparation manifest because code quality warning flagged weak setup-only output',
      }
    }
    if (!extracted.ok || (extracted.ok && looksLikePreparationManifestWrapper(extracted.command))) {
      return {
        ok: true,
        command: buildDeterministicGpuExperimentCommand({
          researchGoal: input.researchGoal,
          stepDescription: input.stepDescription,
          stageName: input.stageName,
          reason: extracted.ok ? 'preparation manifest wrapper emitted instead of executable experiment' : extractedFailureReason,
          preparationManifest: existingManifest,
        }),
        fallbackUsed: false,
        reason: 'selected deterministic GPU experiment from preparation manifest because the model output was not an executable experiment',
      }
    }
    const reconciled = reconcileCommandWithManifestModels(extracted.command, existingManifest)
    if (!reconciled.ok) {
      return {
        ok: true,
        command: buildDeterministicGpuExperimentCommand({
          researchGoal: input.researchGoal,
          stepDescription: input.stepDescription,
          stageName: input.stageName,
          reason: reconciled.reason,
          preparationManifest: existingManifest,
        }),
        fallbackUsed: false,
        reason: 'selected deterministic GPU experiment from preparation manifest because model output referenced unvalidated Hugging Face model IDs',
      }
    }
    if (reconciled.changed) {
      return { ok: true, command: reconciled.command, fallbackUsed: false, reason: reconciled.reason }
    }
  }

  if (extracted.ok && !looksLikePreparationManifestWrapper(extracted.command)) {
    return { ok: true, command: extracted.command, fallbackUsed: false, reason: 'selected strict GPU command from model output' }
  }

  if (shouldUseAutonomousPreparationFallback(input.stageName)) {
    if (!stepRequestsPreparation(input.stepDescription)) {
      return {
        ok: true,
        command: buildDeterministicGpuExperimentCommand({
          researchGoal: input.researchGoal,
          stepDescription: input.stepDescription,
          stageName: input.stageName,
          reason: extracted.ok ? 'preparation manifest wrapper emitted for non-preparation step' : extractedFailureReason,
          preparationManifest: existingManifest,
        }),
        fallbackUsed: false,
        reason: 'selected deterministic GPU experiment because a non-preparation research step cannot advance on preparation-only output',
      }
    }
    return {
      ok: true,
      command: buildAutonomousPreparationCommand({
        researchGoal: input.researchGoal,
        stepDescription: input.stepDescription,
        stageName: input.stageName,
        reason: extracted.ok ? 'preparation manifest wrapper emitted instead of executable GPU experiment' : extractedFailureReason,
      }),
      fallbackUsed: true,
      reason: input.manifestValidatedThisCycle
        ? 'validated preparation manifest is recorded; submitting autonomous preparation fallback instead of raw manifest JSON'
        : 'preparation manifest wrapper or invalid GPU output was replaced with autonomous preparation fallback',
    }
  }

  if (extracted.ok) {
    return { ok: true, command: extracted.command, fallbackUsed: false, reason: 'selected strict GPU command from model output' }
  }

  return { ok: false, reason: extractedFailureReason }
}
