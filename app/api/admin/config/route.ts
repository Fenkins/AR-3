import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware, adminMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const adminCheck = adminMiddleware(auth)
    if (adminCheck) return adminCheck

    const configs = await prisma.systemConfig.findMany()

    return NextResponse.json({ configs })
  } catch (error) {
    console.error('Error fetching config:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const adminCheck = adminMiddleware(auth)
    if (adminCheck) return adminCheck

    const body = await request.json()
    const { key, value } = body

    if (!key || value === undefined) {
      return NextResponse.json(
        { error: 'Key and value are required' },
        { status: 400 }
      )
    }

    const config = await prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })

    return NextResponse.json({ config })
  } catch (error) {
    console.error('Error updating config:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
