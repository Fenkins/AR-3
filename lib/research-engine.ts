Total output lines: 4082

import { prisma } from './prisma'
import { callAI, AIConfig, AIMessage } from './ai'
import { generateVariants, gradeVariant, selectBestVariant, saveVariantsToDatabase, updateVariantStepDb, updateVariantDb, selectBestVariantFromDb, loadVariantsFromDb, reEvaluateStepCount, Variant, Step } from './variant-engine'
import { buildEmbeddingContext } from './embeddings'
import { addToCache } from './model-cache'
import { assessGpuExecutionEvidence, assessGpuStepCompletion, buildAutonomousPreparationCommand, buildDeterministicGpuExperimentCommand, extractPersistablePreparationManifest, extractStrictGpuCommand, selectGpuSubmissionCommand, shouldRouteStageThroughGpu, shouldShortCircuitPreparationFallback, shouldUseAutonomousPreparationFallback } from './gpu-command-contract'
import { buildPreparationManifestInstructions, buildPreparationRetryMessage, extractPreparationManifestCandidate, validatePreparationManifest } from './preparation-manifest'
import fs from 'fs'
import { getInternalGpuApiBase } from './internal-api-base'
import { removeSpaceWorkbenchDirs } from './space-cleanup'
import { buildFallbackThinkingSetupResponse } from './thinking-setup'
import { assessDeadLoop } from './dead-loop-detector'

const logFile = '/tmp/ar1_debug.log'
function debugLog(...args: any[]) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n')
  console.log('[ResearchEngine]', ...args)
}

export interface ResearchStage {
  id: string
  name: string
  description: string
  prompt: string
  order: number
  isActive: boolean
  gpuEnabled?: boolean  // if true, route to GPU worker instead of LLM API
  gpuPrompt?: string  // GPU-optimized prompt variant (used when space.useGpu === true)
  status?: 'pending' | 'running' | 'completed' | 'failed'
  numVariants?: number | 'auto'
  stepsPerVariant?: number | 'auto'
}

