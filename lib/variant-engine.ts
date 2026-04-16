import { prisma } from './prisma'
import { callAI, AIConfig } from './ai'
import fs from 'fs'

const logFile = '/tmp/ar1_debug.log'
function debugLog(...args: any[]) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  fs.appendFileSync(logFile, new Date().toISOString() + ' [VariantEngine] ' + msg + '\n')
  console.log('[VariantEngine]', ...args)
}

export interface Variant {
  id: string
  stageId: string
  name: string
  description: string
  steps: Step[]
  grade?: number
  feedback?: string
  userRating?: string
  isSelected: boolean
  order: number
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  createdAt: Date
}

export interface Step {
  id: string
  variantId: string
  name: string
  description: string
  order: number
  isAuto: boolean
  autoConfig?: {
    minSteps: number
    maxSteps: number
    targetQuality: number
  }
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'FAILED'
  result?: string
  grade?: number
  feedback?: string
  userRating?: string
}

export interface StageConfig {
  id: string
  name: string
  numVariants: number | 'auto'
  variantConfig?: {
    minVariants: number
    maxVariants: number
    targetQuality: number
  }
  stepsPerVariant: number | 'auto'
  stepConfig?: {
    minSteps: number
    maxSteps: number
    timeBudget?: number // in seconds
  }
}

export async function generateVariants(
  spaceId: string,
  stageId: string,
  stageConfig: StageConfig,
  initialPrompt: string,
  previousContext: string
): Promise<Variant[]> {
  // Get thinking agent
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    include: {
      user: { 
        include: { 
          agents: true,
          serviceProviders: true,
        }
      },
    },
  })

  if (!space) throw new Error('Space not found')

  const thinkingAgent = space.user.agents
    .filter(a => a.role === 'THINKING' && a.isActive)
    .sort((a, b) => a.order - b.order)[0]

  if (!thinkingAgent) throw new Error('No thinking agent configured')

  const serviceProvider = space.user.serviceProviders
    .find(sp => sp.id === thinkingAgent.serviceProviderId)

  if (!serviceProvider) throw new Error('Service provider not found')

  const agentConfig: AIConfig = {
    provider: serviceProvider.provider,
    apiKey: serviceProvider.apiKey,
    model: thinkingAgent.model,
  }

  // Determine number of variants
  let numVariants = stageConfig.numVariants
  if (numVariants === 'auto') {
    try {
      const prompt = `
Research Goal: ${initialPrompt}
Stage: ${stageConfig.name}
Previous Context: ${previousContext}

Determine the optimal number of variants to explore for this stage.
Consider:
- Complexity of the research goal
- Time constraints
- Quality requirements
- Resources available

Respond with just a number between 2-5.`

      const response = await callAI(agentConfig, [
        { role: 'user', content: prompt },
      ])

      const match = response.content.match(/\d+/)
      numVariants = match ? Math.min(Math.max(parseInt(match[0]), 2), 5) : 3
    } catch (err: any) {
      debugLog(`[generateVariants] Failed to determine variant count via AI, using 3: ${err.message}`)
      numVariants = 3
    }
  }

  // Generate variant descriptions
  const variants: Variant[] = []
  for (let i = 0; i < numVariants; i++) {
    const variantPrompt = `
Research Goal: ${initialPrompt}
Stage: ${stageConfig.name}
Variant ${i + 1} of ${numVariants}

Generate a unique approach/variant for this stage.
Each variant should explore a different angle or methodology.

Provide:
1. Variant name (short, descriptive)
2. Description (what this variant explores)
3. List of steps to execute (3-7 steps)

Format:
Name: [variant name]
Description: [description]
Steps:
1. [step 1]
2. [step 2]
...`

    const response = await callAI(agentConfig, [
      { role: 'user', content: variantPrompt },
    ])

    // Parse response - robust parsing with fallbacks
    const nameMatch = response.content.match(/Name:\s*(.+?)(?:\n|$)/i)
    const descMatch = response.content.match(/Description:\s*([\s\S]+?)(?:\n\n|\nSteps:|$)/i)
    const stepsMatch = response.content.match(/Steps:\s*([\s\S]+)/i)

    const name = nameMatch ? nameMatch[1].trim() : `Variant ${i + 1}`
    const description = descMatch ? descMatch[1].trim() : 'Exploration variant'

    // Parse steps - robust with multiple fallback strategies
    let steps: Step[] = []
    if (stepsMatch && stepsMatch[1].trim()) {
      const stepLines = stepsMatch[1].split('\n').filter(l => l.trim())
      steps = stepLines.map((line, idx) => {
        const stepText = line.replace(/^\d+[\.\)]\s*/, '').trim()
        return {
          id: `step_${Date.now()}_${i}_${idx}`,
          variantId: '',
          name: stepText.substring(0, 60) || `Step ${idx + 1}`,
          description: stepText,
          order: idx,
          isAuto: true,
          status: 'PENDING',
        }
      })
    }

    // Fallback: if no steps parsed, generate default steps based on stage
    if (steps.length === 0) {
      const defaultStepTemplates: Record<string, string[]> = {
        'Investigation': ['Research background and context', 'Identify key concepts and relationships', 'Find gaps in existing approaches', 'Document findings', 'Prepare investigation summary'],
        'Proposition': ['Synthesize investigation insights', 'Formulate hypothesis', 'Identify potential solutions', 'Evaluate novelty of approaches', 'Draft proposition statement'],
        'Planning': ['Analyze requirements and constraints', 'Break down into actionable tasks', 'Define success criteria', 'Estimate resource needs', 'Create implementation timeline'],
        'Implementation': ['Set up development environment', 'Implement core functionality', 'Add error handling', 'Test the implementation', 'Refine and optimize'],
        'Testing': ['Design test cases', 'Execute test suite', 'Analyze test results', 'Document failures and issues', 'Prepare test report'],
        'Verification': ['Review testing methodology', 'Verify reproducibility', 'Cross-check results', 'Validate assumptions', 'Confirm verification verdict'],
        'Evaluation': ['Aggregate all stage results', 'Assess overall quality', 'Identify breakthrough potential', 'Rate confidence level', 'Prepare evaluation summary'],
      }
      const templates = defaultStepTemplates[stageConfig.name] || ['Define approach', 'Execute investigation', 'Analyze results', 'Document findings', 'Prepare next steps']
      steps = templates.map((desc, idx) => ({
        id: `step_${Date.now()}_${i}_${idx}`,
        variantId: '',
        name: desc.substring(0, 60),
        description: desc,
        order: idx,
        isAuto: true,
        status: 'PENDING',
      }))
    }

    // If auto mode for steps, configure range
    const numSteps = stageConfig.stepsPerVariant
    if (numSteps === 'auto') {
      steps.forEach(step => {
        step.isAuto = true
        step.autoConfig = {
          minSteps: stageConfig.stepConfig?.minSteps || 3,
          maxSteps: stageConfig.stepConfig?.maxSteps || 7,
          targetQuality: 80,
        }
      })
    } else {
      // Ensure we have at least numSteps
      while (steps.length < (numSteps as number)) {
        steps.push({
          id: `step_${Date.now()}_${i}_${steps.length}`,
          variantId: '',
          name: `Additional step ${steps.length + 1}`,
          description: `Additional exploration for variant ${i + 1}`,
          order: steps.length,
          isAuto: true,
          status: 'PENDING',
        })
      }
      steps = steps.slice(0, numSteps as number)
      steps.forEach(step => {
        step.isAuto = false
      })
    }

    variants.push({
      id: `variant_${Date.now()}_${i}`,
      stageId,
      name,
      description,
      steps,
      isSelected: false,
      order: i,
      status: 'PENDING',
      createdAt: new Date(),
    })
  }

  return variants
}

