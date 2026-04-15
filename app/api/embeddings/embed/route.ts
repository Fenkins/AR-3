import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

export async function POST(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()
    const { text, providerId } = body

    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 })
    }

    // Get embedding provider - use specified one or default
    let embeddingProvider
    if (providerId) {
      embeddingProvider = await prisma.embeddingProvider.findFirst({
        where: { id: providerId, userId: auth.user.id, isActive: true },
      })
    } else {
      embeddingProvider = await prisma.embeddingProvider.findFirst({
        where: { userId: auth.user.id, isActive: true },
        orderBy: { isDefault: 'desc' },
      })
    }

    if (!embeddingProvider) {
      return NextResponse.json(
        { error: 'No embedding provider configured. Add one in Embeddings settings.' },
        { status: 400 }
      )
    }

    // Generate embedding based on provider type
    let embedding: number[] = []
    let tokensUsed = 0

    try {
      switch (embeddingProvider.provider) {
        case 'openai':
        case 'azure': {
          const openai = new OpenAI({
            apiKey: embeddingProvider.apiKey,
            ...(embeddingProvider.provider === 'azure' && embeddingProvider.apiEndpoint ? {
              baseURL: `${embeddingProvider.apiEndpoint}/openai/deployments`,
              defaultQuery: { 'api-version': '2024-02-01' },
              defaultHeaders: { 'api-key': embeddingProvider.apiKey },
            } : {}),
          })

          const params: any = {
            model: embeddingProvider.model,
            input: text,
          }
          // OpenAI 3-large supports dimensions
          if (embeddingProvider.dimensions && embeddingProvider.provider === 'openai') {
            params.dimensions = embeddingProvider.dimensions
          }

          const response = await openai.embeddings.create(params)
          embedding = response.data[0].embedding
          tokensUsed = response.usage.total_tokens
          break
        }

        case 'google': {
          // Google uses a different API format
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${embeddingProvider.model}:embedContent?key=${embeddingProvider.apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: { parts: [{ text }] },
                model: embeddingProvider.model,
              }),
            }
          )
          const data = await response.json()
          if (data.error) throw new Error(data.error.message)
          // Google returns values in a different structure
          embedding = data.embedding.values || []
          break
        }

        case 'cohere': {
          const response = await fetch('https://api.cohere.ai/v1/embed', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${embeddingProvider.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              texts: [text],
              model: embeddingProvider.model,
              ...(embeddingProvider.dimensions && { embedding_types: ['float'] }),
            }),
          })
          const data = await response.json()
          if (data.error) throw new Error(data.error.message)
          embedding = data.embeddings[0] || []
          break
        }

        default:
          return NextResponse.json(
            { error: `Unsupported embedding provider: ${embeddingProvider.provider}` },
            { status: 400 }
          )
      }
    } catch (apiError: any) {
      console.error('Embedding API error:', apiError.message)
      return NextResponse.json(
        { error: `Embedding API error: ${apiError.message}` },
        { status: 400 }
      )
    }

    return NextResponse.json({
      embedding,
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimensions: embedding.length,
      tokensUsed,
    })
  } catch (error: any) {
    console.error('Error generating embedding:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// Test endpoint - test embedding with the provided text
export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const { searchParams } = new URL(request.url)
    const text = searchParams.get('text') || 'Hello world'
    const providerId = searchParams.get('providerId')

    // Get embedding provider
    let embeddingProvider
    if (providerId) {
      embeddingProvider = await prisma.embeddingProvider.findFirst({
        where: { id: providerId, userId: auth.user.id, isActive: true },
      })
    } else {
      embeddingProvider = await prisma.embeddingProvider.findFirst({
        where: { userId: auth.user.id, isActive: true },
        orderBy: { isDefault: 'desc' },
      })
    }

    if (!embeddingProvider) {
      return NextResponse.json(
        { error: 'No embedding provider configured' },
        { status: 400 }
      )
    }

    // Simple test - generate and return vector preview + dimensions
    const testText = text.substring(0, 1000) // Limit for test

    let result: any = { provider: embeddingProvider.provider, model: embeddingProvider.model }

    try {
      if (embeddingProvider.provider === 'openai' || embeddingProvider.provider === 'azure') {
        const openai = new OpenAI({
          apiKey: embeddingProvider.apiKey,
          ...(embeddingProvider.provider === 'azure' && embeddingProvider.apiEndpoint ? {
            baseURL: `${embeddingProvider.apiEndpoint}/openai/deployments`,
          } : {}),
        })
        const response = await openai.embeddings.create({
          model: embeddingProvider.model,
          input: testText,
          ...(embeddingProvider.dimensions && embeddingProvider.provider === 'openai' ? { dimensions: embeddingProvider.dimensions } : {}),
        })
        result.embedding = response.data[0].embedding
        result.dimensions = response.data[0].embedding.length
        result.tokensUsed = response.usage.total_tokens
      } else if (embeddingProvider.provider === 'google') {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${embeddingProvider.model}:embedContent?key=${embeddingProvider.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: { parts: [{ text: testText }] },
              model: embeddingProvider.model,
            }),
          }
        )
        const data = await response.json()
        if (data.error) throw new Error(data.error.message)
        result.embedding = data.embedding?.values || []
        result.dimensions = result.embedding.length
      } else {
        result.error = `Provider ${embeddingProvider.provider} not yet supported in test endpoint`
      }

      // Return preview of embedding
      if (result.embedding) {
        result.preview = result.embedding.slice(0, 5)
      }
    } catch (apiError: any) {
      result.error = apiError.message
    }

    return NextResponse.json(result)
  } catch (error: any) {
    console.error('Error testing embedding:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}