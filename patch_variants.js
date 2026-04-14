const fs = require('fs');

const tsPath = '/root/.openclaw/workspace/AR-3/lib/research-engine.ts';
let tsContent = fs.readFileSync(tsPath, 'utf8');

const targetStr = `  // Execute first stage immediately
  debugLog('[runThinkingSetup] Starting first stage execution')`;

const insertion = `  // Pre-allocate variants and steps for all recommended stages
  debugLog('[runThinkingSetup] Pre-allocating variants and steps for all stages...')
  for (const stage of recommendedStages) {
    try {
      debugLog(\`[runThinkingSetup] Generating variants for \${stage.name} (\${stage.id})...\`)
      await generateStageVariants(spaceId, stage.id, 'auto', 'auto')
    } catch (err: any) {
      debugLog(\`[runThinkingSetup] Failed to generate variants for \${stage.name}:\`, err.message)
    }
  }

  // Execute first stage immediately
  debugLog('[runThinkingSetup] Starting first stage execution')`;

if (tsContent.includes(targetStr) && !tsContent.includes('Pre-allocating variants and steps for all stages')) {
  tsContent = tsContent.replace(targetStr, insertion);
  fs.writeFileSync(tsPath, tsContent);
  console.log('Patched variants allocation');
} else {
  console.log('Target string not found or already patched.');
}
