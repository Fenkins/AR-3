#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'app/api/agents/route.ts'), 'utf8')

function roleBlock(role, nextRole) {
  const startMarker = '  ' + role + ': {'
  const start = routeSource.indexOf(startMarker)
  if (start < 0) return null
  const end = nextRole ? routeSource.indexOf('  ' + nextRole + ': {', start + startMarker.length) : routeSource.indexOf('\n}', start + startMarker.length)
  if (end < 0) return null
  return [routeSource.slice(start, end), routeSource.slice(start, end)]
}

const investigationBlock = roleBlock('INVESTIGATION', 'PROPOSITION')
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

const gpuRoles = [
  ['INVESTIGATION', 'PROPOSITION'],
  ['PLANNING', 'IMPLEMENTATION'],
  ['IMPLEMENTATION', 'TESTING'],
  ['TESTING', 'VERIFICATION'],
]

for (const pair of gpuRoles) {
  const role = pair[0]
  const nextRole = pair[1]
  const block = roleBlock(role, nextRole)
  assert.ok(block, role + ' role defaults must be present')
  assert.match(
    block[1],
    /gpuPromptVariant\s*:/,
    role + ' GPU-routed stages need a role-specific GPU prompt',
  )
  assert.match(
    block[1],
    /Return ONLY a single JSON object[\s\S]*run_python[\s\S]*complete executable Python/,
    role + ' GPU prompt must require ONLY strict run_python JSON with complete executable Python',
  )
  assert.doesNotMatch(
    block[1],
    /pseudocode is fine|code sketches|EXECUTION_PLAN|required execution_plan|include actual PyTorch code sketches|prose descriptions/i,
    role + ' GPU prompt must not invite sketches, markdown, execution plans, or prose',
  )
}

assert.ok(
  routeSource.includes('gpuPromptVariant: gpuPromptVariant ?? defaults.gpuPromptVariant ?? null'),
  'Agent creation must preserve a caller-provided gpuPromptVariant; do not let ternary precedence overwrite it with the default',
)

console.log('agent gpu prompt tests passed')
