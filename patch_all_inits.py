import re

with open('/opt/AR-3/lib/research-engine.ts', 'r') as f:
    content = f.read()

# Patch 1: runThinkingSetup init (line ~926) - needs retryCount
old1 = '''  // Initialize execution state
  executionStates.set(spaceId, {
    spaceId,
    isRunning: true,
    isThinkingSetupRunning: true,
    currentStageId: recommendedStages[0].id,
    currentPhase: 'Investigation',
    variants: [],
    experiments: [],
    lastUpdated: new Date(),
  })'''

new1 = '''  // Initialize execution state
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
  })'''

count = 0
if old1 in content:
    content = content.replace(old1, new1)
    count += 1
    print(f'Patched instance 1 (runThinkingSetup)')

# Also patch the state variable reference in the retry loop
# The state.retryCountByStage access needs to use state?.retryCountByStage
old2 = '''  const state = getExecutionState(spaceId)
  const currentRetryCount = state?.retryCountByStage?.[stageId] || 0'''
new2 = '''  const state = getExecutionState(spaceId)
  const currentRetryCount = state?.retryCountByStage?.[stageId] || 0'''
# This one is already correct in the instance, skip if already correct
print(f'Total patches: {count}')
with open('/opt/AR-3/lib/research-engine.ts', 'w') as f:
    f.write(content)
