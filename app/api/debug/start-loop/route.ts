import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '@/app/api/middleware'
import { startBackgroundLoop } from '@/lib/research-engine'

export async function PUT(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth
    const { spaceId } = await request.json()
    if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })
    startBackgroundLoop(spaceId)
    return NextResponse.json({ success: true, message: 'Background loop started' })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
