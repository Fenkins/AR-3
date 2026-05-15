#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'secret-redaction.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const m = new Module(sourcePath, module)
m.filename = sourcePath
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

const { redactSecrets } = m.exports

const sample = [
  'HF_TOKEN=hf_1234567890abcdefghijklmnopqrstuvwxyz',
  'Authorization: Bearer hf_abcdefghijklmnopqrstuvwxyz1234567890',
  'github ghp_1234567890abcdefghijklmnopqrstuvwxyz1234',
  'gemini AIzaSyAHliLkCiULDwG47WZU1Aohvei7X-mv78k',
  'vast 10c0fd894b2bbcbabc693f1c79b2644c08696d6596905c9efd1ff3c1a3242d9e',
  'api_key: should_not_survive',
].join('\n')

const redacted = redactSecrets(sample)
assert(!redacted.includes('hf_1234567890abcdefghijklmnopqrstuvwxyz'))
assert(!redacted.includes('hf_abcdefghijklmnopqrstuvwxyz1234567890'))
assert(!redacted.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz1234'))
assert(!redacted.includes('AIzaSyAHliLkCiULDwG47WZU1Aohvei7X-mv78k'))
assert(!redacted.includes('10c0fd894b2bbcbabc693f1c79b2644c08696d6596905c9efd1ff3c1a3242d9e'))
assert(!redacted.includes('should_not_survive'))
assert(redacted.includes('HF_TOKEN=[REDACTED]'))
assert(redacted.includes('Authorization: Bearer [REDACTED]'))
assert(redacted.includes('api_key: [REDACTED]'))

console.log('secret redaction tests passed')
