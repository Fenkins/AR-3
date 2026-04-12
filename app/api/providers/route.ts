import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'
import { fetchModels } from '@/lib/ai'

const PROVIDER_CONFIG = {
  openai: { label: 'OpenAI', icon: '🟢', models_endpoint: true },
  anthropic: { label: 'Anthropic', icon: '🟣', models_endpoint: false },
  google: { label: 'Google', icon: '🔵', models_endpoint: false },
  openrouter: { label: 'OpenRouter', icon: '🟠', models_endpoint: true },
  minimax: { label: 'MiniMax', icon: '🔴', models_endpoint: false },
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const providers = await prisma.serviceProvider.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ providers })
  } catch (error) {
    console.error('Error fetching providers:', error)
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
    const { provider, name, apiKey } = body

    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: 'Provider and API key are required' },
        { status: 400 }
      )
    }

    // Validate provider
    if (!PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG]) {
      return NextResponse.json(
        { error: 'Invalid provider' },
        { status: 400 }
      )
    }

    // Test API key by fetching models
    let models: string[] = []
    try {
      models = await fetchModels(provider, apiKey)
    } catch (error) {
      return NextResponse.json(
        { error: 'Invalid API key or failed to connect to provider' },
        { status: 400 }
      )
    }

    // Upsert provider (update if exists, create if not)
    const serviceProvider = await prisma.serviceProvider.upsert({
      where: {
        userId_provider: {
          userId: auth.user.id,
          provider,
        },
      },
      update: {
        apiKey,
        name: name || PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG].label,
        isActive: true,
      },
      create: {
        userId: auth.user.id,
        provider,
        name: name || PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG].label,
        apiKey,
        isActive: true,
      },
    })

    return NextResponse.json({ 
      provider: serviceProvider,
      models,
      modelCount: models.length,
    }, { status: 201 })
  } catch (error: any) {
    console.error('Error creating provider:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
