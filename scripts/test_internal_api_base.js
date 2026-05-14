#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const vm = require('vm')

function loadTsModule(relativePath) {
  const filePath = path.join(__dirname, '..', relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const context = vm.createContext({ require, module, exports: module.exports, console, process, URL })
  vm.runInContext(output, context, { filename: filePath })
  return module.exports
}

const { getInternalGpuApiBase } = loadTsModule('lib/internal-api-base.ts')

function withEnv(env, fn) {
  const oldEnv = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  try { fn() } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, oldEnv)
  }
}

function testMalformedNextauthUrlDoesNotPoisonServerSideGpuPolling() {
  withEnv({ NEXTAUTH_URL: 'http:/...3000', PORT: '3001' }, () => {
    assert.strictEqual(getInternalGpuApiBase(), 'http://127.0.0.1:3001')
  })
}

function testExplicitInternalApiBaseWins() {
  withEnv({ AR3_INTERNAL_API_BASE: 'http://127.0.0.1:3001/', NEXTAUTH_URL: 'https://public.example' }, () => {
    assert.strictEqual(getInternalGpuApiBase(), 'http://127.0.0.1:3001')
  })
}

function testValidLocalNextauthUrlIsAllowed() {
  withEnv({ NEXTAUTH_URL: 'http://localhost:3000', PORT: '3001' }, () => {
    assert.strictEqual(getInternalGpuApiBase(), 'http://localhost:3000')
  })
}

testMalformedNextauthUrlDoesNotPoisonServerSideGpuPolling()
testExplicitInternalApiBaseWins()
testValidLocalNextauthUrlIsAllowed()
console.log('internal-api-base tests passed')
