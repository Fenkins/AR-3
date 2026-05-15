Total output lines: 3679

import { prisma } from './prisma'
import { callAI, AIConfig, AIMessage } from './ai'
import { generateVariants, gradeVariant, selectBestVariant, saveVariantsToDatabase, updateVariantStepDb, updateVariantDb, selectBestVariantFromDb, loadVariantsFromDb, reEvaluateStepCount, Variant, Step } from './variant-engine'
import { buildEmbeddingContext } from './embeddings'
import { addToCache } from './model-cache'
import { assessGpuExecutionEvidence, buildAutonomousPreparationCommand, buildDeterministicGpuExperimentCommand, extractPersistablePreparationManifest, extractStrictGpuCommand, selectGpuSubmissionCommand, shouldShortCircuitPreparationFallback, shouldUseAutonomousPreparationFallback } from './gpu-command-contract'
import { buildPreparationManifestInstructions, buildPreparationRetryMessage, extractPreparationManifestCandidate, validatePreparationManifest } from './preparation-manifest'
import fs from 'fs'
import { getInternalGpuApiBase } from './internal-api-base'
import { removeSpaceWorkbenchDirs } from './space-cleanup'
import { buildFallbackThinkingSetupResponse } from './thinking-setup'

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
- After download, models are available at /tmp/model_cache/{spaceId}/{model_id}/ (full repo)
- Load models with bitsandbytes 8-bit for VRAM efficiency:

  from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
  import torch

  # Use BitsAndBytesConfig for transformers 5.x compatibility
  bnb_config = BitsAndBytesConfig(load_in_8bit=True)
  model = AutoModelForCausalLM.from_pretrained(
      '/tmp/model_cache/{spaceId}/model_id',  # Full repo path or HuggingFace model ID
      quantization_config=bnb_config,
      device_map='cuda',
      dtype=torch.bfloat16,
      trust_remote_code=True,  # Required for custom model architectures
  )
  tokenizer = AutoTokenizer.from_pretrained('/tmp/model_cache/{spaceId}/model_id')

  # Inference example:
  input_ids = tokenizer(text, return_tensors='pt').to('cuda')
  with torch.no_grad():
      output = model.generate(**input_ids, max_new_tokens=50)
  print(tokenizer.decode(output[0], skip_special_tokens=True))
- Your primary output MUST be executable Python code in PYTHON-CODE blocks
- The GPU worker will execute it directly -- if the code crashes, the variant fails
- Print MEASUREABLE outputs: tensor norms, convergence values, alignment scores, etc.

Be specific and technical. Produce concrete, measurable results.`,
    order: 3,
    isActive: true,
    gpuEnabled: true,
    numVariants: 6,
  },
  {
    name: 'Testing',
    description: 'Test implementation and determine viability',
    prompt: `Test the implementation thoroughly.

Your tasks:
1. Run tests and validate the implementation
2. Identify issues, bugs, or weaknesses
3. Determine if implementation passes quality bar
4. Document what went wrong if it failed
5. Provide clear verdict: PASS or FAIL with reasoning

Be critical but fair.`,
    gpuPrompt: `Your primary output MUST be a JSON object with a GPU command if your tests need GPU. Format:
{"action": "run_python", "code": "YOUR_TEST_CODE"}

The GPU worker will execute this on an NVIDIA GPU with torch.

CRITICAL RULES -- VIOLATING ANY OF THESE WILL CAUSE RUNTIME FAILURES:
1. ALWAYS move ALL tensors to CUDA -- use .cuda() or device='cuda' consistently
2. NEVER call .item() on tensors with >1 element -- use .sum().item(), .mean().item(), or .tolist()
3. All tensors in an expression must be on the same device -- check with tensor.device
4. Wrap operations in try/except and print tensor shapes/devices on failure
5. Print ALL intermediate values so failures are traceable
6. If using downloaded models, load from /tmp/model_cache/{spaceId}/ -- never from remote URLs

ROBUST TEST CODE TEMPLATE:
import torch
import numpy as np

device = torch.device('cuda')
print(f'Testing on: {device}')

try:
    # Your test code here
    x = torch.randn(N, H, device=device)
    print(f'Tensor shape: {x.shape}, device: {x.device}')
    
    # Example: test a diffusion model or consensus mechanism
    result = your_test(x)
    print(f'Result: {result}')
    print(f'Verdict: PASS' if result > threshold else 'Verdict: FAIL')
