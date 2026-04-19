import { prisma } from './prisma'
import { callAI, AIConfig, AIMessage } from './ai'
import { generateVariants, gradeVariant, selectBestVariant, saveVariantsToDatabase, updateVariantStepDb, updateVariantDb, selectBestVariantFromDb, loadVariantsFromDb, reEvaluateStepCount, Variant } from './variant-engine'
import { buildEmbeddingContext } from './embeddings'
import fs from 'fs'

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
    description: 'Research existing approaches, identify gaps and opportunities',
    prompt: `Analyze the research goal and investigate the problem space.

Your tasks:
1. Research existing approaches and solutions
2. Identify gaps and opportunities
3. Look for novel angles and unexplored areas
4. Document findings and insights
5. Provide feedback for the next stage

Be thorough and curious in your investigation.`,
    order: 0,
    isActive: true,
    gpuEnabled: false,
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

CRITICAL: The implementation will ONLY have access to:
- torch, numpy, and standard Python libraries
- An NVIDIA RTX 3060 GPU (12GB VRAM)
- No trained models, no external APIs, no internet

Your output should be a structured PLAN with code sketches, not prose.
Format:
  ## Step 1: [Name]
  - What: [specific description]
  - Tensor shapes: [e.g. (B, 512, 512)]
  - Code sketch: [2-5 lines of pseudocode or actual torch operations]
  - Failure points: [what could break]

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

The GPU worker will execute this on an NVIDIA RTX 3060 GPU with torch.

