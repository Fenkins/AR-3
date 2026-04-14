const fs = require('fs');
const content = fs.readFileSync('/opt/AR-3/lib/research-engine.ts', 'utf8');
const old = `  // Initialize execution state
  executionStates.set(spaceId, {
    spaceId,
    isRunning: true,
    currentStageId: defaultStagesWithIds[0].id,
    currentPhase: 'Investigation',
    variants: [],
    experiments: [],
    lastUpdated: new Date(),
  })`;
const newBlock = `  // Initialize execution state
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
  })`;
if (content.includes(old)) {
    fs.writeFileSync('/opt/AR-3/lib/research-engine.ts', content.replace(old, newBlock));
    console.log('Patched');
} else {
    console.log('Not found');
}
