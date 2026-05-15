import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import fs from 'fs'

const LOG_PATHS = [
  '/tmp/nextjs.log',
  '/tmp/gpu_worker.log',
  '/tmp/ar1_debug.log',
]

function tailLines(text: string, maxLines = 120): string[] {
  return text.split('\n').filter(Boolean).slice(-maxLines)
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const lines: string[] = []
    for (const path of LOG_PATHS) {
      try {
        if (!fs.existsSync(path)) continue
        const stat = fs.statSync(path)
        const start = Math.max(0, stat.size - 64 * 1024)
        const fd = fs.openSync(path, 'r')
        try {
          const buffer = Buffer.alloc(stat.size - start)
          fs.readSync(fd, buffer, 0, buffer.length, start)
          const fileLines = tailLines(buffer.toString('utf8'), 40)
          if (fileLines.length > 0) {
            lines.push(`--- ${path} ---`, ...fileLines)
          }
        } finally {
          fs.closeSync(fd)
        }
      } catch (error: any) {
        lines.push(`--- ${path} unavailable: ${error?.message || String(error)} ---`)
      }
    }

    if (lines.length === 0) {
      return new NextResponse('(no server log files found)', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    return new NextResponse(lines.slice(-120).join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
