import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    // Get overall stats
    const spaces = await prisma.space.findMany({
      where: { userId: auth.user.id },
      include: {
        experiments: {
          select: {
            tokensUsed: true,
            cost: true,
            status: true,
            phase: true,
          },
        },
        breakthroughs: {
          select: {
            id: true,
            title: true,
            confidence: true,
            verified: true,
            category: true,
            createdAt: true,
          },
        },
      },
    })

    // Calculate aggregated stats
    const totalTokens = spaces.reduce((sum, s) => sum + s.totalTokens, 0)
    const totalCost = spaces.reduce((sum, s) => sum + s.totalCost, 0)
    const totalExperiments = spaces.reduce((sum, s) => sum + s.experiments.length, 0)
    const totalBreakthroughs = spaces.reduce((sum, s) => sum + s.breakthroughs.length, 0)
    const verifiedBreakthroughs = spaces.reduce(
      (sum, s) => sum + s.breakthroughs.filter(b => b.verified).length,
      0
    )

    // Experiments by phase
    const experimentsByPhase: Record<string, number> = {}
    spaces.forEach(space => {
      space.experiments.forEach(exp => {
        experimentsByPhase[exp.phase] = (experimentsByPhase[exp.phase] || 0) + 1
      })
    })

    // Breakthroughs by category
    const breakthroughsByCategory: Record<string, number> = {}
    spaces.forEach(space => {
      space.breakthroughs.forEach(b => {
        breakthroughsByCategory[b.category] = (breakthroughsByCategory[b.category] || 0) + 1
      })
    })

    // Space stats
    const spaceStats = spaces.map(space => ({
      id: space.id,
      name: space.name,
      status: space.status,
      phase: space.currentPhase,
      experiments: space.experiments.length,
      breakthroughs: space.breakthroughs.length,
      tokensUsed: space.totalTokens,
      cost: space.totalCost,
    }))

    // Recent breakthroughs across all spaces
    const allBreakthroughs = spaces
      .flatMap(s => s.breakthroughs.map(b => ({ ...b, spaceName: s.name })))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10)

    return NextResponse.json({
      stats: {
        totalSpaces: spaces.length,
        totalTokens,
        totalCost,
        totalExperiments,
        totalBreakthroughs,
        verifiedBreakthroughs,
      },
      experimentsByPhase,
      breakthroughsByCategory,
      spaceStats,
      recentBreakthroughs: allBreakthroughs,
    })
  } catch (error) {
    console.error('Error fetching dashboard:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