except Exception as e:
    print(f'ERROR: {e}')
    print(f'Device debug: {[t.device for t in locals().values() if isinstance(t, torch.Tensor)]}')
    raise

Your testing tasks:
1. Run QUANTITATIVE experiments testing the hypothesis
2. Measure specific things: accuracy, convergence, collaboration quality, vector alignment, etc.
3. Include clear METRICS in your print statements
4. State your VERDICT at the end: PASS (hypothesis supported) or FAIL (hypothesis not supported)

Be rigorous. Use statistics over multiple runs. Output JSON GPU commands only for tests that need the GPU.`,
    order: 4,
    isActive: true,
    gpuEnabled: true,  // GPU needed for inference on trained models
    numVariants: 4,  // More variants = more chances for thorough testing
  },
  {
    name: 'Verification',
    description: 'Verify testing verdict independently',
    prompt: `Verify the testing verdict independently.

Your tasks:
1. Review testing results and methodology
2. Check if the verdict is justified
3. Look for alternative explanations
4. Ensure nothing was overlooked
5. Confirm or challenge the testing verdict

Be skeptical and thorough in verification.`,
    order: 5,
    isActive: true,
    gpuEnabled: false,
  },
  {
    name: 'Evaluation',
    description: 'Evaluate results and determine breakthrough',
    prompt: `Evaluate the complete research cycle results.

Your tasks:
1. Aggregate insights from all stages
2. Assess the quality and novelty of results
3. Determine if this constitutes a breakthrough
4. Rate confidence (0-1) in the findings
5. Prepare summary for next investigation cycle

