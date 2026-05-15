Total output lines: 1212

export type StrictGpuCommand = { action: 'run_python'; dependencies: string[]; code: string }

export function shouldUseAutonomousPreparationFallback(stageName: string): boolean {
  return ['Investigation', 'Planning'].includes(stageName)
}

export function shouldShortCircuitPreparationFallback(stageName: string, reason: string): boolean {
  if (!shouldUseAutonomousPreparationFallback(stageName)) return false
  const normalized = String(reason || '').toLowerCase()
  return [
    'response did not parse',
    'json action must',
    'placeholder',
    'pseudocode',
    'code too short',
    'missing non-empty code',
    'lacks python syntax',
  ].some(marker => normalized.includes(marker))
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

type PersistablePreparationResult =
  | { ok: true; manifest: any; reason: string }
  | { ok: false; reason: string }

function strictGpuFailureReason(result: StrictGpuResult): string {
  return (result as { ok: false; reason?: string }).reason || 'invalid strict GPU command'
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
  return candidates.reverse().find(obj => obj && typeof obj === 'object' && (obj.type || obj.gpu || obj.model_ids || obj.installed_dependencies)) || candidates[candidates.length - 1] || null
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
  const criteria = (preparationManifest as Record<string, unknown>).gradingCriteria
  return Array.isArray(criteria) ? criteria.map(String).filter(Boolean).slice(0, 20) : []
}

function manifestExpectedEvidence(preparationManifest: unknown): string[] {
  if (!preparationManifest || typeof preparationManifest !== 'object' || Array.isArray(preparationManifest)) return []
  const smokeTests = (preparationManifest as Record<string, unknown>).smokeTests
  if (!Array.isArray(smokeTests)) return []

  const expected = new Set<string>()
  for (const smokeTest of smokeTests.slice(0, 20)) {
    if (!smokeTest || typeof smokeTest !== 'object' || Array.isArray(smokeTest)) continue
    const row = smokeTest as Record<string, unknown>
    const evidence = row.expectedEvidence
    if (!Array.isArray(evidence)) continue
    for (const item of evidence.slice(0, 20)) {
      const normalized = String(item || '').trim()
      if (normalized) expected.add(normalized)
    }
  }
  return Array.from(expected).slice(0, 30)
}

function validateGradingCriteriaEvidence(parsedOutput: any, preparationManifest?: unknown): GpuEvidenceResult {
  if (!parsedOutput || typeof parsedOutput !== 'object') return { valid: true, reason: 'no structured grading criteria to validate' }
  const deterministicCriteria = Array.isArray(parsedOutput.grading_criteria_checked)
    ? parsedOutput.grading_criteria_checked.map(String).filter(Boolean)
    : []
  const criteria = deterministicCriteria.length > 0 ? deterministicCriteria : manifestGradingCriteria(preparationManifest)
  if (criteria.length === 0) return { valid: true, reason: 'no grading criteria declared by output' }

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
    return explicitTerms.some(term => !matchedHaystack.includes(term))
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
  const…3217 tokens truncated…orch
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
    for dep in preparation_manifest.get("dependencies") or []:
        if isinstance(dep, dict):
            manifest_deps.append(dep.get("importName") or dep.get("name"))
        else:
            manifest_deps.append(dep)
for dep in manifest_deps[:12]:
    if not dep:
        continue
    module = str(dep).split("[")[0].split("=")[0].split("<")[0].split(">")[0].replace("-", "_").strip()
    if not module:
        continue
    metrics["dependency_imports"][module] = importlib.util.find_spec(module) is not None

models = preparation_manifest.get("models") if isinstance(preparation_manifest, dict) else []
try:
    import requests
    for model in (models or [])[:5]:
        model_id = model.get("id") if isinstance(model, dict) else str(model)
        source = model.get("source") if isinstance(model, dict) else "unknown"
        item = {"id": model_id, "source": source, "required": bool(model.get("required")) if isinstance(model, dict) else False}
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

if isinstance(preparation_manifest, dict):
    criteria = [str(c) for c in (preparation_manifest.get("gradingCriteria") or [])]
    metrics["grading_criteria_checked"] = criteria[:10]
    metrics["smoke_tests_declared"] = len(preparation_manifest.get("smokeTests") or [])
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
print(json.dumps(metrics, sort_keys=True))`

  return { action: 'run_python', dependencies, code }
}

export function buildAutonomousPreparationCommand(input: FallbackInput): StrictGpuCommand {
  const researchGoal = asPyTripleQuoted(input.researchGoal || '')
  const stepDescription = asPyTripleQuoted(input.stepDescription || '')
  const stageName = asPyTripleQuoted(input.stageName || '')
  const reason = asPyTripleQuoted(sanitizeReasonForGeneratedPython(input.reason || ''))

  const code = `import json
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
        "nvidia_smi": None,
    }
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
        info["cuda_available"] = bool(info["cuda_available"] or info["torch_cuda_available"])
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

function pythonFenceCandidate(text: string): string | null {
  const match = String(text || '').match(/\`\`\`python\s*([\s\S]*?)\`\`\`/i)
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
  }

  if (extracted.ok && !looksLikePreparationManifestWrapper(extracted.command)) {
    return { ok: true, command: extracted.command, fallbackUsed: false, reason: 'selected strict GPU command from model output' }
  }

  if (shouldUseAutonomousPreparationFallback(input.stageName)) {
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
