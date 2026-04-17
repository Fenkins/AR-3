import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'
import { startSpace } from '@/lib/research-engine'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const spaces = await prisma.space.findMany({
      where: { userId: auth.user.id },
      include: {
        experiments: {
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
        breakthroughs: {
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
            experiments: true,
            breakthroughs: true,
            modelCaches: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json({ spaces })
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
    const { name, description, initialPrompt, useEmbeddings, useGpu, numVariants, stepsPerVariant } = body

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
        defaultNumVariants: Math.max(1, Math.min(10, numVariants || 3)),
        defaultStepsPerVariant: Math.max(3, Math.min(100, stepsPerVariant || 25)),
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
