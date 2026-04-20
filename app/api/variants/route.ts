import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '@/app/api/middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const { searchParams } = new URL(request.url)
    const spaceId = searchParams.get('spaceId')

    if (!spaceId) {
      return NextResponse.json({ error: 'spaceId required' }, { status: 400 })
    }

    // Verify space belongs to user
    const space = await prisma.space.findFirst({
      where: { id: spaceId, userId: auth.user.id },
    })

    if (!space) {
      return NextResponse.json({ error: 'Space not found' }, { status: 404 })
    }

    const variants = await prisma.variant.findMany({
      where: { spaceId },
      include: {
        variantSteps: { orderBy: { order: 'asc' } },
      },
      orderBy: [{ cycleNumber: 'desc' }, { stageId: 'asc' }, { order: 'asc' }],
    })

    // Group by cycle, then by stage
    const byCycle: Record<number, Record<string, typeof variants>> = {}
    for (const v of variants) {
      if (!byCycle[v.cycleNumber]) byCycle[v.cycleNumber] = {}
      const key = `${v.stageId}:${v.stageName}`
      if (!byCycle[v.cycleNumber][key]) byCycle[v.cycleNumber][key] = []
      byCycle[v.cycleNumber][key].push(v)
    }

    return NextResponse.json({ variants, byCycle, space })
  } catch (error) {
    console.error('Error fetching variants:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
