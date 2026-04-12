import { prisma } from './prisma'
import { callAI, AIConfig } from './ai'

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

    // Parse response
    const nameMatch = response.content.match(/Name:\s*(.+?)(?:\n|$)/i)
    const descMatch = response.content.match(/Description:\s*([\s\S]+?)(?:\n\n|\nSteps:|$)/i)
    const stepsMatch = response.content.match(/Steps:\s*([\s\S]+)/i)

    const name = nameMatch ? nameMatch[1].trim() : `Variant ${i + 1}`
    const description = descMatch ? descMatch[1].trim() : 'Exploration variant'
    
    // Parse steps
    let steps: Step[] = []
    if (stepsMatch) {
      const stepLines = stepsMatch[1].split('\n').filter(l => l.trim())
      steps = stepLines.map((line, idx) => {
        const stepText = line.replace(/^\d+[\.\)]\s*/, '').trim()
        return {
          id: `step_${Date.now()}_${idx}`,
          variantId: '', // Will be set after variant creation
          name: stepText.substring(0, 50) || `Step ${idx + 1}`,
          description: stepText,
          order: idx,
          isAuto: true,
          status: 'PENDING',
        }
      })
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
      // Use exact number from config
      steps = steps.slice(0, numSteps)
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

  const response = await callAI(agentConfig, [
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

export async function saveVariantsToDatabase(
  spaceId: string,
  stageId: string,
  variants: Variant[]
) {
  // Store variants in experiment metadata
  const experiment = await prisma.experiment.create({
    data: {
      spaceId,
      phase: `VARIANTS_${stageId}`,
      agentId: 'system',
      agentName: 'Variant Generator',
      prompt: JSON.stringify({ stageId, numVariants: variants.length }),
      response: JSON.stringify(variants),
      status: 'COMPLETED',
      metrics: JSON.stringify({
        type: 'variants',
        stageId,
        variants: variants.map(v => ({
          id: v.id,
          name: v.name,
          numSteps: v.steps.length,
        })),
      }),
    },
  })

  return experiment
}

export async function updateVariantGrade(
  experimentId: string,
  grade: number,
  feedback: string,
  userRating?: string
) {
  await prisma.experiment.update({
    where: { id: experimentId },
    data: {
      grade,
      feedback,
      userRating,
    },
  })
}
