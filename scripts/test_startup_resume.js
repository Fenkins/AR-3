#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const routePath = path.join(root, 'app', 'api', 'spaces', '[id]', 'route.ts')
const route = fs.readFileSync(routePath, 'utf8')

assert.match(
  route,
  /if \(!executionState && space\.status === 'RUNNING'\) \{/,
  'space GET must detect persisted running spaces without an in-memory loop after server restart',
)

assert.match(
  route,
  /resumeSpace\(params\.id\)\.catch/,
  'space GET must hydrate the running space and restart its background loop in the background',
)

console.log('startup resume tests passed')
