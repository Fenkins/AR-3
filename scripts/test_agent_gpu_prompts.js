#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'app/api/agents/route.ts'), 'utf8')

const investigationBlock = routeSource.match(/INVESTIGATION:\s*\{([\s\S]*?)\n\s*\},\n\s*PROPOSITION:/)
assert.ok(investigationBlock, 'INVESTIGATION role defaults must be present')
assert.match(
  investigationBlock[1],
  /gpuPromptVariant\s*:/,
  'GPU-routed Investigation stages need a role-specific GPU prompt so weak models emit strict run_python JSON instead of prose',
)
assert.match(
  investigationBlock[1],
  /ONLY a single JSON object|Return ONLY|run_python/,
  'Investigation GPU prompt must explicitly require strict run_python JSON output',
)

assert.ok(
  routeSource.includes('gpuPromptVariant: gpuPromptVariant ?? defaults.gpuPromptVariant ?? null'),
  'Agent creation must preserve a caller-provided gpuPromptVariant; do not let ternary precedence overwrite it with the default',
)

console.log('agent gpu prompt tests passed')