CRITICAL RULES -- VIOLATING ANY OF THESE WILL CAUSE RUNTIME FAILURES:
1. ALWAYS move ALL tensors to CUDA -- use .cuda() or device='cuda' consistently
2. NEVER call .item() on tensors with >1 element -- use .sum().item(), .mean().item(), or .tolist()
3. All tensors in an expression must be on the same device -- check with tensor.device
4. Wrap operations in try/except and print tensor shapes/devices on failure
5. Print ALL intermediate values so failures are traceable

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
      experiments: { orderBy: { createdAt: 'desc' }, take: 100 },
      breakthroughs: { orderBy: { createdAt: 'desc' } },
      user: {
        include: {
          agents: { where: { isActive: true } },
          serviceProviders: true,
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

  debugLog(`[executeResearchCycle] Space has agents:`, space.user.agents.map(a => `${a.name}(${a.role})`).join(', '))
  // Get appropriate agent
  const agent = getAgentForStage(space, currentStage.name)
  if (!agent) {
    debugLog(`[executeResearchCycle] Available roles:`, space.user.agents.map(a => a.role).join(', '))
    throw new Error(`No active agent found for stage: ${currentStage.name}`)
  }

  const serviceProvider = space.user.serviceProviders.find(sp => sp.id === agent.serviceProviderId)
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
  const previousExperiments = space.experiments.slice(0, 10)
  const messages = await generateStagePrompt(space, currentStage, previousExperiments, agent)

  debugLog(`[executeResearchCycle] Calling AI for stage: ${currentStage.name}`)
  debugLog(`[executeResearchCycle] Agent: ${agent?.name} (${agent?.role}), Provider: ${serviceProvider?.provider}`)

  // Call LLM API
  let response: { content: string; tokensUsed: number; cost: number } | null = null
  try {
    debugLog(`[executeResearchCycle] About to call callAI, config:`, JSON.stringify({provider: agentConfig.provider, model: agentConfig.model, hasKey: !!agentConfig.apiKey}))
    response = await callAI(agentConfig, messages)
    debugLog(`[executeResearchCycle] AI call succeeded, tokens: ${response.tokensUsed}, cost: ${response.cost}`)

    // If stage has gpuEnabled AND space has useGpu enabled, submit to GPU worker
    // The LLM's response text contains GPU commands in structured format
    const useGpu = (space as any).useGpu ?? false
    if (currentStage.gpuEnabled && useGpu) {
      debugLog(`[executeResearchCycle] GPU-enabled stage, submitting LLM output to GPU worker`)
      try {
        const gpuResponse = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/jobs/gpu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            spaceId,
            spaceName: space.name,
            stageName: currentStage.name,
            prompt: response.content,  // LLM's GPU command instructions
            context: JSON.stringify({ previousExperiments: previousExperiments.slice(0, 5) }),
          }),
        })
        if (gpuResponse.ok) {
          const { jobId } = await gpuResponse.json()
          debugLog(`[executeResearchCycle] GPU job submitted: ${jobId}`)

          // Poll for result (max 5 minutes)
          const maxWait = 300000
          const pollInterval = 5000
          let waited = 0
          while (waited < maxWait) {
            await new Promise(r => setTimeout(r, pollInterval))
            waited += pollInterval
            const statusRes = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/jobs/gpu?jobId=${jobId}`)
            if (statusRes.ok) {
              const statusData = await statusRes.json()
              if (statusData.status === 'completed') {
                const result = statusData.result
                // Append GPU result to LLM response
                const gpuResultText = result.success
                  ? `[GPU Execution Result]: ${result.output}`
                  : `[GPU Execution Error]: ${result.error}`
                response.content += '\n\n' + gpuResultText
                debugLog(`[executeResearchCycle] GPU job completed: ${gpuResultText.substring(0, 100)}`)
                break
              } else if (statusData.status === 'failed') {
                debugLog(`[executeResearchCycle] GPU job failed: ${statusData.error}`)
                response.content += `\n\n[GPU Error]: ${statusData.error}`
                break
              }
            }
            if (waited >= maxWait) {
              debugLog(`[executeResearchCycle] GPU job timed out`)
              response.content += '\n\n[GPU Timeout]: Job did not complete within 5 minutes'
              break
            }
          }
        } else {
          debugLog(`[executeResearchCycle] GPU job submission failed: ${gpuResponse.status}`)
          response.content += '\n\n[GPU Error]: Failed to submit GPU job'
        }
      } catch (gpuError: any) {
        debugLog(`[executeResearchCycle] GPU worker error: ${gpuError.message}`)
        response.content += `\n\n[GPU Error]: ${gpuError.message}`
      }
    }
  } catch (error: any) {
    debugLog(`[executeResearchCycle] AI/GPU call failed:`, error.message)
    throw error
  }

  // Defensive: ensure response was set
  if (!response) {
    throw new Error('executeResearchCycle: response was not set (GPU timeout without result?)')
  }

  // Create experiment record
  const experiment = await prisma.experiment.create({
    data: {
      spaceId: space.id,
      phase: currentStage.name.toUpperCase(),
      agentId: agent.id,
      agentName: agent.name,
      prompt: JSON.stringify(messages),
      response: response.content,
      tokensUsed: response.tokensUsed,
      cost: response.cost,
      status: 'COMPLETED',
      cycleNumber: currentCycle,
      result: stripThinkingTags(response.content),
      metrics: JSON.stringify({
        stageId: currentStage.id,
        stageName: currentStage.name,
        cycleNumber: currentCycle,
      }),
    },
  })

  // Quality gate: if stripped result is suspiciously empty, log a warning
  const strippedResult = stripThinkingTags(response.content)
  if (strippedResult.length < 100) {
    debugLog(`[executeResearchCycle] WARNING: Result for ${currentStage.name} is only ${strippedResult.length} chars after stripping. Content preview: ${strippedResult.substring(0, 100)}`)
  }

  // Update space
  await prisma.space.update({
    where: { id: spaceId },
    data: {
      totalTokens: { increment: response.tokensUsed },
      totalCost: { increment: response.cost },
      currentPhase: currentStage.name,
    },
  })
  debugLog(`[executeResearchCycle] Space updated with ${response.tokensUsed} tokens, total: ${space.totalTokens + response.tokensUsed}`)

  // Update execution state
  const nextStageId = getNextStageId(stages, currentStage.id)
  
  // Check if we just completed Evaluation (last stage) -- this means a full cycle completed
  // Next stage will be Investigation (first stage), so increment cycle counter
  let newCycle = currentCycle
  if (currentStage.name === 'Evaluation') {
    newCycle = currentCycle + 1
    debugLog(`[executeResearchCycle] Cycle ${currentCycle} completed, starting cycle ${newCycle}`)
    // Persist cycle to DB
    await prisma.space.update({
      where: { id: spaceId },
      data: { currentCycle: newCycle },
    })
  }

  updateExecutionState(spaceId, {
    currentStageId: nextStageId,
    currentPhase: currentStage.name,
    lastUpdated: new Date(),
    currentCycle: newCycle,
  })

  // Check for breakthroughs
  if (currentStage.name === 'Evaluation') {
    await processEvaluationResults(spaceId, response.content)
  }

  debugLog(`[executeResearchCycle] Stage ${currentStage.name} completed`)

  return {
    experiment,
    stage: currentStage,
    nextStageId,
    response: response.content.substring(0, 500),
    tokensUsed: response.tokensUsed,
    cost: response.cost,
  }
}

/**
 * Non-blocking cycle execution: creates pending experiment and returns immediately.
 * The actual AI work happens in the background, updating the experiment when done.
 */
export async function runCycleBackground(spaceId: string, stageId?: string): Promise<{ jobId: string }> {
  const space = await prisma.space.findFirst({
    where: { id: spaceId },
    include: {
      user: {
        include: {
          agents: { where: { isActive: true } },
        },
      },
    },
  })
  
  if (!space) throw new Error('Space not found')
  
  const stages = parseStages(space)
  const currentStage = stageId ? stages.find(s => s.id === stageId) : stages[0]
  const agent = getAgentForStage(space, currentStage?.name || 'Investigation')
  
  // Create pending experiment
  const experiment = await prisma.experiment.create({
    data: {
      spaceId,
      phase: currentStage?.name?.toUpperCase() || 'INVESTIGATION',
      agentId: agent?.id || '',
      agentName: agent?.name || 'Unknown',
      prompt: JSON.stringify({ stageId, action: 'cycle' }),
      response: '',
      tokensUsed: 0,
      cost: 0,
      status: 'PENDING',
    },
  })
  
  // Fire and forget - process in background without blocking the response
  executeResearchCycle(spaceId, stageId)
    .then((result) => {
      prisma.experiment.update({
        where: { id: experiment.id },
        data: {
          response: result.response,
          tokensUsed: result.tokensUsed,
          cost: result.cost,
          status: 'COMPLETED',
          result: result.response,
        },
      }).catch(err => console.error('[runCycleBackground] Failed to update experiment:', err))
    })
    .catch((err) => {
      prisma.experiment.update({
        where: { id: experiment.id },
        data: { status: 'FAILED', response: `Error: ${err.message}` },
      }).catch(e => console.error('[runCycleBackground] Failed to mark failed:', e))
      console.error('[runCycleBackground] Cycle failed:', err.message)
    })
  
  return { jobId: experiment.id }
}

async function executeVariant(variant: Variant, spaceId: string, stageName: string, gpuEnabled: boolean): Promise<Variant> {
  const space = await prisma.space.findFirst({
    where: { id: spaceId },
    include: {
      experiments: { orderBy: { createdAt: 'desc' }, take: 50 },
      user: {
        include: {
          agents: { where: { isActive: true } },
          serviceProviders: true,
        },
      },
    },
  })

  if (!space) throw new Error('Space not found')

  const agent = getAgentForStage(space, stageName)
  if (!agent) throw new Error(`No agent for stage: ${stageName}`)

  const serviceProvider = space.user.serviceProviders.find(sp => sp.id === agent.serviceProviderId)
  if (!serviceProvider) throw new Error('Service provider not found')

  const agentConfig: AIConfig = {
    provider: serviceProvider.provider,
    apiKey: serviceProvider.apiKey,
    model: agent.model,
  }

  const useGpu = gpuEnabled && ((space as any).useGpu ?? false)

  // Execute each step
  for (const step of variant.steps) {
    if (step.status === 'COMPLETED') continue

    const variantDefaultPrompt = `You are executing variant "${variant.name}" of stage "${stageName}". Produce concrete results -- no <thought> tags. Focus on actual output, findings, and deliverables.`
    const variantSystemPrompt = agent?.gpuPromptVariant && useGpu
      ? agent.gpuPromptVariant
      : (agent?.systemPrompt || variantDefaultPrompt)

    const messages: AIMessage[] = [
      { role: 'system', content: variantSystemPrompt },
      { role: 'user', content: `Step: ${step.description}\n\nResearch Goal: ${space.initialPrompt}\n\nExecute this step and provide concrete results. Be concise -- focus on findings and deliverables.` },
    ]

    try {
      let response: { content: string; tokensUsed: number; cost: number } = { content: '', tokensUsed: 0, cost: 0 }

      // GPU-enabled stage: call AI then submit output to GPU worker
      if (useGpu) {
        debugLog(`[executeVariant] GPU stage "${stageName}", calling AI then submitting to GPU worker`)
        response = await callAI(agentConfig, messages)

        // Submit LLM output to GPU worker for execution
        try {
          const gpuResponse = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/jobs/gpu`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              spaceId,
              spaceName: space.name,
              stageName,
              prompt: response.content,
              context: JSON.stringify({ previousExperiments: space.experiments.slice(0, 5) }),
            }),
          })
          if (gpuResponse.ok) {
            const { jobId } = await gpuResponse.json()
            debugLog(`[executeVariant] GPU job submitted: ${jobId}`)

            // Poll for result (max 5 minutes)
            const maxWait = 300000
            const pollInterval = 5000
            let waited = 0
            let gpuResult = ''
            while (waited < maxWait) {
              await new Promise(r => setTimeout(r, pollInterval))
              waited += pollInterval
              const statusRes = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/jobs/gpu?jobId=${jobId}`)
              if (statusRes.ok) {
                const statusData = await statusRes.json()
                if (statusData.status === 'completed') {
                  gpuResult = statusData.result.success
                    ? `[GPU Execution Result]: ${statusData.result.output}`
                    : `[GPU Execution Error]: ${statusData.result.error}`
                  debugLog(`[executeVariant] GPU job completed`)
                  break
                } else if (statusData.status === 'failed') {
                  gpuResult = `[GPU Error]: ${statusData.error}`
                  break
                }
              }
              if (waited >= maxWait) {
                gpuResult = '[GPU Timeout]: Job did not complete within 5 minutes'
                break
              }
            }
            response.content += '\n\n' + gpuResult
          } else {
            debugLog(`[executeVariant] GPU job submission failed: ${gpuResponse.status}`)
            response.content += '\n\n[GPU Error]: Failed to submit GPU job'
          }
        } catch (gpuError: any) {
          debugLog(`[executeVariant] GPU worker error: ${gpuError.message}`)
          response.content += `\n\n[GPU Error]: ${gpuError.message}`
        }
      } else {
        // Normal LLM-only call (no GPU)
        response = await callAI(agentConfig, messages)
      }

      step.result = response.content
      step.status = 'COMPLETED'
      step.grade = Math.min(100, Math.max(0, Math.floor(response.tokensUsed / 10)))
      
      // Persist step result to DB
      await updateVariantStepDb(step.id, {
        result: response.content,
        grade: step.grade,
        status: 'COMPLETED',
      })
      
      await prisma.experiment.create({
        data: {
          spaceId: space.id,
          phase: stageName.toUpperCase() + '_STEP',
          agentId: agent.id,
          agentName: agent.name,
          prompt: JSON.stringify(messages),
          response: response.content,
          tokensUsed: response.tokensUsed,
          cost: response.cost,
          status: 'COMPLETED',
          result: response.content,
          metrics: JSON.stringify({ variantId: variant.id, stepId: step.id, grade: step.grade }),
        }
      })
      
      await prisma.space.update({
        where: { id: spaceId },
        data: {
          totalTokens: { increment: response.tokensUsed },
          totalCost: { increment: response.cost },
        }
      })
    } catch (error: any) {
      step.status = 'FAILED'
      step.result = `Error: ${error.message}`
    }
  }

  // Grade the variant
  const graded = await gradeVariant(variant, spaceId, stageName)
  variant.grade = graded.grade
  variant.feedback = graded.feedback
  variant.status = 'COMPLETED'

  // Persist variant grade to DB
  await updateVariantDb(variant.id, {
    grade: graded.grade,
    feedback: graded.feedback,
    status: 'COMPLETED',
  })

  return variant
}

export function getAgentForStage(space: any, stageName: string) {
  const roleMap: Record<string, string[]> = {
    'Investigation': ['INVESTIGATION', 'THINKING'],
    'Proposition': ['PROPOSITION', 'THINKING'],
    'Planning': ['PLANNING', 'THINKING'],
    'Implementation': ['IMPLEMENTATION', 'THINKING'],
    'Testing': ['TESTING', 'EVALUATION', 'THINKING'],
    'Verification': ['VERIFICATION', 'THINKING'],
    'Evaluation': ['EVALUATION', 'THINKING'],
  }

  const roles = roleMap[stageName] || ['THINKING']

  for (const role of roles) {
    const agent = space.user.agents
      .filter((a: any) => a.role === role && a.isActive)
      .sort((a: any, b: any) => a.order - b.order)[0]
    if (agent) return agent
  }

  return space.user.agents[0]
}

export function parseStages(space: any): ResearchStage[] {
  try {
    const metadata = JSON.parse(space.description || '{}')
    if (metadata.stages && Array.isArray(metadata.stages)) {
      return metadata.stages
    }
  } catch {}

  return DEFAULT_STAGES.map((s, i) => ({
    ...s,
    id: `stage_${i}`,
  }))
}

function getNextStageId(stages: ResearchStage[], currentId: string): string {
  const currentIndex = stages.findIndex(s => s.id === currentId)
  if (currentIndex === -1 || currentIndex >= stages.length - 1) {
    return stages[0].id
  }
  return stages[currentIndex + 1].id
}

async function generateStagePrompt(space: any, stage: ResearchStage, previousExperiments: any[], agent?: any): Promise<AIMessage[]> {
  let contextFromPrevious = ''
  if (previousExperiments.length > 0) {
    contextFromPrevious = `\n\nContext from Previous Work:\n${
      previousExperiments.slice(0, 5).map((exp: any, i: number) => 
        `[${exp.phase}]: ${exp.result?.substring(0, 500) || 'No result'}`
      ).join('\n\n')
    }`
  }

  // Add semantic search context from embeddings if enabled
  let embeddingContext = ''
  if (space.useEmbeddings) {
    try {
      embeddingContext = await buildEmbeddingContext(
        space.initialPrompt,
        space.userId,
        space.id,
        2000
      )
    } catch (e: any) {
      debugLog('[generateStagePrompt] Embedding context error:', e.message)
    }
  }

  // Pick prompt variant: gpuPromptVariant from agent > stage.gpuPrompt > stage.prompt
  const useGpu = (space as any).useGpu ?? false
  let activePrompt = stage.prompt
  if (useGpu) {
    if (agent?.gpuPromptVariant) {
      activePrompt = agent.gpuPromptVariant
    } else if (stage.gpuPrompt) {
      activePrompt = stage.gpuPrompt
    }
  }

  const fullPrompt = `${activePrompt}${contextFromPrevious}${embeddingContext}

Research Goal: ${space.initialPrompt}

Execute your stage tasks thoroughly.`

  // Use agent's custom system prompt if set, otherwise results-focused default
  // Explicitly tell agent to avoid thinking tags in final output
  const defaultSystemPrompt = 'You are an expert research scientist. Your role is to produce actionable research results -- not to describe your thinking process.\n\nIMPORTANT RULES:\n1. NEVER use <thought> or <think> tags in your output -- they are not part of your deliverable\n2. Focus on concrete findings, code, data, and conclusions\n3. When reporting results, write as if communicating to a colleague who needs the facts\n4. Be direct and concise -- prioritize substance over explanation\n5. If you would include a thought in your final output, remove it and keep only the useful content\n\nYour output will be parsed automatically -- include only meaningful content.'
  const systemPrompt = agent?.systemPrompt || defaultSystemPrompt

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: fullPrompt },
  ]
}

async function processEvaluationResults(spaceId: string, content: string) {
  // Check for explicit negative verdicts FIRST -- these override any positive mentions
  const negativeVerdictPatterns = [
    /NOT\s+A\s+BREAKTHROUGH/i,
    /NOT\s+A\s+BREAKTHROUGH\s*--/i,
    /INSUFFICIENT\s+EVIDENCE/i,
    /does\s+not\s+constitute\s+a\s+breakthrough/i,
    /no+ breakthroughs? detected/i,
    /breakthrough:\s*no/i,
    /verdict:\s*not a breakthrough/i,
    /verdict:\s*rejected/i,
    /false positive/i,
    /not sufficient for breakthrough/i,
  ]
  const hasNegativeVerdict = negativeVerdictPatterns.some(p => p.test(content))
  if (hasNegativeVerdict) {
    debugLog(`[processEvaluationResults] Negative verdict detected -- skipping breakthrough creation`)
    return
  }

  const confidenceMatch = content.match(/confidence[:\s]+([\d.]+)/i)
  const breakthroughMatch = content.match(/breakthrough[:\s]+(yes|true|definitely)/i)
  const goldNuggetMatch = content.match(/(?:gold nugget|major discovery|significant breakthrough)/i)

  if (breakthroughMatch || goldNuggetMatch) {
    // Require meaningful confidence (>60%) to auto-verify; below that, leave unverified for human review
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5
    const minConfidenceForAutoVerify = 0.6
    const isVerified = confidence >= minConfidenceForAutoVerify

    await prisma.breakthrough.create({
      data: {
        spaceId,
        title: extractTitle(content),
        description: stripThinkingTags(content).substring(0, 2000),
        category: 'EVALUATION',
        confidence,
        verified: isVerified,
      },
    })
    debugLog(`[processEvaluationResults] Breakthrough ${isVerified ? 'auto-verified' : 'created unverified'} with confidence ${confidence}`)
  }
}

/**
 * Process cacheDownloads for a variant -- fetch models/datasets referenced in the plan.
 * Calls POST /api/model-cache for each download URL. Failures are non-fatal.
 */
async function processVariantCacheDownloads(variant: Variant, spaceId: string): Promise<void> {
  if (!variant.cacheDownloads) return

  let downloads: Array<{ fileName: string; downloadUrl: string; description: string }>
  try {
    downloads = JSON.parse(variant.cacheDownloads)
  } catch {
    debugLog(`[processVariantCacheDownloads] Failed to parse cacheDownloads for variant ${variant.id}`)
    return
  }

  if (!Array.isArray(downloads) || downloads.length === 0) return

  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'

  for (const dl of downloads) {
    if (!dl.downloadUrl || !dl.fileName) continue
    try {
      const res = await fetch(`${baseUrl}/api/model-cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceId,
          fileName: dl.fileName,
          downloadUrl: dl.downloadUrl,
          description: dl.description || dl.fileName,
        }),
      })
      if (res.ok) {
        debugLog(`[processVariantCacheDownloads] Downloaded: ${dl.fileName}`)
      } else {
        debugLog(`[processVariantCacheDownloads] Failed to download ${dl.fileName}: ${res.status} ${await res.text()}`)
      }
    } catch (err: any) {
      debugLog(`[processVariantCacheDownloads] Error downloading ${dl.fileName}: ${err.message}`)
    }
  }
}

