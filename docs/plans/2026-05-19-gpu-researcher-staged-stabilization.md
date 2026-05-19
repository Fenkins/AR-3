# GPU Researcher Staged Stabilization Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn the GPU researcher from a fragile prose/fallback-driven loop into a staged, measurable, self-correcting research pipeline that cycles quickly and only advances on real executable evidence.

**Architecture:** Stabilize the pipeline in layers: observability first, then control-flow correctness, then multi-call Implementation/Testing/Verification code synthesis, then final strict GPU command generation, then evidence quality, then stage-specific handoff/fallback behavior, then cycle-speed optimization. Each stage must leave the system more measurable and safer than before.

**Tech Stack:** Next.js/TypeScript research engine, SQLite/Prisma runtime DB, Python GPU worker, CUDA/PyTorch/HuggingFace model cache, shell-based deployment on Vast.ai.

---

## Architectural correction: restored logical stage separation

The overnight run revealed drift: GPU execution had been routed through Investigation, Proposition, and Planning. That violated the original stage design. The corrected invariant is:

- **Investigation:** non-GPU reasoning/research stage. Drafts initial research directions, investigates prior art/approaches, and defines what would need evidence.
- **Proposition:** non-GPU reasoning stage. Uses Investigation variants, feedback, and grades to formulate novel falsifiable propositions.
- **Planning:** non-GPU planning stage. Uses Proposition variants, feedback, and grades to create detailed implementation instructions, dependencies, smoke tests, and evidence requirements for Implementation.
- **Implementation:** GPU execution stage. Produces actual working code/artifacts from the plan.
- **Testing:** GPU execution stage. Benchmarks/tests the implementation and emits quantitative PASS/FAIL evidence.
- **Verification:** GPU execution stage. Independently reproduces/challenges the Testing verdict using artifacts and evidence paths.
- **Evaluation:** non-GPU synthesis stage. Aggregates prior stages, feeds lessons into the next Investigation cycle, and only increments breakthrough state when highly confident.

Implementation note: `shouldRouteStageThroughGpu` must deny GPU to Investigation/Proposition/Planning even if stale/default stage config says `gpuEnabled: true`. Only Implementation, Testing, and Verification may be space-GPU-routed.


## Multi-call code synthesis policy for executable stages

Restoring stage separation does **not** mean executable stages must be one-shot. The correct behavior is:

- Investigation / Proposition / Planning may spend normal LLM calls on reasoning, literature/context synthesis, proposition design, pseudocode, dependency choices, interfaces, and evidence requirements. They do not submit GPU jobs.
- Implementation / Testing / Verification may spend multiple LLM calls before GPU execution to improve code quality:
  1. understand prior-stage handoff and evidence requirements;
  2. draft pseudocode / architecture / tensor-shape plan;
  3. produce executable Python in chunks or modules if needed;
  4. run static contract checks locally before submission;
  5. only submit the final strict `run_python` command to the GPU worker.
- Intermediate calls may contain prose or pseudocode. The strict no-prose `run_python` rule applies only to the final GPU submission payload.
- If final executable code fails, Testing/Verification should decide whether to retry within the same cycle, regress to Planning/Implementation with concrete feedback, or allow Evaluation to aggregate the failure.

This preserves logical reasoning while still making GPU execution evidence-based where it belongs.


## Stage 0: Baseline snapshot and dashboardable metrics

**Objective:** Make every overnight run answerable with hard numbers: stages reached, jobs submitted, contract failures, regressions, fallback rate, evidence-gate failures, and time per stage.

**Files:**
- Create: `scripts/report_research_run.py`
- Create: `scripts/test_research_run_report.py`
- Modify as needed: `package.json`

**Tasks:**
1. Add a read-only report script that accepts `--space-id` or defaults to latest space.
2. Report counts by stage/status for variants, steps, and GPU jobs.
3. Parse `/tmp/ar1_debug.log` for blocker markers: strict JSON failures, prose/pseudocode, prep-only evidence, regression, reconciliation, model download, variant timeout.
4. Add tests using a temporary SQLite DB/log fixture.
5. Add an npm script or documented command.
6. Verify on current space: `python3 scripts/report_research_run.py --space-id cmpbocvx7000bu1exvzprwm96`.
7. Commit: `tools: add GPU research run report`.

**Acceptance criteria:** A single command produces a reliable overnight-run summary without manual SQL/log spelunking.

---

## Stage 1: Runner correctness and stale-state recovery

**Objective:** Ensure no completed GPU job, failed GPU job, or stale RUNNING step can wedge the background loop or mislead the UI.

**Files:**
- Modify: `lib/research-engine.ts`
- Modify: `scripts/test_gpu_resume_reconcile.js`
- Modify/Create: `scripts/test_background_loop_watchdog.js`

**Tasks:**
1. Add tests for RUNNING step plus terminal GPU job reconciliation.
2. Add tests for failed GPU diagnostics being persisted as failed step results.
3. Add tests that retries clear stale diagnostics/result text.
4. Add tests that background loop resumes a latest pending/regressed variant exactly once.
5. Patch `research-engine.ts` only where tests expose a gap.
6. Run: `node scripts/test_gpu_resume_reconcile.js && node scripts/test_background_loop_watchdog.js`.
7. Commit: `fix: stabilize GPU research runner recovery`.

**Acceptance criteria:** Restart/resume never loses a terminal GPU job and never treats stale diagnostics as fresh success.

---

## Stage 2: Strict command generation without wasted retries

