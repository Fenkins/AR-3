const fs = require('fs');

const tsPath = '/root/.openclaw/workspace/AR-3/lib/research-engine.ts';
let tsContent = fs.readFileSync(tsPath, 'utf8');

const oldLoop = `  // Execute each step
  for (const step of variant.steps) {
    if (step.status === 'COMPLETED') continue

    const messages: AIMessage[] = [
      { role: 'system', content: \`You are executing variant "\${variant.name}" of stage "\${stageName}".\` },
      { role: 'user', content: \`\${step.description}\\n\\nResearch Goal: \${space.initialPrompt}\\n\\nExecute this step and provide results.\` },
    ]

    try {
      const response = await callAI(agentConfig, messages)
      step.result = response.content
      step.status = 'COMPLETED'
      step.grade = Math.min(100, Math.max(0, Math.floor(response.tokensUsed / 10)))
    } catch (error: any) {
      step.status = 'FAILED'
      step.result = \`Error: \${error.message}\`
    }
  }`;

const newLoop = `  // Execute each step
  for (const step of variant.steps) {
    if (step.status === 'COMPLETED') continue

    const messages: AIMessage[] = [
      { role: 'system', content: \`You are executing variant "\${variant.name}" of stage "\${stageName}".\` },
      { role: 'user', content: \`\${step.description}\\n\\nResearch Goal: \${space.initialPrompt}\\n\\nExecute this step and provide results.\` },
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
      step.result = \`Error: \${error.message}\`
    }
  }`;

if (tsContent.includes('// Execute each step')) {
  tsContent = tsContent.replace(oldLoop, newLoop);
  fs.writeFileSync(tsPath, tsContent);
  console.log('Patched executeVariant');
}