function stripThinkingTags(text: string): string {
  // Remove thinking/reasoning tags from MiniMax and similar models
  // MiniMax uses Chinese characters: <think> (think) and </think> (finish thought)
  return text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // lowercase think tags
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<反思>[\s\S]*?<\/反思>/gi, '') // Chinese reflect
    .replace(/<内省>[\s\S]*?<\/内省>/gi, '') // Chinese introspect
    .replace(/<answer>[\s\S]*?<\/answer>/gi, '')
    .replace(/<notes>[\s\S]*?<\/notes>/gi, '')
    .replace(/<commentary>[\s\S]*?<\/commentary>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<observation>[\s\S]*?<\/observation>/gi, '')
    .replace(/<findings>[\s\S]*?<\/findings>/gi, '')
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .replace(/<working>[\s\S]*?<\/working>/gi, '')
    .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, '')
    .replace(/<memo>[\s\S]*?<\/memo>/gi, '')
    .replace(/<submission>[\s\S]*?<\/submission>/gi, '')
    .replace(/<interpretation>[\s\S]*?<\/interpretation>/gi, '')
    .replace(/<summary>[\s\S]*?<\/summary>/gi, '')
    .replace(/<explain>[\s\S]*?<\/explain>/gi, '')
    .replace(/<step>[\s\S]*?<\/step>/gi, '')
    .replace(/<result>[\s\S]*?<\/result>/gi, '')
    .replace(/<output>[\s\S]*?<\/output>/gi, '')
    .replace(/<text>[\s\S]*?<\/text>/gi, '')
    .replace(/<content>[\s\S]*?<\/content>/gi, '')
    .replace(/<response>[\s\S]*?<\/response>/gi, '')
    .replace(/<thoughts>[\s\S]*?<\/thoughts>/gi, '')
    // Self-closing and bare tags
    .replace(/<\/think>/gi, '')
    .replace(/<think>/gi, '')
    .replace(/<\/thought>/gi, '')
    .replace(/<thought>/gi, '')
    .replace(/<\/reasoning>/gi, '')
    .replace(/<reasoning>/gi, '')
    .replace(/<\/thinking>/gi, '')
    .replace(/<thinking>/gi, '')
    .replace(/<\/反思>/gi, '')
    .replace(/<反思>/gi, '')
    .replace(/<\/内省>/gi, '')
    .replace(/<内省>/gi, '')
    .replace(/<\/answer>/gi, '')
    .replace(/<answer>/gi, '')
    .replace(/<\/notes>/gi, '')
    .replace(/<notes>/gi, '')
    .replace(/<\/commentary>/gi, '')
    .replace(/<commentary>/gi, '')
    .replace(/<\/analysis>/gi, '')
    .replace(/<analysis>/gi, '')
    .replace(/<\/observation>/gi, '')
    .replace(/<observation>/gi, '')
    .replace(/<\/findings>/gi, '')
    .replace(/<findings>/gi, '')
    .replace(/<\/details>/gi, '')
    .replace(/<details>/gi, '')
    .replace(/<\/working>/gi, '')
    .replace(/<working>/gi, '')
    .replace(/<\/scratchpad>/gi, '')
    .replace(/<scratchpad>/gi, '')
    .replace(/<\/memo>/gi, '')
    .replace(/<memo>/gi, '')
    .replace(/<\/submission>/gi, '')
    .replace(/<submission>/gi, '')
    .replace(/<\/interpretation>/gi, '')
    .replace(/<interpretation>/gi, '')
    .replace(/<\/summary>/gi, '')
    .replace(/<summary>/gi, '')
    .replace(/<\/explain>/gi, '')
    .replace(/<explain>/gi, '')
    .replace(/<\/step>/gi, '')
    .replace(/<step>/gi, '')
    .replace(/<\/result>/gi, '')
    .replace(/<result>/gi, '')
    .replace(/<\/output>/gi, '')
    .replace(/<output>/gi, '')
    .replace(/<\/text>/gi, '')
    .replace(/<text>/gi, '')
    .replace(/<\/content>/gi, '')
    .replace(/<content>/gi, '')
    .replace(/<\/response>/gi, '')
    .replace(/<response>/gi, '')
    .replace(/<\/thoughts>/gi, '')
    .replace(/<thoughts>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<\/self>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<\/self>/gi, '')
    .replace(/<think>/gi, '')
    .replace(/<\/t>/gi, '')
    .replace(/<t>/gi, '')
    .replace(/<\/q>/gi, '')
    .replace(/<q>/gi, '')
    .replace(/<\/r>/gi, '')
    .replace(/<r>/gi, '')
    .replace(/<\/n>/gi, '')
    .replace(/<n>/gi, '')
    .replace(/<\/c>/gi, '')
    .replace(/<c>/gi, '')
    .replace(/<\/d>/gi, '')
    .replace(/<d>/gi, '')
    .replace(/<\/p>/gi, '')
    .replace(/<p>/gi, '')
    .replace(/<\/fn>/gi, '')
    .replace(/<fn>/gi, '')
    .replace(/<\/fd>/gi, '')
    .replace(/<fd>/gi, '')
    .replace(/<\/cd>/gi, '')
    .replace(/<cd>/gi, '')
    .replace(/<\/bd>/gi, '')
    .replace(/<bd>/gi, '')
    .replace(/<\/md>/gi, '')
    .replace(/<md>/gi, '')
    .replace(/<\/rd>/gi, '')
    .replace(/<rd>/gi, '')
    .replace(/<\/nd>/gi, '')
    .replace(/<nd>/gi, '')
    .replace(/<\/pd>/gi, '')
    .replace(/<pd>/gi, '')
    .replace(/<\/td>/gi, '')
    .replace(/<td>/gi, '')
    .replace(/<self>/gi, '')
    .replace(/\u8ba8\u8bba[\s\S]*?\u7ed3\u675f/gi, '')  // 讨论...结束
    .replace(/\u300c[\s\S]*?\u300d/g, '') // Remove quoted content
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(content: string): string {
  // Strip thinking tags first so they don't pollute the title
  const clean = stripThinkingTags(content)
  const titleMatch = clean.match(/^(?:Title:|Finding:|Breakthrough:|##\s*)(.+)$/im)
  if (titleMatch) {
    return titleMatch[1].trim().substring(0, 200)
  }
  // Use first meaningful non-empty line
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 10)
  return lines[0]?.substring(0, 200) || 'New Finding'
}

export async function startSpace(spaceId: string) {
  const defaultStagesWithIds = DEFAULT_STAGES.map((s, i) => ({
    ...s,
    id: `stage_${i}`,
  }))

  await prisma.space.update({
    where: { id: spaceId },
    data: {
      status: 'RUNNING',
      currentPhase: 'Investigation',
      description: JSON.stringify({ stages: defaultStagesWithIds }),
    },
  })

  // Initialize execution state
  executionStates.set(spaceId, {
    spaceId,
    isRunning: true,
    currentStageId: defaultStagesWithIds[0].id,
    currentPhase: 'Investigation',
    variants: [],
    experiments: [],
    lastUpdated: new Date(),
    retryCount: 0,
    retryCountByStage: {},
    currentCycle: 1,
  })

  await prisma.space.update({
    where: { id: spaceId },
    data: { currentCycle: 1 },
  })

  // Execute first cycle immediately
  const result = await executeResearchCycle(spaceId, defaultStagesWithIds[0].id)

  // Start the continuous background loop
  startBackgroundLoop(spaceId)

  return result
}

export async function runResearchLoop(spaceId: string, numCycles: number = 3): Promise<any[]> {
  const results = []
  const space = await prisma.space.findUnique({ where: { id: spaceId } })

  if (!space || space.status !== 'RUNNING') {
    throw new Error('Space is not running')
  }

  const stages = parseStages(space)

  for (let i = 0; i < numCycles; i++) {
    const state = getExecutionState(spaceId)
    debugLog(`[runResearchLoop] Cycle ${i + 1}, state:`, JSON.stringify({ isRunning: state?.isRunning, currentStageId: state?.currentStageId }))
    if (!state?.isRunning) {
      debugLog(`[runResearchLoop] Space not running, stopping`)
      break
    }

    const stageId = state.currentStageId
    debugLog(`[runResearchLoop] Executing cycle ${i + 1} for stageId: ${stageId}`)
    try {
      const result = await executeResearchCycle(spaceId, stageId)
      results.push(result)
    } catch (error: any) {
      debugLog(`[runResearchLoop] Cycle ${i + 1} failed:`, error.message)
      // Don't break - continue to next cycle
    }
  }
  debugLog(`[runResearchLoop] Completed ${results.length} cycles`)

  return results
}

/**
 * Non-blocking start: initializes space and fires first cycle in background.
 */
export function runStartBackground(spaceId: string): void {
  startSpace(spaceId).catch(err => {
    console.error('[runStartBackground] startSpace failed:', err.message)
  })
}

/**
 * Non-blocking run loop: fires all cycles in background without blocking.
 */
export function runLoopBackground(spaceId: string, numCycles: number = 3): void {
  runResearchLoop(spaceId, numCycles).catch(err => {
    console.error('[runLoopBackground] runResearchLoop failed:', err.message)
  })
}

// Active background loops (prevent duplicate loops)
const activeLoops: Set<string> = new Set()

/**
 * Continuous background loop that keeps executing research cycles
 * while the space is running. This is the auto-pilot for the pipeline.
 */
export function startBackgroundLoop(spaceId: string): void {
  if (activeLoops.has(spaceId)) {
    debugLog(`[startBackgroundLoop] Loop already running for ${spaceId}, skipping`)
    return
  }
  activeLoops.add(spaceId)
  debugLog(`[startBackgroundLoop] Starting background loop for ${spaceId}`)

  const pollInterval = 15000 // 15 seconds between cycles
  const maxConsecutiveErrors = 5
  let consecutiveErrors = 0

  async function loop() {
    try {
      const state = getExecutionState(spaceId)
      if (!state || !state.isRunning) {
        debugLog(`[startBackgroundLoop] Space ${spaceId} no longer running, stopping loop`)
        activeLoops.delete(spaceId)
        return
      }

      const stages = DEFAULT_STAGES.map((s, i) => ({ ...s, id: `stage_${i}` }))
      const currentStageId = state.currentStageId || stages[0].id
      const currentStage = stages.find(s => s.id === currentStageId)

      // Check if there are pending variants to execute for the current stage
      if (state.variants && state.variants.length > 0) {
        const currentStageVariants = state.variants.filter(v => v.stageId === currentStageId)
        const pendingVariant = currentStageVariants.find(v => v.status === 'PENDING')
        
        if (pendingVariant) {
          debugLog(`[startBackgroundLoop] Executing pending variant ${pendingVariant.name}`)
          try {
            await withTimeout(
              executeVariantCycle(spaceId, pendingVariant.id),
              1800000,
              'executeVariantCycle'
            )
            consecutiveErrors = 0
          } catch (err: any) {
            consecutiveErrors++
            debugLog(`[startBackgroundLoop] Variant execution failed: ${err.message}`)
          }
          scheduleNext()
          return
        }
        
        // No PENDING variants for current stage -- check if ALL variants for this stage are done
        // (all COMPLETED or non-existent). If so, advance to next stage and generate its variants.
        if (currentStageVariants.length > 0) {
          const allDone = currentStageVariants.every(v => v.status === 'COMPLETED' || v.status === 'FAILED')
          if (allDone) {
            debugLog(`[startBackgroundLoop] All variants for ${currentStage?.name} complete -- advancing to next stage`)
            const nextStageId = getNextStageId(stages, currentStageId)
            const nextStage = stages.find(s => s.id === nextStageId)
            
            // Load space for config (defaultNumVariants, etc)
            const spaceForConfig = await prisma.space.findUnique({ where: { id: spaceId } })
            
            // Persist stage advancement to DB
            try {
              await prisma.space.update({
                where: { id: spaceId },
                data: { currentPhase: nextStage?.name || 'Investigation' }
              })
            } catch {}
            
            // Update execution state to next stage
            updateExecutionState(spaceId, {
              currentStageId: nextStageId,
              currentPhase: nextStage?.name || 'Investigation',
            })
            
            // Generate variants for the new stage
            try {
              const numVariants = (spaceForConfig as any)?.defaultNumVariants ?? nextStage?.numVariants ?? 3
              const stepsPerVariant = (spaceForConfig as any)?.defaultStepsPerVariant ?? nextStage?.stepsPerVariant ?? 25
              debugLog(`[startBackgroundLoop] Generating ${numVariants} variants for ${nextStage?.name}`)
              await generateStageVariants(spaceId, nextStageId, numVariants, stepsPerVariant)
            } catch (err: any) {
              debugLog(`[startBackgroundLoop] Failed to generate variants for next stage: ${err.message}`)
            }
            
            scheduleNext()
            return
          }
        }
      }

      // Execute next cycle with a hard timeout (30 min -- variant execution with 15 steps takes time)
      debugLog(`[startBackgroundLoop] Executing cycle for stage ${currentStage?.name}`)
      try {
        await withTimeout(
          executeResearchCycle(spaceId, currentStageId),
          1800000, // 30 min -- variant step execution is slow
          'executeResearchCycle'
        )
        consecutiveErrors = 0
        debugLog(`[startBackgroundLoop] Cycle completed successfully for ${currentStage?.name}`)
      } catch (err: any) {
        const isTimeout = err.message?.includes('Timeout') || err.message?.includes('timeout')
        consecutiveErrors++
        debugLog(`[startBackgroundLoop] Cycle ${isTimeout ? 'timed out' : 'failed'} (${consecutiveErrors}/${maxConsecutiveErrors}): ${err.message}`)

        if (consecutiveErrors >= maxConsecutiveErrors) {
          updateExecutionState(spaceId, {
            lastError: `Too many consecutive failures: ${err.message}`,
            lastErrorTime: new Date(),
            lastErrorType: 'API_ERROR',
          })
          debugLog(`[startBackgroundLoop] Max consecutive errors reached, pausing space`)
          await pauseSpace(spaceId)
          activeLoops.delete(spaceId)
          return
        }
      }

      scheduleNext()
    } catch (err: any) {
      debugLog(`[startBackgroundLoop] Loop error: ${err.message}`)
      scheduleNext()
    }
  }

  function scheduleNext() {
    setTimeout(loop, pollInterval)
  }

  // Start the loop
  loop()
}

export async function pauseSpace(spaceId: string) {
  updateExecutionState(spaceId, { isRunning: false })
  await prisma.space.update({
    where: { id: spaceId },
    data: { status: 'PAUSED' },
  })
}

export async function resumeSpace(spaceId: string) {
  // Reconstruct execution state from database since in-memory state was lost on restart
  const space = await prisma.space.findFirst({
    where: { id: spaceId },
    include: { experiments: { orderBy: { createdAt: 'desc' }, take: 50 } },
  })
  if (!space) throw new Error('Space not found')

  let stages: any[] = []
  try {
    const metadata = JSON.parse(space.description || '{}')
    stages = metadata.stages || []
  } catch {}

  if (stages.length === 0) {
    stages = DEFAULT_STAGES.map((s, i) => ({ ...s, id: `stage_${i}` }))
  }

  // Find current stage from execution or default to first
  const currentStage = stages[0]
  const currentStageId = currentStage?.id || 'stage_0'

  // Load variants from DB
  let variants: any[] = []
  try {
    variants = await loadVariantsFromDb(spaceId)
    debugLog(`[resumeSpace] Loaded ${variants.length} variants from DB`)
  } catch (err: any) {
    debugLog(`[resumeSpace] Could not load variants from DB: ${err.message}`)
  }

  updateExecutionState(spaceId, {
    spaceId,
    isRunning: true,
    currentStageId,
    currentPhase: currentStage?.name || 'Investigation',
    variants,
    experiments: space.experiments,
    lastUpdated: new Date(),
    retryCount: 0,
    retryCountByStage: {},
    currentCycle: (space as any).currentCycle || 1,
  })

  await prisma.space.update({
    where: { id: spaceId },
    data: { status: 'RUNNING' },
  })

  // Restart background loop
  startBackgroundLoop(spaceId)
}

export async function stopSpace(spaceId: string, userId?: string) {
  updateExecutionState(spaceId, { isRunning: false })
  clearExecutionState(spaceId)

  // ── Safeguard 1: Verify space exists ─────────────────────────────────────────
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    include: {
      variants: { select: { id: true } },
      experiments: { select: { id: true } },
      breakthroughs: { select: { id: true } },
    },
  })
  if (!space) {
    debugLog(`[stopSpace] Space ${spaceId} not found — nothing to do`)
    return
  }

  // ── Safeguard 2: Ownership check ──────────────────────────────────────────
  if (userId && space.userId !== userId) {
    throw new Error(`Access denied: space ${spaceId} does not belong to user ${userId}`)
  }


  const variantIds = space.variants.map(v => v.id)
  const experimentIds = space.experiments.map(e => e.id)
  const breakthroughIds = space.breakthroughs.map(b => b.id)


  debugLog(`[stopSpace] Cascading delete for space ${spaceId}: ` +
    `${variantIds.length} variants, ${experimentIds.length} experiments, ` +
    `${breakthroughIds.length} breakthroughs`)

  // ── Safeguard 3: Transaction-wrapped cascade delete ────────────────────────
  // Order: VariantStep (dependent on Variant) → Variant → Breakthrough → Experiment → ModelCache → Space
  // GPU jobs are cleaned via API (separate process on Vast.ai)
  await prisma.$transaction([
    // Delete variant steps first (foreign key to Variant)
    prisma.variantStep.deleteMany({
      where: { variantId: { in: variantIds } },
    }),
    // Delete variants
    prisma.variant.deleteMany({
      where: { spaceId },
    }),
    // Delete breakthroughs
    prisma.breakthrough.deleteMany({
      where: { spaceId },
    }),
    // Delete experiments
    prisma.experiment.deleteMany({
      where: { spaceId },
    }),
    // Delete model cache entries (model files tracked in DB)
    prisma.modelCache.deleteMany({
      where: { spaceId },
    }),
    // Finally delete the space itself
    prisma.space.delete({
      where: { id: spaceId },
    }),
  ])

  debugLog(`[stopSpace] DB cascade complete for space ${spaceId}`)

  // ── Safeguard 4: Post-DB file cleanup (best-effort, outside transaction) ──────
  // Clean up space model cache directory on disk
  try {
    const { execSync } = await import('child_process')
    const cacheDir = `/opt/AR-3/model_cache/${spaceId}`
    execSync(`rm -rf "${cacheDir}"`, { stdio: 'ignore' })
    debugLog(`[stopSpace] Removed model cache directory: ${cacheDir}`)
  } catch (err) {
    debugLog(`[stopSpace] Warning: could not remove model cache dir: ${(err as Error).message}`)
  }

  // Clean up stale GPU results for this space from shared GPU result file
  try {
    const resultsPath = '/tmp/gpu_results.json'
    const fs = await import('fs')
    if (fs.existsSync(resultsPath)) {
      const raw = fs.readFileSync(resultsPath, 'utf-8')
      const results = JSON.parse(raw)
      // Filter out results belonging to this space's variants
      const cleaned = Object.fromEntries(
        Object.entries(results).filter(([jobId]) => {
          // Keep entries whose jobId doesn't belong to a deleted variant/experiment
          // We don't have the full job→variant mapping here, so just purge entries
          // older than 24h as a heuristic cleanup
          const entry = results[jobId]
        if (!entry?.completedAt) return true
        const age = Date.now() - new Date(entry.completedAt).getTime()
        return age < 24 * 60 * 60 * 1000
      })
      )
      fs.writeFileSync(resultsPath, JSON.stringify(cleaned, null, 2))
      debugLog(`[stopSpace] Pruned stale GPU results (${Object.keys(results).length - Object.keys(cleaned).length} removed)`)
    }
  } catch (err) {
    debugLog(`[stopSpace] Warning: could not prune GPU results: ${(err as Error).message}`)
  }

  // ── Safeguard 5: GPU jobs cleanup via API ────────────────────────────────────
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
    await fetch(`${baseUrl}/api/jobs/gpu?spaceId=${spaceId}`, { method: 'DELETE' })
    debugLog(`[stopSpace] GPU jobs API cleanup called for space ${spaceId}`)
  } catch (err) {
    debugLog(`[stopSpace] Warning: GPU jobs API cleanup failed: ${(err as Error).message}`)
  }
}

