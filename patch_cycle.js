const fs = require('fs');

const tsPath = '/root/.openclaw/workspace/AR-3/lib/research-engine.ts';
let tsContent = fs.readFileSync(tsPath, 'utf8');

const target = `  // Get context from previous experiments
  const previousExperiments = space.experiments.slice(0, 10)
  const messages = generateStagePrompt(space, currentStage, previousExperiments)

  debugLog(\`[executeResearchCycle] Calling AI for stage: \${currentStage.name}\`)
  debugLog(\`[executeResearchCycle] Agent: \${agent?.name} (\${agent?.role}), Provider: \${serviceProvider?.provider}\`)

  // Call AI
  let response
  try {
    debugLog(\`[executeResearchCycle] About to call callAI, config:\`, JSON.stringify({provider: agentConfig.provider, model: agentConfig.model, hasKey: !!agentConfig.apiKey}))
    response = await callAI(agentConfig, messages)
    debugLog(\`[executeResearchCycle] AI call succeeded, tokens: \${response.tokensUsed}, cost: $\${response.cost}\`)
  } catch (error: any) {
    debugLog(\`[executeResearchCycle] AI call failed:\`, error.message)
    throw error
  }`;

const replacement = `  // Check if we have pending variants to execute instead
  const state = getExecutionState(spaceId)
  if (state && state.variants && state.variants.length > 0) {
    const pendingVariant = state.variants.find(v => v.stageId === currentStage.id && v.status === 'PENDING')
    if (pendingVariant) {
      debugLog(\`[executeResearchCycle] Found pending variant \${pendingVariant.name}, delegating to executeVariantCycle\`)
      const executedVariant = await executeVariantCycle(spaceId, pendingVariant.id)
      
      // Return a dummy experiment since we just executed a variant with steps (which logged their own experiments)
      return {
        id: 'variant_' + pendingVariant.id,
        spaceId,
        phase: currentStage.name.toUpperCase(),
        agentId: agent.id,
        agentName: agent.name,
        prompt: 'Variant execution',
        response: executedVariant.result || 'Variant completed',
        tokensUsed: 0,
        cost: 0,
        status: 'COMPLETED',
        result: executedVariant.result || 'Variant completed',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    }
  }

  // Get context from previous experiments
  const previousExperiments = space.experiments.slice(0, 10)
  const messages = generateStagePrompt(space, currentStage, previousExperiments)

  debugLog(\`[executeResearchCycle] Calling AI for stage: \${currentStage.name}\`)
  debugLog(\`[executeResearchCycle] Agent: \${agent?.name} (\${agent?.role}), Provider: \${serviceProvider?.provider}\`)

  // Call AI
  let response
  try {
    debugLog(\`[executeResearchCycle] About to call callAI, config:\`, JSON.stringify({provider: agentConfig.provider, model: agentConfig.model, hasKey: !!agentConfig.apiKey}))
    response = await callAI(agentConfig, messages)
    debugLog(\`[executeResearchCycle] AI call succeeded, tokens: \${response.tokensUsed}, cost: $\${response.cost}\`)
  } catch (error: any) {
    debugLog(\`[executeResearchCycle] AI call failed:\`, error.message)
    throw error
  }`;

if (tsContent.includes('// Call AI')) {
  tsContent = tsContent.replace(target, replacement);
  fs.writeFileSync(tsPath, tsContent);
  console.log('Patched executeResearchCycle to delegate to variants');
}
