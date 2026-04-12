import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, getUserFromToken } from '@/lib/auth'

export async function authMiddleware(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
 
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const token = authHeader.substring(7)
  const user = await getUserFromToken(token)

  if (!user) {
    return NextResponse.json(
      { error: 'Invalid or expired token' },
      { status: 401 }
    )
  }

  if (!user.isActive) {
    return NextResponse.json(
      { error: 'Account is disabled' },
      { status: 403 }
    )
  }

  return { user, token }
}

export function adminMiddleware(authResult: any) {
  if (authResult.user.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    )
  }
  return null
}