export async function updateSpaceStages(spaceId: string, stages: ResearchStage[]) {
  const space = await prisma.space.findUnique({ where: { id: spaceId } })
  if (!space) throw new Error('Space not found')

  let metadata: Record<string, any> = {}
  try {
    metadata = JSON.parse(space.description || '{}')
  } catch {}

  metadata.stages = stages

  await prisma.space.update({
    where: { id: spaceId },
    data: { description: JSON.stringify(metadata) },
  })

  return stages
}

export async function getSpaceStages(spaceId: string): Promise<ResearchStage[]> {
  const space = await prisma.space.findUnique({ where: { id: spaceId } })
  if (!space) throw new Error('Space not found')
  return parseStages(space)
}

export async function generateStageVariants(
  spaceId: string,
  stageId: string,
  numVariants: number | 'auto' = 'auto',
  stepsPerVariant: number | 'auto' = 'auto'
): Promise<Variant[]> {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    include: { experiments: { orderBy: { createdAt: 'desc' }, take: 10 } },
  })

  if (!space) throw new Error('Space not found')

  const stages = parseStages(space)
  const stage = stages.find(s => s.id === stageId)
  if (!stage) throw new Error('Stage not found')

  const previousContext = space.experiments
    .slice(0, 3)
    .map(e => `[${e.phase}]: ${e.result?.substring(0, 300) || ''}`)
    .join('\n\n')

  const stageConfig: { id: string; name: string; numVariants: number | 'auto'; stepsPerVariant: number | 'auto' } = {
    id: stageId,
    name: stage.name,
    numVariants: (space as any).numVariantsMode === 'auto' ? 'auto' : ((space as any).defaultNumVariants ?? numVariants),
    stepsPerVariant: (space as any).stepsPerVariantMode === 'auto' ? 'auto' : ((space as any).defaultStepsPerVariant ?? stepsPerVariant),
  }

  // Generate real variants using AI
  const variants = await generateVariants(
    spaceId,
    stageId,
    stageConfig,
    space.initialPrompt,
    previousContext
  )

  // Save to database
  await saveVariantsToDatabase(spaceId, stageId, stage.name, variants, space.currentCycle)

  // Update execution state -- merge with existing variants from OTHER stages (don't wipe them)
  const state = getExecutionState(spaceId)
  if (state) {
    const otherStageVariants = (state.variants || []).filter(v => v.stageId !== stageId)
    updateExecutionState(spaceId, { variants: [...otherStageVariants, ...variants] })
  }

  return variants
}

