import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '@/app/api/middleware'
import { prisma } from '@/lib/prisma'

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()
    const { action, userRating, feedback, grade } = body

    // Verify variant belongs to user's space
    const variant = await prisma.variant.findFirst({
      where: {
        id: params.id,
        space: { userId: auth.user.id },
      },
    })

    if (!variant) {
      return NextResponse.json({ error: 'Variant not found' }, { status: 404 })
    }

    if (action === 'rate') {
      // Update user rating (thumbs up/down)
      const updated = await prisma.variant.update({
        where: { id: params.id },
        data: { userRating },
      })
      return NextResponse.json({ success: true, variant: updated })
    }

    if (action === 'feedback') {
      // Update feedback text
      const updated = await prisma.variant.update({
        where: { id: params.id },
        data: { feedback },
      })
      return NextResponse.json({ success: true, variant: updated })
    }

    if (action === 'grade') {
      // Update grade
      const updated = await prisma.variant.update({
        where: { id: params.id },
        data: { grade },
      })
      return NextResponse.json({ success: true, variant: updated })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Error updating variant:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const variant = await prisma.variant.findFirst({
      where: {
        id: params.id,
        space: { userId: auth.user.id },
      },
      include: {
        VariantStep: { orderBy: { order: 'asc' } },
        space: { select: { id: true, name: true, currentPhase: true, currentCycle: true } },
      },
    })

    if (!variant) {
      return NextResponse.json({ error: 'Variant not found' }, { status: 404 })
    }

    return NextResponse.json({ variant })
  } catch (error) {
    console.error('Error fetching variant:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
