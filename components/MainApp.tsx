'use client'

import { useAuth } from '@/contexts/AuthContext'
import { useState, useEffect } from 'react'
import StageWorkflow from './StageWorkflow'
import ServiceProviders from './ServiceProviders'
import Agents from './AgentsView'
import EmbeddingsView from './EmbeddingsView'

export default function Home() {
  const { isAuthenticated, isAdmin } = useAuth()
  const [activeTab, setActiveTab] = useState('dashboard')

  if (!isAuthenticated) {
    return <AuthScreen />
  }

  return (
    <div className="min-h-screen">
      <Navigation activeTab={activeTab} setActiveTab={setActiveTab} />
      <main className="pt-16">
        {activeTab === 'dashboard' && <DashboardView />}
        {activeTab === 'providers' && <ServiceProviders />}
        {activeTab === 'agents' && <Agents />}
        {activeTab === 'spaces' && <SpacesView />}
        {activeTab === 'embeddings' && <EmbeddingsView />}
        {activeTab === 'admin' && isAdmin && <AdminView />}
      </main>
    </div>
  )
}

function AuthScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-dark-950 via-dark-900 to-dark-800">
      <div className="max-w-md w-full p-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
            Research Platform
          </h1>
          <p className="text-dark-400 mt-2">Autonomous Agent-Driven Software Discovery</p>
        </div>
        <AuthForm />
      </div>
    </div>
  )
}

function AuthForm() {
  const { login, register } = useAuth()
  const [isLogin, setIsLogin] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      if (isLogin) {
        await login(email, password)
      } else {
        await register(email, password, username)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-dark-900 rounded-lg p-6 shadow-xl border border-dark-700">
      <h2 className="text-2xl font-semibold mb-6 text-center">
        {isLogin ? 'Sign In' : 'Create Account'}
      </h2>

      {error && (
        <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
          {error}
        </div>
      )}

      {!isLogin && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-dark-300 mb-2">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            required
          />
        </div>
      )}

      <div className="mb-4">
        <label className="block text-sm font-medium text-dark-300 mb-2">
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          required
        />
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-dark-300 mb-2">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          required
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full py-2 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-600/50 rounded-lg font-medium transition-colors"
      >
        {loading ? 'Processing...' : isLogin ? 'Sign In' : 'Create Account'}
      </button>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={() => setIsLogin(!isLogin)}
          className="text-primary-400 hover:text-primary-300 text-sm"
        >
          {isLogin ? "Don't have an account? Register" : 'Already have an account? Sign In'}
        </button>
      </div>
    </form>
  )
}

