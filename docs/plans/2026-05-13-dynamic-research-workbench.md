# Dynamic Research Workbench Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make AR-3 prompt-independent enough to prepare its own model/dependency environment, reject prose/pseudocode before GPU execution, grade results with experiment-grounded criteria, and reuse a live workbench across iterative GPU experiment cycles.

**Architecture:** Split the platform into a deterministic preparation contract, a validated GPU execution contract, and a grading/retry controller. Weak researcher models such as MiniMax 2.7 must be guided by schema-bound outputs, small discoverable tasks, and machine validators rather than open-ended prose. The GPU worker should execute only explicit commands and should keep workbench state available across cycles.

**Tech Stack:** Next.js 14, TypeScript, Prisma/SQLite, Python GPU worker, VAST.ai CUDA container, HuggingFace Hub, OpenRouter/MiniMax-compatible LLM providers.

---

## Current architecture map

- UI/API: `app/` exposes spaces, variants, model cache, and GPU job routes.
- Orchestration: `lib/research-engine.ts` creates stage variants, calls LLM agents, submits GPU work, verifies outputs, grades variants, and records experiments.
- Variant planning: `lib/variant-engine.ts` extracts research keywords, generates approaches, and builds stage variants.
- Model prep/cache: `lib/model-cache.ts` downloads HuggingFace models and records cache rows.
- GPU execution: `scripts/gpu_worker.py` polls `/tmp/ar3-gpu-jobs/queue.json`, extracts executable commands, runs Python/Bash, and writes result JSON.
- Deployment: `deploy/SUCCESS_LOG.md`, `deploy/setup-with-tunnel.sh`, and `deploy/vast-ai-launch*.py` document the successful Vast.ai + Cloudflare tunnel pattern.

## Root-cause findings

1. **Environment preparation was not a first-class contract.** Researcher outputs could mention models/dependencies without producing a machine-readable manifest that the implementer/GPU worker could consume.
2. **Model cache could claim success while storing the wrong path/status.** HuggingFace snapshot downloads produced a loadable snapshot path, but previous cache bookkeeping was fragile and could leave consumers with invented or stale paths.
3. **The implementer could spend GPU time on prose.** `scripts/gpu_worker.py` had extraction fallbacks that could eventually degrade to `nvidia-smi`, masking invalid research code as a successful GPU job.
4. **Weak models need validators and repair loops.** MiniMax 2.7-style outputs need strict JSON schemas, rejection reasons, and retry prompts before execution rather than post-hoc human interpretation.
5. **Grading is not yet sufficiently experiment-grounded.** Current grading can mark a variant as complete based on agent output shape rather than independent, measurable artifacts and criteria.
6. **Workbench reuse is implicit.** The GPU worker runs snippets, but there is no explicit persistent per-space workbench manifest with installed deps, downloaded model paths, datasets, run history, and retry state.

---

## Phase 1: Stabilize executable GPU contract

### Task 1: Keep strict GPU output validation in orchestrator

**Objective:** Prevent prose/pseudocode from reaching GPU execution.

**Files:**
- Modify: `lib/research-engine.ts`

**Implementation details:**
- Use `STRICT_GPU_CODE_CONTRACT` for GPU-enabled steps.
- Parse only JSON commands shaped like:
  ```json
  {"action":"run_python","dependencies":["numpy"],"code":"print('measurable output')"}
  ```
- Reject short code, missing print/log output, `TODO`, `pass`, `pseudocode`, placeholders, and markdown-only answers.
- Retry the same LLM up to two times with the validator rejection reason before submitting to `/api/jobs/gpu`.

**Verification:**
- `npm run build -- --no-lint` compiles successfully.
- A fake response such as `I would train a model...` is rejected with `GPU_CONTRACT_FAILED`.
- A valid JSON command is submitted unchanged to GPU worker.

### Task 2: Keep GPU worker fail-fast invalid command behavior

**Objective:** Stop masking invalid code as successful `nvidia-smi` diagnostics.

**Files:**
- Modify: `scripts/gpu_worker.py`

**Implementation details:**
- If extraction strategies cannot find a valid command/code block, return:
  ```json
  {"action":"invalid","error":"No executable GPU command found..."}
  ```
- Do not fall back to `nvidia_smi` for research jobs.

**Verification:**
- `python3 -m py_compile scripts/gpu_worker.py`
- Submit prose-only prompt to `extract_gpu_command`; expected action is `invalid`.

---

## Phase 2: Make preparation machine-readable

### Task 3: Add a preparation manifest schema

**Objective:** Make researcher output consumable by environment setup and implementer agents.

**Files:**
- Create: `lib/preparation-manifest.ts`
- Test: `tests/preparation-manifest.test.ts` or a lightweight Node script if no test runner exists.

**Schema:**
```ts
export interface PreparationManifest {
  research_type: string
  success_criteria: Array<{ name: string; metric: string; threshold?: string; evidence: string }>
  models: Array<{ id: string; source: 'huggingface' | 'url' | 'none'; reason: string; min_vram_gb?: number }>
  datasets: Array<{ id: string; source: string; reason: string; optional?: boolean }>
  python_dependencies: string[]
  system_dependencies: string[]
  smoke_tests: Array<{ name: string; command: string; expected: string }>
  risks: Array<{ risk: string; mitigation: string }>
}
```

