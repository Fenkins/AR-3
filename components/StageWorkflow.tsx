'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/AuthContext'

interface Stage {
  id: string
  name: string
  description: string
  prompt: string
  order: number
  isActive: boolean
  status?: 'pending' | 'running' | 'completed' | 'failed'
  numVariants?: number | 'auto'
  stepsPerVariant?: number | 'auto'
}

interface Variant {
  id: string
  stageId: string
  name: string
  description: string
  steps: Step[]
  grade?: number
  feedback?: string
  userRating?: string
  isSelected: boolean
  order: number
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PENDING_REVIEW'
}

interface Step {
  id: string
  name: string
  description: string
  order: number
  isAuto: boolean
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PENDING_REVIEW'
  result?: string
  grade?: number
  userRating?: string
}

interface Experiment {
  id: string
  phase: string
  agentName: string
  result?: string
  tokensUsed: number
  grade?: number
  userRating?: string
  createdAt: string
  status: string
}

interface StageWorkflowProps {
  spaceId: string
  initialPrompt: string
  onClose: () => void
}

export default function StageWorkflow({ spaceId, initialPrompt, onClose }: StageWorkflowProps) {
  const { token } = useAuth()
  const [space, setSpace] = useState<any>(null)
  const [stages, setStages] = useState<Stage[]>([])
  const [currentStageIndex, setCurrentStageIndex] = useState(0)
  const [variants, setVariants] = useState<Variant[]>([])
  const [allVariants, setAllVariants] = useState<Variant[]>([])
  const [selectedVariant, setSelectedVariant] = useState<Variant | null>(null)
  const [isAutoMode, setIsAutoMode] = useState(true)
  const [isThinkingSetup, setIsThinkingSetup] = useState(false)
  const [setupProgress, setSetupProgress] = useState(0)
  const [setupMessage, setSetupMessage] = useState('')
  const [showEditModal, setShowEditModal] = useState<string | null>(null)
  const [showVariantsModal, setShowVariantsModal] = useState(false)
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [showVariantDetailModal, setShowVariantDetailModal] = useState<Variant | null>(null)
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [loading, setLoading] = useState(true)
  const [setupComplete, setSetupComplete] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'paused' | 'stopped'>('idle')
  const [generatingVariants, setGeneratingVariants] = useState(false)
  const [executionState, setExecutionState] = useState<any>(null)
  const [totalTokens, setTotalTokens] = useState(0)
  const [totalCost, setTotalCost] = useState(0)
  const [breakthroughs, setBreakthroughs] = useState<any[]>([])
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())
  const [showDebugLog, setShowDebugLog] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<string>>(new Set())
  const [expandedVariantIds, setExpandedVariantIds] = useState<Set<string>>(new Set())
  const [genNumVariants, setGenNumVariants] = useState(3)
  const [genStepsPerVariant, setGenStepsPerVariant] = useState(25)
  const [cycleCount, setCycleCount] = useState(0)

  const serverStageSyncDone = useRef(false)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const setupStartTimeRef = useRef<number | null>(null)
  const debugLogIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const fetchSpaceData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }

      if (data.space) {
        setSpace(data.space)
        const setupDone = !!(data.stages?.length || ['COMPLETED', 'FAILED'].includes(data.space.setupStatus))
        if (setupDone) {
          setSetupComplete(true)
        } else {
          if (!data.stages?.length) {
            setTimeout(() => fetchSpaceData(false), 3000)
          }
        }

        if (!data.stages?.length) {
          setStages([])
          setVariants([])
          setAllVariants([])
          return
        }

        setStages(data.stages)

        if (!serverStageSyncDone.current && data.execution?.currentStageId) {
          const idx = data.stages.findIndex((s: Stage) => s.id === data.execution.currentStageId)
          if (idx >= 0) {
            setCurrentStageIndex(idx)
            serverStageSyncDone.current = true
          }
        }

        setExecutionState(data.execution || null)
        setIsRunning(data.execution?.isRunning || data.space.status === 'RUNNING')
        setRunStatus(data.execution?.isRunning ? 'running' : data.space.status === 'PAUSED' ? 'paused' : 'idle')
        setTotalTokens(data.space.totalTokens || 0)
        setTotalCost(data.space.totalCost || 0)

        if (data.space.experiments) {
          setExperiments(data.space.experiments)
          setCycleCount(data.space.experiments.filter((e: Experiment) => e.status === 'COMPLETED').length)
        }
        if (data.space.breakthroughs) setBreakthroughs(data.space.breakthroughs)

        let selectedStageId: string
        if (currentStageIndex >= 0 && currentStageIndex < data.stages.length) {
          selectedStageId = data.stages[currentStageIndex].id
        } else if (data.execution?.currentStageId) {
          selectedStageId = data.execution.currentStageId
        } else {
          selectedStageId = data.stages[0].id
        }

        const allVars = data.execution?.variants || []
        setAllVariants(allVars)
        const stageVars = allVars.filter((v: any) => v.stageId === selectedStageId)
        if (stageVars.length > 0) {
          setVariants(stageVars)
        } else {
          setVariants([])
        }
        setLastUpdated(new Date())
      }
    } catch (error) {
      console.error('Error fetching space:', error)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [spaceId, token, currentStageIndex])

  useEffect(() => {
    fetchSpaceData()
  }, [fetchSpaceData])

  useEffect(() => {
    if (isRunning && setupComplete) {
      pollIntervalRef.current = setInterval(() => {
        fetchSpaceData(false)
      }, 5000)
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    }
  }, [isRunning, setupComplete, fetchSpaceData])

  useEffect(() => {
    if (showDebugLog) {
      const fetchLog = async () => {
        try {
          const res = await fetch('/api/debug/log')
          if (res.ok) {
            const lines = await res.text()
            setDebugLog(lines.split('\n').filter(Boolean).slice(-30))
          }
        } catch {
          setDebugLog(['(debug log unavailable)'])
        }
      }
      fetchLog()
      debugLogIntervalRef.current = setInterval(fetchLog, 5000)
    }
    return () => {
      if (debugLogIntervalRef.current) clearInterval(debugLogIntervalRef.current)
    }
  }, [showDebugLog])

  const setupSteps = [
    'Analyzing research goal...',
    'Configuring thinking agent...',
    'Creating stage pipeline...',
    'Initializing research cycle...',
    'Pre-allocating variants...',
  ]

  const runThinkingSetup = async () => {
    if (isThinkingSetup) return
    setIsThinkingSetup(true)
    setSetupProgress(0)
    setSetupMessage('Starting setup...')
    setupStartTimeRef.current = Date.now()

    let pollCount = 0
    const maxPolls = 300

    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'thinking_setup' }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server error: ${text.substring(0, 100)}`) }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    } catch (error: any) {
      console.error('[ThinkingSetup] Failed to start:', error)
      setIsThinkingSetup(false)
      alert(`Setup failed to start: ${error.message}`)
      return
    }

    const pollInterval = setInterval(async () => {
      pollCount++
      try {
        const res = await fetch(`/api/spaces/${spaceId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const spaceData = await res.json()
        const sp = spaceData.space || spaceData

        if (sp.setupStatus === 'COMPLETED') {
          clearInterval(pollInterval)
          setSetupProgress(100)
          setSetupMessage('Setup complete!')
          setIsThinkingSetup(false)
          setSetupComplete(true)
          await fetchSpaceData()
          if (isAutoMode) { setIsRunning(true); setRunStatus('running') }
          return
        }
        if (sp.setupStatus === 'FAILED') {
          clearInterval(pollInterval)
          setIsThinkingSetup(false)
          alert(`Setup failed: ${sp.setupError || 'Unknown error'}`)
          return
        }
        if (sp.setupStep) setSetupMessage(sp.setupStep)
        const stepIndex = setupSteps.findIndex(s => sp.setupStep?.includes(s.substring(0, 20)))
        if (stepIndex >= 0) setSetupProgress(Math.min(((stepIndex + 1) / setupSteps.length) * 90, 90))
        else if (pollCount > 2) setSetupProgress(Math.min((pollCount / maxPolls) * 90, 90))
        if (pollCount >= maxPolls) {
          clearInterval(pollInterval)
          setIsThinkingSetup(false)
          alert('Setup timed out after 10 minutes.')
        }
      } catch (err) { console.error('[ThinkingSetup] Poll error:', err) }
    }, 2000)
  }

  const runResearchCycle = async (numCycles = 1) => {
    setIsRunning(true)
    setRunStatus('running')
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'run', numCycles }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      if (!response.ok) throw new Error(data.error || 'Research run failed')
      await fetchSpaceData(false)
    } catch (error: any) {
      console.error('Research run error:', error)
      alert(`Research run failed: ${error.message}`)
    } finally {
      setIsRunning(false)
    }
  }

  const runSingleCycle = async () => {
    setIsRunning(true)
    setRunStatus('running')
    try {
      const currentStage = stages[currentStageIndex]
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'cycle', stageId: currentStage?.id }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      if (!response.ok) throw new Error(data.error || 'Cycle failed')
      await fetchSpaceData(false)
    } catch (error: any) {
      console.error('Cycle error:', error)
      alert(`Cycle failed: ${error.message}`)
    } finally {
      setIsRunning(false)
      setRunStatus('idle')
    }
  }

  const pauseResearch = async () => {
    try {
      await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'pause' }),
      })
      setRunStatus('paused')
      setIsRunning(false)
    } catch (error) { console.error('Failed to pause:', error) }
  }

  const resumeResearch = async () => {
    try {
      await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'resume' }),
      })
      setRunStatus('running')
      setIsRunning(true)
    } catch (error) { console.error('Failed to resume:', error) }
  }

  const stopResearch = async () => {
    if (!confirm('Stop all research? This cannot be undone.')) return
    try {
      await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'stop' }),
      })
      setRunStatus('stopped')
      setIsRunning(false)
      await fetchSpaceData(false)
    } catch (error) { console.error('Failed to stop:', error) }
  }

  const doGenerateVariants = async () => {
    const currentStage = stages[currentStageIndex]
    if (!currentStage) return
    setGeneratingVariants(true)
    setShowGenerateModal(false)
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'generate_variants',
          stageId: currentStage.id,
          numVariants: genNumVariants,
          stepsPerVariant: genStepsPerVariant,
        }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      if (!response.ok) throw new Error(data.error || 'Variant generation failed')
      setVariants(data.variants || [])
      await fetchSpaceData(false)
    } catch (error: any) {
      alert(`Failed to generate variants: ${error.message}`)
    } finally {
      setGeneratingVariants(false)
    }
  }

  const executeVariant = async (variantId: string) => {
    setIsRunning(true)
    setRunStatus('running')
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'execute_variant', variantId }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      if (!response.ok) throw new Error(data.error || 'Variant execution failed')
      await fetchSpaceData(false)
    } catch (error: any) {
      alert(`Execution failed: ${error.message}`)
    } finally {
      setIsRunning(false)
      setRunStatus('idle')
    }
  }

  const handleDeleteSpace = async () => {
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) onClose()
    } catch (error) { console.error('Failed to delete space:', error) }
  }

  const currentStage = stages[currentStageIndex]

  const secondsAgo = Math.floor((Date.now() - lastUpdated.getTime()) / 1000)

  const getGradeColor = (grade?: number) => {
    if (!grade) return 'bg-dark-700 text-dark-400'
    if (grade > 70) return 'bg-green-500/20 text-green-300'
    if (grade >= 40) return 'bg-yellow-500/20 text-yellow-300'
    return 'bg-red-500/20 text-red-300'
  }

  const getGradeEmoji = (grade?: number) => {
    if (!grade) return ''
    if (grade > 70) return '🟢'
    if (grade >= 40) return '🟡'
    return '🔴'
  }

  const getStageStatusIcon = (status?: string) => {
    switch (status) {
      case 'completed': return '✅'
      case 'running': return '🔄'
      case 'failed': return '❌'
      default: return '⏳'
    }
  }

  const getRunningVariant = () => variants.find(v => v.status === 'RUNNING')
  const getRunningStep = (variant: Variant) => variant.steps.find(s => s.status === 'RUNNING')
  const getCurrentStepIndex = (variant: Variant) => {
    const running = getRunningStep(variant)
    if (!running) return variant.steps.filter(s => s.status === 'COMPLETED').length
    return variant.steps.findIndex(s => s.id === running.id)
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 border-4 border-dark-700 rounded-full"></div>
          <div className="absolute inset-0 border-4 border-primary-500 rounded-full border-t-transparent animate-spin"></div>
        </div>
        <p className="text-dark-400 animate-pulse">Loading research space...</p>
      </div>
    )
  }

  if (!setupComplete) {
    const elapsed = setupStartTimeRef.current ? Math.floor((Date.now() - setupStartTimeRef.current) / 1000) : 0
    return (
      <div className="bg-dark-900 rounded-xl border border-dark-700 p-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary-500/5 to-transparent pointer-events-none" />
        <button onClick={onClose} className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg transition-all">✕</button>
        <div className="relative">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-xl bg-primary-500/20 flex items-center justify-center text-2xl">🧠</div>
            <div>
              <h3 className="text-2xl font-bold">Research Space Setup</h3>
              <p className="text-dark-400 text-sm">Configure your thinking agent</p>
            </div>
          </div>
          <div className="mt-6 bg-dark-800/50 rounded-lg p-4 border border-dark-700">
            <p className="text-xs text-dark-400 uppercase tracking-wider mb-2">Research Goal</p>
            <p className="text-dark-200">{initialPrompt}</p>
          </div>
          {!isThinkingSetup ? (
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3 p-4 bg-dark-800/30 rounded-lg border border-dark-700">
                <input type="checkbox" checked={isAutoMode} onChange={(e) => setIsAutoMode(e.target.checked)} className="w-5 h-5 rounded border-dark-500 text-primary-500 focus:ring-primary-500" />
                <div>
                  <p className="font-medium">Auto-start research</p>
                  <p className="text-sm text-dark-400">Automatically begin research cycle after setup</p>
                </div>
              </div>
              <button onClick={runThinkingSetup} className="w-full py-4 px-6 bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-700 hover:to-primary-600 rounded-xl font-semibold text-lg transition-all shadow-lg shadow-primary-500/25">
                <span className="flex items-center justify-center gap-2"><span>🚀</span><span>Start Thinking Agent Setup</span></span>
              </button>
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              <div className="space-y-3">
                {setupSteps.map((step, i) => {
                  const stepProgress = setupProgress >= ((i + 1) / setupSteps.length) * 100
                  const isActive = setupProgress > (i / setupSteps.length) * 100 && !stepProgress
                  return (
                    <div key={i} className={`flex items-center gap-3 p-3 rounded-lg transition-all ${stepProgress ? 'bg-green-500/10 text-green-300' : isActive ? 'bg-primary-500/10 text-primary-300' : 'bg-dark-800/50 text-dark-500'}`}>
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${stepProgress ? 'bg-green-500 text-white' : isActive ? 'bg-primary-500 text-white animate-pulse' : 'bg-dark-700 text-dark-400'}`}>{stepProgress ? '✓' : i + 1}</div>
                      <span className={isActive ? 'animate-pulse' : ''}>{step}</span>
                    </div>
                  )
                })}
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-dark-400">Overall Progress</span>
                  <span className="text-primary-400 font-medium">{Math.round(setupProgress)}%</span>
                </div>
                <div className="h-3 bg-dark-700 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-primary-600 to-primary-400 transition-all duration-500 ease-out" style={{ width: `${setupProgress}%` }} />
                </div>
                <p className="text-xs text-dark-500 text-center">Elapsed time: {elapsed}s</p>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  const runningVariant = getRunningVariant()
  const runningStep = runningVariant ? getRunningStep(runningVariant) : null
  const currentStepIdx = runningVariant ? getCurrentStepIndex(runningVariant) : 0
  const totalSteps = runningVariant?.steps.length || 0

  const stageVariantsCompleted = (stageId: string) => allVariants.filter(v => v.stageId === stageId && v.status === 'COMPLETED').length

  const toggleHistoryExpand = (id: string) => {
    setExpandedHistoryIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleVariantExpand = (id: string) => {
    setExpandedVariantIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-3">
      {/* TOP HEADER BAR */}
      <div className="bg-dark-900 rounded-xl border border-dark-700 p-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-white">{space?.name || 'Research Space'}</h2>
            <div className="flex items-center gap-2">
              {runStatus === 'running' && <span className="flex items-center gap-1 text-xs text-green-400"><span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" /> Running</span>}
              {runStatus === 'paused' && <span className="flex items-center gap-1 text-xs text-yellow-400"><span className="w-2 h-2 bg-yellow-400 rounded-full" /> Paused</span>}
              {runStatus === 'stopped' && <span className="flex items-center gap-1 text-xs text-red-400"><span className="w-2 h-2 bg-red-400 rounded-full" /> Stopped</span>}
              {runStatus === 'idle' && <span className="flex items-center gap-1 text-xs text-dark-400"><span className="w-2 h-2 bg-dark-500 rounded-full" /> Idle</span>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-dark-400">Tokens: <span className="text-dark-200 font-medium">{totalTokens.toLocaleString()}</span></span>
            <span className="text-xs text-dark-400">Cost: <span className="text-dark-200 font-medium">${totalCost.toFixed(4)}</span></span>
            <span className="text-xs px-2 py-0.5 bg-dark-800 rounded text-dark-300">Cycle {cycleCount}</span>
          </div>
          <div className="flex items-center gap-2">
            {runStatus === 'idle' && (
              <>
                <button onClick={runSingleCycle} disabled={isRunning} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-all">
                  <span>▶</span><span>Run</span>
                </button>
                {isAutoMode && (
                  <button onClick={() => runResearchCycle(5)} disabled={isRunning} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-all">
                    <span>🔥</span><span>Run 5</span>
                  </button>
                )}
              </>
            )}
            {runStatus === 'running' && (
              <>
                <button onClick={pauseResearch} className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 rounded-lg text-sm font-medium transition-all">
                  <span>⏸</span><span>Pause</span>
                </button>
                <button onClick={stopResearch} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-all">
                  <span>⏹</span><span>Stop</span>
                </button>
              </>
            )}
            {runStatus === 'paused' && (
              <>
                <button onClick={resumeResearch} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-medium transition-all">
                  <span>▶</span><span>Resume</span>
                </button>
                <button onClick={stopResearch} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-all">
                  <span>⏹</span><span>Stop</span>
                </button>
              </>
            )}
            <div className="relative group">
              <button className="w-8 h-8 flex items-center justify-center bg-dark-700 hover:bg-dark-600 rounded-lg transition-all text-dark-300">⋮</button>
              <div className="absolute right-0 top-full mt-1 w-44 bg-dark-800 border border-dark-700 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                <button onClick={() => setShowGenerateModal(true)} disabled={generatingVariants} className="w-full px-3 py-2.5 text-left text-dark-300 hover:bg-dark-700 rounded-lg transition-colors flex items-center gap-2 text-sm disabled:opacity-50">
                  <span>🎲</span><span>{generatingVariants ? 'Generating...' : 'Generate Variants'}</span>
                </button>
                <button onClick={() => { if (confirm('Delete this research space?')) handleDeleteSpace() }} className="w-full px-3 py-2.5 text-left text-red-400 hover:bg-dark-700 rounded-lg transition-colors flex items-center gap-2 text-sm">
                  <span>🗑</span><span>Delete Space</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-dark-500">Last updated: {secondsAgo}s ago</span>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isAutoMode} onChange={(e) => setIsAutoMode(e.target.checked)} className="sr-only" />
            <div className={`w-9 h-5 rounded-full transition-colors ${isAutoMode ? 'bg-primary-500' : 'bg-dark-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full shadow transform transition-transform mt-0.5 ${isAutoMode ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-xs text-dark-400">Auto</span>
          </label>
        </div>
      </div>

      {/* STAGE TABS */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {stages.map((stage, index) => {
          const completed = stageVariantsCompleted(stage.id)
          const isCurrent = index === currentStageIndex
          return (
            <button
              key={stage.id}
              onClick={() => { setCurrentStageIndex(index); setSelectedVariant(null) }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap border ${isCurrent ? 'bg-primary-500/20 border-primary-500 text-white' : 'bg-dark-800 border-dark-700 text-dark-300 hover:border-dark-500'}`}
            >
              <span>{getStageStatusIcon(stage.status)}</span>
              <span>{stage.name}</span>
              {completed > 0 && <span className="px-1.5 py-0.5 text-xs bg-dark-700 rounded-full">{completed}</span>}
            </button>
          )
        })}
      </div>

      {/* SPLIT VIEW */}
      <div className="grid grid-cols-1 lg:grid-cols-[65%_35%] gap-3">
        {/* LEFT PANEL — Current Execution (65%) */}
        <div className="space-y-3">
          {/* Current Stage Info */}
          <div className="bg-dark-900 rounded-xl border border-dark-700 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">{currentStage?.name}</h3>
                <span className={`px-2 py-0.5 text-xs rounded ${currentStage?.status === 'completed' ? 'bg-green-500/20 text-green-300' : currentStage?.status === 'running' ? 'bg-yellow-500/20 text-yellow-300' : 'bg-dark-700 text-dark-400'}`}>
                  {currentStage?.status || 'pending'}
                </span>
              </div>
              <button onClick={() => setShowEditModal(currentStage?.id || null)} className="p-1.5 text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg transition-colors text-sm">✏️</button>
            </div>

            {/* Progress Bar */}
            {runningVariant && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-dark-300 font-medium">{runningVariant.name}</span>
                  <span className="text-dark-400">Step {currentStepIdx + 1} of {totalSteps}</span>
                </div>
                <div className="h-2.5 bg-dark-700 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-primary-600 to-primary-400 transition-all duration-500 ease-out" style={{ width: `${totalSteps > 0 ? ((currentStepIdx + 1) / totalSteps) * 100 : 0}%` }} />
                </div>
                {runningStep && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="w-2 h-2 bg-primary-400 rounded-full animate-pulse" />
                    <span className="text-xs text-primary-300">Executing: {runningStep.name}</span>
                  </div>
                )}
              </div>
            )}

            {/* Variant Cards */}
            {(variants.length ?? 0) > 0 ? (
              <div className="space-y-2">
                {variants.map((variant) => {
                  const isExpanded = expandedVariantIds.has(variant.id)
                  const hasRunning = variant.status === 'RUNNING'
                  return (
                    <div key={variant.id} className={`rounded-lg border-2 transition-all ${variant.isSelected ? 'bg-primary-500/10 border-primary-500' : 'bg-dark-800 border-dark-700'}`}>
                      <div className="flex items-center justify-between p-3">
                        <button onClick={() => toggleVariantExpand(variant.id)} className="flex items-center gap-2 flex-1 text-left">
                          <span className={`w-2 h-2 rounded-full ${variant.status === 'COMPLETED' ? 'bg-green-400' : variant.status === 'RUNNING' ? 'bg-yellow-400 animate-pulse' : variant.status === 'FAILED' ? 'bg-red-400' : 'bg-dark-500'}`} />
                          <span className="text-sm font-medium text-dark-200">{variant.name}</span>
                          {variant.isSelected && <span className="text-xs text-primary-400">★</span>}
                        </button>
                        <div className="flex items-center gap-2">
                          {variant.grade !== undefined && <span className={`px-2 py-0.5 text-xs rounded ${getGradeColor(variant.grade)}`}>{getGradeEmoji(variant.grade)} {variant.grade}</span>}
                          <span className={`px-2 py-0.5 text-xs rounded capitalize ${variant.status === 'COMPLETED' ? 'bg-green-500/20 text-green-300' : variant.status === 'RUNNING' ? 'bg-yellow-500/20 text-yellow-300' : variant.status === 'FAILED' ? 'bg-red-500/20 text-red-300' : 'bg-dark-700 text-dark-400'}`}>{variant.status.toLowerCase()}</span>
                          <button onClick={() => setShowVariantDetailModal(variant)} className="p-1 text-dark-400 hover:text-white transition-colors text-xs">🔍</button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="px-3 pb-3 border-t border-dark-700 pt-2 space-y-1.5">
                          {variant.steps.map((step) => (
                            <div key={step.id} className="flex items-start gap-2 p-2 bg-dark-900 rounded-lg">
                              <span className={`w-5 h-5 rounded flex items-center justify-center text-xs flex-shrink-0 mt-0.5 ${step.status === 'COMPLETED' ? 'bg-green-500/20 text-green-400' : step.status === 'RUNNING' ? 'bg-yellow-500/20 text-yellow-400 animate-pulse' : step.status === 'FAILED' ? 'bg-red-500/20 text-red-400' : 'bg-dark-700 text-dark-400'}`}>
                                {step.status === 'COMPLETED' ? '✓' : step.status === 'FAILED' ? '✗' : '○'}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium text-dark-200 truncate">{step.name}</span>
                                  {step.grade !== undefined && <span className={`px-1.5 py-0.5 text-xs rounded ${getGradeColor(step.grade)}`}>{step.grade}</span>}
                                  {step.userRating && <span className="text-xs">{step.userRating === 'thumbs_up' ? '👍' : '👎'}</span>}
                                </div>
                                {step.result && <p className="text-xs text-dark-400 mt-0.5 line-clamp-2 font-mono">{step.result.substring(0, 120)}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-dark-400">
                <div className="text-3xl mb-2">🎲</div>
                <p className="text-sm mb-3">No variants generated yet</p>
                <button onClick={() => setShowGenerateModal(true)} className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg text-sm font-medium transition-all">
                  Generate Variants
                </button>
              </div>
            )}
          </div>

          {/* Breakthroughs */}
          {(breakthroughs?.length ?? 0) > 0 && (
            <div className="bg-dark-900 rounded-xl border border-green-500/30 p-4">
              <h4 className="text-sm font-semibold text-green-300 mb-3 flex items-center gap-2"><span>🏆</span><span>Breakthroughs</span></h4>
              <div className="space-y-2">
                {breakthroughs.map((bb: any) => (
                  <div key={bb.id} className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
                    <p className="text-sm font-medium text-dark-200">{bb.title}</p>
                    <p className="text-xs text-dark-400 mt-1 line-clamp-2">{bb.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT PANEL — Variant History (35%) */}
        <div className="bg-dark-900 rounded-xl border border-dark-700 p-4 flex flex-col max-h-[calc(100vh-220px)]">
          <h3 className="text-sm font-bold text-dark-300 mb-3 uppercase tracking-wider">Variant History</h3>
          <div className="flex-1 overflow-y-auto space-y-2">
            {allVariants.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-dark-400">
                <div className="text-3xl mb-2">📭</div>
                <p className="text-sm">No history yet</p>
              </div>
            ) : (
              allVariants.map((variant) => {
                const isExpanded = expandedHistoryIds.has(variant.id)
                const stage = stages.find(s => s.id === variant.stageId)
                const isFailed = variant.status === 'FAILED'
                return (
                  <div key={variant.id} className={`rounded-lg border-2 transition-all ${isFailed ? 'bg-red-500/10 border-red-500/50' : variant.isSelected ? 'bg-primary-500/10 border-primary-500/50' : 'bg-dark-800 border-dark-700'}`}>
                    <div className="flex items-center justify-between p-3">
                      <button onClick={() => toggleHistoryExpand(variant.id)} className="flex items-center gap-2 flex-1 text-left">
                        <span className={`w-2 h-2 rounded-full ${variant.status === 'COMPLETED' ? 'bg-green-400' : variant.status === 'RUNNING' ? 'bg-yellow-400 animate-pulse' : isFailed ? 'bg-red-400' : 'bg-dark-500'}`} />
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-dark-200 truncate max-w-[100px]">{variant.name}</span>
                          {variant.grade !== undefined && <span className={`px-1.5 py-0.5 text-xs rounded ${getGradeColor(variant.grade)}`}>{getGradeEmoji(variant.grade)}</span>}
                          {variant.isSelected && <span className="text-primary-400 text-xs">★</span>}
                        </div>
                      </button>
                      <div className="flex items-center gap-1.5">
                        {variant.grade !== undefined && <span className={`px-1.5 py-0.5 text-xs rounded ${getGradeColor(variant.grade)}`}>{variant.grade}</span>}
                        {variant.userRating && <span className="text-xs">{variant.userRating === 'thumbs_up' ? '👍' : '👎'}</span>}
                        <span className="text-xs text-dark-500">▶</span>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-3 pb-3 border-t border-dark-700 pt-2">
                        {isFailed && variant.feedback && (
                          <div className="mb-2 p-2 bg-red-500/10 rounded-lg border border-red-500/20">
                            <p className="text-xs text-red-300 font-medium">Failure: {variant.feedback}</p>
                          </div>
                        )}
                        {stage && <p className="text-xs text-dark-400 mb-2">Stage: {stage.name}</p>}
                        {variant.steps.map((step) => (
                          <div key={step.id} className="flex items-start gap-2 p-2 bg-dark-900 rounded-lg mb-1.5 last:mb-0">
                            <span className={`w-5 h-5 rounded flex items-center justify-center text-xs flex-shrink-0 mt-0.5 ${step.status === 'COMPLETED' ? 'bg-green-500/20 text-green-400' : step.status === 'FAILED' ? 'bg-red-500/20 text-red-400' : 'bg-dark-700 text-dark-400'}`}>
                              {step.status === 'COMPLETED' ? '✓' : step.status === 'FAILED' ? '✗' : '○'}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-dark-200 truncate">{step.name}</span>
                                {step.grade !== undefined && <span className={`px-1 py-0.5 text-xs rounded ${getGradeColor(step.grade)}`}>{step.grade}</span>}
                                {step.userRating && <span className="text-xs">{step.userRating === 'thumbs_up' ? '👍' : '👎'}</span>}
                              </div>
                              {step.result && <p className="text-xs text-dark-400 mt-0.5 line-clamp-2 font-mono">{step.result.substring(0, 100)}</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* COLLAPSIBLE DEBUG LOG */}
      <div className="bg-dark-900 rounded-xl border border-dark-700">
        <button onClick={() => setShowDebugLog(!showDebugLog)} className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-dark-400 hover:text-dark-200 transition-colors">
          <span className="flex items-center gap-2"><span>🐞</span><span>{showDebugLog ? 'Hide' : 'Show'} Logs</span></span>
          <span>{showDebugLog ? '▲' : '▼'}</span>
        </button>
        {showDebugLog && (
          <div className="px-4 pb-3">
            <div className="bg-dark-800 rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs text-dark-300 space-y-0.5">
              {debugLog.length > 0 ? debugLog.map((line, i) => (
                <div key={i} className="text-dark-400">{line}</div>
              )) : <div className="text-dark-500">(no log output)</div>}
            </div>
          </div>
        )}
      </div>

      {/* MODALS */}
      {showGenerateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-dark-900 rounded-2xl p-6 w-full max-w-md border border-dark-700">
            <h3 className="text-lg font-bold mb-6">Generate Variants</h3>
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-3">Number of Variants: <span className="text-primary-400">{genNumVariants}</span></label>
                <input type="range" min="1" max="10" value={genNumVariants} onChange={(e) => setGenNumVariants(Number(e.target.value))} className="w-full h-2 bg-dark-700 rounded-full appearance-none cursor-pointer accent-primary-500" />
                <div className="flex justify-between text-xs text-dark-500 mt-1"><span>1</span><span>10</span></div>
              </div>
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-3">Steps per Variant: <span className="text-primary-400">{genStepsPerVariant}</span></label>
                <input type="range" min="5" max="50" value={genStepsPerVariant} onChange={(e) => setGenStepsPerVariant(Number(e.target.value))} className="w-full h-2 bg-dark-700 rounded-full appearance-none cursor-pointer accent-primary-500" />
                <div className="flex justify-between text-xs text-dark-500 mt-1"><span>5</span><span>50</span></div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setShowGenerateModal(false)} className="flex-1 py-3 px-4 bg-dark-700 hover:bg-dark-600 rounded-xl text-sm font-medium">Cancel</button>
                <button onClick={doGenerateVariants} className="flex-1 py-3 px-4 bg-primary-600 hover:bg-primary-700 rounded-xl text-sm font-medium">Generate</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showEditModal && (
        <EditStageModal
          stage={stages.find(s => s.id === showEditModal)!}
          onSave={(updates) => {
            setStages(prev => prev.map(s => s.id === showEditModal ? { ...s, ...updates } : s))
            setShowEditModal(null)
          }}
          onClose={() => setShowEditModal(null)}
        />
      )}

      {showVariantDetailModal && (
        <VariantDetailModal
          variant={showVariantDetailModal}
          onClose={() => setShowVariantDetailModal(null)}
          onExecute={executeVariant}
          onExpandStep={(stepId) => {}}
        />
      )}
    </div>
  )
}

function EditStageModal({ stage, onSave, onClose }: { stage: Stage; onSave: (updates: Partial<Stage>) => void; onClose: () => void }) {
  const [name, setName] = useState(stage.name)
  const [description, setDescription] = useState(stage.description)
  const [prompt, setPrompt] = useState(stage.prompt)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({ name, description, prompt })
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-2xl p-6 w-full max-w-2xl border border-dark-700 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold">Edit Stage</h3>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg">✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">Stage Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl focus:ring-2 focus:ring-primary-500" required />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl focus:ring-2 focus:ring-primary-500 resize-none" rows={3} required />
          </div>
          <div className="mb-6">
            <label className="block text-sm font-medium text-dark-300 mb-2">Stage Prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl focus:ring-2 focus:ring-primary-500 font-mono text-sm resize-none" rows={8} required />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="flex-1 py-3 px-4 bg-dark-700 hover:bg-dark-600 rounded-xl">Cancel</button>
            <button type="submit" className="flex-1 py-3 px-4 bg-primary-600 hover:bg-primary-700 rounded-xl">Save</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function VariantDetailModal({ variant, onClose, onExecute, onExpandStep }: { variant: Variant; onClose: () => void; onExecute: (id: string) => void; onExpandStep: (id: string) => void }) {
  const [showCodeMap, setShowCodeMap] = useState<Record<string, boolean>>({})
  const toggleCode = (stepId: string) => setShowCodeMap(prev => ({ ...prev, [stepId]: !prev[stepId] }))

  const getGradeColor = (grade?: number) => {
    if (!grade) return 'bg-dark-700 text-dark-400'
    if (grade > 70) return 'bg-green-500/20 text-green-300'
    if (grade >= 40) return 'bg-yellow-500/20 text-yellow-300'
    return 'bg-red-500/20 text-red-300'
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-2xl p-6 w-full max-w-4xl border border-dark-700 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h3 className="text-xl font-bold">{variant.name}</h3>
            {variant.grade !== undefined && <span className={`px-2 py-0.5 text-sm rounded ${getGradeColor(variant.grade)}`}>{variant.grade}/100</span>}
            {variant.isSelected && <span className="text-primary-400 text-sm">★ Selected</span>}
          </div>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg">✕</button>
        </div>
        <p className="text-sm text-dark-400 mb-4">{variant.description}</p>

        {variant.feedback && (
          <div className="mb-4 p-3 bg-dark-800 rounded-lg border border-dark-700">
            <p className="text-xs text-dark-400 mb-1">Feedback:</p>
            <p className="text-sm text-dark-200">{variant.feedback}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-2">
          {variant.steps.map((step, idx) => {
            const showCode = showCodeMap[step.id] ?? false
            const isGpu = step.result && (step.result.includes('[GPU Execution Result]') || step.result.includes('[GPU Execution Error]'))
            return (
              <div key={step.id} className="bg-dark-800 rounded-lg border border-dark-700 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-dark-800 border-b border-dark-700">
                  <div className="flex items-center gap-2">
                    <span className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${step.status === 'COMPLETED' ? 'bg-green-500/20 text-green-400' : step.status === 'RUNNING' ? 'bg-yellow-500/20 text-yellow-400 animate-pulse' : step.status === 'FAILED' ? 'bg-red-500/20 text-red-400' : 'bg-dark-700 text-dark-400'}`}>
                      {step.status === 'COMPLETED' ? '✓' : step.status === 'FAILED' ? '✗' : idx + 1}
                    </span>
                    <span className="text-sm font-medium text-dark-200">{step.name}</span>
                    {step.grade !== undefined && <span className={`px-1.5 py-0.5 text-xs rounded ${getGradeColor(step.grade)}`}>{step.grade}</span>}
                    {step.userRating && <span className="text-xs">{step.userRating === 'thumbs_up' ? '👍' : '👎'}</span>}
                  </div>
                  {isGpu && (
                    <button onClick={() => toggleCode(step.id)} className="text-xs px-2 py-0.5 rounded bg-dark-700 hover:bg-dark-600 text-dark-300">{showCode ? 'Output' : 'Code'}</button>
                  )}
                </div>
                <div className="p-3">
                  {step.description && <p className="text-xs text-dark-400 mb-2">{step.description}</p>}
                  {step.result && !isGpu && <p className="text-xs font-mono text-dark-300 whitespace-pre-wrap line-clamp-4">{step.result.substring(0, 500)}</p>}
                  {step.result && isGpu && (() => {
                    const codeMatch = step.result.match(/\[CODE\][\s\S]*?\n?([\s\S]*?)\n?\[\/CODE\]/)
                    const jobIdMatch = step.result.match(/\[GPU Execution (?:Result|Error)\] job:([^:\s]+)/)
                    const isError = step.result.includes('[GPU Execution Error]')
                    const code = codeMatch ? codeMatch[1].trim() : null
                    const rawOutput = step.result.replace(/\[CODE\][\s\S]*?\[\/CODE\]/, '').replace(/^\[GPU Execution (?:Result|Error)\] job:[^:\s]+:?\s*/, '').trim()
                    const displayContent = showCode && code ? code : rawOutput
                    return (
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${isError ? 'bg-red-400' : 'bg-green-400'}`} />
                          <span className="text-xs text-dark-400">{isError ? 'ERROR' : 'OK'}{jobIdMatch ? ` — job: ${jobIdMatch[1]}` : ''}</span>
                        </div>
                        <pre className="text-xs font-mono text-dark-300 whitespace-pre-wrap break-all">{displayContent.substring(0, 2000)}{displayContent.length > 2000 && '...'}</pre>
                      </div>
                    )
                  })()}
                </div>
              </div>
            )
          })}
        </div>

        {variant.status !== 'COMPLETED' && (
          <div className="pt-4 border-t border-dark-700 mt-4">
            <button onClick={() => { onExecute(variant.id); onClose() }} className="w-full py-3 bg-primary-600 hover:bg-primary-700 rounded-xl font-medium transition-all">
              ▶ Execute Variant
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
