import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '@/app/api/middleware'

const EMBEDDING_MODELS = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  azure: ['text-embedding-ada-002', 'text-embedding-3-small', 'text-embedding-3-large'],
  google: ['embedding-001', 'text-embedding-004'],
  cohere: ['embed-english-v3.0', 'embed-english-v3.0-512', 'embed-multilingual-v3.0', 'embed-english-v2.0', 'embed-multilingual-v2.0'],
  huggingface: ['sentence-transformers/all-MiniLM-L6-v2', 'sentence-transformers/all-mpnet-base-v2', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'],
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()
    const { provider, apiKey, apiEndpoint } = body

    if (!provider || !apiKey) {
      return NextResponse.json({ error: 'Provider and API key are required' }, { status: 400 })
    }

    // For most providers, just return the known model list
    // For OpenAI/Azure, we could test the key by making a real request
    if (provider === 'openai' || provider === 'azure') {
      try {
        // Test the API key by making a minimal request
        const testUrl = provider === 'azure'
          ? `${apiEndpoint}/embeddings?api-version=2024-02-01`
          : 'https://api.openai.com/v1/embeddings'

        const testBody = provider === 'azure'
          ? { input: 'test', model: 'text-embedding-ada-002' }
          : { input: 'test', model: 'text-embedding-3-small' }

        const testResponse = await fetch(testUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(provider === 'azure' && apiEndpoint ? { 'api-key': apiKey } : {}),
          },
          body: JSON.stringify(testBody),
        })

        if (!testResponse.ok) {
          const err = await testResponse.json().catch(() => ({ error: 'Invalid response' }))
          return NextResponse.json({ error: err.error?.message || err.error || 'Invalid API key' }, { status: 401 })
        }

        return NextResponse.json({ 
          models: EMBEDDING_MODELS[provider as keyof typeof EMBEDDING_MODELS] || [],
          tested: true,
        })
      } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to test API key' }, { status: 401 })
      }
    }

    // For other providers, return known models (they typically use open-source models)
    return NextResponse.json({ 
      models: EMBEDDING_MODELS[provider as keyof typeof EMBEDDING_MODELS] || [],
      tested: false,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}
