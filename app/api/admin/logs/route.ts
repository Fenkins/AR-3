import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import fs from 'fs'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    // Only admins can access logs
    if (auth.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    // Read the debug log file
    const logFile = '/tmp/ar1_debug.log'
    const startupLog = '/tmp/ar1_startup.log'

    let debugLogs = ''
    let startupLogs = ''

    try {
      debugLogs = fs.readFileSync(logFile, 'utf8')
    } catch {
      debugLogs = 'No debug log file found'
    }

    try {
      startupLogs = fs.readFileSync(startupLog, 'utf8')
    } catch {
      startupLogs = 'No startup log file found'
    }

    // Get system info
    const os = require('os')
    const systemInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: os.uptime(),
      freemem: os.freemem(),
      totalmem: os.totalmem(),
    }

    return NextResponse.json({
      debugLogs,
      startupLogs,
      systemInfo,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    // Only admins can clear logs
    if (auth.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { logType } = await request.json()

    if (logType === 'debug') {
      fs.writeFileSync('/tmp/ar1_debug.log', '')
    } else if (logType === 'startup') {
      fs.writeFileSync('/tmp/ar1_startup.log', '')
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
