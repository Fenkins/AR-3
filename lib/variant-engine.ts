import { prisma } from './prisma'
import { callAI, AIConfig, AIResponse } from './ai'
import fs from 'fs'

const logFile = '/tmp/ar1_debug.log'
function debugLog(...args: any[]) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  fs.appendFileSync(logFile, new Date().toISOString() + ' [VariantEngine] ' + msg + '\n')
  console.log('[VariantEngine]', ...args)
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

/** Sleep helper for retry backoff */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface DiscoveredModel {
  id: string
  url: string
  downloadUrl: string
  fileName?: string
  downloads?: number
  likes?: number
  tags?: string[]
}

/** Search HuggingFace for relevant models via direct internal search service call */
async function searchModels(query: string, limit = 5): Promise<DiscoveredModel[]> {
  try {
    const url = `http://127.0.0.1:4000/search?q=${encodeURIComponent(query)}&source=hf&limit=${limit}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      debugLog(`[searchModels] Search service returned ${res.status}`)
      return []
    }
    const data = await res.json()
    let results = Array.isArray(data) ? data : []
    // If multi-word query returns 0, fall back to word-by-word and merge
    if (results.length === 0 && query.includes(' ')) {
      const seen = new Set<string>()
      for (const word of query.split(' ')) {
        if (!word || seen.has(word)) continue
        seen.add(word)
        const url2 = `http://127.0.0.1:4000/search?q=${encodeURIComponent(word)}&source=hf&limit=${limit}`
        const res2 = await fetch(url2, { signal: AbortSignal.timeout(15000) })
        if (!res2.ok) continue
        const data2 = await res2.json()
        if (Array.isArray(data2)) {
          results = results.concat(data2)
        }
      }
      // Deduplicate by id
      const seenIds = new Set<string>()
      results = results.filter(r => {
        const id = r.id || r.model_name
        if (seenIds.has(id)) return false
        seenIds.add(id)
        return true
      })
    }
    return results.slice(0, limit).map((m: any) => ({
      id: m.id || m.model_name || '',
      url: m.url || `https://huggingface.co/${m.id || m.model_name}`,
      downloadUrl: m.download_url || m.downloadUrl || `https://huggingface.co/${m.id || m.model_name}`,
      fileName: m.file_name || m.id?.split('/').pop() || 'model',
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      tags: Array.isArray(m.tags) ? m.tags : [],
    }))
  } catch (err: any) {
    debugLog(`[searchModels] Error: ${err.message}`)
    return []
  }
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
  // Self-evolution fields from grading agent
  failureMode?: string
  approachVerdict?: string
  gradingWarning?: string
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
      User: {
        include: {
          Agent: true,
          ServiceProvider: true,
        }
      },
    },
  })

  if (!space) throw new Error('Space not found')

  const thinkingAgent = space.User.Agent
    .filter(a => a.role === 'THINKING' && a.isActive)
    .sort((a, b) => a.order - b.order)[0]

  if (!thinkingAgent) throw new Error('No thinking agent configured')

  const serviceProvider = space.User.ServiceProvider
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

  const variants: Variant[] = []
  const maxRetries = 2
  const numStepsTarget = typeof stageConfig.stepsPerVariant === 'number' ? stageConfig.stepsPerVariant : 25

  // Discover relevant models before generating variants
  const discoveredModels = await searchModels(initialPrompt)

  const modelListSection = discoveredModels.length > 0
    ? `\n\n## AVAILABLE MODELS FOR DOWNLOAD\nThe following HuggingFace models are available — use their download URLs in the downloads field if needed:\n${
    discoveredModels.map(m => `- ${m.downloadUrl || m.url}  (${m.downloads?.toLocaleString() || 0} downloads, file: ${m.fileName || 'see URL'})`).join('\n')}
`
    : ''

  for (let i = 0; i < numVariants; i++) {
    let name = `Variant ${i + 1}`
    let description = 'Exploration variant'
    let steps: Step[] = []
    let qualityFailed = false
    let cacheDownloads: Array<{fileName: string, downloadUrl: string, description: string}> = []

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptLabel = attempt === 0 ? '' : ` (retry ${attempt})`
      if (attempt > 0) {
        const backoffMs = 60000 * Math.pow(2, attempt - 1)
        debugLog(`[generateVariants] Variant ${i + 1} backing off ${backoffMs}ms before retry ${attempt}`)
        await sleep(backoffMs)
      }

      // Structured prompt: use section markers to prevent header duplication
      const variantPrompt = `
You are a research planning assistant. Generate a detailed research plan.

RESEARCH GOAL: ${initialPrompt}
STAGE: ${stageConfig.name}
VARIANT NUMBER: ${i + 1} of ${numVariants}

IMPORTANT: Follow this EXACT format. Write ONLY the sections below. Do NOT repeat headers. Do NOT include anything outside the marked sections.

## METADATA
name: <2-4 word specific name for this variant, be concrete and specific to the research goal above>
description: <2-3 sentences describing what this variant explores and why it differs from other approaches>
downloads: <Use download URLs from AVAILABLE MODELS section above, or "none" if not needed — IMPORTANT: only use URLs provided above>

## STEPS
step_1: <imperative sentence — specific action with concrete goal>
step_2: <imperative sentence — distinct action or analysis>
step_3: <imperative sentence — include expected output or result>
step_4: <imperative sentence>
step_5: <imperative sentence>
step_6: <imperative sentence>
step_7: <imperative sentence>
step_8: <imperative sentence>
step_9: <imperative sentence>
step_10: <imperative sentence>
step_11: <imperative sentence>
step_12: <imperative sentence>
step_13: <imperative sentence>
step_14: <imperative sentence>
step_15: <imperative sentence>
step_16: <imperative sentence>
step_17: <imperative sentence>
step_18: <imperative sentence>
step_19: <imperative sentence>
step_20: <imperative sentence>
step_21: <imperative sentence>
step_22: <imperative sentence>
step_23: <imperative sentence>
step_24: <imperative sentence>
step_25: <imperative sentence>

CRITICAL: You MUST generate AT LEAST ${numStepsTarget} steps. Replace ALL step placeholders with real content. Each step must be a concrete action sentence relevant to "${initialPrompt}". Do not stop before step_25.${modelListSection}`

      let response: AIResponse
      try {
        response = await withTimeout(
          callAI(agentConfig, [{ role: 'user', content: variantPrompt }]),
          300000,
          `variant ${i + 1} attempt ${attempt + 1}`
        )
      } catch (err: any) {
        const isTimeout = err.message?.includes('Timeout')
        debugLog(`[generateVariants] Variant ${i + 1} ${isTimeout ? 'timed out' : 'failed'} (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`)
        if (attempt === maxRetries) qualityFailed = true
        continue
      }

      const content = response.content

      // Parse name
      const nameMatch = content.match(/^name:\s*(.+)$/im) || content.match(/VARIANT_NAME:\s*(.+?)(?:\n|$)/i)
      const parsedName = nameMatch ? nameMatch[1].trim() : ''

      // Parse description
      const descMatch = content.match(/^description:\s*([\s\S]+?)(?:^downloads:|^## |^step_|_metadata)/im)
      const parsedDesc = descMatch ? descMatch[1].trim() : ''

      // Parse downloads
      const dlMatch = content.match(/^downloads:\s*([\s\S]+?)(?:^## STEPS|^step_|_steps)/im)
      if (dlMatch) {
        const dlText = dlMatch[1].trim()
        if (!/^none$/i.test(dlText)) {
          const urls = Array.from(dlText.matchAll(/(https?:\/\/[^\s\n,]+)/g), (m: RegExpMatchArray) => m[1])
          for (const url of urls.slice(0, 5)) {
            const label = url.split('/').pop() || url
            cacheDownloads.push({ fileName: label, downloadUrl: url, description: label })
          }
        }
      }

      // Parse step_N lines
      const stepMap = new Map<number, string>()
      for (const m of Array.from(content.matchAll(/^step_(\d+):\s*(.+)$/gm))) {
        const n = parseInt(m[1])
        const txt = m[2].trim()
        // Only keep the last occurrence of each step number
        stepMap.set(n, txt)
      }
      const parsedSteps = Array.from(stepMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)

      // Quality checks
      const hasPlaceholderBrackets = /<(write|placeholder|example|[xyz]+)>/i.test(parsedName) || /<(write|placeholder|example|[xyz]+)>/i.test(parsedDesc)
      const isGenericName = /^(variant|step|ok|undefined|null|\[.*\]|a specific|a 2-3|additional exploration)$/i.test(parsedName)
      const nameOk = parsedName.length >= 5 && parsedName.length <= 80 && !hasPlaceholderBrackets && !isGenericName
      const descOk = parsedDesc.length >= 20

      // Step quality: require >= 5 real steps, no placeholders, no duplicated header artifacts
      const badStepPatterns = /^(write|placeholder|example|continue|additional exploration|null|undefined|step \d|<)/i
      const validSteps = parsedSteps.filter(s => s.length > 10 && !badStepPatterns.test(s))
      const stepsOk = validSteps.length >= 5

      debugLog(`[generateVariants] Variant ${i + 1} attempt ${attempt + 1}: nameOk=${nameOk}(${parsedName.substring(0,25)}), descOk=${descOk}, stepsOk=${stepsOk}(${validSteps.length} valid of ${parsedSteps.length} parsed)`)

      if (nameOk && descOk && stepsOk) {
        name = parsedName
        description = parsedDesc
        steps = validSteps.slice(0, numStepsTarget).map((text, idx) => ({
          id: `step_${Date.now()}_${i}_${idx}`,
          variantId: '',
          name: text.substring(0, 80),
          description: text,
          order: idx,
          isAuto: false,
          status: 'PENDING',
        }))
        break
      } else {
        debugLog(`[generateVariants] Variant ${i + 1} failed quality: content preview="${content.substring(0, 150).replace(/\n/g, ' ')}"`)
        if (attempt === maxRetries) {
          qualityFailed = true
          name = `Variant ${i + 1} (needs review)`
          description = parsedDesc || 'Generated content did not meet quality bar — review required'
          steps = validSteps.slice(0, numStepsTarget).map((text, idx) => ({
            id: `step_${Date.now()}_${i}_${idx}`,
            variantId: '',
            name: text.substring(0, 80) || `Step ${idx + 1}`,
            description: text,
            order: idx,
            isAuto: true,
            status: 'PENDING_REVIEW',
          }))
        }
      }
    }

    // Fallback: if steps still empty after retries, use stage-specific defaults
    if (steps.length === 0) {
      const defaults: Record<string, string[]> = {
        Investigation: ['Survey existing ODE and diffusion model literature', 'Identify gaps in multi-model latent approaches', 'Catalog available open-source implementations', 'Define evaluation metrics for latent synchronization', 'Outline experimental setup'],
        Proposition: ['Synthesize findings from investigation', 'Formulate core hypothesis for this variant', 'Identify the most promising theoretical angle', 'Draft proposition narrative', 'Submit for review'],
        Planning: ['Analyze requirements and resource constraints', 'Design implementation architecture', 'Sequence tasks by dependency', 'Define success criteria and baselines', 'Create implementation timeline'],
        Implementation: ['Set up development environment', 'Implement core latent synchronization mechanism', 'Add GPU-accelerated diffusion sampling', 'Integrate multi-model coordination layer', 'Verify basic functionality'],
        Testing: ['Design quantitative evaluation benchmarks', 'Run inference comparisons across model variants', 'Measure synchronization quality metrics', 'Document performance results', 'Identify failure modes'],
        Verification: ['Reproduce key experimental results', 'Cross-check with alternative implementations', 'Validate against theoretical predictions', 'Confirm reproducibility of claims', 'Summarize verification findings'],
        Evaluation: ['Aggregate results from all test variants', 'Assess novelty and breakthrough potential', 'Compare against published baselines', 'Rate overall quality and readiness', 'Prepare evaluation summary'],
      }
      const stageKey = stageConfig.name as keyof typeof defaults
      const templates = defaults[stageKey] || ['Analyze requirements', 'Design approach', 'Execute plan', 'Evaluate results', 'Document findings']
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

    // Truncate to target step count
    if (steps.length > numStepsTarget) {
      steps = steps.slice(0, numStepsTarget)
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
): Promise<{ grade: number; feedback: string; failureMode: string; approachVerdict: string; warning: string }> {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    include: {
      User: {
        include: {
          Agent: true,
          ServiceProvider: true,
        }
      },
    },
  })

  if (!space) throw new Error('Space not found')

  // Get grading agent (GRADING role only — separate from EVALUATION which is for the stage)
  const gradingAgent = space.User.Agent
    .filter(a => a.role === 'GRADING' && a.isActive)
    .sort((a, b) => a.order - b.order)[0]

  if (!gradingAgent) throw new Error('No Grading Agent configured — please add a Grading Agent in the Agents panel')

  const serviceProvider = space.User.ServiceProvider
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

Provide a structured evaluation:

1. Grade (1-100, where 100 is perfect)
2. Detailed feedback on what worked and what didn't
3. Key learnings from this variant
4. Recommendation for next stages
5. FAILURE MODE CLASSIFICATION — this is critical for self-evolution:
   - MODE_COLLAPSE: outputs converged to a single mode or degenerate output
   - GRADIENT_EXPLOSION: training diverged, loss went to infinity or NaN
   - WRONG_DIRECTION: technically ran but didn't address the research goal
   - PARTIAL_SUCCESS: addressed some sub-goals but missed the main objective
   - IMPLEMENTATION_BUG: code ran but had logical/mathematical errors
   - RESOURCE_EXHAUSTION: ran out of memory/time/compute
   - NOVEL_APPROACH: unexpected positive result — potential breakthrough signal
6. APPROACH VERDICT: Was the underlying approach/proposition correct?
   - SOUND: The approach was right, implementation had issues
   - FLAWED: The approach itself was wrong or poorly conceived
   - PARTIALLY_RIGHT: Some aspects right, others wrong
   - TOO_EARLY: Right approach but premature — needs more fundamental work
7. SPECIFIC WARNING for future cycles (1 sentence — what to explicitly avoid)

Format:
Grade: [number]
Feedback: [detailed feedback]
Learnings: [key insights]
Recommendation: [suggestion]
FailureMode: [MODE_COLLAPSE/GRADIENT_EXPLOSION/WRONG_DIRECTION/PARTIAL_SUCCESS/IMPLEMENTATION_BUG/RESOURCE_EXHAUSTION/NOVEL_APPROACH/NONE]
ApproachVerdict: [SOUND/FLAWED/PARTIALLY_RIGHT/TOO_EARLY]
Warning: [1-sentence warning for next cycle's Proposition/Planning]`

  const defaultGradingPrompt = 'You are an expert research grading agent. Evaluate variants rigorously and provide constructive feedback. Focus on the quality of actual results produced, not on the presence of reasoning. Score based on: scientific merit, concrete output quality, reproducibility, and relevance to the research goal.'
  const systemPrompt = gradingAgent.systemPrompt || defaultGradingPrompt

  const response = await callAI(agentConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ])

  const gradeMatch = response.content.match(/Grade:\s*(\d+)/i)
  const feedbackMatch = response.content.match(/Feedback:\s*([\s\S]+?)(?:\nLearnings:|$)/i)
  const failureModeMatch = response.content.match(/FailureMode:\s*(\w+)/i)
  const approachVerdictMatch = response.content.match(/ApproachVerdict:\s*(\w+)/i)
  const warningMatch = response.content.match(/Warning:\s*([^\n]+)/i)

  return {
    grade: gradeMatch ? parseInt(gradeMatch[1]) : 50,
    feedback: feedbackMatch ? feedbackMatch[1].trim() : response.content,
    failureMode: failureModeMatch ? failureModeMatch[1].trim() : 'NONE',
    approachVerdict: approachVerdictMatch ? approachVerdictMatch[1].trim() : 'UNKNOWN',
    warning: warningMatch ? warningMatch[1].trim() : '',
  }
}

export async function reEvaluateStepCount(
  spaceId: string,
  stageId: string,
  completedVariant: Variant
): Promise<number | null> {
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

  if (!space) return null

  const gradingAgent = space.User.Agent
    .filter(a => a.role === 'GRADING' && a.isActive)
    .sort((a, b) => a.order - b.order)[0]

  if (!gradingAgent) return null

  const serviceProvider = space.User.ServiceProvider.find(sp => sp.id === gradingAgent.serviceProviderId)
  if (!serviceProvider) return null

  const agentConfig: AIConfig = {
    provider: serviceProvider.provider,
    apiKey: serviceProvider.apiKey,
    model: gradingAgent.model,
  }

  const prompt = `
You are an auto-step advisor for a research pipeline.

Research Goal: ${space.initialPrompt}
Stage: ${stageId} (completed variant)

Completed Variant: ${completedVariant.name}
Grade: ${completedVariant.grade || 'N/A'}
Steps Completed: ${completedVariant.steps.filter(s => s.status === 'COMPLETED').length}/${completedVariant.steps.length}
Feedback: ${completedVariant.feedback || 'None'}

Results from completed steps:
${completedVariant.steps.filter(s => s.status === 'COMPLETED').map(s => `- ${s.name}: ${(s.result || '').substring(0, 150)}`).join('\n')}

Based on quality of results so far and remaining time/resources, should the remaining pending variants in this stage have MORE steps (complex task not fully explored), FEWER steps (quality plateauing, diminishing returns), or KEEP the same step count?

Also consider: Was ${completedVariant.steps.length} steps the right amount, or should future variants use a different count?

Respond with:
RECOMMENDATION: [MORE / FEWER / SAME]
RECOMMENDED_STEP_COUNT: [number between 5 and 50]`

  try {
    const response = await callAI(agentConfig, [
      { role: 'system', content: 'You are a research optimization advisor. Analyze completed work and recommend step count adjustments for remaining variants in the stage.' },
      { role: 'user', content: prompt },
    ])

    const recMatch = response.content.match(/RECOMMENDATION:\s*(MORE|FEWER|SAME)/i)
    const countMatch = response.content.match(/RECOMMENDED_STEP_COUNT:\s*(\d+)/i)

    if (recMatch && countMatch) {
      const rec = recMatch[1].toUpperCase()
      const count = parseInt(countMatch[1])

      if (rec === 'FEWER') return Math.max(5, count)
      if (rec === 'MORE') return Math.min(50, count)
      if (rec === 'SAME') return null // no change
    }
  } catch (err: any) {
    debugLog(`[reEvaluateStepCount] Failed: ${err.message}`)
  }

  return null
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
        updatedAt: new Date(),
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
            updatedAt: new Date(),
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
    include: { VariantStep: { orderBy: { order: 'asc' } } },
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
    cacheDownloads: v.cacheDownloads || null,
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
  updates: {
    grade?: number
    feedback?: string
    userRating?: string
    isSelected?: boolean
    status?: string
    failureMode?: string
    approachVerdict?: string
    gradingWarning?: string
  }
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
