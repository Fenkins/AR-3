import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()

    const provider = await prisma.serviceProvider.update({
      where: {
        id: params.id,
        userId: auth.user.id,
      },
      data: {
        apiKey: body.apiKey,
        name: body.name,
        isActive: body.isActive !== undefined ? body.isActive : true,
      },
    })

    return NextResponse.json({ provider })
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

    // Check if any agents use this provider
    const agentCount = await prisma.agent.count({
      where: { serviceProviderId: params.id },
    })

    if (agentCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete provider: ${agentCount} agent(s) are using it` },
        { status: 400 }
      )
    }

    await prisma.serviceProvider.delete({
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
