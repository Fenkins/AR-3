import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'http://127.0.0.1:4000'

// GET /api/search?q=<query>&source=<hf|github|arxiv|all>&limit=<N>
export async function GET(request: NextRequest) {
  // Skip auth for internal service-to-service calls
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const auth = await authMiddleware(request)
  if ('json' in auth) return auth

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')
  const source = searchParams.get('source') || 'all'
  const limit = parseInt(searchParams.get('limit') || '5', 10)

  if (!q) {
    return NextResponse.json({ error: 'q parameter required' }, { status: 400 })
  }

  try {
    const url = `${SEARCH_SERVICE_URL}/search?q=${encodeURIComponent(q)}&source=${source}&limit=${limit}`
    const response = await fetch(url, {
      next: { revalidate: 0 }, // Don't cache search results
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json()
    return NextResponse.json(data)
  } catch (error: any) {
    console.error('[Search API] Error:', error?.message || error)
    return NextResponse.json(
      { error: `Search service unavailable: ${error?.message || 'connection failed'}` },
      { status: 503 }
    )
  }
}
