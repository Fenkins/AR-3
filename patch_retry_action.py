with open('/opt/AR-3/app/api/spaces/[id]/route.ts', 'r') as f:
    content = f.read()

old = """      case 'stop':
        console.log('[Spaces API] Stopping space:', params.id)
        await stopSpace(params.id)
        return NextResponse.json({ success: true })

      case 'thinking_setup':"""

new = """      case 'stop':
        console.log('[Spaces API] Stopping space:', params.id)
        await stopSpace(params.id)
        return NextResponse.json({ success: true })

      case 'retry': {
        // Manual retry after timeout/failure - clears error state and re-runs setup
        const { updateExecutionState } = await import('@/lib/research-engine')
        const state = getExecutionState(params.id)
        if (!state) return NextResponse.json({ error: 'No execution state found' }, { status: 400 })
        updateExecutionState(params.id, {
          lastError: undefined,
          lastErrorTime: undefined,
          lastErrorType: undefined,
          isThinkingSetupRunning: true,
        })
        runThinkingSetupBackground(params.id)
        return NextResponse.json({ success: true, message: 'Retry started in background' })
      }

      case 'thinking_setup':"""

if old in content:
    content = content.replace(old, new)
    with open('/opt/AR-3/app/api/spaces/[id]/route.ts', 'w') as f:
        f.write(content)
    print('Patched successfully')
else:
    print('Old block not found')