**Verification:**
- Invalid missing criteria fails validation.
- Empty model list is allowed only when a `none` entry explains why.

### Task 4: Add researcher repair loop for manifest creation

**Objective:** Let MiniMax 2.7 recover from incomplete preparation output.

**Files:**
- Modify: `lib/research-engine.ts`
- Modify: `lib/variant-engine.ts`

**Implementation details:**
- At the beginning of a space/cycle, ask the researcher for `PreparationManifest` JSON only.
- Validate it deterministically.
- Retry up to three times with concise validator errors.
- Store the accepted manifest on the space or as an experiment artifact.

**Verification:**
- Prompt with arbitrary domain still yields criteria/models/deps/smoke tests or a structured failure.

---

## Phase 3: Build persistent workbench state

### Task 5: Add per-space workbench manifest

**Objective:** Retain environment state between cycles.

**Files:**
- Create: `lib/workbench-state.ts`
- Modify: `scripts/gpu_worker.py`

**State file:** `/opt/AR-3/workbenches/<spaceId>/workbench.json`

**Fields:**
- installed Python deps with versions
- downloaded model cache paths
- dataset paths
- smoke test results
- GPU hardware facts
- recent run IDs and artifact paths

**Verification:**
- First run creates the manifest.
- Second run sees and reuses installed deps/model paths instead of rediscovering from scratch.

### Task 6: Install dependencies from explicit command field

**Objective:** Make dependencies dynamic but controlled.

**Files:**
- Modify: `scripts/gpu_worker.py`

**Implementation details:**
- Read `dependencies` from strict JSON command.
- Before execution, install missing packages with `python3 -m pip install --no-input` and record versions.
- Limit to Python package specs; reject shell fragments.

**Verification:**
- Command with `dependencies:["numpy"]` runs after ensuring numpy exists.
- Command with `dependencies:["numpy; rm -rf /"]` is rejected.

---

## Phase 4: Ground grading in evidence and retries

### Task 7: Add experiment evidence validator

**Objective:** Grade only based on measurable outputs.

**Files:**
- Create: `lib/evidence-validator.ts`
- Modify: `lib/research-engine.ts`

**Validation:**
- Code artifact exists or `[CODE]...[/CODE]` included.
- GPU output includes numeric/structured metrics.
- Success criteria from preparation manifest are referenced.
- Failure includes actionable missing dependency/model/error.

**Verification:**
- Prose-only result grade is forced to 0.
- Numeric metric output can pass when it maps to criteria.

### Task 8: Add dead-loop detector

**Objective:** Stop cycles that repeat the same failure or same experiment without new evidence.

**Files:**
- Create: `lib/dead-loop-detector.ts`
- Modify: `lib/research-engine.ts`

**Signals:**
- Same normalized error appears 3 times.
- Same code hash appears 3 times with no metric improvement.
- Same model/dependency discovery failure appears twice.
- Grading feedback repeats without new workbench state change.

**Behavior:**
- Mark current variant `FAILED` with `DEAD_LOOP_DETECTED`.
- Force next cycle to choose a different approach or setup fix.

**Verification:**
- Three repeated fake outputs trigger dead-loop.
- A changed dependency/model path resets the loop counter.

---

## Phase 5: VAST deployment guardrails

### Task 9: Add single-instance guard

**Objective:** Ensure at most one active Vast.ai instance for AR-3.

**Files:**
- Modify: `deploy/vast-ai-launch-v3.py`
- Modify: `deploy/active_instance.json`

**Implementation details:**
- Query active instances before rental.
- If any running/rented AR-3-labelled instance exists, refuse to create another unless `--replace` is provided.
- Record chosen offer ID, GPU, price, instance ID, and created timestamp.

**Verification:**
- With active instance mock, launch exits before rental.
- With zero active instances and `--dry-run`, it prints chosen offer but does not rent.

---

## Immediate status from this session

Implemented first stabilization changes:
- `lib/research-engine.ts`: strict GPU JSON/Python contract, validator-driven retries, and no shadowed `jobId` in GPU polling.
- `scripts/gpu_worker.py`: prose-only extraction now fails fast instead of falling back to `nvidia-smi`.
- `lib/model-cache.ts`: HuggingFace snapshot path is persisted as the loadable cache path and DB rows transition through `DOWNLOADING`/`COMPLETED`/`FAILED`.
- `lib/variant-engine.ts`: fixed keyword splitting so model/search terms are separated by whitespace instead of using the entire prompt as one token.

Validation performed:
- `python3 -m py_compile scripts/gpu_worker.py`
- `npm run build -- --no-lint`

Known pre-existing issues:
- `npx tsc --noEmit` still reports existing schema/type mismatches unrelated to this session.
- `npm install` reports dependency vulnerabilities from existing package versions, including Next.js 14.2.3.
- VAST account currently reports zero balance, so no instance should be rented until funded.
