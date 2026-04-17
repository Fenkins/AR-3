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
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PENDING_REVIEW'
  cacheDownloads?: string | null
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
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'PENDING_REVIEW'
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
  const maxRetries = 2
  const numStepsTarget = typeof stageConfig.stepsPerVariant === 'number' ? stageConfig.stepsPerVariant : 25

  for (let i = 0; i < numVariants; i++) {
    let name = `Variant ${i + 1}`
    let description = 'Exploration variant'
    let steps: Step[] = []
    let qualityFailed = false
    let cacheDownloads: Array<{fileName: string, downloadUrl: string, description: string}> = []

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptLabel = attempt === 0 ? '' : ` (retry ${attempt})`
      const variantPrompt = `
You are a research planning assistant. Generate a detailed research plan for the goal below.

RESEARCH GOAL: ${initialPrompt}
STAGE: ${stageConfig.name}
VARIANT NUMBER: ${i + 1} of ${numVariants}

CRITICAL — MODEL CACHE: Before generating steps, identify any models, datasets, or large files needed for IMPLEMENTATION, TESTING, or VERIFICATION of this variant. List them in the first 1-2 steps using the CACHE_DOWNLOAD format below.

Respond ONLY with the following exact format. Do not include any explanatory text before or after.

VARIANT_NAME: <write a short descriptive name, 5-15 words, specific to the research goal above>
VARIANT_DESCRIPTION: <write 2-3 sentences describing what this variant explores and why it differs from other approaches. Be specific to the research goal.>
CACHE_DOWNLOADS:
- <model_or_file_name> | <huggingface_url_or_download_link> | <what_this_file_is_used_for>
(If no downloads needed, write: NONE)
STEPS:
1. <write a concrete, specific step relevant to the research goal>
2. <write a concrete, specific step with distinct actions or analysis>
3. <write a concrete, specific step with expected outputs>
4. <write a concrete, specific step>
5. <write a concrete, specific step>
6. <write a concrete, specific step>
7. <write a concrete, specific step>
8. <write a concrete, specific step>
9. <write a concrete, specific step>
10. <write a concrete, specific step>
11. <write a concrete, specific step>
12. <write a concrete, specific step>
13. <write a concrete, specific step>
14. <write a concrete, specific step>
15. <write a concrete, specific step>

IMPORTANT: Replace ALL placeholders above with real content. Each step must be specific, non-generic, and directly relevant to "${initialPrompt}". Do NOT write placeholder text like "<write a step>" or "Continue with more steps". Do NOT write generic steps like "Download and install dependencies" without specifying actual URLs.`

      const response = await callAI(agentConfig, [
        { role: 'user', content: variantPrompt },
      ])

      // Parse response — support both old format (Name:/Description:/Steps:) and new format with CACHE_DOWNLOADS
      const nameMatch = response.content.match(/VARIANT_NAME:\s*(.+?)(?:\n|$)/i)
      const descMatch = response.content.match(/VARIANT_DESCRIPTION:\s*([\s\S]+?)(?:\nCACHE_DOWNLOADS:|\nSTEPS:|\n\n|$)/i)
      const cacheMatch = response.content.match(/CACHE_DOWNLOADS:\s*([\s\S]+?)(?:\nSTEPS:|$)/i)
      const stepsMatch = response.content.match(/STEPS:\s*([\s\S]+)/i)

      // Parse cache downloads
      cacheDownloads = []
      if (cacheMatch) {
        const cacheSection = cacheMatch[1].trim()
        if (!/^none$/i.test(cacheSection)) {
          const lines = cacheSection.split('\n').filter(l => l.trim().startsWith('- '))
          for (const line of lines) {
            const parts = line.substring(2).split('|').map(p => p.trim())
            if (parts.length >= 3) {
              cacheDownloads.push({ fileName: parts[0], downloadUrl: parts[1], description: parts[2] })
            }
          }
        }
      }

      const parsedName = nameMatch ? nameMatch[1].trim() : ''
      const parsedDesc = descMatch ? descMatch[1].trim() : ''

      // Quality validation — reject leftover placeholders or generic junk
      const hasBrackets = /<[^>]+>|\[[^\]]+\]/.test(parsedName) || /<[^>]+>|\[[^\]]+\]/.test(parsedDesc) || /<[^>]+>|\[[^\]]+\]/.test(stepsMatch?.[1] || '')
      const isGenericName = /^(variant|step|ok|undefined|null|a specific|a 2-3|continue|write|placeholder|example|sample)$/i.test(parsedName)
      const nameOk = parsedName.length >= 8 && parsedName.length <= 80 && !hasBrackets && !isGenericName
      const descOk = parsedDesc.length >= 30 && !hasBrackets && !/<write|continue|placeholder/i.test(parsedDesc)
      const stepsRaw = stepsMatch?.[1] || ''
      const stepsOk = stepsRaw.length > 100 && !/<write|continue|placeholder|example/i.test(stepsRaw) && !/\[step \d+\]/i.test(stepsRaw)

      if (nameOk && descOk && stepsOk) {
        name = parsedName
        description = parsedDesc
        // Parse steps
        const rawSteps = stepsMatch ? stepsMatch[1] : ''
        const stepLines = rawSteps.split('\n').filter(l => l.trim() && l.trim().length > 3)
        steps = stepLines.slice(0, numStepsTarget).map((line, idx) => ({
          id: `step_${Date.now()}_${i}_${idx}`,
          variantId: '',
          name: line.replace(/^\d+[\.\)]\s*/, '').trim().substring(0, 80) || `Step ${idx + 1}`,
          description: line.replace(/^\d+[\.\)]\s*/, '').trim(),
          order: idx,
          isAuto: false,
          status: 'PENDING',
        }))
        break // quality OK, move on
      } else {
        debugLog(`[generateVariants] Variant ${i + 1} quality check failed (attempt ${attempt + 1}): nameOk=${nameOk} descOk=${descOk} stepsOk=${stepsOk}, content="${response.content.substring(0, 100)}"`)
        if (attempt === maxRetries) {
          // Mark as pending review
          qualityFailed = true
          name = `Variant ${i + 1} (pending review)`
          description = parsedDesc || 'Variant requires review — generated content was below quality threshold'
          steps = Array.from({ length: Math.min(numStepsTarget, 5) }, (_, idx) => ({
            id: `step_${Date.now()}_${i}_${idx}`,
            variantId: '',
            name: `Step ${idx + 1} — processing pending`,
            description: 'Step content pending — quality check failed during generation',
            order: idx,
            isAuto: true,
            status: 'PENDING_REVIEW',
          }))
        }
      }
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

    // Pad to target number of steps if needed (only when quality was good)
    if (!qualityFailed) {
      while (steps.length < numStepsTarget) {
        steps.push({
          id: `step_${Date.now()}_${i}_${steps.length}`,
          variantId: '',
          name: `Step ${steps.length + 1} — additional exploration`,
          description: `Additional exploration for variant ${i + 1}`,
          order: steps.length,
          isAuto: true,
          status: 'PENDING',
        })
      }
      steps = steps.slice(0, numStepsTarget)
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
      status: qualityFailed ? 'PENDING_REVIEW' : 'PENDING',
      cacheDownloads: cacheDownloads.length > 0 ? JSON.stringify(cacheDownloads) : null,
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

  // Get grading agent (GRADING role only — separate from EVALUATION which is for the stage)
  const gradingAgent = space.user.agents
    .filter(a => a.role === 'GRADING' && a.isActive)
    .sort((a, b) => a.order - b.order)[0]

  if (!gradingAgent) throw new Error('No Grading Agent configured — please add a Grading Agent in the Agents panel')

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
        cacheDownloads: variant.cacheDownloads || null,
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