// Dashboard Component
function DashboardView() {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const fetchDashboard = async () => {
    const token = localStorage.getItem('research_token')
    const response = await fetch('/api/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await response.json()
    setStats(data)
    setLoading(false)
  }

  useEffect(() => {
    fetchDashboard()
    const interval = setInterval(fetchDashboard, 30000)
    return () => clearInterval(interval)
  }, [])

  if (loading || !stats) {
    return <LoadingSpinner />
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h2 className="text-3xl font-bold mb-6">Dashboard</h2>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Total Spaces"
          value={stats.stats.totalSpaces}
          icon="🔬"
          color="from-blue-500 to-blue-600"
        />
        <StatCard
          title="Total Experiments"
          value={stats.stats.totalExperiments}
          icon="🧪"
          color="from-green-500 to-green-600"
        />
        <StatCard
          title="Breakthroughs"
          value={`${stats.stats.verifiedBreakthroughs}/${stats.stats.totalBreakthroughs}`}
          icon="💡"
          color="from-yellow-500 to-yellow-600"
        />
        <StatCard
          title="Total Tokens"
          value={formatNumber(stats.stats.totalTokens)}
          icon="⚡"
          color="from-purple-500 to-purple-600"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Experiments by Phase */}
        <div className="bg-dark-900 rounded-lg p-6 border border-dark-700">
          <h3 className="text-lg font-semibold mb-4">Experiments by Phase</h3>
          <div className="space-y-3">
            {Object.entries(stats.experimentsByPhase).map(([phase, count]: any) => (
              <div key={phase} className="flex items-center justify-between">
                <span className="text-dark-300">{phase}</span>
                <span className="font-medium">{count}</span>
              </div>
            ))}
            {Object.keys(stats.experimentsByPhase).length === 0 && (
              <p className="text-dark-400 text-center py-4">No experiments yet</p>
            )}
          </div>
        </div>

        {/* Breakthroughs by Category */}
        <div className="bg-dark-900 rounded-lg p-6 border border-dark-700">
          <h3 className="text-lg font-semibold mb-4">Breakthroughs by Category</h3>
          <div className="space-y-3">
            {Object.entries(stats.breakthroughsByCategory).map(([category, count]: any) => (
              <div key={category} className="flex items-center justify-between">
                <span className="text-dark-300">{category}</span>
                <span className="font-medium">{count}</span>
              </div>
            ))}
            {Object.keys(stats.breakthroughsByCategory).length === 0 && (
              <p className="text-dark-400 text-center py-4">No breakthroughs yet</p>
            )}
          </div>
        </div>
      </div>

      {/* Recent Breakthroughs */}
      <div className="mt-6 bg-dark-900 rounded-lg p-6 border border-dark-700">
        <h3 className="text-lg font-semibold mb-4">Recent Breakthroughs</h3>
        <div className="space-y-4">
          {stats.recentBreakthroughs.map((b: any) => (
            <div key={b.id} className="border-l-4 border-yellow-500 pl-4 py-2">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">{b.title}</h4>
                <span className={`text-sm px-2 py-1 rounded ${b.verified ? 'bg-green-500/20 text-green-300' : 'bg-dark-700 text-dark-300'}`}>
                  {b.verified ? 'Verified' : 'Unverified'}
                </span>
              </div>
              <p className="text-sm text-dark-400 mt-1">Space: {b.spaceName}</p>
              <p className="text-sm text-dark-400">Confidence: {(b.confidence * 100).toFixed(0)}%</p>
            </div>
          ))}
          {stats.recentBreakthroughs.length === 0 && (
            <p className="text-dark-400 text-center py-4">No breakthroughs yet</p>
          )}
        </div>
      </div>

      {/* Space Stats */}
      <div className="mt-6 bg-dark-900 rounded-lg p-6 border border-dark-700">
        <h3 className="text-lg font-semibold mb-4">Space Overview</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-700">
                <th className="text-left py-2 px-4">Name</th>
                <th className="text-left py-2 px-4">Status</th>
                <th className="text-left py-2 px-4">Phase</th>
                <th className="text-left py-2 px-4">Experiments</th>
                <th className="text-left py-2 px-4">Breakthroughs</th>
                <th className="text-left py-2 px-4">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {stats.spaceStats.map((s: any) => (
                <tr key={s.id} className="border-b border-dark-800">
                  <td className="py-3 px-4">{s.name}</td>
                  <td className="py-3 px-4">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="py-3 px-4 text-sm text-dark-300">{s.phase}</td>
                  <td className="py-3 px-4">{s.experiments}</td>
                  <td className="py-3 px-4">{s.breakthroughs}</td>
                  <td className="py-3 px-4 text-sm">{formatNumber(s.tokensUsed)}</td>
                </tr>
              ))}
              {stats.spaceStats.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-dark-400">
                    No spaces yet. Create one to start researching!
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// Spaces Component
function SpacesView() {
  const [spaces, setSpaces] = useState<any[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedSpace, setSelectedSpace] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  const fetchSpaces = async () => {
    const response = await fetch('/api/spaces', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await response.json()
    setSpaces(data.spaces)
    setLoading(false)
  }

  useEffect(() => {
    fetchSpaces()
  }, [])

  if (loading) {
    return <LoadingSpinner />
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-bold">Research Spaces</h2>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
        >
          + New Space
        </button>
      </div>

      {/* Space Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {spaces.map((space) => (
          <div
            key={space.id}
            onClick={() => setSelectedSpace(space)}
            className="bg-dark-900 rounded-lg p-6 border border-dark-700 cursor-pointer hover:border-primary-500 transition-colors"
          >
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-xl font-semibold">{space.name}</h3>
              <StatusBadge status={space.status} />
            </div>
            <p className="text-dark-400 text-sm mb-4 line-clamp-2">
              {space.initialPrompt ? space.initialPrompt.substring(0, 120) + '...' : 'No prompt'}
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-dark-400">Phase:</span>
                <span className="text-dark-200">{space.currentPhase}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-400">Experiments:</span>
                <span className="text-dark-200">{space._count?.experiments || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-400">Breakthroughs:</span>
                <span className="text-yellow-400">{space._count?.breakthroughs || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-400">Tokens:</span>
                <span className="text-dark-200">{formatNumber(space.totalTokens)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {spaces.length === 0 && (
        <div className="text-center py-16">
          <p className="text-dark-400 text-lg mb-4">No spaces yet</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-6 py-3 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
          >
            Create Your First Space
          </button>
        </div>
      )}

      {/* Create Space Modal */}
      {showCreateModal && (
        <CreateSpaceModal
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false)
            fetchSpaces()
          }}
        />
      )}

      {/* Space Detail Modal */}
      {selectedSpace && (
        <SpaceDetailModalNew
          space={selectedSpace}
          onClose={() => setSelectedSpace(null)}
          onUpdate={fetchSpaces}
        />
      )}
    </div>
  )
}

function CreateSpaceModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [initialPrompt, setInitialPrompt] = useState('')
  const [useEmbeddings, setUseEmbeddings] = useState(false)
  const [useGpu, setUseGpu] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const token = localStorage.getItem('research_token')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/spaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, description, initialPrompt, useEmbeddings, useGpu }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create space')
      }

      onSuccess()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-dark-700">
        <h3 className="text-2xl font-bold mb-6">Create New Research Space</h3>
        
        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Space Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              rows={3}
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Initial Research Prompt
            </label>
            <textarea
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              rows={6}
              placeholder="Define your research goal here. For example: 'Explore novel neural network architectures for efficient language modeling' or 'Investigate new optimization algorithms for training large language models'"
              required
            />
            <p className="text-sm text-dark-400 mt-2">
              This prompt will guide the autonomous research agents in their exploration.
            </p>
          </div>


          <div className="mb-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useEmbeddings}
                onChange={(e) => setUseEmbeddings(e.target.checked)}
                className="w-5 h-5 rounded border-dark-600 bg-dark-800 text-primary-600 focus:ring-primary-500"
              />
              <div>
                <span className="font-medium">Enable Semantic Search</span>
                <p className="text-sm text-dark-400">Use embeddings to find relevant context from prior experiments</p>
              </div>
            </label>
          </div>

          <div className="mb-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useGpu}
                onChange={(e) => setUseGpu(e.target.checked)}
                className="w-5 h-5 rounded border-dark-600 bg-dark-800 text-primary-600 focus:ring-primary-500"
              />
              <div>
                <span className="font-medium">Enable GPU Acceleration</span>
                <p className="text-sm text-dark-400">Use GPU-optimized prompts for Implementation and Testing stages (RTX 3060)</p>
              </div>
            </label>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-600/50 rounded-lg font-medium transition-colors"
            >
              {loading ? 'Creating...' : 'Create Space'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SpaceDetailModalNew({ space, onClose, onUpdate }: { space: any; onClose: () => void; onUpdate: () => void }) {
  const token = localStorage.getItem('research_token')
  const [spaceDetail, setSpaceDetail] = useState(space)
  const [showOldView, setShowOldView] = useState(false)
  const [expandedBreakthrough, setExpandedBreakthrough] = useState<any>(null)
  const [expandedExperiment, setExpandedExperiment] = useState<any>(null)
  const [expandedCycles, setExpandedCycles] = useState<Set<number>>(new Set())
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set())
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set())
  const [editingFeedback, setEditingFeedback] = useState<Record<string, string>>({})
  const [ratingLoading, setRatingLoading] = useState<string | null>(null)

  const fetchSpaceDetail = async () => {
    const response = await fetch(`/api/spaces/${space.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await response.json()
    setSpaceDetail(data.space)
  }

  const handleVariantRate = async (variantId: string, rating: 'thumbs_up' | 'thumbs_down') => {
    setRatingLoading(variantId)
    try {
      const res = await fetch(`/api/variants/${variantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'rate', userRating: rating }),
      })
      if (res.ok) {
        await fetchSpaceDetail()
      }
    } finally {
      setRatingLoading(null)
    }
  }

  const handleVariantFeedbackUpdate = async (variantId: string) => {
    const feedback = editingFeedback[variantId]
    if (feedback === undefined) return
    try {
      const res = await fetch(`/api/variants/${variantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'feedback', feedback }),
      })
      if (res.ok) {
        await fetchSpaceDetail()
        setEditingFeedback(prev => { const s = {...prev}; delete s[variantId]; return s })
      }
    } catch {}
  }

  useEffect(() => {
    fetchSpaceDetail()
  }, [space.id])

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-6xl h-full bg-dark-900 border-l border-dark-700 shadow-2xl flex flex-col">
        <div className="flex-shrink-0 border-b border-dark-800 p-6 flex items-start justify-between">
          <div>
            <h3 className="text-2xl font-bold">{spaceDetail.name}</h3>
            <p className="text-dark-400 mt-1 max-w-3xl truncate">{spaceDetail.initialPrompt}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                const token = localStorage.getItem('research_token')
                const action = spaceDetail.status === 'PAUSED' ? 'resume' : 'pause'
                if (action === 'pause' && !confirm('Pause this research?')) return
                try {
                  const res = await fetch(`/api/spaces/${space.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ action }),
                  })
                  if (res.ok) {
                    setSpaceDetail((prev: any) => ({ ...prev, status: action === 'pause' ? 'PAUSED' : 'RUNNING' }))
                  }
                } catch (e) { console.error('Failed to', action, e) }
              }}
              className={`px-3 py-1.5 rounded text-sm border ${spaceDetail.status === 'PAUSED' ? 'bg-green-900/30 hover:bg-green-800/50 text-green-400 border-green-900/50' : 'bg-red-900/30 hover:bg-red-800/50 text-red-400 border-red-900/50'}`}
            >{spaceDetail.status === 'PAUSED' ? '▶ Resume' : '⏸ Pause'}</button>
            <button
              onClick={() => setShowOldView(!showOldView)}
              className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm"
            >
              {showOldView ? '📊 Stages' : '📈 Stats'}
            </button>
            <button onClick={onClose} className="text-dark-400 hover:text-dark-200 text-3xl ml-2">&times;</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
        {!showOldView ? (
          <StageWorkflow
            spaceId={space.id}
            initialPrompt={spaceDetail.initialPrompt}
            onClose={onClose}
          />
        ) : (
          <div className="space-y-6">
            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-dark-800 rounded p-4">
                <div className="text-sm text-dark-400">Status</div>
                <div className="font-semibold mt-1"><StatusBadge status={spaceDetail.status} /></div>
              </div>
              <div className="bg-dark-800 rounded p-4">
                <div className="text-sm text-dark-400">Experiments</div>
                <div className="font-semibold mt-1">{spaceDetail.experiments?.length || 0}</div>
              </div>
              <div className="bg-dark-800 rounded p-4">
                <div className="text-sm text-dark-400">Breakthroughs</div>
                <div className="font-semibold mt-1 text-yellow-400">{spaceDetail.breakthroughs?.length || 0}</div>
              </div>
              <div className="bg-dark-800 rounded p-4">
                <div className="text-sm text-dark-400">Tokens</div>
                <div className="font-semibold mt-1">{formatNumber(spaceDetail.totalTokens)}</div>
              </div>
            </div>

            {/* Breakthroughs */}
            {spaceDetail.breakthroughs && spaceDetail.breakthroughs.length > 0 && (
              <div>
                <h4 className="text-lg font-semibold mb-3">Breakthroughs</h4>
                <div className="space-y-3">
                  {spaceDetail.breakthroughs.map((b: any) => (
                    <div key={b.id} className="bg-dark-800 rounded p-4 border-l-4 border-yellow-500 cursor-pointer hover:bg-dark-700" onClick={() => setExpandedBreakthrough(b)}>
                      <h5 className="font-medium">{b.title}</h5>
                      <p className="text-sm text-dark-400 mt-1">Confidence: {(b.confidence * 100).toFixed(0)}% | {b.verified ? '✓ Verified' : 'Pending'}</p>
                      <p className="text-xs text-dark-500 mt-1">Click to view details</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Variants Panel */}
            {spaceDetail.variants && spaceDetail.variants.length > 0 && (() => {
              // Group variants by stage
              const byStage: Record<string, any[]> = {}
              for (const v of spaceDetail.variants) {
                const key = v.stageName || 'UNKNOWN'
                if (!byStage[key]) byStage[key] = []
                byStage[key].push(v)
              }
              // Get current cycle or most recent
              const currentCycle = spaceDetail.currentCycle || Math.max(...spaceDetail.variants.map((v: any) => v.cycleNumber || 1), 1)
              const currentStageVariants = byStage[spaceDetail.currentPhase] || []
              
              return (
                <div className="mt-6">
                  <h4 className="text-lg font-semibold mb-3">Variants</h4>
                  
                  {/* Current stage variants */}
                  {currentStageVariants.length > 0 && (
                    <div className="mb-4">
                      <p className="text-sm text-dark-400 mb-2">{currentStageVariants.length} variant{currentStageVariants.length !== 1 ? 's' : ''} for current stage ({spaceDetail.currentPhase})</p>
                      <div className="space-y-3">
                        {currentStageVariants.map((variant: any) => {
                          const isExpanded = expandedVariants.has(variant.id)
                          const isEditing = editingFeedback[variant.id] !== undefined
                          return (
                            <div key={variant.id} className="bg-dark-800 rounded border border-dark-700 overflow-hidden">
                              {/* Variant header */}
                              <div className="flex items-center justify-between p-3">
                                <div className="flex items-center gap-3">
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => handleVariantRate(variant.id, 'thumbs_up')}
                                      disabled={ratingLoading === variant.id}
                                      className={`p-1.5 rounded transition-colors ${variant.userRating === 'thumbs_up' ? 'bg-green-600 text-white' : 'bg-dark-700 text-dark-400 hover:text-green-400 hover:bg-dark-600'}`}
                                      title="Thumbs up"
                                    >
                                      👍
                                    </button>
                                    <button
                                      onClick={() => handleVariantRate(variant.id, 'thumbs_down')}
                                      disabled={ratingLoading === variant.id}
                                      className={`p-1.5 rounded transition-colors ${variant.userRating === 'thumbs_down' ? 'bg-red-600 text-white' : 'bg-dark-700 text-dark-400 hover:text-red-400 hover:bg-dark-600'}`}
                                      title="Thumbs down"
                                    >
                                      👎
                                    </button>
                                  </div>
                                  <div>
                                    <span className="font-medium">{variant.name || variant.stageName}</span>
                                    <span className="text-xs text-dark-400 ml-2">Grade: {variant.grade != null ? variant.grade.toFixed(1) : '—'}</span>
                                    <span className="text-xs text-dark-500 ml-2">{variant.steps?.length || 0} steps</span>
                                    {variant.isSelected && (
                                      <span className="ml-2 text-xs bg-primary-900/50 text-primary-400 px-2 py-0.5 rounded">Selected</span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {variant.feedback && (
                                    <span className="text-xs text-dark-400 max-w-32 truncate">{variant.feedback}</span>
                                  )}
                                  <button
                                    onClick={() => setExpandedVariants(prev => { const s = new Set(prev); s.has(variant.id) ? s.delete(variant.id) : s.add(variant.id); return s; })}
                                    className="text-dark-400 hover:text-white text-sm"
                                  >
                                    {isExpanded ? '−' : '+'}
                                  </button>
                                </div>
                              </div>
                              
                              {/* Variant detail (steps, feedback) */}
                              {isExpanded && (
                                <div className="border-t border-dark-700 p-3 bg-dark-900">
                                  {/* Feedback editor */}
                                  <div className="mb-3">
                                    <label className="text-xs text-dark-400 block mb-1">Feedback</label>
                                    {isEditing ? (
                                      <div className="flex gap-2">
                                        <input
                                          type="text"
                                          className="flex-1 bg-dark-800 border border-dark-600 rounded px-3 py-1.5 text-sm"
                                          value={editingFeedback[variant.id]}
                                          onChange={e => setEditingFeedback(prev => ({ ...prev, [variant.id]: e.target.value }))}
                                          placeholder="Enter feedback..."
                                        />
                                        <button
                                          onClick={() => handleVariantFeedbackUpdate(variant.id)}
                                          className="px-3 py-1.5 bg-primary-600 hover:bg-primary-500 rounded text-sm"
                                        >
                                          Save
                                        </button>
                                        <button
                                          onClick={() => setEditingFeedback(prev => { const s = {...prev}; delete s[variant.id]; return s })}
                                          className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm text-dark-300 flex-1">{variant.feedback || 'No feedback yet'}</span>
                                        <button
                                          onClick={() => setEditingFeedback(prev => ({ ...prev, [variant.id]: variant.feedback || '' }))}
                                          className="text-xs text-primary-400 hover:text-primary-300"
                                        >
                                          Edit
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                  
                                  {/* Steps */}
                                  {variant.steps && variant.steps.length > 0 && (
                                    <div>
                                      <label className="text-xs text-dark-400 block mb-1">Steps</label>
                                      <div className="space-y-2">
                                        {variant.steps.map((step: any) => (
                                          <div key={step.id} className="bg-dark-800 rounded p-2 border border-dark-700">
                                            <div className="flex items-center justify-between">
                                              <span className="text-sm font-medium">{step.name}</span>
                                              <span className={`text-xs px-2 py-0.5 rounded ${step.status === 'COMPLETED' ? 'bg-green-900/50 text-green-400' : step.status === 'FAILED' ? 'bg-red-900/50 text-red-400' : 'bg-dark-700 text-dark-400'}`}>
                                                {step.status}
                                              </span>
                                            </div>
                                            {step.grade != null && (
                                              <div className="text-xs text-dark-400 mt-1">Grade: {step.grade.toFixed(1)}</div>
                                            )}
                                            {step.feedback && (
                                              <div className="text-xs text-dark-500 mt-1">{step.feedback}</div>
                                            )}
                                            {step.result && (
                                              <div className="text-xs text-dark-500 mt-1 font-mono max-h-16 overflow-y-auto">{step.result.slice(0, 200)}</div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  
                  {/* Other cycles' variants collapsed by default */}
                  {Object.entries(byStage).filter(([stage]) => stage !== spaceDetail.currentPhase).map(([stage, variants]) => (
                    <div key={stage} className="mt-3">
                      <div
                        className="flex items-center justify-between cursor-pointer hover:text-primary-400 p-2 rounded bg-dark-800/50"
                        onClick={() => setExpandedStages(prev => { const s = new Set(prev); const k = `variant-${stage}`; s.has(k) ? s.delete(k) : s.add(k); return s; })}
                      >
                        <span className="text-sm font-medium">{stage} — {variants.length} variant{(variants as any).length !== 1 ? 's' : ''}</span>
                        <button className="text-dark-400 hover:text-white text-sm">
                          {expandedStages.has(`variant-${stage}`) ? '−' : '+'}
                        </button>
                      </div>
                      {expandedStages.has(`variant-${stage}`) && (
                        <div className="mt-2 pl-4 space-y-2">
                          {(variants as any[]).map((variant: any) => (
                            <div key={variant.id} className="text-xs text-dark-400 bg-dark-900 rounded p-2">
                              <span className="font-medium">Cycle {variant.cycleNumber}:</span> {variant.name || variant.stageName} (Grade: {variant.grade != null ? variant.grade.toFixed(1) : '—'})
                              {variant.userRating && <span className="ml-2">{variant.userRating === 'thumbs_up' ? '👍' : '👎'}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Execution History: Cycles → Stages → Experiments */}
            {spaceDetail.experiments && spaceDetail.experiments.length > 0 && (() => {
              const STAGE_ORDER = ['INVESTIGATION', 'PROPOSITION', 'PLANNING', 'IMPLEMENTATION', 'TESTING', 'VERIFICATION', 'EVALUATION']
              const byCycle: Record<number, Record<string, any[]>> = {}
              for (const exp of spaceDetail.experiments) {
                const cyc = exp.cycleNumber || 1
                if (!byCycle[cyc]) byCycle[cyc] = {}
                const ph = exp.phase || 'UNKNOWN'
                if (!byCycle[cyc][ph]) byCycle[cyc][ph] = []
                byCycle[cyc][ph].push(exp)
              }
              const cycles = Object.keys(byCycle).map(Number).sort((a, b) => b - a)
              const totalCycles = Math.max(...cycles, 1)
              const displayCycles = cycles.slice(0, 10)

              return (
                <div className="mt-6">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-lg font-semibold">Execution History</h4>
                    <span className="text-xs text-dark-400">Cycle {spaceDetail.currentCycle} of {totalCycles}</span>
                  </div>
                  <div className="space-y-2">
                    {displayCycles.map(cycleNum => {
                      const cycleStages = byCycle[cycleNum]
                      const stageCount = Object.keys(cycleStages).length
                      const expCount = Object.values(cycleStages).flat().length
                      return (
                        <div key={cycleNum} className="bg-dark-800 rounded border border-dark-700">
                          <div
                            className="flex items-center justify-between p-3 cursor-pointer hover:bg-dark-700 rounded"
                            onClick={() => setExpandedCycles(prev => { const s = new Set(prev); s.has(cycleNum) ? s.delete(cycleNum) : s.add(cycleNum); return s; })}
                          >
                            <div>
                              <span className="font-medium text-primary-400">Cycle {cycleNum}</span>
                              <span className="text-xs text-dark-400 ml-3">{stageCount} stages, {expCount} experiments</span>
                            </div>
                            <button className="text-dark-400 hover:text-white text-lg">
                              {expandedCycles.has(cycleNum) ? '−' : '+'}
                            </button>
                          </div>
                          {expandedCycles.has(cycleNum) && (
                            <div className="px-3 pb-3 border-t border-dark-700">
                              {STAGE_ORDER.filter(stage => cycleStages[stage]?.length > 0).map(stage => {
                                const stageExps = cycleStages[stage]
                                return (
                                  <div key={stage} className="mt-3">
                                    <div
                                      className="flex items-center justify-between cursor-pointer hover:text-primary-400"
                                      onClick={() => setExpandedStages(prev => { const s = new Set(prev); s.has(`${cycleNum}-${stage}`) ? s.delete(`${cycleNum}-${stage}`) : s.add(`${cycleNum}-${stage}`); return s; })}
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium">{stage}</span>
                                        <span className="text-xs text-dark-500">{stageExps.length} exp{stageExps.length !== 1 ? 's' : ''}</span>
                                      </div>
                                      <button className="text-dark-400 hover:text-white text-sm">
                                        {expandedStages.has(`${cycleNum}-${stage}`) ? '−' : '+'}
                                      </button>
                                    </div>
                                    {expandedStages.has(`${cycleNum}-${stage}`) && (
                                      <div className="mt-2 pl-4 border-l border-dark-600 space-y-2">
                                        {stageExps.map((exp: any) => (
                                          <div
                                            key={exp.id}
                                            className="bg-dark-900 rounded p-2 border border-dark-700 cursor-pointer hover:border-primary-500"
                                            onClick={() => setExpandedExperiment(exp)}
                                          >
                                            <div className="flex items-center justify-between">
                                              <span className="text-xs font-medium">{exp.phase}</span>
                                              <span className="text-xs text-dark-500">{exp.tokensUsed.toLocaleString()} tokens</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                              {Object.keys(cycleStages).filter(s => !STAGE_ORDER.includes(s)).map(stage => {
                                const stageExps = cycleStages[stage]
                                return (
                                  <div key={stage} className="mt-3">
                                    <div
                                      className="flex items-center justify-between cursor-pointer hover:text-primary-400"
                                      onClick={() => setExpandedStages(prev => { const s = new Set(prev); s.has(`${cycleNum}-${stage}`) ? s.delete(`${cycleNum}-${stage}`) : s.add(`${cycleNum}-${stage}`); return s; })}
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-yellow-400">{stage}</span>
                                        <span className="text-xs text-dark-500">{stageExps.length} exp{stageExps.length !== 1 ? 's' : ''}</span>
                                      </div>
                                      <button className="text-dark-400 hover:text-white text-sm">
                                        {expandedStages.has(`${cycleNum}-${stage}`) ? '−' : '+'}
                                      </button>
                                    </div>
                                    {expandedStages.has(`${cycleNum}-${stage}`) && (
                                      <div className="mt-2 pl-4 border-l border-dark-600 space-y-2">
                                        {stageExps.map((exp: any) => (
                                          <div
                                            key={exp.id}
                                            className="bg-dark-900 rounded p-2 border border-dark-700 cursor-pointer hover:border-primary-500"
                                            onClick={() => setExpandedExperiment(exp)}
                                          >
                                            <div className="flex items-center justify-between">
                                              <span className="text-xs font-medium">{exp.phase}</span>
                                              <span className="text-xs text-dark-500">{exp.tokensUsed.toLocaleString()} tokens</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {displayCycles.length === 0 && (
                      <p className="text-dark-400 text-sm text-center py-4">No experiments yet</p>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Breakthrough Detail Modal */}
            {expandedBreakthrough && (
              <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setExpandedBreakthrough(null)}>
                <div className="bg-dark-900 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto border border-dark-700" onClick={e => e.stopPropagation()}>
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="text-xl font-bold">{expandedBreakthrough.title}</h3>
                    <button onClick={() => setExpandedBreakthrough(null)} className="text-dark-400 hover:text-white text-2xl">&times;</button>
                  </div>
                  <div className="text-sm text-dark-400 mb-4">
                    Confidence: {(expandedBreakthrough.confidence * 100).toFixed(0)}% | {expandedBreakthrough.verified ? '✓ Verified' : 'Pending'} | {expandedBreakthrough.category}
                  </div>
                  <div className="text-sm text-dark-200 whitespace-pre-wrap overflow-wrap-break">
                    {expandedBreakthrough.description || 'No description available'}
                  </div>
                </div>
              </div>
            )}

            {/* Experiment Detail Modal */}
            {expandedExperiment && (
              <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setExpandedExperiment(null)}>
                <div className="bg-dark-900 rounded-lg p-6 max-w-3xl w-full max-h-[80vh] overflow-y-auto border border-dark-700" onClick={e => e.stopPropagation()}>
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-xl font-bold">{expandedExperiment.phase}</h3>
                      <p className="text-sm text-dark-400 mt-1">{expandedExperiment.tokensUsed} tokens | Cost: ${expandedExperiment.cost?.toFixed(4)}</p>
                    </div>
                    <button onClick={() => setExpandedExperiment(null)} className="text-dark-400 hover:text-white text-2xl">&times;</button>
                  </div>
                  <div className="text-sm text-dark-200 whitespace-pre-wrap overflow-wrap-break">
                    {expandedExperiment.response || 'No response yet'}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

// Agents Component
function AgentsView() {
  const [agents, setAgents] = useState<any[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  const fetchAgents = async () => {
    const response = await fetch('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await response.json()
    setAgents(data.agents)
    setLoading(false)
  }

  useEffect(() => {
    fetchAgents()
  }, [])

  const AGENT_ROLES = [
    { value: 'THINKING', label: 'Thinking Agent', icon: '🧠' },
    { value: 'INVESTIGATION', label: 'Investigation Agent', icon: '🔍' },
    { value: 'PROPOSITION', label: 'Proposition Agent', icon: '💡' },
    { value: 'PLANNING', label: 'Planning Agent', icon: '📋' },
    { value: 'IMPLEMENTATION', label: 'Implementation Agent', icon: '⚙️' },
    { value: 'TESTING', label: 'Testing Agent', icon: '🧪' },
    { value: 'VERIFICATION', label: 'Verification Agent', icon: '✓' },
    { value: 'EVALUATION', label: 'Evaluation Agent', icon: '⭐' },
  ]

  const PROVIDERS = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'minimax', label: 'MiniMax' },
  ]

  if (loading) {
    return <LoadingSpinner />
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-bold">AI Agents</h2>
        <button
          onClick={() => {
            setEditingAgent(null)
            setShowCreateModal(true)
          }}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
        >
          + New Agent
        </button>
      </div>

      {/* Agent Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="bg-dark-900 rounded-lg p-6 border border-dark-700"
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-semibold">{agent.name}</h3>
                <p className="text-dark-400 text-sm">{agent.provider} • {agent.model}</p>
              </div>
              <span className={`px-2 py-1 text-xs rounded ${agent.isActive ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
                {agent.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>

            <div className="space-y-2 text-sm mb-4">
              <div className="flex items-center justify-between">
                <span className="text-dark-400">Role:</span>
                <span>
                  {AGENT_ROLES.find(r => r.value === agent.role)?.icon} {AGENT_ROLES.find(r => r.value === agent.role)?.label}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-dark-400">Priority:</span>
                <span>Order {agent.order}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setEditingAgent(agent)
                  setShowCreateModal(true)
                }}
                className="flex-1 py-2 px-4 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors text-sm"
              >
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>

      {agents.length === 0 && (
        <div className="text-center py-16">
          <p className="text-dark-400 text-lg mb-4">No agents configured</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-6 py-3 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
          >
            Create Your First Agent
          </button>
        </div>
      )}

      {/* Create/Edit Agent Modal */}
      {showCreateModal && (
        <AgentModal
          agent={editingAgent}
          onClose={() => {
            setShowCreateModal(false)
            setEditingAgent(null)
          }}
          onSuccess={() => {
            setShowCreateModal(false)
            setEditingAgent(null)
            fetchAgents()
          }}
          roles={AGENT_ROLES}
          providers={PROVIDERS}
        />
      )}
    </div>
  )
}

function AgentModal({ agent, onClose, onSuccess, roles, providers }: any) {
  const [name, setName] = useState(agent?.name || '')
  const [provider, setProvider] = useState(agent?.provider || '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(agent?.model || '')
  const [models, setModels] = useState<string[]>([])
  const [role, setRole] = useState(agent?.role || 'PLANNING')
  const [order, setOrder] = useState(agent?.order || 0)
  const [loading, setLoading] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [error, setError] = useState('')
  const token = localStorage.getItem('research_token')

  const handleFetchModels = async () => {
    if (!provider || !apiKey) {
      setError('Provider and API key are required')
      return
    }

    setFetchingModels(true)
    setError('')

    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ provider, apiKey }),
      })

      if (!response.ok) {
        throw new Error('Failed to fetch models')
      }

      const data = await response.json()
      setModels(data.models)
      if (data.models.length > 0) {
        setModel(data.models[0])
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setFetchingModels(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const url = agent ? `/api/agents/${agent.id}` : '/api/agents'
      const method = agent ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, provider, apiKey, model, role, order }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save agent')
      }

      onSuccess()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-dark-700">
        <h3 className="text-2xl font-bold mb-6">
          {agent ? 'Edit Agent' : 'Create New Agent'}
        </h3>

        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Agent Name */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Agent Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
            />
          </div>

          {/* Provider */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
                setModels([])
              }}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
            >
              <option value="">Select Provider</option>
              {providers.map((p: any) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              API Key
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                required={!agent}
              />
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={fetchingModels || !provider || !apiKey}
                className="px-4 py-2 bg-dark-700 hover:bg-dark-600 disabled:bg-dark-700/50 rounded-lg font-medium transition-colors text-sm"
              >
                {fetchingModels ? 'Loading...' : 'Load Models'}
              </button>
            </div>
          </div>

          {/* Model */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
            >
              <option value="">Select Model</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {!models.includes(model) && model && (
                <option value={model}>{model}</option>
              )}
            </select>
          </div>

          {/* Role */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Agent Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
            >
              {roles.map((r: any) => (
                <option key={r.value} value={r.value}>{r.icon} {r.label}</option>
              ))}
            </select>
          </div>

          {/* Order */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Priority Order (lower = higher priority)
            </label>
            <input
              type="number"
              value={order}
              onChange={(e) => setOrder(parseInt(e.target.value))}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              min="0"
              required
            />
            <p className="text-sm text-dark-400 mt-2">
              Agents with lower order values will be preferred when multiple agents are available for a role.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-600/50 rounded-lg font-medium transition-colors"
            >
              {loading ? 'Saving...' : (agent ? 'Update Agent' : 'Create Agent')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Logs Tab Component for Admin
function LogsTab() {
  const [logs, setLogs] = useState<{ debugLogs: string; startupLogs: string; systemInfo: any; timestamp?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeLog, setActiveLog] = useState<'debug' | 'startup'>('debug')
  const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/logs', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setLogs(data)
    } catch (error) {
      console.error('Failed to fetch logs:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
  }, [])

  const handleClearLog = async (logType: 'debug' | 'startup') => {
    if (!confirm(`Clear ${logType} log?`)) return
    try {
      await fetch('/api/admin/logs', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ logType }),
      })
      fetchLogs()
    } catch (error) {
      console.error('Failed to clear log:', error)
    }
  }

  if (loading) {
    return <div className="text-center py-8 text-dark-400">Loading logs...</div>
  }

  return (
    <div className="space-y-6">
      {/* System Info */}
      {logs?.systemInfo && (
        <div className="bg-dark-900 rounded-lg p-4 border border-dark-700">
          <h3 className="text-lg font-semibold mb-3">System Info</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-dark-400">Hostname:</span>
              <div className="font-mono">{logs.systemInfo.hostname}</div>
            </div>
            <div>
              <span className="text-dark-400">Platform:</span>
              <div className="font-mono">{logs.systemInfo.platform}</div>
            </div>
            <div>
              <span className="text-dark-400">Uptime:</span>
              <div className="font-mono">{Math.floor(logs.systemInfo.uptime / 60)}min</div>
            </div>
            <div>
              <span className="text-dark-400">Free Memory:</span>
              <div className="font-mono">{Math.floor(logs.systemInfo.freemem / 1024 / 1024)}MB</div>
            </div>
          </div>
        </div>
      )}

      {/* Log Selector */}
      <div className="flex gap-4 items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveLog('debug')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeLog === 'debug' ? 'bg-primary-600' : 'bg-dark-700 hover:bg-dark-600'
            }`}
          >
            Debug Log
          </button>
          <button
            onClick={() => setActiveLog('startup')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeLog === 'startup' ? 'bg-primary-600' : 'bg-dark-700 hover:bg-dark-600'
            }`}
          >
            Startup Log
          </button>
        </div>
        <button
          onClick={() => handleClearLog(activeLog)}
          className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-300 rounded-lg font-medium transition-colors"
        >
          Clear {activeLog === 'debug' ? 'Debug' : 'Startup'} Log
        </button>
        <button
          onClick={fetchLogs}
          className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors"
        >
          🔄 Refresh
        </button>
      </div>

      {/* Log Content */}
      <div className="bg-dark-900 rounded-lg border border-dark-700">
        <div className="p-4 border-b border-dark-700 flex justify-between items-center">
          <h3 className="font-semibold">
            {activeLog === 'debug' ? 'Debug Log' : 'Startup Log'}
          </h3>
          <span className="text-xs text-dark-400">
            Last updated: {logs?.timestamp ? new Date(logs.timestamp).toLocaleTimeString() : 'N/A'}
          </span>
        </div>
        <pre className="p-4 text-sm font-mono overflow-x-auto max-h-96 overflow-y-auto text-dark-300">
          {activeLog === 'debug' ? logs?.debugLogs : logs?.startupLogs}
        </pre>
      </div>
    </div>
  )
}

// Admin Component
function AdminView() {
  const [activeTab, setActiveTab] = useState('users')
  const [users, setUsers] = useState<any[]>([])
  const [config, setConfig] = useState<any>({})
  const [gpuConfig, setGPUConfig] = useState<any>({ maxConcurrent: 1, jobTimeout: 300 })
  const [loading, setLoading] = useState(true)
  const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  const fetchData = async () => {
    const usersRes = await fetch('/api/admin/users', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const usersData = await usersRes.json()
    setUsers(usersData.users)

    const configRes = await fetch('/api/admin/config', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const configData = await configRes.json()
    const configMap: any = {}
    configData.configs.forEach((c: any) => {
      configMap[c.key] = c.value
    })
    setConfig(configMap)
    setLoading(false)
  }

  const fetchGPUConfig = async () => {
    try {
      const res = await fetch('/api/jobs/gpu?action=config', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setGPUConfig(data.config)
      }
    } catch (e) {
      console.error('Failed to fetch GPU config:', e)
    }
  }

  const handleUpdateGPUConfig = async (key: string, value: string) => {
    const updates = { [key]: parseInt(value, 10) }
    const res = await fetch('/api/jobs/gpu', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      setGPUConfig(data.config)
    }
  }

  useEffect(() => {
    fetchData()
    fetchGPUConfig()
  }, [])

  const handleUpdateConfig = async (key: string, value: string) => {
    await fetch('/api/admin/config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ key, value }),
    })
    setConfig({ ...config, [key]: value })
  }

  const handleUpdateUser = async (userId: string, updates: any) => {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updates),
    })
    fetchData()
  }

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
      return
    }
    await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    fetchData()
  }

  if (loading) {
    return <LoadingSpinner />
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h2 className="text-3xl font-bold mb-6">Administration</h2>

      <div className="flex gap-4 mb-6">
        <button
          onClick={() => setActiveTab('users')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'users' ? 'bg-primary-600' : 'bg-dark-700 hover:bg-dark-600'
          }`}
        >
          Users
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'settings' ? 'bg-primary-600' : 'bg-dark-700 hover:bg-dark-600'
          }`}
        >
          Settings
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'logs' ? 'bg-primary-600' : 'bg-dark-700 hover:bg-dark-600'
          }`}
        >
          📋 Logs
        </button>
      </div>

      {activeTab === 'users' && (
        <div className="bg-dark-900 rounded-lg border border-dark-700 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-700">
                <th className="text-left py-4 px-6">User</th>
                <th className="text-left py-4 px-6">Role</th>
                <th className="text-left py-4 px-6">Status</th>
                <th className="text-left py-4 px-6">Spaces</th>
                <th className="text-left py-4 px-6">Agents</th>
                <th className="text-left py-4 px-6">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-dark-800">
                  <td className="py-4 px-6">
                    <div>
                      <div className="font-medium">{user.username}</div>
                      <div className="text-sm text-dark-400">{user.email}</div>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    <select
                      value={user.role}
                      onChange={(e) => handleUpdateUser(user.id, { role: e.target.value })}
                      className="bg-dark-800 border border-dark-600 rounded px-2 py-1 text-sm"
                    >
                      <option value="USER">User</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </td>
                  <td className="py-4 px-6">
                    <button
                      onClick={() => handleUpdateUser(user.id, { isActive: !user.isActive })}
                      className={`px-3 py-1 rounded text-sm ${
                        user.isActive ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'
                      }`}
                    >
                      {user.isActive ? 'Active' : 'Disabled'}
                    </button>
                  </td>
                  <td className="py-4 px-6">{user._count.spaces}</td>
                  <td className="py-4 px-6">{user._count.agents}</td>
                  <td className="py-4 px-6">
                    <button
                      onClick={() => handleDeleteUser(user.id)}
                      className="px-3 py-1 bg-red-600/20 text-red-300 rounded text-sm hover:bg-red-600/30 transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-dark-400">
                    No users found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-6">
          <div className="bg-dark-900 rounded-lg p-6 border border-dark-700">
            <h3 className="text-lg font-semibold mb-4">Registration Settings</h3>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Allow User Registration</div>
                <div className="text-sm text-dark-400 mt-1">
                  When disabled, only admins can create accounts via the API
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.REGISTRATION_ENABLED === 'true'}
                  onChange={(e) => handleUpdateConfig('REGISTRATION_ENABLED', e.target.checked.toString())}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-dark-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
              </label>
            </div>
          </div>

          <div className="bg-dark-900 rounded-lg p-6 border border-dark-700">
            <h3 className="text-lg font-semibold mb-4">GPU Settings</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Max Concurrent GPU Jobs</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="1"
                    max="8"
                    value={gpuConfig.maxConcurrent || 1}
                    onChange={(e) => handleUpdateGPUConfig('maxConcurrent', e.target.value)}
                    className="flex-1"
                  />
                  <span className="text-lg font-mono w-8">{gpuConfig.maxConcurrent || 1}</span>
                </div>
                <p className="text-xs text-dark-400 mt-1">
                  Increase for RTX 4090 (24GB) or multi-GPU setups. RTX 3060: 1-2 recommended.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Job Timeout (seconds)</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="60"
                    max="600"
                    step="30"
                    value={gpuConfig.jobTimeout || 300}
                    onChange={(e) => handleUpdateGPUConfig('jobTimeout', e.target.value)}
                    className="flex-1"
                  />
                  <span className="text-lg font-mono w-12">{gpuConfig.jobTimeout || 300}s</span>
                </div>
                <p className="text-xs text-dark-400 mt-1">
                  Kill GPU jobs that run longer than this. 5 minutes is default.
                </p>
              </div>
              <div className="pt-2 border-t border-dark-700">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">GPU Worker Status</div>
                    <div className="text-xs text-dark-400 mt-1">Shows current GPU config on the worker</div>
                  </div>
                  <button
                    onClick={fetchGPUConfig}
                    className="px-3 py-1 bg-dark-700 hover:bg-dark-600 rounded text-sm transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'logs' && <LogsTab />}
    </div>
  )
}

// Navigation Component
function Navigation({ activeTab, setActiveTab }: { activeTab: string; setActiveTab: (tab: string) => void }) {
  const { user, logout, isAdmin } = useAuth()

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'providers', label: 'Providers', icon: '🔑' },
    { id: 'agents', label: 'Agents', icon: '🤖' },
    { id: 'embeddings', label: 'Embeddings', icon: '🔢' },
    { id: 'spaces', label: 'Spaces', icon: '🔬' },
  ]

  if (isAdmin) {
    tabs.push({ id: 'admin', label: 'Admin', icon: '⚙️' })
  }

  return (
    <nav className="fixed top-0 left-0 right-0 bg-dark-900/95 backdrop-blur-sm border-b border-dark-700 z-40">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <span className="text-xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
              Research Platform
            </span>
            <div className="flex gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-primary-600 text-white'
                      : 'text-dark-300 hover:bg-dark-800'
                  }`}
                >
                  <span className="mr-2">{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-dark-400">
              {user?.email} ({user?.role})
            </span>
            <button
              onClick={logout}
              className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors text-sm"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}

// Utility Components
function StatCard({ title, value, icon, color }: { title: string; value: string | number; icon: string; color: string }) {
  return (
    <div className={`bg-gradient-to-br ${color} rounded-lg p-6`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-white/80 text-sm">{title}</span>
        <span className="text-2xl">{icon}</span>
      </div>
      <div className="text-3xl font-bold text-white">{value}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    RUNNING: 'bg-green-500/20 text-green-300',
    PAUSED: 'bg-yellow-500/20 text-yellow-300',
    STOPPED: 'bg-red-500/20 text-red-300',
    INITIALIZING: 'bg-blue-500/20 text-blue-300',
  }

  return (
    <span className={`px-2 py-1 text-xs rounded font-medium ${colors[status] || 'bg-dark-700 text-dark-300'}`}>
      {status}
    </span>
  )
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
    </div>
  )
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toString()
}
