import { prisma } from './prisma'
import OpenAI from 'openai'

const EMBEDDING_MODELS: Record<string, { endpoint?: string; supportsDimensions: boolean; defaultDimensions: number }> = {
  openai: {
    supportsDimensions: true,
    defaultDimensions: 1536,
  },
  azure: {
    supportsDimensions: true,
    defaultDimensions: 1536,
  },
  google: {
    supportsDimensions: false,
    defaultDimensions: 768,
  },
  cohere: {
    supportsDimensions: true,
    defaultDimensions: 1024,
  },
  huggingface: {
    supportsDimensions: false,
    defaultDimensions: 384,
  },
}

export interface EmbeddingResult {
  embedding: number[]
  provider: string
  model: string
  dimensions: number
  tokensUsed: number
}

export async function getEmbedding(
  text: string,
  userId: string,
  providerId?: string
): Promise<EmbeddingResult> {
  // Get embedding provider
  let provider
  if (providerId) {
    provider = await prisma.embeddingProvider.findUnique({
      where: { id: providerId },
    })
  } else {
    provider = await prisma.embeddingProvider.findFirst({
      where: { userId, isActive: true, isDefault: true },
    })
  }

  if (!provider) {
    throw new Error('No embedding provider configured')
  }

  const modelConfig = EMBEDDING_MODELS[provider.provider]
  if (!modelConfig) {
    throw new Error(`Unsupported embedding provider: ${provider.provider}`)
  }

  const dimensions = provider.dimensions || modelConfig.defaultDimensions

  // Build request based on provider type
  if (provider.provider === 'openai') {
    const openai = new OpenAI({ apiKey: provider.apiKey })
    const response = await openai.embeddings.create({
      model: provider.model || 'text-embedding-3-small',
      input: text,
      dimensions,
    })

    return {
      embedding: response.data[0].embedding,
      provider: 'openai',
      model: provider.model || 'text-embedding-3-small',
      dimensions: response.data[0].embedding.length,
      tokensUsed: response.usage.total_tokens || text.split(/\s+/).length,
    }
  }

  if (provider.provider === 'azure') {
    const openai = new OpenAI({
      apiKey: provider.apiKey,
      baseURL: provider.apiEndpoint ? `${provider.apiEndpoint}/openai/deployments/${provider.model}/embeddings` : undefined,
      defaultQuery: { 'api-version': '2024-02-01' },
    })
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text,
    })

    return {
      embedding: response.data[0].embedding,
      provider: 'azure',
      model: provider.model,
      dimensions: response.data[0].embedding.length,
      tokensUsed: response.usage.total_tokens || text.split(/\s+/).length,
    }
  }

  if (provider.provider === 'google') {
    // Google Gemini embedding-001
    const { GoogleGenerativeAI } = require('@google/generative-ai')
    const genAI = new GoogleGenerativeAI(provider.apiKey)
    const model = genAI.getTextEmbeddingModel()
    const result = await model.embedContent(text)
    
    return {
      embedding: result.embedding,
      provider: 'google',
      model: 'embedding-001',
      dimensions: result.embedding.length,
      tokensUsed: text.split(/\s+/).length,
    }
  }

  if (provider.provider === 'cohere') {
    const { CohereClient } = require('cohere-ai')
    const cohere = new CohereClient({ token: provider.apiKey })
    const response = await cohere.embed({ texts: [text], model: provider.model || 'embed-english-v3.0' })
    
    return {
      embedding: response.embeddings[0],
      provider: 'cohere',
      model: provider.model || 'embed-english-v3.0',
      dimensions: response.embeddings[0].length,
      tokensUsed: text.split(/\s+/).length,
    }
  }

  if (provider.provider === 'huggingface') {
    // HuggingFace Inference API
    const response = await fetch(
      `https://api-inference.huggingface.co/pipeline/feature-extraction/${provider.model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: text }),
      }
    )
    
    if (!response.ok) {
      throw new Error(`HuggingFace API error: ${response.statusText}`)
    }
    
    const embedding = await response.json()
    
    return {
      embedding,
      provider: 'huggingface',
      model: provider.model,
      dimensions: Array.isArray(embedding) ? embedding.length : 0,
      tokensUsed: text.split(/\s+/).length,
    }
  }

  throw new Error(`Unsupported provider: ${provider.provider}`)
}

// Cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface SearchResult {
  experimentId: string
  spaceId: string
  phase: string
  content: string
  similarity: number
}

// Store cached embeddings for experiments
const embeddingCache: Map<string, { embedding: number[]; timestamp: number }> = new Map()
const CACHE_TTL = 1000 * 60 * 60 // 1 hour

export async function findSimilarExperiments(
  query: string,
  userId: string,
  spaceId?: string,
  topK: number = 5,
  threshold: number = 0.7
): Promise<SearchResult[]> {
  // Get query embedding
  const queryResult = await getEmbedding(query, userId)
  const queryEmbedding = queryResult.embedding

  // Fetch experiments to search
  const where: any = { userId }
  if (spaceId) {
    where.spaceId = spaceId
  }

  const experiments = await prisma.experiment.findMany({
    where,
    select: { id: true, spaceId: true, phase: true, result: true, prompt: true },
  })

  const results: SearchResult[] = []

  for (const exp of experiments) {
    if (!exp.result) continue

    const cacheKey = exp.id
    let cached = embeddingCache.get(cacheKey)

    if (!cached || Date.now() - cached.timestamp > CACHE_TTL) {
      try {
        const expResult = await getEmbedding(exp.result, userId)
        cached = { embedding: expResult.embedding, timestamp: Date.now() }
        embeddingCache.set(cacheKey, cached)
      } catch (e) {
        continue // Skip experiments that fail to embed
      }
    }

    const similarity = cosineSimilarity(queryEmbedding, cached.embedding)
    if (similarity >= threshold) {
      results.push({
        experimentId: exp.id,
        spaceId: exp.spaceId,
        phase: exp.phase,
        content: exp.result,
        similarity,
      })
    }
  }

  // Sort by similarity and return top K
  results.sort((a, b) => b.similarity - a.similarity)
  return results.slice(0, topK)
}

// Context injection for AI prompts
export async function buildEmbeddingContext(
  query: string,
  userId: string,
  spaceId?: string,
  maxChars: number = 4000
): Promise<string> {
  const similar = await findSimilarExperiments(query, userId, spaceId, 5, 0.65)

  if (similar.length === 0) return ''

  let context = '\n\nRelevant Context from Prior Experiments:\n'
  let totalChars = context.length

  for (const result of similar) {
    const entry = `[${result.phase}][similarity:${(result.similarity * 100).toFixed(0)}%] ${result.content}`
    if (totalChars + entry.length > maxChars) break
    context += entry + '\n\n'
    totalChars += entry.length
  }

  return context
}
