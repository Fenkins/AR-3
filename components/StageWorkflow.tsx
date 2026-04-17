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
  const [selectedVariant, setSelectedVariant] = useState<Variant | null>(null)
  const [isAutoMode, setIsAutoMode] = useState(true)
  const [isThinkingSetup, setIsThinkingSetup] = useState(false)
  const [setupProgress, setSetupProgress] = useState(0)
  const [setupMessage, setSetupMessage] = useState('')
  const [showEditModal, setShowEditModal] = useState<string | null>(null)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [showVariantsModal, setShowVariantsModal] = useState(false)
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

  // Polling interval
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const setupStartTimeRef = useRef<number | null>(null)

  // Fetch space data
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
        // Check if setup is complete
        if (data.stages && data.stages.length > 0) {
          setStages(data.stages)
          setSetupComplete(true)
          
          // Find current stage index
          if (data.execution?.currentStageId) {
            const idx = data.stages.findIndex((s: Stage) => s.id === data.execution.currentStageId)
            if (idx >= 0) setCurrentStageIndex(idx)
          }
        }
        
        setExecutionState(data.execution)
        setIsRunning(data.execution?.isRunning || data.space.status === 'RUNNING')
        setRunStatus(data.execution?.isRunning ? 'running' : data.space.status === 'PAUSED' ? 'paused' : 'idle')
        setTotalTokens(data.space.totalTokens || 0)
        setTotalCost(data.space.totalCost || 0)
        
        if (data.space.experiments) {
          setExperiments(data.space.experiments)
        }
        if (data.breakthroughs) {
          setBreakthroughs(data.breakthroughs)
        }
        
        // Load variants for the CURRENTLY SELECTED stage (by UI index), not execution state's currentStageId
        // Execution state holds ALL stages' variants; we filter to only the selected stage
        const selectedStageId = stages[currentStageIndex]?.id || data.execution?.currentStageId || data.stages?.[0]?.id
        const allVariants = data.execution?.variants || data.space?.variants || []
        const stageVariants = allVariants.filter((v: any) => v.stageId === selectedStageId)
        if (stageVariants.length > 0) {
          setVariants(stageVariants)
        } else {
          setVariants([])
        }
      }
    } catch (error) {
      console.error('Error fetching space:', error)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [spaceId, token, currentStageIndex, stages])

  // Initial fetch
  useEffect(() => {
    fetchSpaceData()
  }, [fetchSpaceData])

  // Polling for updates when running
  useEffect(() => {
    if (isRunning && setupComplete) {
      pollIntervalRef.current = setInterval(() => {
        fetchSpaceData(false)
      }, 5000) // Poll every 5 seconds
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [isRunning, setupComplete, fetchSpaceData])

  const setupSteps = [
    'Analyzing research goal...',
    'Configuring thinking agent...',
    'Creating stage pipeline...',
    'Initializing research cycle...',
    'Pre-allocating variants...',
  ]

  const runThinkingSetup = async () => {
    if (isThinkingSetup) return // Guard against double-click
    setIsThinkingSetup(true)
    setSetupProgress(0)
    setSetupMessage('Starting setup...')
    setupStartTimeRef.current = Date.now()

    let pollCount = 0
    const maxPolls = 300 // 300 * 2s = 10 min max wait

    // Call API to START the thinking setup (fire-and-forget)
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'thinking_setup' }),
      })

      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server error: ${text.substring(0, 100)}`) }

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`)
      }

      console.log('[ThinkingSetup] Started, polling for status...')
    } catch (error: any) {
      console.error('[ThinkingSetup] Failed to start:', error)
      setIsThinkingSetup(false)
      alert(`Setup failed to start: ${error.message}`)
      return
    }

    // Poll space status every 2s to get real progress from setupStep
    const pollInterval = setInterval(async () => {
      pollCount++
      try {
        const res = await fetch(`/api/spaces/${spaceId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const spaceData = await res.json()
        const space = spaceData.space || spaceData

        // Update progress based on real backend state
        if (space.setupStatus === 'COMPLETED') {
          clearInterval(pollInterval)
          setSetupProgress(100)
          setSetupMessage('Setup complete!')
          setIsThinkingSetup(false)
          setSetupComplete(true)
          await fetchSpaceData()
          if (isAutoMode) {
            setIsRunning(true)
            setRunStatus('running')
          }
          return
        }

        if (space.setupStatus === 'FAILED') {
          clearInterval(pollInterval)
          setIsThinkingSetup(false)
          alert(`Setup failed: ${space.setupError || 'Unknown error'}`)
          return
        }

        // Update with real step from backend
        if (space.setupStep) {
          setSetupMessage(space.setupStep)
        }

        // Progress based on which step (out of 5)
        const stepIndex = setupSteps.findIndex(s => space.setupStep?.includes(s.substring(0, 20)))
        if (stepIndex >= 0) {
          setSetupProgress(Math.min(((stepIndex + 1) / setupSteps.length) * 90, 90))
        } else if (pollCount > 2) {
          // Still waiting for first sign of life
          setSetupProgress(Math.min((pollCount / maxPolls) * 90, 90))
        }

        if (pollCount >= maxPolls) {
          clearInterval(pollInterval)
          setIsThinkingSetup(false)
          alert('Setup timed out after 10 minutes. Please try again.')
        }
      } catch (err) {
        console.error('[ThinkingSetup] Poll error:', err)
      }
    }, 2000)
  }

  const runResearchCycle = async (numCycles = 1) => {
    setIsRunning(true)
    setRunStatus('running')
    
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'run', numCycles }),
      })

      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      
      if (!response.ok) {
        throw new Error(data.error || 'Research run failed')
      }

      // Refresh data
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'cycle', stageId: currentStage?.id }),
      })

      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      
      if (!response.ok) {
        throw new Error(data.error || 'Cycle failed')
      }

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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'pause' }),
      })
      setRunStatus('paused')
      setIsRunning(false)
    } catch (error) {
      console.error('Failed to pause:', error)
    }
  }

  const resumeResearch = async () => {
    try {
      await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'resume' }),
      })
      setRunStatus('running')
      setIsRunning(true)
    } catch (error) {
      console.error('Failed to resume:', error)
    }
  }

  const stopResearch = async () => {
    if (!confirm('Stop all research? This cannot be undone.')) return
    try {
      await fetch(`/api/spaces/${spaceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'stop' }),
      })
      setRunStatus('stopped')
      setIsRunning(false)
      await fetchSpaceData(false)
    } catch (error) {
      console.error('Failed to stop:', error)
    }
  }

  const generateVariants = async () => {
    const currentStage = stages[currentStageIndex]
    if (!currentStage) return

    setGeneratingVariants(true)
    try {
      const response = await fetch(`/api/spaces/${spaceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'generate_variants',
          stageId: currentStage.id,
          numVariants: space?.defaultNumVariants ?? 3,
          stepsPerVariant: space?.defaultStepsPerVariant ?? 25,
        }),
      })

      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      
      if (!response.ok) {
        throw new Error(data.error || 'Variant generation failed')
      }

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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'execute_variant', variantId }),
      })

      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server returned: ${text.substring(0, 150)}`) }
      
      if (!response.ok) {
        throw new Error(data.error || 'Variant execution failed')
      }

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
      if (response.ok) {
        onClose()
      }
    } catch (error) {
      console.error('Failed to delete space:', error)
    }
  }

  const currentStage = stages[currentStageIndex]
  const completedStages = stages.filter(s => s.status === 'completed').length
  const completedExperiments = experiments.filter(e => e.status === 'COMPLETED').length

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

  // Thinking Setup Screen
  if (!setupComplete) {
    const elapsed = setupStartTimeRef.current ? Math.floor((Date.now() - setupStartTimeRef.current) / 1000) : 0

    return (
      <div className="bg-dark-900 rounded-xl border border-dark-700 p-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary-500/5 to-transparent pointer-events-none" />
        
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg transition-all"
        >
          ✕
        </button>
        
        <div className="relative">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-xl bg-primary-500/20 flex items-center justify-center text-2xl">
              🧠
            </div>
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
                <input
                  type="checkbox"
                  checked={isAutoMode}
                  onChange={(e) => setIsAutoMode(e.target.checked)}
                  className="w-5 h-5 rounded border-dark-500 text-primary-500 focus:ring-primary-500"
                />
                <div>
                  <p className="font-medium">Auto-start research</p>
                  <p className="text-sm text-dark-400">Automatically begin research cycle after setup</p>
                </div>
              </div>

              <button
                onClick={runThinkingSetup}
                className="w-full py-4 px-6 bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-700 hover:to-primary-600 rounded-xl font-semibold text-lg transition-all shadow-lg shadow-primary-500/25"
              >
                <span className="flex items-center justify-center gap-2">
                  <span>🚀</span>
                  <span>Start Thinking Agent Setup</span>
                </span>
              </button>
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              <div className="space-y-3">
                {setupSteps.map((step, i) => {
                  const stepProgress = setupProgress >= ((i + 1) / setupSteps.length) * 100
                  const isActive = setupProgress > (i / setupSteps.length) * 100 && !stepProgress
                  return (
                    <div 
                      key={i}
                      className={`flex items-center gap-3 p-3 rounded-lg transition-all ${
                        stepProgress 
                          ? 'bg-green-500/10 text-green-300' 
                          : isActive
                            ? 'bg-primary-500/10 text-primary-300'
                            : 'bg-dark-800/50 text-dark-500'
                      }`}
                    >
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        stepProgress
                          ? 'bg-green-500 text-white'
                          : isActive
                            ? 'bg-primary-500 text-white animate-pulse'
                            : 'bg-dark-700 text-dark-400'
                      }`}>
                        {stepProgress ? '✓' : i + 1}
                      </div>
                      <span className={isActive ? 'animate-pulse' : ''}>
                        {step}
                      </span>
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
                  <div 
                    className="h-full bg-gradient-to-r from-primary-600 to-primary-400 transition-all duration-500 ease-out"
                    style={{ width: `${setupProgress}%` }}
                  />
                </div>
                <p className="text-xs text-dark-500 text-center">
                  Elapsed time: {elapsed}s
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Main Research View
  return (
    <div className="space-y-4">
      {/* Control Header */}
      <div className="bg-dark-900 rounded-xl border border-dark-700 p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          {/* Status */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="px-2 py-0.5 bg-primary-500/20 text-primary-300 text-xs rounded-full font-medium">
                Stage {currentStageIndex + 1} of {stages.length}
              </span>
              <span className="px-2 py-0.5 bg-dark-700 text-dark-300 text-xs rounded-full">
                {currentStage?.name || 'No Stage'}
              </span>
              {runStatus === 'running' && (
                <span className="flex items-center gap-1 text-xs text-green-400">
                  <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  Running
                </span>
              )}
              {runStatus === 'paused' && (
                <span className="flex items-center gap-1 text-xs text-yellow-400">
                  <span className="w-2 h-2 bg-yellow-400 rounded-full" />
                  Paused
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs text-dark-400">
              <span>Tokens: {totalTokens.toLocaleString()}</span>
              <span>Cost: ${totalCost.toFixed(4)}</span>
              <span>Cycles: {completedExperiments}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {runStatus === 'idle' && (
              <>
                <button
                  onClick={runSingleCycle}
                  disabled={isRunning}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg font-medium transition-all min-h-[44px]"
                >
                  <span>▶</span>
                  <span>Run Cycle</span>
                </button>
                {isAutoMode && (
                  <button
                    onClick={() => runResearchCycle(5)}
                    disabled={isRunning}
                    className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 rounded-lg font-medium transition-all min-h-[44px]"
                  >
                    <span>🔥</span>
                    <span>Run 5 Cycles</span>
                  </button>
                )}
              </>
            )}
            
            {runStatus === 'running' && (
              <>
                <button
                  onClick={pauseResearch}
                  className="flex items-center gap-2 px-5 py-2.5 bg-yellow-600 hover:bg-yellow-700 rounded-lg font-medium transition-all min-h-[44px]"
                >
                  <span>⏸</span>
                  <span>Pause</span>
                </button>
                <button
                  onClick={stopResearch}
                  className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-all min-h-[44px]"
                >
                  <span>⏹</span>
                  <span>Stop</span>
                </button>
              </>
            )}

            {runStatus === 'paused' && (
              <>
                <button
                  onClick={resumeResearch}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 rounded-lg font-medium transition-all min-h-[44px]"
                >
                  <span>▶</span>
                  <span>Resume</span>
                </button>
                <button
                  onClick={stopResearch}
                  className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-all min-h-[44px]"
                >
                  <span>⏹</span>
                  <span>Stop</span>
                </button>
              </>
            )}

            {/* More Actions */}
            <div className="relative group">
              <button className="w-10 h-10 flex items-center justify-center bg-dark-700 hover:bg-dark-600 rounded-lg transition-all">
                ⋮
              </button>
              <div className="absolute right-0 top-full mt-1 w-48 bg-dark-800 border border-dark-700 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                <button
                  onClick={generateVariants}
                  disabled={generatingVariants}
                  className="w-full px-4 py-3 text-left text-dark-300 hover:bg-dark-700 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <span>🎲</span>
                  <span>{generatingVariants ? 'Generating...' : 'Generate Variants'}</span>
                </button>
                <button
                  onClick={() => setShowHistoryModal(true)}
                  className="w-full px-4 py-3 text-left text-dark-300 hover:bg-dark-700 rounded-lg transition-colors flex items-center gap-2"
                >
                  <span>📜</span>
                  <span>History</span>
                </button>
                <button
                  onClick={() => {
                    if (confirm('Delete this research space?')) handleDeleteSpace()
                  }}
                  className="w-full px-4 py-3 text-left text-red-400 hover:bg-dark-700 rounded-lg transition-colors flex items-center gap-2"
                >
                  <span>🗑</span>
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Auto Mode Toggle */}
        <div className="mt-4 pt-4 border-t border-dark-700 flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isAutoMode}
              onChange={(e) => setIsAutoMode(e.target.checked)}
              className="sr-only"
            />
            <div className={`w-11 h-6 rounded-full transition-colors ${isAutoMode ? 'bg-primary-500' : 'bg-dark-600'}`}>
              <div className={`w-5 h-5 bg-white rounded-full shadow transform transition-transform mt-0.5 ${isAutoMode ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-sm font-medium">Auto-run mode</span>
          </label>
        </div>
      </div>

      {/* Stage Pipeline Vertical */}
      <div className="bg-dark-900 rounded-xl border border-dark-700 p-4">
        <h4 className="text-sm font-semibold text-dark-400 mb-3">Research Pipeline</h4>
        <div className="flex flex-col gap-3">
          {stages.map((stage, index) => {
            const isCurrent = index === currentStageIndex
            const isCompleted = stage.status === 'completed'
            const experiment = experiments.find(e => e.phase.toLowerCase() === stage.name.toLowerCase())
            const hasRun = !!experiment
            
            return (
              <div
                key={stage.id}
                className={`flex items-center justify-between p-3 rounded-lg border-2 transition-all ${
                  isCurrent 
                    ? 'bg-primary-500/10 border-primary-500' 
                    : hasRun
                      ? 'bg-green-500/10 border-green-500/50 hover:border-green-500'
                      : 'bg-dark-800 border-dark-700 hover:border-dark-500'
                }`}
              >
                <button 
                  onClick={() => setCurrentStageIndex(index)}
                  className="flex-1 flex items-center gap-3 text-left"
                >
                  <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    isCurrent ? 'bg-primary-600 text-white' 
                      : hasRun ? 'bg-green-600 text-white'
                        : 'bg-dark-700 text-dark-400'
                  }`}>
                    {hasRun ? '✓' : index + 1}
                  </div>
                  <div>
                    <p className={`text-base font-medium ${isCurrent ? 'text-white' : 'text-dark-200'}`}>
                      {stage.name}
                    </p>
                    <p className="text-xs text-dark-500 line-clamp-1">{stage.description}</p>
                    {experiment && (
                      <p className="text-xs text-green-400 mt-0.5">
                        {experiment.tokensUsed.toLocaleString()} tokens
                      </p>
                    )}
                  </div>
                </button>

                {/* Stage Controls */}
                <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                  <button 
                    onClick={() => setShowEditModal(stage.id)}
                    className="p-1.5 hover:bg-dark-600 rounded text-dark-400 hover:text-white transition-colors"
                    title="Edit Stage"
                  >
                    ✏️
                  </button>
                  
                  <button
                    onClick={() => setIsAutoMode(!isAutoMode)}
                    className={`px-2 py-1 text-xs rounded font-medium border ${
                      isAutoMode ? 'bg-primary-600/20 text-primary-400 border-primary-500/50' : 'bg-dark-700 text-dark-400 border-dark-600'
                    }`}
                    title="Toggle Auto/Manual Mode"
                  >
                    Auto {isAutoMode ? 'ON' : 'OFF'}
                  </button>

                  <button
                    onClick={() => setShowHistoryModal(true)}
                    className="p-1.5 hover:bg-dark-600 rounded text-dark-400 hover:text-white transition-colors"
                    title="View History & Ratings"
                  >
                    🕒 History
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Current Stage Detail */}
      {currentStage && (
        <div className="bg-dark-900 rounded-xl border border-dark-700 p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="text-lg font-bold">{currentStage.name}</h3>
              <p className="text-sm text-dark-400">{currentStage.description}</p>
            </div>
            <button
              onClick={() => setShowEditModal(currentStage.id)}
              className="p-2 text-dark-400 hover:text-primary-400 hover:bg-dark-800 rounded-lg transition-colors"
            >
              ✏️
            </button>
          </div>
          
          {/* Latest Experiment Result */}
          {experiments.length > 0 && (
            <div className="mt-4 p-4 bg-dark-800 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-dark-300">Latest Result</span>
                <span className="text-xs text-dark-500">
                  {new Date(experiments[0].createdAt).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-sm text-dark-300 font-mono whitespace-pre-wrap line-clamp-6">
                {experiments[0].result?.substring(0, 500) || 'No result yet...'}
                {(experiments[0].result?.length || 0) > 500 && '...'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Variants */}
      {variants.length > 0 && (
        <div className="bg-dark-900 rounded-xl border border-dark-700 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold">Variants</h4>
            <button
              onClick={() => setShowVariantsModal(true)}
              className="text-sm text-primary-400 hover:text-primary-300"
            >
              View All →
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {variants.slice(0, 3).map((v) => (
              <div
                key={v.id}
                className={`p-3 rounded-lg border-2 ${
                  v.isSelected 
                    ? 'bg-primary-500/20 border-primary-500' 
                    : 'bg-dark-800 border-dark-700'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm truncate">{v.name}</span>
                  {v.grade && (
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      v.grade >= 80 ? 'bg-green-500/20 text-green-300' :
                      v.grade >= 60 ? 'bg-yellow-500/20 text-yellow-300' :
                      'bg-red-500/20 text-red-300'
                    }`}>
                      {v.grade}
                    </span>
                  )}
                </div>
                <p className="text-xs text-dark-400 mb-2 line-clamp-2">{v.description}</p>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 text-xs rounded capitalize ${
                    v.status === 'COMPLETED' ? 'bg-green-500/20 text-green-300' :
                    v.status === 'RUNNING' ? 'bg-yellow-500/20 text-yellow-300' :
                    'bg-dark-700 text-dark-400'
                  }`}>
                    {v.status.toLowerCase()}
                  </span>
                  <span className="text-xs text-dark-500">{v.steps.length} steps</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Breakthroughs */}
      {breakthroughs.length > 0 && (
        <div className="bg-dark-900 rounded-xl border border-green-500/30 p-4">
          <h4 className="font-semibold mb-3 flex items-center gap-2">
            <span>🏆</span>
            <span>Breakthroughs</span>
          </h4>
          <div className="space-y-2">
            {breakthroughs.map((bb) => (
              <div key={bb.id} className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
                <p className="font-medium text-sm">{bb.title}</p>
                <p className="text-xs text-dark-400 mt-1 line-clamp-2">{bb.description}</p>
                <div className="flex items-center gap-2 mt-2 text-xs">
                  <span className={`px-2 py-0.5 rounded ${
                    bb.verified ? 'bg-green-500/20 text-green-300' : 'bg-yellow-500/20 text-yellow-300'
                  }`}>
                    {bb.verified ? 'Verified' : 'Pending'}
                  </span>
                  <span className="text-dark-500">Confidence: {Math.round(bb.confidence * 100)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modals */}
      {showEditModal && (
        <EditStageModal
          stage={stages.find(s => s.id === showEditModal)!}
          onSave={(updates) => {
            setStages(prev => prev.map(s => 
              s.id === showEditModal ? { ...s, ...updates } : s
            ))
            setShowEditModal(null)
          }}
          onClose={() => setShowEditModal(null)}
        />
      )}

      {showVariantsModal && (
        <VariantsModal
          variants={variants}
          onSelect={(id) => {
            const v = variants.find(vv => vv.id === id)
            setSelectedVariant(v || null)
          }}
          onExecute={executeVariant}
          selectedVariantId={selectedVariant?.id}
          onClose={() => setShowVariantsModal(false)}
        />
      )}

      {showHistoryModal && (
        <HistoryModal
          experiments={experiments}
          onClose={() => setShowHistoryModal(false)}
        />
      )}
    </div>
  )
}

function EditStageModal({ stage, onSave, onClose }: { 
  stage: Stage
  onSave: (updates: Partial<Stage>) => void
  onClose: () => void
}) {
  const [name, setName] = useState(stage.name)
  const [description, setDescription] = useState(stage.description)
  const [prompt, setPrompt] = useState(stage.prompt)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({ name, description, prompt })
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-dark-700">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold">Edit Stage</h3>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg">✕</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">Stage Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl focus:ring-2 focus:ring-primary-500"
              required
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl focus:ring-2 focus:ring-primary-500 resize-none"
              rows={3}
              required
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-dark-300 mb-2">Stage Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl focus:ring-2 focus:ring-primary-500 font-mono text-sm resize-none"
              rows={8}
              required
            />
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

function VariantsModal({ variants, onSelect, onExecute, selectedVariantId, onClose }: {
  variants: Variant[]
  onSelect: (id: string) => void
  onExecute: (id: string) => void
  selectedVariantId?: string
  onClose: () => void
}) {
  const selectedVariant = variants.find(v => v.id === selectedVariantId)

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-2xl p-6 max-w-5xl w-full max-h-[90vh] overflow-hidden border border-dark-700 flex flex-col">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold">Stage Variants</h3>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg">✕</button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0 overflow-hidden">
          {/* Variant List */}
          <div className="space-y-3 overflow-y-auto">
            {variants.map((variant) => (
              <div
                key={variant.id}
                onClick={() => onSelect(variant.id)}
                className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                  variant.id === selectedVariantId
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-dark-700 hover:border-dark-500'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <h5 className="font-medium">{variant.name}</h5>
                  {(variant.status === 'PENDING_REVIEW' || variant.name.includes('pending review')) && (
                    <span className="px-2 py-0.5 text-xs rounded bg-yellow-500/20 text-yellow-300">
                      pending
                    </span>
                  )}
                  {variant.grade && (
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      variant.grade >= 80 ? 'bg-green-500/20 text-green-300' :
                      variant.grade >= 60 ? 'bg-yellow-500/20 text-yellow-300' :
                      'bg-red-500/20 text-red-300'
                    }`}>
                      {variant.grade}/100
                    </span>
                  )}
                </div>
                <p className={`text-sm mb-2 ${variant.status === 'PENDING_REVIEW' ? 'text-yellow-400' : 'text-dark-400'}`}>{variant.description}</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-dark-500">{variant.steps.length} steps</span>
                  <span className={`px-2 py-0.5 text-xs rounded capitalize ${
                    variant.status === 'COMPLETED' ? 'bg-green-500/20 text-green-300' :
                    variant.status === 'RUNNING' ? 'bg-yellow-500/20 text-yellow-300' :
                    variant.status === 'PENDING_REVIEW' ? 'bg-yellow-500/20 text-yellow-300' :
                    'bg-dark-700 text-dark-400'
                  }`}>
                    {variant.status === 'PENDING_REVIEW' ? 'pending review' : variant.status.toLowerCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Selected Variant Details */}
          <div className="lg:col-span-2 overflow-y-auto">
            {selectedVariant ? (
              <div className="space-y-4">
                <div className="bg-dark-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-bold text-lg">{selectedVariant.name}</h4>
                    {selectedVariant.status !== 'COMPLETED' && (
                      <button
                        onClick={() => onExecute(selectedVariant.id)}
                        className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg text-sm font-medium"
                      >
                        ▶ Execute
                      </button>
                    )}
                  </div>
                  <p className="text-sm text-dark-300 mb-4">{selectedVariant.description}</p>
                  
                  {selectedVariant.feedback && (
                    <div className="p-3 bg-dark-900 rounded-lg mb-4">
                      <p className="text-xs text-dark-400 mb-1">Feedback:</p>
                      <p className="text-sm text-dark-300">{selectedVariant.feedback}</p>
                    </div>
                  )}

                  <div className="space-y-2">
                    <h5 className="text-sm font-semibold text-dark-400">Steps:</h5>
                    {selectedVariant.steps.map((step, idx) => (
                      <div key={step.id} className="bg-dark-900 rounded-lg p-3">
                        <div className="flex items-start gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${
                            step.status === 'COMPLETED' ? 'bg-green-500/20 text-green-400' :
                            step.status === 'RUNNING' ? 'bg-yellow-500/20 text-yellow-400' :
                            step.status === 'PENDING_REVIEW' ? 'bg-yellow-500/20 text-yellow-400' :
                            'bg-dark-700 text-dark-400'
                          }`}>
                            {step.status === 'COMPLETED' ? '✓' : idx + 1}
                          </div>
                          <div className="flex-1">
                            <p className="font-medium">{step.status === 'PENDING_REVIEW' ? `⚠ ${step.name}` : step.name}</p>
                            <p className={`text-xs ${step.status === 'PENDING_REVIEW' ? 'text-yellow-400' : 'text-dark-400'}`}>{step.description}</p>
                            {step.result && (
                              <p className="text-xs text-dark-300 mt-2 font-mono line-clamp-3">{step.result}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-dark-400">
                Select a variant to view details
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function HistoryModal({ experiments, onClose }: {
  experiments: Experiment[]
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-dark-700 flex flex-col">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold">Execution History</h3>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 rounded-lg">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 space-y-4">
          {experiments.map((exp) => (
            <div key={exp.id} className="bg-dark-800 rounded-xl p-4 border border-dark-700">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary-500/20 rounded-lg flex items-center justify-center">
                    <span className="text-primary-400">{exp.phase.substring(0, 3)}</span>
                  </div>
                  <div>
                    <span className="font-semibold">{exp.phase}</span>
                    <span className="text-sm text-dark-400 ml-2">by {exp.agentName}</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs text-dark-500">
                    {new Date(exp.createdAt).toLocaleString()}
                  </span>
                  {exp.grade && (
                    <div className={`text-sm font-medium ${
                      exp.grade >= 80 ? 'text-green-400' :
                      exp.grade >= 60 ? 'text-yellow-400' :
                      'text-red-400'
                    }`}>
                      Grade: {exp.grade}/100
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-dark-900 rounded-lg p-3 mb-3 max-h-40 overflow-y-auto">
                <p className="text-sm text-dark-300 font-mono whitespace-pre-wrap">
                  {exp.result?.substring(0, 500)}
                  {(exp.result?.length || 0) > 500 && '...'}
                </p>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-dark-400">Tokens: {exp.tokensUsed.toLocaleString()}</span>
                {exp.userRating && (
                  <span>{exp.userRating === 'thumbs_up' ? '👍' : '👎'}</span>
                )}
              </div>
            </div>
          ))}

          {experiments.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-dark-400">
              <div className="text-4xl mb-2">📭</div>
              <p>No execution history yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
