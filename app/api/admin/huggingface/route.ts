import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware, adminMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'

const HF_CONFIG_KEY = 'huggingface_token'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const adminCheck = adminMiddleware(auth)
    if (adminCheck) return adminCheck

    const config = await prisma.systemConfig.findUnique({
      where: { key: HF_CONFIG_KEY },
    })

    return NextResponse.json({
      hasToken: !!config?.value,
      tokenPrefix: config?.value ? `***${config.value.slice(-4)}` : null,
    })
  } catch (error) {
    console.error('[HuggingFace] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const adminCheck = adminMiddleware(auth)
    if (adminCheck) return adminCheck

    const body = await request.json()
    const { token, action } = body

    if (action === 'test') {
      // Test the token without saving
      if (!token) {
        return NextResponse.json({ error: 'Token required' }, { status: 400 })
      }

      try {
        // Test by fetching HF API whoami
        const whoamiRes = await fetch('https://huggingface.co/api/whoami-v2', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        })

        if (!whoamiRes.ok) {
          const errText = await whoamiRes.text()
          return NextResponse.json(
            { valid: false, error: `HuggingFace rejected token: ${whoamiRes.status}` },
            { status: 401 }
          )
        }

        const whoami = await whoamiRes.json()
        return NextResponse.json({
          valid: true,
          username: whoami.name,
          email: whoami.email,
        })
      } catch (err: any) {
        return NextResponse.json(
          { valid: false, error: `Connection failed: ${err.message}` },
          { status: 400 }
        )
      }
    }

    if (action === 'save') {
      if (!token) {
        return NextResponse.json({ error: 'Token required' }, { status: 400 })
      }

      // Upsert the token
      const config = await prisma.systemConfig.upsert({
        where: { key: HF_CONFIG_KEY },
        update: { value: token },
        create: { id: `cfg_hf_${Date.now()}`, key: HF_CONFIG_KEY, value: token, updatedAt: new Date() },
      })

      return NextResponse.json({
        message: 'Token saved',
        tokenPrefix: `***${token.slice(-4)}`,
      })
    }

    if (action === 'delete') {
      await prisma.systemConfig.deleteMany({
        where: { key: HF_CONFIG_KEY },
      })
      return NextResponse.json({ message: 'Token deleted' })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('[HuggingFace] PUT error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