export async function gradeVariant(
  variant: Variant,
  spaceId: string,
  stageName: string
): Promise<{ grade: number; feedback: string }> {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    include: {
      user: { 
        include: { 
          agents: true,
          serviceProviders: true,
        }
      },
    },
  })

  if (!space) throw new Error('Space not found')

  // Get grading/evaluation agent
  const gradingAgent = space.user.agents
    .filter(a => ['EVALUATION', 'GRADING'].includes(a.role) && a.isActive)
    .sort((a, b) => a.order - b.order)[0]

  if (!gradingAgent) throw new Error('No grading agent configured')

  const serviceProvider = space.user.serviceProviders
    .find(sp => sp.id === gradingAgent.serviceProviderId)

  if (!serviceProvider) throw new Error('Service provider not found')

  const agentConfig: AIConfig = {
    provider: serviceProvider.provider,
    apiKey: serviceProvider.apiKey,
    model: gradingAgent.model,
  }

  const prompt = `
Grade this variant execution for stage: ${stageName}

Variant: ${variant.name}
Description: ${variant.description}
Steps Completed: ${variant.steps.filter(s => s.status === 'COMPLETED').length}/${variant.steps.length}

Results:
${variant.steps.map(s => `- ${s.name}: ${s.result || 'No result'}`).join('\n')}

Provide:
1. Grade (1-100, where 100 is perfect)
2. Detailed feedback on what worked and what didn't
3. Key learnings from this variant
4. Recommendation for next stages

Format:
Grade: [number]
Feedback: [detailed feedback]
Learnings: [key insights]
Recommendation: [suggestion]`

  const defaultGradingPrompt = 'You are an expert research grading agent. Evaluate variants rigorously and provide constructive feedback. Focus on the quality of actual results produced, not on the presence of reasoning. Score based on: scientific merit, concrete output quality, reproducibility, and relevance to the research goal.'
  const systemPrompt = gradingAgent.systemPrompt || defaultGradingPrompt

  const response = await callAI(agentConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ])

  const gradeMatch = response.content.match(/Grade:\s*(\d+)/i)
  const feedbackMatch = response.content.match(/Feedback:\s*([\s\S]+?)(?:\nLearnings:|$)/i)

  return {
    grade: gradeMatch ? parseInt(gradeMatch[1]) : 50,
    feedback: feedbackMatch ? feedbackMatch[1].trim() : response.content,
  }
}

