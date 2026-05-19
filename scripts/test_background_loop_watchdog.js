#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'research-engine.ts')
const fullSource = fs.readFileSync(sourcePath, 'utf8')
const start = fullSource.indexOf('export type ActiveLoopState')
if (start === -1) throw new Error('Active loop watchdog helpers are missing')
const end = fullSource.indexOf('\n/**\n * Continuous background loop', start)
if (end === -1) throw new Error('Active loop watchdog helpers should appear before startBackgroundLoop')

const source = fullSource.slice(start, end)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { activeLoopIsStaleForRestart } = m.exports
assert.equal(typeof activeLoopIsStaleForRestart, 'function')

const now = Date.parse('2026-05-19T00:00:00Z')
assert.equal(
  activeLoopIsStaleForRestart({ generation: 1, startedMs: now - 61 * 60 * 1000, lastTickMs: now - 61 * 60 * 1000 }, now),
  true,
  'a loop with no heartbeat for over an hour should be restartable so resume can recover completed GPU jobs',
)
assert.equal(
  activeLoopIsStaleForRestart({ generation: 1, startedMs: now - 5 * 60 * 1000, lastTickMs: now - 5 * 60 * 1000 }, now),
  false,
  'fresh active loops must not be duplicated',
)
assert.equal(
  activeLoopIsStaleForRestart({ generation: 1, startedMs: now - 2 * 60 * 60 * 1000, lastTickMs: now - 5 * 60 * 1000 }, now),
  false,
  'recent heartbeat prevents duplicate restart even when the loop is old',
)

console.log('background loop watchdog tests passed')
