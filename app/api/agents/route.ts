import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const agents = await prisma.agent.findMany({
      where: { userId: auth.user.id },
      include: {
        serviceProvider: {
          select: {
            id: true,
            provider: true,
            name: true,
          },
        },
      },
      orderBy: { order: 'asc' },
    })

    return NextResponse.json({ agents })
  } catch (error) {
    console.error('Error fetching agents:', error)
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
    const { name, serviceProviderId, model, role, order } = body

    if (!name || !serviceProviderId || !model || !role) {
      return NextResponse.json(
        { error: 'Name, service provider, model, and role are required' },
        { status: 400 }
      )
    }

    // Verify service provider belongs to user
    const serviceProvider = await prisma.serviceProvider.findFirst({
      where: {
        id: serviceProviderId,
        userId: auth.user.id,
      },
    })

    if (!serviceProvider) {
      return NextResponse.json(
        { error: 'Service provider not found' },
        { status: 404 }
      )
    }

    const agent = await prisma.agent.create({
      data: {
        userId: auth.user.id,
        serviceProviderId,
        name,
        model,
        role,
        order: order || 0,
        isActive: true,
      },
      include: {
        serviceProvider: {
          select: {
            id: true,
            provider: true,
            name: true,
          },
        },
      },
    })

    return NextResponse.json({ agent }, { status: 201 })
  } catch (error) {
    console.error('Error creating agent:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