/** Wrap an async operation with a hard timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ])
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function gpuJobPollTimeoutMsFromConfig(config: { jobTimeout?: unknown } | null | undefined, fallbackMs = 300000): number {
  const configuredSeconds = Number(config?.jobTimeout)
  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) return fallbackMs
  return Math.max(fallbackMs, Math.floor(configuredSeconds * 1000))
}

function readGpuJobPollTimeoutMs(): number {
  try {
    const gpuConfig = JSON.parse(fs.readFileSync('/tmp/gpu_config.json', 'utf8'))
    return gpuJobPollTimeoutMsFromConfig(gpuConfig)
  } catch {
    return gpuJobPollTimeoutMsFromConfig(null)
  }
}

export function formatCompletedGpuJobStepResult(job: { jobId: string; prompt?: string | null; resultJson?: string | null }): string | null {
  if (!job.resultJson) return null
  let result: any
  try {
    result = JSON.parse(job.resultJson)
  } catch {
    return null
  }
  if (!result || typeof result !== 'object') return null
  const code = typeof result.code === 'string' ? result.code : ''
  const codeBlock = code ? `\n[CODE]\n${code}\n[/CODE]` : ''
  const prompt = typeof job.prompt === 'string' ? job.prompt : ''
  const gpuResult = result.success
    ? `[GPU Execution Result] job:${result.jobId || job.jobId}${codeBlock}\n${result.output || ''}`
    : `[GPU Execution Error] job:${result.jobId || job.jobId}: ${result.error || 'GPU job failed'}${codeBlock}`
  return prompt ? `${prompt}\n\n${gpuResult}` : gpuResult
}

export function gpuJobMatchesRunningStep(
  step: { description?: string | null; name?: string | null; updatedAt?: Date | string | null },
  job: { prompt?: string | null; submittedAt?: Date | string | null },
  options: { allowTimingFallback?: boolean } = {},
): boolean {
  const submittedAt = job.submittedAt ? new Date(job.submittedAt).getTime() : NaN
  const stepUpdatedAt = step.updatedAt ? new Date(step.updatedAt).getTime() : NaN
  if (Number.isFinite(submittedAt) && Number.isFinite(stepUpdatedAt) && submittedAt + 60000 < stepUpdatedAt) return false
  const prompt = String(job.prompt || '')
  const description = String(step.description || '').trim()
  const name = String(step.name || '').trim()
  if (description && prompt.includes(description)) return true
  if (name && prompt.includes(name)) return true

  // Implementation GPU prompts can be strict JSON/code with the original step text
  // omitted. When the caller has already established that there is only one running
  // step in the stage, a close submit timestamp is enough to reconcile the job.
  if (options.allowTimingFallback && Number.isFinite(submittedAt) && Number.isFinite(stepUpdatedAt)) {
    const submittedAfterStepStarted = submittedAt + 60000 >= stepUpdatedAt
    const closeToStepStart = submittedAt - stepUpdatedAt <= 10 * 60 * 1000
    const strictGpuPrompt = /"action"\s*:\s*"run_python"/.test(prompt) && /"code"\s*:/.test(prompt)
    return submittedAfterStepStarted && closeToStepStart && strictGpuPrompt
  }

  return false
}

export function runningStepIsStaleWithoutGpuJob(
  step: { status?: string | null; updatedAt?: Date | string | null; description?: string | null; name?: string | null },
  jobs: Array<{ prompt?: string | null; submittedAt?: Date | string | null; status?: string | null }>,
  nowMs = Date.now(),
  staleMs = 10 * 60 * 1000,
  matchOptions: { allowTimingFallback?: boolean } = {},
): boolean {
  if (step.status !== 'RUNNING') return false
  const stepUpdatedAt = step.updatedAt ? new Date(step.updatedAt).getTime() : NaN
  if (!Number.isFinite(stepUpdatedAt) || nowMs - stepUpdatedAt < staleMs) return false
  return !jobs.some(job => gpuJobMatchesRunningStep(step, job, matchOptions))
}

export function runningVariantIsStaleWithoutActiveStep(
  variant: { status?: string | null; updatedAt?: Date | string | null },
  steps: Array<{ status?: string | null; updatedAt?: Date | string | null }>,
  activeJobs: Array<{ status?: string | null }>,
  nowMs = Date.now(),
  staleMs = 10 * 60 * 1000,
): boolean {
  if (variant.status !== 'RUNNING') return false
  if (activeJobs.length > 0) return false
  if (steps.some(step => step.status === 'RUNNING')) return false
  if (!steps.some(step => step.status === 'PENDING')) return false
  const newestStepUpdate = steps.reduce((latest, step) => {
    const updatedAt = step.updatedAt ? new Date(step.updatedAt).getTime() : NaN
    return Number.isFinite(updatedAt) ? Math.max(latest, updatedAt) : latest
  }, NaN)
  const variantUpdatedAt = variant.updatedAt ? new Date(variant.updatedAt).getTime() : NaN
  const updatedAt = Number.isFinite(newestStepUpdate) ? newestStepUpdate : variantUpdatedAt
  if (!Number.isFinite(updatedAt)) return false
  return nowMs - updatedAt >= staleMs
}

async function reconcileCompletedGpuJobsForRunningSteps(spaceId: string): Promise<number> {
  const gpuJobDelegate = (prisma as any).gpuJob
  if (!gpuJobDelegate) return 0

  const runningVariants = await prisma.variant.findMany({
    where: { spaceId, status: 'RUNNING' },
    include: { VariantStep: { orderBy: { order: 'asc' } } },
  })
  let reconciled = 0

  for (const variant of runningVariants) {
    const runningSteps = variant.VariantStep.filter(step => step.status === 'RUNNING')
    for (const step of runningSteps) {
      const jobs = await gpuJobDelegate.findMany({
        where: {
          spaceId,
          stageName: variant.stageName,
          status: { in: ['completed', 'failed_runtime', 'failed_validation'] },
          resultJson: { not: null },
        },
        orderBy: { submittedAt: 'desc' },
        take: 25,
      })
      const job = jobs.find((candidate: any) => gpuJobMatchesRunningStep(step, candidate, { allowTimingFallback: runningSteps.length === 1 }))
      if (!job) continue

      const resultText = formatCompletedGpuJobStepResult(job)
      if (!resultText) continue

      const completion = assessGpuStepCompletion(resultText, { stepName: step.name, stepDescription: step.description })
      if (completion.valid) {
        await prisma.variantStep.update({
          where: { id: step.id },
          data: { status: 'COMPLETED', result: resultText, grade: 100 },
        })
        debugLog(`[reconcileCompletedGpuJobsForRunningSteps] Reconciled terminal GPU job ${job.jobId} into completed step ${step.id}`)
      } else {
        await prisma.variantStep.update({
          where: { id: step.id },
          data: {
            status: 'FAILED',
            result: `[GPU COMPLETION INVALID]: ${completion.reason}\n\nOriginal output:\n${resultText}`,
            grade: 0,
          },
        })
        await prisma.variant.update({
          where: { id: variant.id },
          data: {
            status: 'FAILED',
            failureMode: 'GPU_COMPLETION_INVALID',
            lastFailureReason: completion.reason,
            feedback: `Step failure: ${completion.reason}`,
          },
        })
        debugLog(`[reconcileCompletedGpuJobsForRunningSteps] Reconciled failed GPU job ${job.jobId} into step ${step.id}: ${completion.reason}`)
      }
      reconciled++
    }

    const refreshedSteps = await prisma.variantStep.findMany({ where: { variantId: variant.id } })
    if (refreshedSteps.some(step => step.status === 'FAILED')) continue
    if (refreshedSteps.some(step => step.status === 'PENDING')) {
      await prisma.variant.update({ where: { id: variant.id }, data: { status: 'PENDING' } })
    } else if (refreshedSteps.length > 0 && refreshedSteps.every(step => step.status === 'COMPLETED')) {
      await prisma.variant.update({ where: { id: variant.id }, data: { status: 'PENDING' } })
    }
  }

  return reconciled
}

async function recoverStaleRunningStepsWithoutGpuJobs(spaceId: string): Promise<number> {
  const gpuJobDelegate = (prisma as any).gpuJob
  if (!gpuJobDelegate) return 0

  const runningVariants = await prisma.variant.findMany({
    where: { spaceId, status: 'RUNNING' },
    include: { VariantStep: { orderBy: { order: 'asc' } } },
  })
  let recovered = 0

  for (const variant of runningVariants) {
    const runningSteps = variant.VariantStep.filter(step => step.status === 'RUNNING')
    if (runningSteps.length === 0) continue

    const jobs = await gpuJobDelegate.findMany({
      where: {
        spaceId,
        stageName: variant.stageName,
        status: { in: ['queued', 'preparing_workbench', 'installing_dependencies', 'running_experiment', 'validating_evidence'] },
      },
      orderBy: { submittedAt: 'desc' },
      take: 25,
    })

    for (const step of runningSteps) {
      if (!runningStepIsStaleWithoutGpuJob(step, jobs, undefined, undefined, { allowTimingFallback: runningSteps.length === 1 })) continue
      await prisma.variantStep.update({
        where: { id: step.id },
        data: { status: 'PENDING' },
      })
      await prisma.variant.update({
        where: { id: variant.id },
        data: {
          status: 'PENDING',
          lastFailureReason: 'Recovered stale RUNNING step with no active GPU job after process/provider interruption; retrying.',
        },
      })
      recovered++
      debugLog('[recoverStaleRunningStepsWithoutGpuJobs] Reset stale RUNNING step ' + step.id + ' on variant ' + variant.id + ' to PENDING')
    }
  }

  return recovered
}

async function recoverStaleRunningVariantsWithoutActiveSteps(spaceId: string): Promise<number> {
  const gpuJobDelegate = (prisma as any).gpuJob
  if (!gpuJobDelegate) return 0

  const runningVariants = await prisma.variant.findMany({
    where: { spaceId, status: 'RUNNING' },
    include: { VariantStep: { orderBy: { order: 'asc' } } },
  })
  let recovered = 0

  for (const variant of runningVariants) {
    const activeJobs = await gpuJobDelegate.findMany({
      where: {
        spaceId,
        stageName: variant.stageName,
        status: { in: ['queued', 'preparing_workbench', 'installing_dependencies', 'running_experiment', 'validating_evidence'] },
      },
      orderBy: { submittedAt: 'desc' },
      take: 25,
    })

    if (!runningVariantIsStaleWithoutActiveStep(variant, variant.VariantStep, activeJobs)) continue
    await prisma.variant.update({
      where: { id: variant.id },
      data: {
        status: 'PENDING',
        lastFailureReason: 'Recovered stale RUNNING variant with pending steps and no active GPU job after process/provider interruption; retrying.',
      },
    })
    recovered++
    debugLog('[recoverStaleRunningVariantsWithoutActiveSteps] Reset stale RUNNING variant ' + variant.id + ' to PENDING')
  }

  return recovered
}


const STRICT_GPU_CODE_CONTRACT = `

GPU OUTPUT CONTRACT (MANDATORY)
Return ONLY a single JSON object, no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["package-or-pip-spec"],"code":"<complete executable Python>"}

The code must be self-contained for this step, must import its dependencies, must execute a GPU/CUDA probe or GPU runtime path (for example torch.cuda.is_available(), tensor allocation on cuda when available, nvidia-smi/NVML inspection, or an explicit GPU fallback explanation in printed JSON), must print measurable outputs, and must not contain placeholders or pseudocode. If a model is needed, use the loadable paths from Model Cache context when present; otherwise write a short smoke-test that discovers/validates the missing requirement and fails clearly.
`

function buildStrictGpuRetryMessage(stepDescription: string, reason: string, previous: string): AIMessage {
  return {
    role: 'user',
    content: `Your previous response was rejected before GPU execution. Reason: ${reason}\n\nStep: ${stepDescription}\n\nReturn ONLY valid JSON matching this exact schema, with complete executable Python and measurable print outputs:\n{"action":"run_python","dependencies":[],"code":"..."}\n\nRejected response preview:\n${previous.substring(0, 1800)}`,
  }
}

export interface SpaceExecutionState {
  spaceId: string
  isRunning: boolean
  isThinkingSetupRunning?: boolean  // guards against duplicate setup calls
  currentStageId: string
  currentPhase: string
  variants: Variant[]
  selectedVariantId?: string
  experiments: any[]
  lastUpdated: Date
  // Error tracking for timeout/failure visibility
  lastError?: string
  lastErrorTime?: Date
  lastErrorType?: 'TIMEOUT' | 'RATE_LIMIT' | 'API_ERROR' | 'OTHER'
  retryCount: number
  retryCountByStage: Record<string, number>  // track retries per stage
  currentCycle: number  // track which cycle number we're on (increments when we wrap from Evaluation back to Investigation
}

export const DEFAULT_STAGES: Omit<ResearchStage, 'id'>[] = [
  {
    name: 'Investigation',
    description: 'Explore LLaDA model behavior through actual code execution',
    prompt: `You are exploring how LLaDA diffusion language models actually behave by running real code.

Your task: For each step, you MUST produce ACTUAL RUNNABLE code that loads and executes on the LLaDA model. This is not analysis or description — this is hands-on exploration.

For each step you must:
1. Write real Python/PyTorch code (not pseudocode, not description)
2. The code must actually load a diffusion model and run inference
3. Execute the code and observe the real output
4. Based on the output, design the next experiment

Code requirements for EACH step:
- Must include: import statements, model loading, tokenization, diffusion sampling loop
- Must print: actual tensor shapes, actual latent values, actual model outputs
- Must not: describe what code should do without running it

Output format for EACH step:
## Step N: [Exploration name]
### Code:
\`\`\`python
[actual runnable code]
\`\`\`
### Observed Output:
[what the code actually produced]
### Analysis:
[what this tells us about the model]

IMPORTANT: Every step must produce REAL code that runs. If your code fails, that IS a valid result — document WHY it failed and what that reveals about the model.

Your goal is to discover how LLaDA's latent space works through direct experimentation, not through literature review or description.`,
    order: 0,
    isActive: true,
    gpuEnabled: true,
  },
  {
    name: 'Proposition',
    description: 'Formulate proposition based on investigation findings',
    prompt: `Based on the investigation findings, formulate a clear proposition.

Your tasks:
1. Synthesize investigation insights
2. Identify key variants and approaches
3. Propose novel ideas and solutions
4. Consider feedback and grades from investigation
5. Draft a clear proposition with rationale

Be creative but grounded in the investigation results.`,
    order: 1,
    isActive: true,
    gpuEnabled: false,
  },
  {
    name: 'Planning',
    description: 'Create detailed implementation plan with runnable code components',
    prompt: `Create a detailed implementation plan that INCLUDES RUNNABLE CODE for the GPU stage.

Your tasks:
1. Break down the proposition into concrete steps -- each step should be specific and technical
2. Define EXACT tensor shapes, dimensions, and data types for every operation
3. Design the core algorithm in precise mathematical terms (not vague descriptions)
4. Specify what the GPU code will compute and what outputs it will print
5. Anticipate failure modes -- what could go wrong with each step?
6. For each major component, write a BRIEF SKETCH of the PyTorch code (pseudocode is fine)

Your output should be a structured PLAN with code sketches, not prose.
Format:
  ## Step 1: [Name]
  - What: [specific description]
  - Tensor shapes: [e.g. (B, 512, 512)]
  - Code sketch: [2-5 lines of pseudocode or actual torch operations]
  - Failure points: [what could break]

IMPORTANT: The downloads field below is REQUIRED. If no external models are needed, explicitly write "downloads: none". Otherwise include HuggingFace model IDs and/or download URLs.

Be specific about dimensions and operations. Vague plans produce broken code.`,
    order: 2,
    isActive: true,
    gpuEnabled: false,
  },
  {
    name: 'Implementation',
    description: 'Execute the implementation based on plan -- produce REAL working GPU code',
    prompt: `Implement the solution based on the planning stage output.

Your tasks:
1. Execute the implementation plan from Planning stage
2. Write REAL code that actually runs on the GPU -- not pseudocode, not sketches
3. Address technical challenges as they arise
4. Incorporate all previous stage feedback
5. Produce a VIABLE, WORKING implementation that produces measurable outputs

IMPORTANT:
- You will receive the planning stage output in the context -- use it as your blueprint
- If the research goal requires models (e.g., diffusion LMs, embeddings), use /api/model-cache to download them from HuggingFace first
- Download format: POST /api/model-cache with {spaceId, fileName, downloadUrl}
- HuggingFace download URLs: https://huggingface.co/{model_id}
- After download/resolution, models are exposed through AR3_MODEL_CACHE_DIR and AR3_MODEL_LOCAL_DIR. Do not hardcode /tmp model paths.
- Load models with bitsandbytes 8-bit for VRAM efficiency:

  from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
  import os
  import torch

  # Use BitsAndBytesConfig for transformers 5.x compatibility
  bnb_config = BitsAndBytesConfig(load_in_8bit=True)
  model = AutoModelForCausalLM.from_pretrained(
      os.environ.get('AR3_MODEL_LOCAL_DIR') or os.environ.get('AR3_MODEL_CACHE_DIR') or 'model_id',
      quantization_config=bnb_config,
      device_map='cuda',
      dtype=torch.bfloat16,
      trust_remote_code=True,  # Required for custom model architectures
  )
  tokenizer = AutoTokenizer.from_pretrained(os.environ.get('AR3_MODEL_LOCAL_DIR') or os.environ.get('AR3_MODEL_CACHE_DIR') or 'model_id')

  # Inference …33724 tokens truncated…     } catch {}
          // Remove from pending variants list so pipeline moves on
          const remaining = state.variants.filter(v => v.id !== vid)
          updateExecutionState(spaceId, { variants: remaining })
        }

        debugLog(`[executeVariantCycle] ${failedVariants.length} variant(s) marked FAILED due to download failure — continuing pipeline`)
        // Return a minimal failed result so executeResearchCycle can continue
        return {
          ...variant,
          status: 'FAILED' as const,
          feedback: errorMsg,
        }
      }

      debugLog(`[executeVariantCycle] All model downloads confirmed for stage ${stage.name}`)
    } else {
      // Non-GPU stage: use original non-blocking download (failures non-fatal)
      await processVariantCacheDownloads(variant, spaceId)
    }
  } catch (err: any) {
    debugLog(`[executeVariantCycle] Download processing failed for ${variant.name}: ${err.message}`)
    const failedVariant = { ...variant, status: 'FAILED' as const, feedback: `Download failed: ${err.message}` }
    const updatedVariants = state.variants.map(v => v.id === variantId ? failedVariant : v)
    updateExecutionState(spaceId, { variants: updatedVariants })
    try {
      await prisma.variant.update({ where: { id: variantId }, data: { status: 'FAILED', feedback: `Download failed: ${err.message}` } })
    } catch {}
    return failedVariant
  }

  // Execute the variant
  const runningVariant = { ...variant, status: 'RUNNING' as const }
  updateExecutionState(spaceId, {
    variants: state.variants.map(v => v.id === variantId ? runningVariant : v),
  })
  const executedVariant = await executeVariant(variant, spaceId, stage.name, stage.gpuEnabled ?? false)

  // Update state
  const updatedVariants = state.variants.map(v =>
    v.id === variantId ? executedVariant : v
  )
  updateExecutionState(spaceId, { variants: updatedVariants })

  // ─── Failure Regression ──────────────────────────────────────────────────────────────
  // If the variant failed (step crash, model load error, etc.), regress to an earlier stage
  // This allows the pipeline to self-correct without incrementing the cycle counter
  if (executedVariant.status === 'FAILED') {
    const failedSteps = executedVariant.steps.filter((s: any) => s.status === 'FAILED')
    const { failureType, reason } = classifyStepFailure(failedSteps)
    const currentStageOrder = stage.order
    const { targetStageOrder, targetStageName } = getRegressionTargetStage(failureType, currentStageOrder)

    // Don't regress if already at Investigation (order 0) or if the target is the same stage
    if (targetStageName !== stage.name) {
      debugLog(`[executeVariantCycle] Variant "${executedVariant.name}" FAILED (${failureType}): ${reason}`)
      debugLog(`[executeVariantCycle] Regressing to ${targetStageName} (from ${stage.name})`)

      // Get stages to find the target stage ID
      const stages = parseStages(space)
      const targetStage = stages.find(s => s.name === targetStageName)
      if (targetStage) {
        const regressionResult = await regressVariantToStage(
          spaceId, variantId, targetStageName, targetStage.id,
          failureType, reason
        )
        if (regressionResult.success) {
          debugLog(`[executeVariantCycle] Regression successful: ${executedVariant.name} → ${targetStageName} (retry ${regressionResult.retryCount})`)
          // Return the updated variant (now PENDING in the new stage)
          const regressedVariant = state.variants.find(v => v.id === variantId)
          return regressedVariant || executedVariant
        }
      }
    } else {
      debugLog(`[executeVariantCycle] Variant "${executedVariant.name}" FAILED but already at ${stage.name}, not regressing`)
    }
  }

  // If this variant is the best, propagate its learnings
  if (executedVariant.status === 'COMPLETED') {
    try {
      const best = await selectBestVariant(updatedVariants)
      if (best.id === variantId) {
        // This is the best variant, save its context
        updateExecutionState(spaceId, { selectedVariantId: variantId })
      }
    } catch {}
  }

  // Auto-steps: if grading agent is in auto mode, re-evaluate step count for remaining pending variants
  if (space.stepsPerVariantMode === 'auto') {
    try {
      const stageVariants = updatedVariants.filter(v => v.stageId === variant.stageId)
      const pendingCount = stageVariants.filter(v => v.status === 'PENDING').length
      if (pendingCount > 0) {
        debugLog(`[executeVariantCycle] Auto-steps: ${pendingCount} pending variants in ${stage.name}, evaluating step count`)
        const reEvaluated = await reEvaluateStepCount(spaceId, variant.stageId, executedVariant)
        if (reEvaluated && reEvaluated !== space.defaultStepsPerVariant) {
          debugLog(`[executeVariantCycle] Auto-steps: adjusting remaining variants from ${space.defaultStepsPerVariant} to ${reEvaluated} steps`)
          // Update defaultStepsPerVariant for future variant generation in this stage
          await prisma.space.update({
            where: { id: spaceId },
            data: { defaultStepsPerVariant: reEvaluated },
          })
          // Trim excess steps from pending variants
          for (const v of stageVariants) {
            if (v.status === 'PENDING' && v.steps.length > reEvaluated) {
              const trimmed = v.steps.slice(0, reEvaluated)
              v.steps = trimmed
              // Persist trimmed steps to DB
              for (const step of trimmed) {
                await updateVariantStepDb(step.id, { status: 'PENDING' })
              }
              debugLog(`[executeVariantCycle] Trimmed variant ${v.name} to ${reEvaluated} steps`)
            }
          }
          updateExecutionState(spaceId, { variants: updatedVariants })
        }
      }
    } catch (err: any) {
      debugLog(`[executeVariantCycle] Auto-steps evaluation failed: ${err.message}`)
    }
  }

  return executedVariant
}

export async function runThinkingSetup(spaceId: string) {
  debugLog('[runThinkingSetup] Starting for spaceId:', spaceId)

  // Guard: skip if a thinking setup is already running for this space
  const existingState = getExecutionState(spaceId)
  if (existingState?.isThinkingSetupRunning) {
    debugLog('[runThinkingSetup] Already running, skipping duplicate call')
    return { skipped: true, reason: 'thinking_setup already in progress' }
  }

  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    include: {
      User: {
        include: {
          Agent: { where: { isActive: true } },
          ServiceProvider: true,
        },
      },
    },
  })

  if (!space) throw new Error('Space not found')

  const thinkingAgent = space.User.Agent
    .filter(a => a.role === 'THINKING')
    .sort((a, b) => a.order - b.order)[0]

  if (!thinkingAgent) {
    throw new Error('No THINKING agent configured. Please create a Thinking Agent first.')
  }

  const serviceProvider = space.User.ServiceProvider.find(sp => sp.id === thinkingAgent.serviceProviderId)
  if (!serviceProvider) {
    throw new Error('Service provider not found for thinking agent')
  }

  const agentConfig: AIConfig = {
    provider: serviceProvider.provider,
    apiKey: serviceProvider.apiKey,
    model: thinkingAgent.model,
  }

  // Analyze research goal
  const setupPrompt = `Analyze this research goal and provide setup recommendations:

Research Goal: ${space.initialPrompt}

Respond with:
1. Recommended stages to use (choose from: Investigation, Proposition, Planning, Implementation, Testing, Verification, Evaluation)
2. Any special considerations or focus areas
3. Estimated complexity (simple/moderate/complex)

Keep your response concise (3-5 sentences).`

  let response
  try {
    response = await callAI(agentConfig, [
      { role: 'system', content: 'You are a research planning assistant. Be concise and practical.' },
      { role: 'user', content: setupPrompt },
    ])
    debugLog('[runThinkingSetup] AI response received')
  } catch (error: any) {
    debugLog('[runThinkingSetup] AI call failed:', error.message)
    throw error
  }

  // Parse recommended stages or use defaults
  let recommendedStages = DEFAULT_STAGES.map((s, i) => ({
    ...s,
    id: `stage_${i}`,
  }))

  // IMPORTANT: Always use ALL 7 DEFAULT_STAGES regardless of AI suggestions.
  // The AI sometimes suggests fewer stages, which causes incomplete pipelines.
  // We use DEFAULT_STAGES as the source of truth.
  recommendedStages = DEFAULT_STAGES.map((s, i) => ({
    ...s,
    id: `stage_${i}`,
  }))

  // Create thinking setup experiment
  await prisma.experiment.create({
    data: {
      spaceId: space.id,
      phase: 'THINKING_SETUP',
      agentId: thinkingAgent.id,
      agentName: thinkingAgent.name,
      prompt: JSON.stringify({ goal: space.initialPrompt }),
      response: response.content,
      tokensUsed: response.tokensUsed,
      cost: response.cost,
      status: 'COMPLETED',
      updatedAt: new Date(),
      result: response.content,
      metrics: JSON.stringify({
        recommendedStages: recommendedStages.map(s => s.name),
        fullAnalysis: response.content.substring(0, 1000),
      }),
    },
  })

  // Update space with stages
  await prisma.space.update({
    where: { id: spaceId },
    data: {
      status: 'RUNNING',
      currentPhase: 'Investigation',
      description: JSON.stringify({ stages: recommendedStages }),
    },
  })

  // Initialize execution state
  executionStates.set(spaceId, {
    spaceId,
    isRunning: true,
    isThinkingSetupRunning: true,
    currentStageId: recommendedStages[0].id,
    currentPhase: 'Investigation',
    variants: [],
    experiments: [],
    lastUpdated: new Date(),
    retryCount: 0,
    retryCountByStage: {},
    currentCycle: 1,
  })

  // Pre-allocate variants and steps for all recommended stages - IN PARALLEL
  debugLog('[runThinkingSetup] Pre-allocating variants and steps for all stages (parallel)...')
  const variantPromises = recommendedStages.map(stage =>
    (async () => {
      try {
        debugLog(`[runThinkingSetup] Generating variants for ${stage.name} (${stage.id})...`)
        await generateStageVariants(spaceId, stage.id, 'auto', 'auto')
        debugLog(`[runThinkingSetup] Variants for ${stage.name} complete`)
      } catch (err: any) {
        debugLog(`[runThinkingSetup] Failed to generate variants for ${stage.name}: ${err.message}`)
      }
    })()
  )
  await Promise.all(variantPromises)
  debugLog('[runThinkingSetup] All variant pre-allocation attempts finished')

  // Execute first stage immediately - with retry on timeout/failure
  debugLog('[runThinkingSetup] Starting first stage execution')
  let firstResult = null
  let attempts = 0
  const maxAttempts = 10
  const stageId = recommendedStages[0].id
  while (attempts < maxAttempts) {
    try {
      firstResult = await executeResearchCycle(spaceId, recommendedStages[0].id)
      // Success - clear any previous errors for this stage
      updateExecutionState(spaceId, {
        lastError: undefined,
        lastErrorTime: undefined,
        lastErrorType: undefined,
        retryCountByStage: { [stageId]: 0 },
      })
      break
    } catch (err: any) {
      attempts++
      const isTimeout = err.message?.includes('timeout') || err.message?.includes('timed out')
      const errorType: SpaceExecutionState['lastErrorType'] = isTimeout ? 'TIMEOUT' : 'API_ERROR'
      const currentRetryCount = (executionStates.get(spaceId)?.retryCountByStage[stageId]) || 0
      updateExecutionState(spaceId, {
        lastError: err.message,
        lastErrorTime: new Date(),
        lastErrorType: errorType,
        retryCount: (executionStates.get(spaceId)?.retryCount || 0) + 1,
        retryCountByStage: { [stageId]: currentRetryCount + attempts },
      })
      debugLog(`[runThinkingSetup] Stage execution attempt ${attempts}/${maxAttempts} failed: ${err.message}. Retrying...`)
      if (attempts >= maxAttempts) {
        debugLog('[runThinkingSetup] All stage execution attempts failed. Will show error in UI and allow manual retry.')
      }
    }
  }

  // Start background polling loop to keep advancing stages
  startBackgroundLoop(spaceId)

  debugLog('[runThinkingSetup] Done!')

  debugLog('[runThinkingSetup] Done!')

  // Clear thinking setup running flag
  const finalState = getExecutionState(spaceId)
  if (finalState) {
    updateExecutionState(spaceId, { isThinkingSetupRunning: false })
  }

  return {
    setup: {
      analysis: response.content.substring(0, 500),
      recommendedStages: recommendedStages.map(s => s.name),
      stagesCreated: recommendedStages.length,
    },
    tokensUsed: response.tokensUsed,
    cost: response.cost,
    firstStageResult: {
      stageName: recommendedStages[0].name,
      preview: firstResult.response?.substring(0, 200),
    },
  }
}

export async function getSpaceStatus(spaceId: string) {
  const space = await prisma.space.findFirst({
    where: { id: spaceId },
    include: {
      Experiment: { orderBy: { createdAt: 'desc' }, take: 20 },
      Breakthrough: { orderBy: { createdAt: 'desc' } },
    },
  })

  if (!space) throw new Error('Space not found')

  const state = getExecutionState(spaceId)
  const stages = parseStages(space)

  return {
    space,
    execution: state,
    stages,
    recentExperiments: space.Experiment.slice(0, 10),
    Breakthrough: space.Breakthrough,
    isRunning: state?.isRunning ?? false,
    currentStage: state?.currentStageId,
    currentPhase: state?.currentPhase ?? space.currentPhase,
    totalTokens: space.totalTokens,
    totalCost: space.totalCost,
  }
}

export function runThinkingSetupBackground(spaceId: string): void {
  // Fire-and-forget: run everything async, catch ALL errors, update space state in DB
  ;(async () => {
    let step = 'initialization'
    try {
      // Mark setup as running
      step = 'mark_running'
      await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'RUNNING', setupError: null, setupStep: 'Analyzing research goal...' } })

      // Load space with agents/providers
      step = 'load_space'
      const space = await prisma.space.findUnique({
        where: { id: spaceId },
        include: { User: { include: { Agent: { where: { isActive: true } }, ServiceProvider: true } } },
      })
      if (!space) {
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: 'Space not found', setupStep: null } })
        return
      }

      // Find thinking agent + service provider
      step = 'find_agent'
      await prisma.space.update({ where: { id: spaceId }, data: { setupStep: 'Configuring thinking agent...' } })
      const thinkingAgent = space.User.Agent
        .filter(a => a.role === 'THINKING')
        .sort((a, b) => a.order - b.order)[0]

      if (!thinkingAgent) {
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: 'No THINKING agent configured. Please create a Thinking Agent first.', setupStep: null } })
        return
      }

      const serviceProvider = space.User.ServiceProvider.find(sp => sp.id === thinkingAgent.serviceProviderId)
      if (!serviceProvider) {
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: 'Service provider not found for thinking agent', setupStep: null } })
        return
      }

      const agentConfig: AIConfig = {
        provider: serviceProvider.provider,
        apiKey: serviceProvider.apiKey,
        model: thinkingAgent.model,
      }

      // Call AI to analyze research goal -- with timeout
      step = 'call_ai'
      let response: any
      try {
        const aiPromise = callAI(agentConfig, [
          { role: 'system', content: 'You are a research planning assistant. Be concise and practical.' },
          { role: 'user', content: `Analyze this research goal and recommend stages: ${space.initialPrompt}` },
        ])
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('AI call timeout (10 min)')), 600000))
        response = await Promise.race([aiPromise, timeoutPromise])
      } catch (aiErr: any) {
        debugLog(`[runThinkingSetup] AI call failed at step ${step}: ${aiErr.message}; continuing with deterministic fallback setup`)
        response = buildFallbackThinkingSetupResponse(space.initialPrompt, aiErr)
        await prisma.space.update({
          where: { id: spaceId },
          data: {
            setupError: `Thinking setup used deterministic fallback after AI call failed: ${aiErr.message}`,
            setupStep: 'Creating fallback stage pipeline...',
          },
        })
      }

      // Always use ALL DEFAULT_STAGES -- don't trust AI recommendations
      step = 'create_stages'
      const recommendedStages = DEFAULT_STAGES.map((s, i) => ({ ...s, id: `stage_${i}` }))

      // Create thinking setup experiment
      step = 'create_experiment'
      await prisma.space.update({ where: { id: spaceId }, data: { setupStep: 'Creating stage pipeline...' } })
      try {
        await prisma.experiment.create({
          data: {
            spaceId: space.id,
            phase: 'THINKING_SETUP',
            agentId: thinkingAgent.id,
            agentName: thinkingAgent.name,
            prompt: space.initialPrompt,
            response: response.content,
            tokensUsed: response.tokensUsed || 0,
            cost: response.cost || 0,
            status: 'COMPLETED',
            updatedAt: new Date(),
            result: response.content,
          },
        })
      } catch (expErr: any) {
        debugLog(`[runThinkingSetup] Failed to create setup experiment: ${expErr.message} -- continuing anyway`)
      }

      // Update space with stages and mark as RUNNING
      step = 'update_space'
      try {
        await prisma.space.update({
          where: { id: spaceId },
          data: { status: 'RUNNING', currentPhase: 'Investigation', description: JSON.stringify({ stages: recommendedStages }), setupStep: 'Initializing research cycle...' },
        })
      } catch (updateErr: any) {
        debugLog(`[runThinkingSetup] Failed to update space: ${updateErr.message}`)
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: `Failed to update space: ${updateErr.message}`, setupStep: null } })
        return
      }

      // Initialize execution state in memory
      step = 'init_state'
      executionStates.set(spaceId, {
        spaceId,
        isRunning: true,
        isThinkingSetupRunning: true,
        currentStageId: recommendedStages[0].id,
        currentPhase: 'Investigation',
        variants: [],
        experiments: [],
        lastUpdated: new Date(),
        retryCount: 0,
        retryCountByStage: {},
        currentCycle: 1,
      })

      // Start background loop (generates variants on-demand, no pre-allocation needed)
      step = 'start_loop'
      startBackgroundLoop(spaceId)

      debugLog(`[runThinkingSetup] COMPLETED -- background loop started, variants will generate on-demand`)
      // Mark COMPLETED immediately -- variants generate lazily on first stage execution
      await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'COMPLETED', setupError: null, setupStep: null } })

    } catch (err: any) {
      debugLog(`[runThinkingSetupBackground] Unexpected error at step '${step}': ${err.message}`)
      try {
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: `Step '${step}': ${err.message}`, setupStep: null } })
      } catch (updateErr: any) {
        console.error('[runThinkingSetupBackground] CRITICAL -- could not update space status:', updateErr.message)
      }
    }
  })()
}
