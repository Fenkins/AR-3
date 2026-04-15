import { prisma } from './prisma'
import { callAI, AIConfig, AIMessage } from './ai'
import { generateVariants, gradeVariant, selectBestVariant, saveVariantsToDatabase, Variant } from './variant-engine'
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
  status?: 'pending' | 'running' | 'completed' | 'failed'
  numVariants?: number | 'auto'
  stepsPerVariant?: number | 'auto'
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
  },
  {
    name: 'Planning',
    description: 'Create detailed implementation plan',
    prompt: `Create a detailed implementation plan based on the proposition.

Your tasks:
1. Break down the proposition into concrete steps
2. Define technical requirements and specifications
3. Consider variants and their trade-offs
4. Incorporate feedback from previous stages
5. Create a realistic and actionable plan

Be specific and practical in your planning.`,
    order: 2,
    isActive: true,
  },
  {
    name: 'Implementation',
    description: 'Execute the implementation based on plan',
    prompt: `Implement the solution based on the planning stage output.

Your tasks:
1. Execute the implementation plan
2. Write code, configure systems, or create artifacts
3. Address technical challenges as they arise
4. Incorporate all previous stage feedback
5. Produce a viable, working implementation

Focus on creating something that actually works.`,
    order: 3,
    isActive: true,
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

Be critical but fair in your assessment.`,
    order: 4,
    isActive: true,
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
  const messages = await generateStagePrompt(space, currentStage, previousExperiments)

  debugLog(`[executeResearchCycle] Calling AI for stage: ${currentStage.name}`)
  debugLog(`[executeResearchCycle] Agent: ${agent?.name} (${agent?.role}), Provider: ${serviceProvider?.provider}`)

  // Call AI
  let response
  try {
    debugLog(`[executeResearchCycle] About to call callAI, config:`, JSON.stringify({provider: agentConfig.provider, model: agentConfig.model, hasKey: !!agentConfig.apiKey}))
    response = await callAI(agentConfig, messages)
    debugLog(`[executeResearchCycle] AI call succeeded, tokens: ${response.tokensUsed}, cost: ${response.cost}`)
  } catch (error: any) {
    debugLog(`[executeResearchCycle] AI call failed:`, error.message)
    throw error
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
      result: response.content,
      metrics: JSON.stringify({
        stageId: currentStage.id,
        stageName: currentStage.name,
      }),
    },
  })

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
  updateExecutionState(spaceId, {
    currentStageId: nextStageId,
    currentPhase: currentStage.name,
    lastUpdated: new Date(),
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

async function executeVariant(variant: Variant, spaceId: string, stageName: string): Promise<Variant> {
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

  // Execute each step
  for (const step of variant.steps) {
    if (step.status === 'COMPLETED') continue

    const messages: AIMessage[] = [
      { role: 'system', content: `You are executing variant "${variant.name}" of stage "${stageName}".` },
      { role: 'user', content: `${step.description}\n\nResearch Goal: ${space.initialPrompt}\n\nExecute this step and provide results.` },
    ]

    try {
      const response = await callAI(agentConfig, messages)
      step.result = response.content
      step.status = 'COMPLETED'
      step.grade = Math.min(100, Math.max(0, Math.floor(response.tokensUsed / 10)))
      
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

async function generateStagePrompt(space: any, stage: ResearchStage, previousExperiments: any[]): Promise<AIMessage[]> {
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

  const fullPrompt = `${stage.prompt}${contextFromPrevious}${embeddingContext}

Research Goal: ${space.initialPrompt}

Execute your stage tasks thoroughly.`

  return [
    { role: 'system', content: 'You are an autonomous research agent. Be creative, thorough, and scientific.' },
    { role: 'user', content: fullPrompt },
  ]
}

async function processEvaluationResults(spaceId: string, content: string) {
  const confidenceMatch = content.match(/confidence[:\s]+([\d.]+)/i)
  const breakthroughMatch = content.match(/breakthrough[:\s]+(yes|true|definitely)/i)
  const goldNuggetMatch = content.match(/(gold nugget|breakthrough|major discovery)/i)

  if (breakthroughMatch || goldNuggetMatch) {
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.7

    await prisma.breakthrough.create({
      data: {
        spaceId,
        title: extractTitle(content),
        description: content.substring(0, 1000),
        category: 'EVALUATION',
        confidence,
        verified: confidence > 0.8,
      },
    })
  }
}

function extractTitle(content: string): string {
  const titleMatch = content.match(/^(?:Title:|Finding:|Breakthrough:)\s*(.+)$/im)
  if (titleMatch) {
    return titleMatch[1].trim().substring(0, 200)
  }
  return content.split('\n')[0].substring(0, 200) || 'New Finding'
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

      // Check if there are pending variants to execute
      if (state.variants && state.variants.length > 0) {
        const pendingVariant = state.variants.find(v => v.stageId === currentStageId && v.status === 'PENDING')
        if (pendingVariant) {
          debugLog(`[startBackgroundLoop] Executing pending variant ${pendingVariant.name}`)
          try {
            await executeVariantCycle(spaceId, pendingVariant.id)
            consecutiveErrors = 0
          } catch (err: any) {
            consecutiveErrors++
            debugLog(`[startBackgroundLoop] Variant execution failed: ${err.message}`)
          }
          scheduleNext()
          return
        }
      }

      // Execute next cycle
      debugLog(`[startBackgroundLoop] Executing cycle for stage ${currentStage?.name}`)
      try {
        await executeResearchCycle(spaceId, currentStageId)
        consecutiveErrors = 0
      } catch (err: any) {
        consecutiveErrors++
        const isTimeout = err.message?.includes('timeout')
        debugLog(`[startBackgroundLoop] Cycle failed (${consecutiveErrors}/${maxConsecutiveErrors}): ${err.message}`)

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
  updateExecutionState(spaceId, { isRunning: true })
  await prisma.space.update({
    where: { id: spaceId },
    data: { status: 'RUNNING' },
  })
}

export async function stopSpace(spaceId: string) {
  updateExecutionState(spaceId, { isRunning: false })
  clearExecutionState(spaceId)
  await prisma.space.update({
    where: { id: spaceId },
    data: { status: 'STOPPED' },
  })
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

  const stageConfig = {
    id: stageId,
    name: stage.name,
    numVariants,
    stepsPerVariant,
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
  await saveVariantsToDatabase(spaceId, stageId, variants)

  // Update execution state
  const state = getExecutionState(spaceId)
  if (state) {
    updateExecutionState(spaceId, { variants })
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

  // Execute the variant
  const executedVariant = await executeVariant(variant, spaceId, stage.name)

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
  runThinkingSetup(spaceId).catch(err => {
    console.error('[runThinkingSetupBackground] failed:', err.message);
  });
}
