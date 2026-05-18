import { NextRequest, NextResponse } from 'next/server'
import { collectHealthStatus, publicHealthPayload } from '@/lib/health-status'

export const dynamic = 'force-dynamic'

function wantsAuthorizedDetails(request: NextRequest): boolean {
  const configuredToken = process.env.AR3_HEALTH_DETAIL_TOKEN
  if (!configuredToken) return false
  return request.headers.get('x-ar3-health-detail-token') === configuredToken
}

export async function GET(request: NextRequest) {
  try {
    const health = await collectHealthStatus()
    const body = wantsAuthorizedDetails(request) ? health : publicHealthPayload(health)
    return NextResponse.json(body, { status: health.status === 'healthy' ? 200 : 503 })
  } catch {
    return NextResponse.json({
      status: 'degraded',
      ok: false,
    }, { status: 503 })
  }
}
