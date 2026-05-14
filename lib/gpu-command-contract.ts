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
}

type GpuEvidenceResult = { valid: true; reason: string } | { valid: false; reason: string }

type PersistablePreparationResult =
  | { ok: true; manifest: any; reason: string }
  | { ok: false; reason: string }

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

export function assessGpuExecutionEvidence(input: GpuEvidenceInput): GpuEvidenceResult {
  if (!input.success) {
    return { valid: false, reason: input.error || 'GPU execution failed' }
  }

  const output = String(input.output || '').trim()
  let parsedOutput: any = null
  try {
    parsedOutput = output.startsWith('{') ? JSON.parse(output) : null
  } catch {}
  const looksLikePreparationProbe = Boolean(
    input.fallbackUsed ||
    parsedOutput?.type === 'autonomous_preparation_manifest' ||
    parsedOutput?.contract_failure_reason
  )
  if (looksLikePreparationProbe) {
    if (shouldUseAutonomousPreparationFallback(input.stageName)) {
      const hasProbeEvidence = Boolean(
        parsedOutput?.type === 'autonomous_preparation_manifest' &&
        (parsedOutput?.gpu || parsedOutput?.model_ids || parsedOutput?.huggingface || parsedOutput?.installed_dependencies || parsedOutput?.workbench)
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

  return { valid: true, reason: 'GPU execution produced measurable evidence' }
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

export function extractStrictGpuCommand(text: string): StrictGpuResult {
  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      const code = typeof parsed?.code === 'string' ? parsed.code.trim() : ''
      if (parsed?.action !== 'run_python') return { ok: false, reason: 'JSON action must be "run_python"' }
      if (!code) return { ok: false, reason: 'JSON is missing non-empty code string' }
      const codeLines = code.split('\n').map((l: string) => l.trim()).filter(Boolean)
      const hasPython = /(^|\n)\s*(import |from |def |class |for |while |try:|with |print\(|[A-Za-z_][A-Za-z0-9_]*\s*=)/m.test(code)
      const hasMeasurableOutput = /print\(|json\.dump|json\.dumps|logging\./.test(code)
      const hasGpuProbe = /\b(torch|cuda|cupy|triton|tensorflow|jax|nvidia-smi|nvml|device\s*=|cuda_available|gpu_name|gpu_memory|vram)\b|\.cuda\(|\.to\(\s*['"]cuda|torch\.cuda|subprocess\.[\s\S]*?nvidia-smi/i.test(code)
      const hasPlaceholder = /TODO|pass\s*(#|$)|pseudocode|your code here|placeholder|\.\.\./i.test(code)
      if (codeLines.length < 5) return { ok: false, reason: `code too short (${codeLines.length} non-empty lines)` }
      if (!hasPython) return { ok: false, reason: 'code lacks Python syntax indicators' }
      const syntaxIssue = findLikelyPythonStringSyntaxIssue(code)
      if (syntaxIssue) return { ok: false, reason: `python syntax appears invalid: ${syntaxIssue}` }
      if (!hasMeasurableOutput) return { ok: false, reason: 'code must print/log measurable outputs' }
      if (!hasGpuProbe) return { ok: false, reason: 'code must include an executable GPU/CUDA probe or GPU runtime evidence path' }
      if (hasPlaceholder) return { ok: false, reason: 'code contains placeholder/pseudocode markers' }
      return { ok: true, command: { action: 'run_python', dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String).slice(0, 20) : [], code } }
    } catch {}
  }
  return { ok: false, reason: 'response did not parse as the required JSON object' }
}

function asPyTripleQuoted(value: string): string {
  return JSON.stringify(value).replace(/\\n/g, '\\n')
}

function sanitizeReasonForGeneratedPython(value: string): string {
  return String(value || '')
    .replace(/placeholder/gi, 'invalid-content')
    .replace(/pseudocode/gi, 'non-executable-content')
    .replace(/TODO/gi, 'incomplete-marker')
    .replace(/pass\s*(#|$)/gi, 'empty-body$1')
}

function looksLikePreparationManifestWrapper(command: StrictGpuCommand): boolean {
  const code = String(command.code || '')
  return /ar3\.preparation-manifest\.v1|preparation_manifest|smokeTests|smokeTest/i.test(code) &&
    /manifest\s*=|json\.dumps\(manifest|preparation_manifest\s*=/.test(code)
}

export function selectGpuSubmissionCommand(input: GpuSubmissionInput): GpuSubmissionResult {
  const preparationStage = shouldUseAutonomousPreparationFallback(input.stageName)
  if (preparationStage && input.manifestValidatedThisCycle) {
    const reason = 'preparation manifest validated; running autonomous preparation probe instead of submitting raw manifest JSON'
    return {
      ok: true,
      fallbackUsed: true,
      reason,
      command: buildAutonomousPreparationCommand({
        researchGoal: input.researchGoal,
        stepDescription: input.stepDescription,
        stageName: input.stageName,
        reason,
      }),
    }
  }

  const strict = extractStrictGpuCommand(input.llmResponse)
  if (strict.ok) {
    if (preparationStage && looksLikePreparationManifestWrapper(strict.command)) {
      const reason = 'LLM returned a preparation manifest wrapper instead of executable research evidence; running autonomous preparation fallback'
      return {
        ok: true,
        fallbackUsed: true,
        reason,
        command: buildAutonomousPreparationCommand({
          researchGoal: input.researchGoal,
          stepDescription: input.stepDescription,
          stageName: input.stageName,
          reason,
        }),
      }
    }
    return { ok: true, command: strict.command, fallbackUsed: false, reason: 'strict GPU command validated' }
  }
  if (preparationStage) {
    const reason = (strict as { ok: false; reason: string }).reason
    if (shouldShortCircuitPreparationFallback(input.stageName, reason)) {
      return {
        ok: true,
        fallbackUsed: true,
        reason: `weak preparation-stage GPU command (${reason}); running autonomous preparation fallback`,
        command: buildAutonomousPreparationCommand({
          researchGoal: input.researchGoal,
          stepDescription: input.stepDescription,
          stageName: input.stageName,
          reason,
        }),
      }
    }
  }
  return { ok: false, reason: (strict as { ok: false; reason: string }).reason }
}

function safePipDependenciesFromManifest(manifest: any): string[] {
  const deps = new Set<string>(['requests'])
  for (const dep of Array.isArray(manifest?.dependencies) ? manifest.dependencies : []) {
    const raw = typeof dep === 'string' ? dep : dep?.name
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    // Avoid heavyweight or stdlib-looking installs in the deterministic rescue path.
    if (/^(os|sys|json|time|subprocess|pathlib|re|math|random|statistics)$/i.test(name)) continue
    if (/^(torch|torchvision|torchaudio|transformers|accelerate|safetensors|numpy|scipy|requests)([<>=!~].*)?$/i.test(name)) deps.add(name)
  }
  deps.add('torch')
  return Array.from(deps).slice(0, 8)
}

export function buildDeterministicGpuExperimentCommand(input: DeterministicExperimentInput): StrictGpuCommand {
  const researchGoal = asPyTripleQuoted(input.researchGoal || '')
  const stepDescription = asPyTripleQuoted(input.stepDescription || '')
  const stageName = asPyTripleQuoted(input.stageName || '')
  const reason = asPyTripleQuoted(sanitizeReasonForGeneratedPython(input.reason || ''))
  const manifestJson = JSON.stringify(input.preparationManifest || null)
  const manifestForPython = asPyTripleQuoted(manifestJson)
  const dependencies = safePipDependenciesFromManifest(input.preparationManifest)

  const code = `import importlib.util
import json
import os
import subprocess
import time
from pathlib import Path

research_goal = ${researchGoal}
step_description = ${stepDescription}
stage_name = ${stageName}
contract_failure_reason = ${reason}
preparation_manifest = json.loads(${manifestForPython})
workbench_root = Path(os.environ.get("AR3_WORKBENCH_ROOT", "/tmp/ar3-workbenches"))
reuse_key = "deterministic-gpu-experiment"
if isinstance(preparation_manifest, dict):
    reuse_key = str((preparation_manifest.get("workbench") or {}).get("reuseKey") or reuse_key)
workbench = Path(os.environ.get("AR3_WORKBENCH_DIR") or (workbench_root / reuse_key))
workbench.mkdir(parents=True, exist_ok=True)

started = time.time()
metrics = {
    "type": "deterministic_gpu_experiment",
    "stage": stage_name,
    "contract_failure_reason": contract_failure_reason,
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
    "grading_criteria_checked": [],
    "artifacts": [],
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
except Exception as exc:
    metrics["torch_error"] = repr(exc)

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
