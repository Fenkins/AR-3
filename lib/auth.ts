import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from './prisma'

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret'

export interface JWTPayload {
  userId: string
  email: string
  role: string
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

/** Alias for generateToken — used by variant-engine for internal service auth */
export function signToken(email: string): string {
  return generateToken({ userId: 'admin', email, role: 'ADMIN' })
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload
  } catch {
    return null
  }
}

export async function getUserFromToken(token: string) {
  const payload = verifyToken(token)
  if (!payload) return null

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: {
      agents: true,
      spaces: true,
    }
  })

  return user
}

export function requireAuth(token: string | undefined): JWTPayload {
  if (!token) {
    throw new Error('Authentication required')
  }

  const payload = verifyToken(token)
  if (!payload) {
    throw new Error('Invalid or expired token')
  }

  return payload
}

export function requireAdmin(payload: JWTPayload): JWTPayload {
  if (payload.role !== 'ADMIN') {
    throw new Error('Admin access required')
  }
  return payload
}
