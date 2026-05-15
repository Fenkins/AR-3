#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'MainApp.tsx'), 'utf8')

assert.ok(
  source.includes('const { logout } = useAuth()'),
  'Dashboard and Spaces views should be able to clear stale auth state'
)
assert.ok(
  source.includes('response.status === 401'),
  'API fetches should explicitly handle stale/invalid JWT 401 responses'
)
assert.ok(
  source.includes('Array.isArray(data.spaces) ? data.spaces : []'),
  'Spaces response should be normalized so an error payload cannot crash spaces.map'
)
assert.ok(
  source.includes('recentBreakthroughs: Array.isArray'),
  'Dashboard response should normalize array fields before rendering .map/.length'
)

console.log('auth failure UI guard tests passed')
