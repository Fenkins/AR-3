const fs = require('fs');

const tsPath = '/root/.openclaw/workspace/AR-3/lib/research-engine.ts';
let tsContent = fs.readFileSync(tsPath, 'utf8');

const bgFunc = `
export function runThinkingSetupBackground(spaceId: string): void {
  runThinkingSetup(spaceId).catch(err => {
    console.error('[runThinkingSetupBackground] failed:', err.message);
  });
}
`;

if (!tsContent.includes('runThinkingSetupBackground')) {
  tsContent += bgFunc;
  fs.writeFileSync(tsPath, tsContent);
  console.log('Added runThinkingSetupBackground');
}

const apiPath = '/root/.openclaw/workspace/AR-3/app/api/spaces/[id]/route.ts';
let apiContent = fs.readFileSync(apiPath, 'utf8');

apiContent = apiContent.replace(
  /runStartBackground,\s+runLoopBackground/g,
  'runStartBackground,\n  runLoopBackground,\n  runThinkingSetupBackground'
);

apiContent = apiContent.replace(
  `        try {
          console.log('[Spaces API] Calling runThinkingSetup...')
          const setupResult = await runThinkingSetup(params.id)
          console.log('[Spaces API] Thinking setup complete:', JSON.stringify(setupResult).substring(0, 200))
          return NextResponse.json({ success: true, result: setupResult })
        } catch (error: any) {`,
  `        try {
          console.log('[Spaces API] Calling runThinkingSetupBackground...')
          runThinkingSetupBackground(params.id)
          return NextResponse.json({ success: true, message: 'Setup started in background' })
        } catch (error: any) {`
);

fs.writeFileSync(apiPath, apiContent);
console.log('Patched API route');