**Objective:** Stop burning minutes on repeated MiniMax failures when the failure is deterministic contract noncompliance.

**Files:**
- Modify: `lib/gpu-command-contract.ts`
- Modify: `lib/research-engine.ts`
- Modify: `scripts/test_strict_gpu_contract.js`
- Modify: `scripts/test_agent_gpu_prompts.js`

**Tasks:**
1. Classify contract failures as deterministic vs possibly repairable.
2. Deterministic examples: prose-only, missing JSON object, wrong `action`, placeholder/pseudocode, markdown-only, unmanaged `/tmp` paths.
3. Add tests proving deterministic failures skip extra LLM retries when a validated fallback/preparation route exists.
4. Keep one retry only for repairable malformed-but-close JSON if useful.
5. Ensure all GPU-routed agent prompts still require only `{"action":"run_python","dependencies":[],"code":"..."}`.
6. Run strict prompt/contract tests.
7. Commit: `fix: skip deterministic GPU contract retry loops`.

**Acceptance criteria:** Repeated `JSON action must be "run_python"` loops collapse quickly into deterministic fallback or hard failure.

---

## Stage 3: Evidence gate quality and warning hygiene

**Objective:** Reject fake/prep-only results while not misclassifying benign warnings as core failure reasons.

**Files:**
- Modify: `lib/gpu-command-contract.ts`
- Modify: `scripts/test_gpu_evidence_gate.py`
- Modify/Create: JS tests that exercise completion-gate classification.

**Tasks:**
1. Add fixtures for prep-only evidence, runtime metric evidence, PASS/FAIL evidence, OOM/hardware-limit evidence, and benign warnings.
2. Ensure prep-only evidence fails.
3. Ensure real runtime metrics pass only when tied to the step objective.
4. Strip/deprioritize benign warnings such as `TRANSFORMERS_CACHE` deprecation when extracting failure reason.
5. Improve failure reason extraction to surface the actual Python exception when present.
6. Run: `python3 scripts/test_gpu_evidence_gate.py && node scripts/test_strict_gpu_contract.js`.
7. Commit: `fix: improve GPU evidence classification`.

**Acceptance criteria:** The gate rejects hollow setup checks, accepts real step-specific runtime evidence, and reports useful root causes.

---

## Stage 4: Stage-specific handoffs and experiment fallbacks

**Objective:** Restore non-GPU handoffs for Investigation/Proposition/Planning and keep deterministic executable fallbacks only for Implementation/Testing/Verification.

**Files:**
- Modify: `lib/gpu-command-contract.ts`
- Possibly create: `lib/gpu-fallback-templates.ts`
- Modify: `scripts/test_strict_gpu_contract.js`

**Tasks:**
1. Extract deterministic fallback generation into named templates.
2. Investigation fallback: environment/model/runtime probes plus small objective-linked experiment.
3. Proposition fallback: compare at least two hypotheses/variants using measurable proxy metrics.
4. Planning fallback: generate preparation manifest plus executable smoke tests and grading criteria.
5. Implementation fallback: execute concrete implementation attempt with artifacts/metrics.
6. Testing fallback: include explicit `VERDICT: PASS` or `VERDICT: FAIL`, baseline/control comparison, and artifact paths.
7. Verification fallback: independently reproduce or falsify previous claim using prior artifacts/metrics.
8. Add tests that each stage fallback is structurally different and includes required evidence markers.
9. Run strict/evidence tests.
10. Commit: `fix: add stage-specific GPU fallback experiments`.

**Acceptance criteria:** Fallback no longer produces the same hollow script for all stages.

---

## Stage 5: Faster cycle policy

**Objective:** Make 1 variant x 5 steps complete useful cycles overnight instead of stalling on heavyweight setup.

**Files:**
- Modify: `lib/research-engine.ts`
- Modify/Create: tests around `ensureModelsDownloaded` behavior.

**Tasks:**
1. Detect whether a step actually requires full model weights before blocking on full download.
2. Allow cheap Investigation probes before full model predownload when safe.
3. Reuse existing per-model/global cache paths instead of duplicating per-space cache when possible.
4. Add configurable max LLM attempt budget per step/stage.
5. Add per-stage time budget telemetry to the report script.
6. Run relevant tests and one smoke cycle.
7. Commit: `perf: reduce GPU research cycle startup latency`.

**Acceptance criteria:** Small 1x5 spaces start executing GPU jobs quickly and do not block the whole cycle on model downloads unless needed.

---

## Stage 6: Overnight-run validation protocol

**Objective:** Validate the stabilized system with repeatable overnight criteria.

**Files:**
- Modify: `docs/plans/2026-05-19-gpu-researcher-staged-stabilization.md`
- Possibly create: `docs/runbooks/gpu-researcher-overnight-validation.md`

**Tasks:**
1. Start a fresh 1 variant x 5 step space.
2. Confirm web UI, GPU worker, model cache, and strict gates.
3. Run overnight under heartbeat monitoring.
4. Next morning run `scripts/report_research_run.py`.
5. Pass criteria:
   - reaches at least Testing or Verification;
   - submits real GPU jobs in each reached GPU stage;
   - no prose-only completed GPU steps;
   - fallback rate reported and trending downward;
   - prep-only evidence does not advance steps;
   - at least one stage-specific metric/artifact is produced.
6. Commit any final runbook/report updates.

**Acceptance criteria:** We can tell whether the run evolved, where it failed, and what the next bottleneck is from one report.