export async function executeVariantCycle(spaceId: string, variantId: string) {
  const state = getExecutionState(spaceId)
  if (!state) throw new Error('No execution state found')

  const variant = state.variants.find(v => v.id === variantId)
  if (!variant) throw new Error('Variant not found')

  const space = await prisma.space.findUnique({ where: { id: spaceId } })
  if (!space) throw new Error('Space not found')

  const stages = parseStages(space)
  const stage = stages.find(s => s.id === variant.stageId)
  if (!stage) throw new Error('Stage not found')

  // Process cache downloads (models/datasets) before execution begins
  await processVariantCacheDownloads(variant, spaceId)

  // Execute the variant
  const executedVariant = await executeVariant(variant, spaceId, stage.name, stage.gpuEnabled ?? false)

  // Update state
  const updatedVariants = state.variants.map(v =>
    v.id === variantId ? executedVariant : v
  )
  updateExecutionState(spaceId, { variants: updatedVariants })

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
      user: {
        include: {
          agents: { where: { isActive: true } },
          serviceProviders: true,
        },
      },
    },
  })

  if (!space) throw new Error('Space not found')

  const thinkingAgent = space.user.agents
    .filter(a => a.role === 'THINKING')
    .sort((a, b) => a.order - b.order)[0]

  if (!thinkingAgent) {
    throw new Error('No THINKING agent configured. Please create a Thinking Agent first.')
  }

  const serviceProvider = space.user.serviceProviders.find(sp => sp.id === thinkingAgent.serviceProviderId)
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
      experiments: { orderBy: { createdAt: 'desc' }, take: 20 },
      breakthroughs: { orderBy: { createdAt: 'desc' } },
    },
  })

  if (!space) throw new Error('Space not found')

  const state = getExecutionState(spaceId)
  const stages = parseStages(space)

  return {
    space,
    execution: state,
    stages,
    recentExperiments: space.experiments.slice(0, 10),
    breakthroughs: space.breakthroughs,
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
        include: { user: { include: { agents: { where: { isActive: true } }, serviceProviders: true } } },
      })
      if (!space) {
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: 'Space not found', setupStep: null } })
        return
      }

      // Find thinking agent + service provider
      step = 'find_agent'
      await prisma.space.update({ where: { id: spaceId }, data: { setupStep: 'Configuring thinking agent...' } })
      const thinkingAgent = space.user.agents
        .filter(a => a.role === 'THINKING')
        .sort((a, b) => a.order - b.order)[0]

      if (!thinkingAgent) {
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: 'No THINKING agent configured. Please create a Thinking Agent first.', setupStep: null } })
        return
      }

      const serviceProvider = space.user.serviceProviders.find(sp => sp.id === thinkingAgent.serviceProviderId)
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
        debugLog(`[runThinkingSetup] AI call failed at step ${step}: ${aiErr.message}`)
        await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'FAILED', setupError: `AI call failed: ${aiErr.message}`, setupStep: null } })
        return
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
      await prisma.space.update({ where: { id: spaceId }, data: { setupStatus: 'COMPLETED', setupStep: null } })

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
