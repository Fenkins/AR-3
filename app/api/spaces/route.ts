import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'
import { normalizeSpaceForClient } from '@/lib/space-api-shape'
import { startSpace } from '@/lib/research-engine'
import { getCacheEntrySizeBytes, getSpaceCacheDiskSize } from '@/lib/model-cache'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const spaces = await prisma.space.findMany({
      where: { userId: auth.user.id },
      include: {
        Experiment: {
          select: {
            id: true,
            phase: true,
            status: true,
            tokensUsed: true,
            cost: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        Breakthrough: {
          select: {
            id: true,
            title: true,
            confidence: true,
            verified: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
        _count: {
          select: {
            Experiment: true,
            Breakthrough: true,
            ModelCache: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    // Get cache sizes for all spaces
    const allCaches = await prisma.modelCache.findMany({
      select: { spaceId: true, filePath: true, fileSize: true },
    })
    const cacheSizeMap: Record<string, number> = {}
    for (const cache of allCaches) {
      cacheSizeMap[cache.spaceId] = (cacheSizeMap[cache.spaceId] || 0) + getCacheEntrySizeBytes(cache)
    }

    const spacesWithCacheSize = spaces.map(space => normalizeSpaceForClient({
      ...space,
      cacheSize: Math.max(cacheSizeMap[space.id] || 0, getSpaceCacheDiskSize(space.id)),
    }))

    return NextResponse.json({ spaces: spacesWithCacheSize })
  } catch (error) {
    console.error('Error fetching spaces:', error)
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
    const { name, description, initialPrompt, useEmbeddings, useGpu, strictCodeGates, numVariants, stepsPerVariant, numVariantsMode, stepsPerVariantMode } = body

    if (!name || !initialPrompt) {
      return NextResponse.json(
        { error: 'Name and initial prompt are required' },
        { status: 400 }
      )
    }

    const space = await prisma.space.create({
      data: {
        userId: auth.user.id,
        name,
        description: description || '',
        initialPrompt,
        status: 'INITIALIZING',
        currentPhase: 'PLANNING',
        useEmbeddings: useEmbeddings || false,
        useGpu: useGpu || false,
        strictCodeGates: strictCodeGates || false,
        defaultNumVariants: Math.max(1, Math.min(10, numVariants || 3)),
        defaultStepsPerVariant: Math.max(3, Math.min(100, stepsPerVariant || 25)),
        numVariantsMode: numVariantsMode || 'fixed',
        stepsPerVariantMode: stepsPerVariantMode || 'fixed',
        updatedAt: new Date(),
      },
    })

    return NextResponse.json({ space }, { status: 201 })
  } catch (error) {
    console.error('Error creating space:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
