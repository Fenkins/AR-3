import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'

const EMBEDDING_PROVIDER_CONFIG = {
  openai: { 
    label: 'OpenAI', 
    icon: '🟢', 
    description: 'text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002',
    defaultModel: 'text-embedding-3-small',
    supportsDimensions: true,
  },
  azure: { 
    label: 'Azure OpenAI', 
    icon: '🔷', 
    description: 'Azure-hosted OpenAI embedding models',
    defaultModel: 'text-embedding-ada-002',
    supportsDimensions: true,
    requiresEndpoint: true,
  },
  google: { 
    label: 'Google Gemini', 
    icon: '🔵', 
    description: 'Gemini embedding models (embedding-001)',
    defaultModel: 'embedding-001',
    supportsDimensions: false,
  },
  cohere: { 
    label: 'Cohere', 
    icon: '🌊', 
    description: 'embed-english-v3.0, embed-multilingual-v3.0',
    defaultModel: 'embed-english-v3.0',
    supportsDimensions: true,
  },
  huggingface: { 
    label: 'HuggingFace', 
    icon: '🤗', 
    description: 'Sentence transformers for embeddings',
    defaultModel: 'sentence-transformers/all-MiniLM-L6-v2',
    supportsDimensions: false,
  },
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const providers = await prisma.embeddingProvider.findMany({
      where: { userId: auth.user.id },
      orderBy: [
        { isDefault: 'desc' },
        { createdAt: 'desc' }
      ],
    })

    return NextResponse.json({ 
      providers,
      config: EMBEDDING_PROVIDER_CONFIG,
    })
  } catch (error) {
    console.error('Error fetching embedding providers:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()
    const { provider, name, apiKey, apiEndpoint, model, dimensions, isDefault } = body

    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: 'Provider and API key are required' },
        { status: 400 }
      )
    }

    // Validate provider
    if (!EMBEDDING_PROVIDER_CONFIG[provider as keyof typeof EMBEDDING_PROVIDER_CONFIG]) {
      return NextResponse.json(
        { error: 'Invalid embedding provider' },
        { status: 400 }
      )
    }

    const config = EMBEDDING_PROVIDER_CONFIG[provider as keyof typeof EMBEDDING_PROVIDER_CONFIG]

    // If setting as default, unset other defaults first
    if (isDefault) {
      await prisma.embeddingProvider.updateMany({
        where: { userId: auth.user.id, isDefault: true },
        data: { isDefault: false },
      })
    }

    // Upsert provider
    const embeddingProvider = await prisma.embeddingProvider.upsert({
      where: {
        userId_provider: {
          userId: auth.user.id,
          provider,
        },
      },
      update: {
        apiKey,
        name: name || config.label,
        apiEndpoint: apiEndpoint || null,
        model: model || config.defaultModel,
        dimensions: dimensions || null,
        isActive: true,
        isDefault: isDefault || false,
      },
      create: {
        userId: auth.user.id,
        provider,
        name: name || config.label,
        apiKey,
        apiEndpoint: apiEndpoint || null,
        model: model || config.defaultModel,
        dimensions: dimensions || null,
        isActive: true,
        isDefault: isDefault || false,
      },
    })

    return NextResponse.json({ 
      provider: embeddingProvider,
      config: EMBEDDING_PROVIDER_CONFIG,
    }, { status: 201 })
  } catch (error: any) {
    console.error('Error creating embedding provider:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}