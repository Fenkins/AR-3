import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { fetchModels } from '@/lib/ai'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()
    const { provider, apiKey: clientApiKey } = body
    console.log("FETCH MODELS API HIT:", { userId: auth.user.id, provider, hasClientKey: !!clientApiKey })

    if (!provider) {
      return NextResponse.json(
        { error: 'Provider is required' },
        { status: 400 }
      )
    }

    let apiKeyToUse = clientApiKey

    if (!apiKeyToUse) {
      const serviceProvider = await prisma.serviceProvider.findFirst({
        where: {
          userId: auth.user.id,
          provider: provider
        }
      })

      console.log("FOUND PROVIDER?", !!serviceProvider)

      if (!serviceProvider || !serviceProvider.apiKey) {
        return NextResponse.json(
          { error: 'Provider not configured or missing API key' },
          { status: 400 }
        )
      }
      apiKeyToUse = serviceProvider.apiKey
    }

    const models = await fetchModels(provider, apiKeyToUse)

    return NextResponse.json({ models })
  } catch (error: any) {
    console.error('Error fetching models:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch models' },
      { status: 500 }
    )
  }
}
