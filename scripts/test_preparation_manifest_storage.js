#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, '..', 'lib', 'research-engine.ts')
const source = fs.readFileSync(sourcePath, 'utf8')

assert.doesNotMatch(
  source,
  /setupStep:\s*JSON\.stringify\([^\n]+\)\.substring\(0,\s*8000\)/,
  'validated preparation manifests must not be truncated before storage',
)

assert.doesNotMatch(
  source,
  /setupStep:\s*manifestJson\.substring\(0,\s*8000\)/,
  'autonomous preparation manifests must not be truncated before storage',
)

assert.match(
  source,
  /Stored preparation manifest is not parseable; ignoring it so the preparation fallback can refresh model\/dependency evidence/,
  'unparseable stored manifests should be ignored instead of converted to empty rescue manifests',
)

assert.match(
  source,
  /parsed\?\.truncatedSetupEvidence/,
  'legacy truncated rescue artifacts should be ignored instead of reused as deterministic experiment manifests',
)

assert.match(
  source,
  /Skipping failed preparation manifest downgrade because a validated manifest is already persisted/,
  'invalid later preparation attempts must not downgrade an already validated setup manifest',
)

console.log('preparation manifest storage tests passed')