export async function selectBestVariant(variants: Variant[]): Promise<Variant> {
  // Filter completed variants
  const completed = variants.filter(v => v.status === 'COMPLETED')
  
  if (completed.length === 0) {
    throw new Error('No completed variants to select from')
  }

  // Select highest graded, considering user ratings
  const scored = completed.map(v => {
    let score = v.grade || 50
    
    // Boost if user rated positively
    if (v.userRating === 'thumbs_up') score += 10
    if (v.userRating === 'thumbs_down') score -= 20
    
    // Average step grades
    const stepGrades = v.steps.filter(s => s.grade).map(s => s.grade!)
    if (stepGrades.length > 0) {
      const avgStepGrade = stepGrades.reduce((a, b) => a + b, 0) / stepGrades.length
      score = (score + avgStepGrade) / 2
    }
    
    return { variant: v, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0].variant
}

// Save variants to DB as first-class entities
export async function saveVariantsToDatabase(
  spaceId: string,
  stageId: string,
  stageName: string,
  variants: Variant[],
  cycleNumber: number = 1
) {
  // Delete any existing variants for this stage/cycle to avoid duplicates on re-run
  await prisma.variant.deleteMany({
    where: { spaceId, stageId, cycleNumber },
  })

  // Create each variant with its steps
  for (const variant of variants) {
    await prisma.variant.create({
      data: {
        id: variant.id,
        spaceId,
        stageId,
        stageName,
        cycleNumber,
        name: variant.name,
        description: variant.description,
        grade: variant.grade,
        feedback: variant.feedback,
        userRating: variant.userRating,
        isSelected: variant.isSelected,
        order: variant.order,
        status: variant.status,
        steps: {
          create: variant.steps.map(step => ({
            id: step.id,
            name: step.name,
            description: step.description,
            order: step.order,
            result: step.result,
            grade: step.grade,
            feedback: step.feedback,
            userRating: step.userRating,
            status: step.status,
            isAuto: step.isAuto,
            autoConfig: step.autoConfig ? JSON.stringify(step.autoConfig) : null,
          })),
        },
      },
    })
  }
}

// Load variants from DB for a space
export async function loadVariantsFromDb(spaceId: string, stageId?: string): Promise<Variant[]> {
  const where = stageId ? { spaceId, stageId } : { spaceId }
  const dbVariants = await prisma.variant.findMany({
    where,
    include: { steps: { orderBy: { order: 'asc' } } },
    orderBy: [{ cycleNumber: 'desc' }, { order: 'asc' }],
  })

  return dbVariants.map(v => ({
    id: v.id,
    stageId: v.stageId,
    name: v.name,
    description: v.description || '',
    stageName: v.stageName,
    cycleNumber: v.cycleNumber,
    grade: v.grade || undefined,
    feedback: v.feedback || undefined,
    userRating: v.userRating || undefined,
    isSelected: v.isSelected,
    order: v.order,
    status: v.status as Variant['status'],
    createdAt: v.createdAt,
    steps: v.steps.map(s => ({
      id: s.id,
      variantId: s.variantId,
      name: s.name,
      description: s.description || '',
      order: s.order,
      result: s.result || undefined,
      grade: s.grade || undefined,
      feedback: s.feedback || undefined,
      userRating: s.userRating || undefined,
      isAuto: s.isAuto,
      autoConfig: s.autoConfig ? JSON.parse(s.autoConfig) : undefined,
      status: s.status as Step['status'],
    })),
  }))
}

// Update a single variant step in DB
export async function updateVariantStepDb(
  stepId: string,
  updates: { result?: string; grade?: number; feedback?: string; status?: string }
) {
  await prisma.variantStep.update({
    where: { id: stepId },
    data: updates,
  })
}

// Update variant grade/rating in DB
export async function updateVariantDb(
  variantId: string,
  updates: { grade?: number; feedback?: string; userRating?: string; isSelected?: boolean; status?: string }
) {
  await prisma.variant.update({
    where: { id: variantId },
    data: updates,
  })
}

// Select best variant from DB (factors in userRatings)
export async function selectBestVariantFromDb(spaceId: string, stageId: string): Promise<Variant | null> {
  const variants = await loadVariantsFromDb(spaceId, stageId)
  const completed = variants.filter(v => v.status === 'COMPLETED')
  if (completed.length === 0) return null

  const scored = completed.map(v => {
    let score = v.grade || 50
    if (v.userRating === 'thumbs_up') score += 10
    if (v.userRating === 'thumbs_down') score -= 20
    const stepGrades = v.steps.filter(s => s.grade).map(s => s.grade!)
    if (stepGrades.length > 0) {
      score = (score + stepGrades.reduce((a, b) => a + b, 0) / stepGrades.length) / 2
    }
    return { variant: v, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.variant || null
}

export async function updateVariantGrade(
  variantId: string,
  grade: number,
  feedback: string,
  userRating?: string
) {
  await prisma.variant.update({
    where: { id: variantId },
    data: { grade, feedback, userRating },
  })
}
