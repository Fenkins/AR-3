#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, '..', 'lib', 'research-engine.ts')
const source = fs.readFileSync(sourcePath, 'utf8')

assert.match(
  source,
  /stages\.find\(stage => stage\.name === \(space as any\)\.currentPhase\) \|\| stages\[0\]/,
  'resumeSpace must restore the persisted Space.currentPhase after a server restart',
)

assert.doesNotMatch(
  source,
  /const currentStage = stages\[0\]\n\s*const currentStageId/,
  'resumeSpace must not always restart from the first stage',
)

console.log('resume phase restore tests passed')
