import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const agent = await prisma.agent.findFirst({
      where: {
        id: params.id,
        userId: auth.user.id,
      },
    })

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ agent })
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()

    const agent = await prisma.agent.update({
      where: {
        id: params.id,
        userId: auth.user.id,
      },
      data: {
        name: body.name,
        serviceProviderId: body.serviceProviderId,
        model: body.model,
        role: body.role,
        order: body.order,
        isActive: body.isActive !== undefined ? body.isActive : true,
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

    return NextResponse.json({ agent })
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    await prisma.agent.delete({
      where: {
        id: params.id,
        userId: auth.user.id,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
