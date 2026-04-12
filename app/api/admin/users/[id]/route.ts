import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware, adminMiddleware } from '../../../middleware'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const adminCheck = adminMiddleware(auth)
    if (adminCheck) return adminCheck

    const body = await request.json()

    // Prevent admins from disabling themselves
    if (body.isActive === false && auth.user.id === params.id) {
      return NextResponse.json(
        { error: 'Cannot disable your own account' },
        { status: 400 }
      )
    }

    // Prevent role demotion of self
    if (body.role && auth.user.id === params.id) {
      return NextResponse.json(
        { error: 'Cannot change your own role' },
        { status: 400 }
      )
    }

    const user = await prisma.user.update({
      where: { id: params.id },
      data: {
        role: body.role,
        isActive: body.isActive,
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        isActive: true,
      },
    })

    return NextResponse.json({ user })
  } catch (error) {
    console.error('Error updating user:', error)
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

    const adminCheck = adminMiddleware(auth)
    if (adminCheck) return adminCheck

    // Prevent self-deletion
    if (auth.user.id === params.id) {
      return NextResponse.json(
        { error: 'Cannot delete your own account' },
        { status: 400 }
      )
    }

    await prisma.user.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting user:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
