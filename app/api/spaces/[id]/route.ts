import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../../middleware'
import { prisma } from '@/lib/prisma'
import {
  startSpace,
  executeResearchCycle,
  runResearchLoop,
  pauseSpace,
  resumeSpace,
  stopSpace,
  updateSpaceStages,
  getSpaceStages,
  runThinkingSetup,
  getSpaceStatus,
  generateStageVariants,
  executeVariantCycle,
  getExecutionState,
  runCycleBackground,
  runStartBackground,
  runLoopBackground,
  runThinkingSetupBackground,
} from '@/lib/research-engine'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const space = await prisma.space.findFirst({
      where: {
        id: params.id,
        userId: auth.user.id,
      },
      include: {
        experiments: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        breakthroughs: {
          orderBy: { createdAt: 'desc' },
        },
        variants: {
          include: { steps: { orderBy: { order: 'asc' } } },
          orderBy: [{ cycleNumber: 'desc' }, { order: 'asc' }],
        },
      },
    })

    if (!space) {
      return NextResponse.json({ error: 'Space not found' }, { status: 404 })
    }

    // Get stages from metadata
    let stages = []
    try {
      const metadata = JSON.parse(space.description || '{}')
      stages = metadata.stages || []
    } catch {}

    // Get execution state
    const executionState = getExecutionState(params.id)

    return NextResponse.json({
      space,
      stages,
      execution: executionState,
      isRunning: executionState?.isRunning ?? (space.status === 'RUNNING'),
    })
  } catch (error) {
    console.error('Error fetching space:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  console.log('[Spaces API] PUT received for:', params.id)

  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const rawBody = await request.text()
    let body
    try {
      body = JSON.parse(rawBody)
    } catch (e) {
      console.error('[Spaces API] JSON parse error:', e)
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { action, stages, stageId, numCycles, numVariants, stepsPerVariant, variantId } = body

    console.log('[Spaces API] Action:', action)

    switch (action) {
      case 'start': {
        console.log('[Spaces API] Starting space:', params.id)
        // Non-blocking: initialize and return immediately, first cycle runs in background
        runStartBackground(params.id)
        return NextResponse.json({ success: true, status: 'STARTING', message: 'Space starting in background - poll /status for updates' })
      }

      case 'run': {
        console.log('[Spaces API] Running research cycle(s):', params.id)
        // Non-blocking: run cycles in background without waiting
        runLoopBackground(params.id, numCycles || 3)
        return NextResponse.json({ success: true, status: 'RUNNING', message: `${numCycles || 3} cycles started in background - poll /status for updates` })
      }

      case 'cycle': {
        console.log('[Spaces API] Single cycle for stage:', stageId || 'current')
        // Non-blocking: return immediately with job ID, process in background
        const { jobId } = await runCycleBackground(params.id, stageId)
        return NextResponse.json({ 
          success: true, 
          jobId,
          status: 'PENDING',
          message: 'Cycle started in background - poll /status for completion' 
        })
      }

      case 'pause':
        console.log('[Spaces API] Pausing space:', params.id)
        await pauseSpace(params.id)
        return NextResponse.json({ success: true })

      case 'resume':
        console.log('[Spaces API] Resuming space:', params.id)
        await resumeSpace(params.id)
        return NextResponse.json({ success: true })

      case 'stop':
        console.log('[Spaces API] Stopping space:', params.id)
        await stopSpace(params.id)
        return NextResponse.json({ success: true })

      case 'thinking_setup':
        console.log('[Spaces API] Running thinking setup:', params.id)
        console.log('[Spaces API] Request headers:', JSON.stringify(request.headers).substring(0, 200))
        try {
          console.log('[Spaces API] Calling runThinkingSetupBackground...')
          runThinkingSetupBackground(params.id)
          return NextResponse.json({ success: true, message: 'Setup started in background' })
        } catch (error: any) {
          console.error('[Spaces API] Thinking setup error:', error)
          console.error('[Spaces API] Error stack:', error.stack)
          return NextResponse.json({ error: error.message || String(error) }, { status: 500 })
        }

      case 'update_stages':
        if (!stages) {
          return NextResponse.json({ error: 'Stages array required' }, { status: 400 })
        }
        const updated = await updateSpaceStages(params.id, stages)
        return NextResponse.json({ success: true, stages: updated })

      case 'get_stages':
        const stageList = await getSpaceStages(params.id)
        return NextResponse.json({ success: true, stages: stageList })

      case 'status':
        const status = await getSpaceStatus(params.id)
        return NextResponse.json({ success: true, ...status })

      case 'generate_variants':
        console.log('[Spaces API] Generating variants for stage:', stageId)
        try {
          const variants = await generateStageVariants(
            params.id,
            stageId,
            numVariants || 'auto',
            stepsPerVariant || 'auto'
          )
          return NextResponse.json({ success: true, variants })
        } catch (error: any) {
          console.error('[Spaces API] Variant generation error:', error)
          return NextResponse.json({ error: error.message || String(error) }, { status: 500 })
        }

      case 'execute_variant':
        console.log('[Spaces API] Executing variant:', variantId)
        try {
          const executedVariant = await executeVariantCycle(params.id, variantId)
          return NextResponse.json({ success: true, variant: executedVariant })
        } catch (error: any) {
          console.error('[Spaces API] Variant execution error:', error)
          return NextResponse.json({ error: error.message }, { status: 500 })
        }

      case 'update_settings': {
        const { useGpu, useEmbeddings } = body
        const updateData: any = {}
        if (typeof useGpu === 'boolean') updateData.useGpu = useGpu
        if (typeof useEmbeddings === 'boolean') updateData.useEmbeddings = useEmbeddings
        const updated = await prisma.space.update({
          where: { id: params.id },
          data: updateData,
        })
        return NextResponse.json({ success: true, space: updated })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[Spaces API] Error:', error)
    const errMessage = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: errMessage }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    await stopSpace(params.id)

    await prisma.space.delete({
      where: {
        id: params.id,
        userId: auth.user.id,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting space:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
