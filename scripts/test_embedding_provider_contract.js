#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'embeddings.ts'), 'utf8')

assert.ok(!source.includes('getTextEmbeddingModel('), 'Google embeddings must not call removed getTextEmbeddingModel API')
assert.ok(source.includes('getGenerativeModel({ model:'), 'Google embeddings should use getGenerativeModel({ model })')
assert.ok(source.includes('result.embedding.values'), 'Google embeddings should read embedding.values from @google/generative-ai response')

console.log('embedding provider contract tests passed')
