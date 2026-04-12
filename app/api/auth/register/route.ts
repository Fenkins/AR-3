import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashPassword, generateToken } from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    // Check if registration is enabled
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'REGISTRATION_ENABLED' },
    })

    const registrationEnabled = config?.value === 'true'

    if (!registrationEnabled) {
      return NextResponse.json(
        { error: 'Registration is currently disabled' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { email, password, username } = body

    if (!email || !password || !username) {
      return NextResponse.json(
        { error: 'Email, password, and username are required' },
        { status: 400 }
      )
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username },
        ],
      },
    })

    if (existingUser) {
      return NextResponse.json(
        { error: 'User already exists' },
        { status: 409 }
      )
    }

    // Hash password
    const hashedPassword = await hashPassword(password)

    // Create user with default USER role
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        username,
        role: 'USER',
        isActive: true,
      },
    })

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    })

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      token,
    })
  } catch (error) {
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
