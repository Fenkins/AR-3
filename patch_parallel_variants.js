const fs = require('fs');

const tsPath = '/root/.openclaw/workspace/AR-3/lib/research-engine.ts';
let tsContent = fs.readFileSync(tsPath, 'utf8');

// 1. Add duplicate-call guard to runThinkingSetup - skip if already running
const oldSetupStart = `  debugLog('[runThinkingSetup] Starting for spaceId:', spaceId)

  const space = await prisma.space.findUnique({`;

const newSetupStart = `  debugLog('[runThinkingSetup] Starting for spaceId:', spaceId)

  // Guard: skip if a thinking setup is already running for this space
  const existingState = getExecutionState(spaceId)
  if (existingState?.isThinkingSetupRunning) {
    debugLog('[runThinkingSetup] Already running, skipping duplicate call')
    return { skipped: true, reason: 'thinking_setup already in progress' }
  }

  const space = await prisma.space.findUnique({`;

if (tsContent.includes('debugLog(\'[runThinkingSetup] Starting for spaceId:\', spaceId)') && !tsContent.includes('isThinkingSetupRunning')) {
  tsContent = tsContent.replace(oldSetupStart, newSetupStart);
}

// 2. Mark thinking setup as running in execution state after init
const oldStateInit = `  // Initialize execution state
  executionStates.set(spaceId, {
    spaceId,
    isRunning: true,
    currentStageId: recommendedStages[0].id,
    currentPhase: 'Investigation',
    variants: [],
    experiments: [],
    lastUpdated: new Date(),
  })`;

const newStateInit = `  // Initialize execution state
  executionStates.set(spaceId, {
    spaceId,
    isRunning: true,
    isThinkingSetupRunning: true,
    currentStageId: recommendedStages[0].id,
    currentPhase: 'Investigation',
    variants: [],
    experiments: [],
    lastUpdated: new Date(),
  })`;

tsContent = tsContent.replace(oldStateInit, newStateInit);

// 3. Replace sequential pre-allocation with PARALLEL execution
const oldPreAlloc = `  // Pre-allocate variants and steps for all recommended stages
  debugLog('[runThinkingSetup] Pre-allocating variants and steps for all stages...')
  for (const stage of recommendedStages) {
    try {
      debugLog(\`[runThinkingSetup] Generating variants for \${stage.name} (\${stage.id})...\`)
      await generateStageVariants(spaceId, stage.id, 'auto', 'auto')
    } catch (err: any) {
      debugLog(\`[runThinkingSetup] Failed to generate variants for \${stage.name}:\`, err.message)
    }
  }`;

const newPreAlloc = `  // Pre-allocate variants and steps for all recommended stages - IN PARALLEL
  debugLog('[runThinkingSetup] Pre-allocating variants and steps for all stages (parallel)...')
  const variantPromises = recommendedStages.map(stage =>
    (async () => {
      try {
        debugLog(\`[runThinkingSetup] Generating variants for \${stage.name} (\${stage.id})...\`)
        await generateStageVariants(spaceId, stage.id, 'auto', 'auto')
        debugLog(\`[runThinkingSetup] Variants for \${stage.name} complete\`)
      } catch (err: any) {
        debugLog(\`[runThinkingSetup] Failed to generate variants for \${stage.name}: \${err.message}\`)
      }
    })()
  )
  await Promise.all(variantPromises)
  debugLog('[runThinkingSetup] All variant pre-allocation attempts finished')`;

tsContent = tsContent.replace(oldPreAlloc, newPreAlloc);

// 4. After done, clear the thinking setup flag
const oldReturn = `  debugLog('[runThinkingSetup] Done!')

  return {`;

const newReturn = `  debugLog('[runThinkingSetup] Done!')

  // Clear thinking setup running flag
  const finalState = getExecutionState(spaceId)
  if (finalState) {
    updateExecutionState(spaceId, { isThinkingSetupRunning: false })
  }

  return {`;

tsContent = tsContent.replace(oldReturn, newReturn)

// 5. Add type for isThinkingSetupRunning in ExecutionState
const oldTypeDef = `interface ExecutionState {
  spaceId: string
  isRunning: boolean
  currentStageId?: string
  currentPhase?: string
  variants: Variant[]
  experiments: any[]
  lastUpdated: Date
  selectedVariantId?: string
}`;

const newTypeDef = `interface ExecutionState {
  spaceId: string
  isRunning: boolean
  isThinkingSetupRunning?: boolean  // guards against duplicate setup calls
  currentStageId?: string
  currentPhase?: string
  variants: Variant[]
  experiments: any[]
  lastUpdated: Date
  selectedVariantId?: string
}`;

tsContent = tsContent.replace(oldTypeDef, newTypeDef)

fs.writeFileSync(tsPath, tsContent);
console.log('Patched parallel variant generation + duplicate guard + thinking_setup flag');
