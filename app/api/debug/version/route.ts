import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { execSync } from 'child_process'

function run(command: string): string | null {
  try {
    return execSync(command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const commit = run('git rev-parse HEAD')
    const branch = run('git branch --show-current')
    const status = run('git status --short')

    return NextResponse.json({
      commit,
      branch,
      dirty: !!status,
      status,
      builtAt: process.env.AR3_BUILD_TIME || null,
      nodeEnv: process.env.NODE_ENV || null,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
