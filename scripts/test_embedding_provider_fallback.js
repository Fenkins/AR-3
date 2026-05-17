#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const Module = require('module')

const sourcePath = path.join(__dirname, '..', 'lib', 'embeddings.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText

const calls = []
const mockProvider = {
  id: 'emb-openai',
  userId: 'user-1',
  provider: 'openai',
  name: 'OpenAI',
  apiKey: 'test-key',
  model: 'text-embedding-3-small',
  dimensions: null,
  isActive: true,
  isDefault: false,
  updatedAt: new Date(),
}

class MockOpenAI {
  constructor(config) {
    this.config = config
    this.embeddings = {
      create: async (params) => {
        calls.push({ type: 'embedding.create', params })
        return {
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { total_tokens: 3 },
        }
      },
    }
  }
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './prisma' || request.endsWith('/prisma')) {
    return {
      prisma: {
        embeddingProvider: {
          findFirst: async (query) => {
            calls.push({ type: 'findFirst', query })
            return mockProvider
          },
          findUnique: async () => null,
        },
        experiment: {
          findMany: async () => [],
        },
      },
    }
  }
  if (request === 'openai') {
    return MockOpenAI
  }
  return originalLoad.apply(this, arguments)
}

const m = new Module(sourcePath, module)
m.filename = sourcePath
m.paths = Module._nodeModulePaths(path.dirname(sourcePath))
m._compile(compiled, sourcePath)

async function main() {
  const result = await m.exports.getEmbedding('hello world', 'user-1')
  assert.deepStrictEqual(result.embedding, [0.1, 0.2, 0.3])
  assert.strictEqual(result.provider, 'openai')

  const findFirst = calls.find((call) => call.type === 'findFirst')
  assert(findFirst, 'expected active embedding provider lookup')
  assert.deepStrictEqual(findFirst.query.where, { userId: 'user-1', isActive: true })
  assert.deepStrictEqual(findFirst.query.orderBy, [{ isDefault: 'desc' }, { updatedAt: 'desc' }])
  assert(!('isDefault' in findFirst.query.where), 'active non-default provider should be eligible as fallback')

  const created = calls.find((call) => call.type === 'embedding.create')
  assert(created, 'expected OpenAI embedding call')
  assert.strictEqual(created.params.model, 'text-embedding-3-small')

  console.log('embedding provider fallback tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
