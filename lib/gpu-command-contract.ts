Total output lines: 1887

export type StrictGpuCommand = { action: 'run_python'; dependencies: string[]; code: string }

export function shouldUseAutonomousPreparationFallback(stageName: string): boolean {
  return ['Investigation', 'Planning'].includes(stageName)
}

export function shouldRouteStageThroughGpu(stageName: string, stageGpuEnabled: boolean | undefined, spaceUseGpu: boolean | undefined | null): boolean {
  return Boolean(spaceUseGpu && (stageGpuEnabled || shouldUseAutonomousPreparationFallback(stageName)))
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
  if (/\b(download|verify|checksum|integrity|weights?|checkpoint|snapshot)\b/.test(stepText) && /\b(model|llada|dream|huggingface|hf|weights?|checkpoint|safetensors)\b/.test(stepText)) {
    const parsedOutput = parseGpuEvidenceJson(evidenceOutput)
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
    ))
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
    ))
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
        if (/^(type|gpu|model_ids|huggingface|installed_dependencies|workbench|contract_failure_reason)$/.test(key)) score += 6
        if (/metric|score|loss|accuracy|acc|f1|precision|recall|latency|throughput|seconds|runtime|cuda|gpu|memory|vram|artifact|path|file|stdout|stderr|result|measurement/i.test(key)) score += 3
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) score += 2
        if (typeof rawValue === 'boolean') score += 1
        if (typeof rawValue === 'string' && rawValue.trim()) score += 1
        visit(rawValue, depth + 1)
      }
    }
    visit(value, 0)
    return score
  }

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
…11788 tokens truncated…ria[:10]
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
