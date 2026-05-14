export type StrictGpuCommand = { action: 'run_python'; dependencies: string[]; code: string }

export function shouldUseAutonomousPreparationFallback(stageName: string): boolean {
  return ['Investigation', 'Planning'].includes(stageName)
}

type StrictGpuResult = { ok: true; command: StrictGpuCommand } | { ok: false; reason: string }

type FallbackInput = {
  researchGoal: string
  stepDescription: string
  stageName?: string
  reason?: string
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
  if (strict.ok) return { ok: true, command: strict.command, fallbackUsed: false, reason: 'strict GPU command validated' }
  return { ok: false, reason: (strict as { ok: false; reason: string }).reason }
}

export function buildAutonomousPreparationCommand(input: FallbackInput): StrictGpuCommand {
  const researchGoal = asPyTripleQuoted(input.researchGoal || '')
  const stepDescription = asPyTripleQuoted(input.stepDescription || '')
  const stageName = asPyTripleQuoted(input.stageName || '')
  const reason = asPyTripleQuoted(input.reason || '')

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
    patterns = [r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", r"(?:model|checkpoint)[:=]\\s*([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"]
    found = []
    for pattern in patterns:
        for match in re.findall(pattern, text):
            candidate = match if isinstance(match, str) else match[0]
            if candidate not in found:
                found.append(candidate)
    return found[:10]

def gpu_snapshot():
    info = {"cuda_available": False, "torch_version": None, "gpu_name": None, "gpu_memory_gb": None}
    try:
        import torch
        info["torch_version"] = torch.__version__
        info["cuda_available"] = bool(torch.cuda.is_available())
        if info["cuda_available"]:
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

model_ids = discover_model_ids(research_goal + "\n" + step_description)
manifest = {
    "type": "autonomous_preparation_manifest",
    "stage": stage_name,
    "contract_failure_reason": contract_failure_reason,
    "workbench": str(workbench),
    "model_ids": model_ids,
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