Only mark as breakthrough if absolutely certain.`,
    order: 6,
    isActive: true,
    gpuEnabled: false,
  },
]

export const AGENT_ROLES = [
  'THINKING',
  'INVESTIGATION',
  'PROPOSITION',
  'PLANNING',
  'IMPLEMENTATION',
  'TESTING',
  'VERIFICATION',
  'EVALUATION',
]

// In-memory execution state (in production, use Redis or similar)
const executionStates: Map<string, SpaceExecutionState> = new Map()

export function getExecutionState(spaceId: string): SpaceExecutionState | null {
  return executionStates.get(spaceId) || null
}

export function updateExecutionState(spaceId: string, updates: Partial<SpaceExecutionState>) {
  const existing = executionStates.get(spaceId)
  if (existing) {
    executionStates.set(spaceId, { ...existing, ...updates, lastUpdated: new Date() })
  } else if (updates.spaceId) {
    // Create new state if it doesn't exist (e.g., after server restart)
    executionStates.set(spaceId, { lastUpdated: new Date(), ...updates } as SpaceExecutionState)
  }
}

export function clearExecutionState(spaceId: string) {
  executionStates.delete(spaceId)
}

export async function executeResearchCycle(spaceId: string, stageId?: string): Promise<any> {
  const space = await prisma.space.findFirst({
    where: { id: spaceId },
    include: {
      Experiment: { orderBy: { createdAt: 'desc' }, take: 100 },
      Breakthrough: { orderBy: { createdAt: 'desc' } },
      User: {
        include: {
          Agent: { where: { isActive: true } },
          ServiceProvider: true,
        },
      },
    },
  })

  if (!space) {
    throw new Error('Space not found')
  }

  // Get stages from metadata
  const stages = parseStages(space)
  
  // Determine current stage
  let currentStage: ResearchStage
  if (stageId) {
    currentStage = stages.find(s => s.id === stageId) || stages[0]
  } else {
    // Find next incomplete stage or start from current
    const state = getExecutionState(spaceId)
    if (state?.currentStageId) {
      currentStage = stages.find(s => s.id === state.currentStageId) || stages[0]
    } else {
      currentStage = stages[0]
    }
  }

  debugLog(`[executeResearchCycle] Space has Agent:`, space.User.Agent.map(a => `${a.name}(${a.role})`).join(', '))
  // Get appropriate agent
  const agent = getAgentForStage(space, currentStage.name)
  if (!agent) {
    debugLog(`[executeResearchCycle] Available roles:`, space.User.Agent.map(a => a.role).join(', '))
    throw new Error(`No active agent found for stage: ${currentStage.name}`)
  }

  const serviceProvider = space.User.ServiceProvider.find(sp => sp.id === agent.serviceProviderId)
  debugLog(`[executeResearchCycle] Agent: ${agent?.name}, provider: ${serviceProvider?.provider || 'NOT FOUND'}, model: ${agent?.model}`)
  if (!serviceProvider) {
    throw new Error('Service provider not configured')
  }

  const agentConfig: AIConfig = {
    provider: serviceProvider.provider,
    apiKey: serviceProvider.apiKey,
    model: agent.model,
  }

  // Check if we have pending variants to execute instead
  const state = getExecutionState(spaceId)
  const currentCycle = state?.currentCycle ?? 1

  // Generate variants for this stage if none exist yet (integrated into main pipeline)
  if (state) {
    const stageVariants = state.variants.filter(v => v.stageId === currentStage.id)
    if (stageVariants.length === 0) {
      debugLog(`[executeResearchCycle] No variants for stage ${currentStage.name}, generating...`)
      try {
        // Use space's configured defaults from creation, fall back to stage config
        const numVariants = space.defaultNumVariants ?? currentStage.numVariants ?? 3
        const stepsPerVariant = space.defaultStepsPerVariant ?? currentStage.stepsPerVariant ?? 25
        await generateStageVariants(spaceId, currentStage.id, numVariants, stepsPerVariant)
        // Reload state to get newly generated variants
        const newState = getExecutionState(spaceId)
        if (newState) {
          Object.assign(state, newState)
        }
        debugLog(`[executeResearchCycle] Variant generation complete for ${currentStage.name}`)
      } catch (err: any) {
        debugLog(`[executeResearchCycle] Variant generation failed for ${currentStage.name}: ${err.message} -- proceeding without variants`)
      }
    }
  }

  if (state && state.variants && state.variants.length > 0) {
    const pendingVariant = state.variants.find(v => v.stageId === currentStage.id && v.status === 'PENDING')
    if (pendingVariant) {
      debugLog(`[executeResearchCycle] Found pending variant ${pendingVariant.name}, delegating to executeVariantCycle`)
      const executedVariant = await executeVariantCycle(spaceId, pendingVariant.id)
      
      // Return a dummy experiment since we just executed a variant with steps (which logged their own experiments)
      return {
        id: 'variant_' + pendingVariant.id,
        spaceId,
        phase: currentStage.name.toUpperCase(),
        agentId: agent.id,
        agentName: agent.name,
        prompt: 'Variant execution',
        response: 'Variant executed',
        tokensUsed: 0,
        cost: 0,
        status: 'COMPLETED',
        result: 'Variant executed',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    }
  }

  // Get context from previous experiments
  const previousExperiments = space.Experiment.slice(0, 10)
  if (((space as any).useGpu ?? false) && currentStage.name === 'Implementation' && space.setupStatus !== 'VALIDATED') {
    throw new Error(`Implementation blocked until preparation manifest validates (setupStatus=${space.setupStatus || 'missing'})`)
  }
  const messages = await generateStagePrompt(space, currentStage, previousExperiments, agent)

  debugLog(`[executeResearchCycle] Calling AI for stage: ${currentStage.name}`)
  debugLog(`[executeResearchCycle] Agent: ${agent?.name} (${agent?.role}), Provider: ${serviceProvider?.provider}`)

  // Call LLM API
  let response: { content: string; tokensUsed: number; cost: number } | null = null
  let gpuEvidenceInvalidReasonForExperiment = ''
  try {
    debugLog(`[executeResearchCycle] About to call callAI, config:`, JSON.stringify({provider: agentConfig.provider, model: agentConfig.model, hasKey: !!agentConfig.apiKey}))
    response = await callAI(agentConfig, messages)
    debugLog(`[executeResearchCycle] AI call succeeded, tokens: ${response.tokensUsed}, cost: ${response.cost}`)

    const useGpu = (space as any).useGpu ?? false
    let preparationManifestValidatedThisCycle = false
    let preparationManifestForGpu: any = null
    if (useGpu && ['Investigation', 'Planning'].includes(currentStage.name)) {
      const manifestCandidate = extractPreparationManifestCandidate(response.content)
      let manifestValidation = validatePreparationManifest(manifestCandidate)
      if (!manifestValidation.ok) {
        d…28976 tokens truncated… catch {}
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
