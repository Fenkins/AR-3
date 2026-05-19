#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'embeddings.ts'), 'utf8')

assert.ok(!source.includes('getTextEmbeddingModel('), 'Google embeddings must not call removed getTextEmbeddingModel API')
assert.ok(source.includes('getGenerativeModel({ model:'), 'Google embeddings should use getGenerativeModel({ model })')
assert.ok(source.includes('result.embedding.values'), 'Google embeddings should read embedding.values from @google/generative-ai response')

assert.ok(!source.includes("provider.model || 'embedding-001'"), 'Google embeddings must not default to removed embedding-001 model')
assert.ok(source.includes("'text-embedding-004'"), 'Google embeddings should default legacy/empty config to text-embedding-004')
assert.ok(source.includes("provider.model === 'embedding-001'"), 'Google embeddings should normalize persisted legacy embedding-001 provider rows')

console.log('embedding provider contract tests passed')
