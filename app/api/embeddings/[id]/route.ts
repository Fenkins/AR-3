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

    const provider = await prisma.embeddingProvider.findFirst({
      where: { id: params.id, userId: auth.user.id },
    })

    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    }

    return NextResponse.json({ provider })
  } catch (error) {
    console.error('Error fetching embedding provider:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
    const { name, apiKey, apiEndpoint, model, dimensions, isActive, isDefault } = body

    const existing = await prisma.embeddingProvider.findFirst({
      where: { id: params.id, userId: auth.user.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    }

    // If setting as default, unset other defaults first
    if (isDefault) {
      await prisma.embeddingProvider.updateMany({
        where: { userId: auth.user.id, isDefault: true, id: { not: params.id } },
        data: { isDefault: false },
      })
    }

    const updated = await prisma.embeddingProvider.update({
      where: { id: params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(apiKey !== undefined && { apiKey }),
        ...(apiEndpoint !== undefined && { apiEndpoint }),
        ...(model !== undefined && { model }),
        ...(dimensions !== undefined && { dimensions }),
        ...(isActive !== undefined && { isActive }),
        ...(isDefault !== undefined && { isDefault }),
      },
    })

    return NextResponse.json({ provider: updated })
  } catch (error: any) {
    console.error('Error updating embedding provider:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
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

    const existing = await prisma.embeddingProvider.findFirst({
      where: { id: params.id, userId: auth.user.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    }

    await prisma.embeddingProvider.delete({ where: { id: params.id } })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error deleting embedding provider:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}