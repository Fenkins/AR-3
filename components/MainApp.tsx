Total output lines: 2298

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
  const { logout } = useAuth()
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const fetchDashboard = async () => {
    const token = localStorage.getItem('research_token')
    if (!token) { setLoading(false); return; }
    const response = await fetch('/api/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      logout()
      setLoading(false)
      return
    }
    if (!response.ok) { setLoading(false); return; }
    const data = await response.json()
    setStats({
      stats: {
        totalSpaces: data?.stats?.totalSpaces ?? 0,
        totalExperiments: data?.stats?.totalExperiments ?? 0,
        totalBreakthroughs: data?.stats?.totalBreakthroughs ?? 0,
        verifiedBreakthroughs: data?.stats?.verifiedBreakthroughs ?? 0,
        totalTokens: data?.stats?.totalTokens ?? 0,
      },
      experimentsByPhase: data?.experimentsByPhase ?? {},
      breakthroughsByCategory: data?.breakthroughsByCategory ?? {},
      recentBreakthroughs: Array.isArray(data?.recentBreakthroughs) ? data.recentBreakthroughs : [],
      spaceStats: Array.isArray(data?.spaceStats) ? data.spaceStats : [],
    })
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
  const { logout } = useAuth()
  const [spaces, setSpaces] = useState<any[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedSpace, setSelectedSpace] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  const fetchSpaces = async () => {
    if (!token) {
      setSpaces([])
      setLoading(false)
      return
    }
    const response = await fetch('/api/spaces', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      logout()
      setSpaces([])
      setLoading(false)
      return
    }
    if (!response.ok) {
      setSpaces([])
      setLoading(false)
      return
    }
    const data = await response.json()
    setSpaces(Array.isArray(data.spaces) ? data.spaces : [])
    setLoading(false)
  }

  const deleteSpaceById = async (spaceId: string) => {
    try {
      const res = await fetch(`/api/spaces/${spaceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Delete failed' }))
        alert(`Delete failed: ${err.error}`)
        return
      }
      setSpaces(spaces => spaces.filter(s => s.id !== spaceId))
      if (selectedSpace?.id === spaceId) setSelectedSpace(null)
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`)
    }
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
              <div className="flex items-center gap-2">
                <StatusBadge status={space.status} />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`Delete space "${space.name}"? This cannot be undone.`)) {
                      deleteSpaceById(space.id)
                    }
                  }}
                  className="w-6 h-6 flex items-center justify-center text-dark-500 hover:text-red-400 hover:bg-dark-800 rounded transition-colors text-sm"
                  title="Delete space"
                >
                  ✕
                </button>
              </div>
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
              <div className="flex justify-between">
                <span className="text-dark-400">Model Cache:</span>
                <span className="text-dark-200">{space._count?.modelCaches || 0} items · {formatBytes(space.cacheSize || 0)}</span>
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
  const [useSystemRamOffload, setUseSystemRamOffload] = useState(false)
const [numVariants, setNumVariants] = useState(3)
  const [stepsPerVariant, setStepsPerVariant] = useState(25)
  const [numVariantsMode, setNumVariantsMode] = useState<'fixed' | 'auto'>('fixed')
  const [stepsPerVariantMode, setStepsPerVariantMode] = useState<'fixed' | 'auto'>('fixed')
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
        body: JSON.stringify({ name, description, initialPrompt, useEmbeddings, useGpu, useSystemRamOffload, numVariants, stepsPerVariant, numVariantsMode, stepsPerVariantMode }),
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
           …14500 tokens truncated…m('research_token') : null

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

  const fetchHfStatus = async () => {
    try {
      const res = await fetch('/api/admin/huggingface', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setHfTokenStatus({ hasToken: data.hasToken, tokenPrefix: data.tokenPrefix })
      }
    } catch (e) {
      console.error('Failed to fetch HF status:', e)
    }
  }

  const handleTestHfToken = async () => {
    if (!hfToken) return
    setHfTesting(true)
    setHfTestResult(null)
    try {
      const res = await fetch('/api/admin/huggingface', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: hfToken, action: 'test' }),
      })
      const data = await res.json()
      if (data.valid) {
        setHfTestResult({ success: true, message: `✓ Token valid for @${data.username}` })
      } else {
        setHfTestResult({ success: false, message: `✗ ${data.error}` })
      }
    } catch (e: any) {
      setHfTestResult({ success: false, message: `✗ ${e.message}` })
    } finally {
      setHfTesting(false)
    }
  }

  const handleSaveHfToken = async () => {
    if (!hfToken) return
    setHfSaving(true)
    try {
      const res = await fetch('/api/admin/huggingface', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: hfToken, action: 'save' }),
      })
      const data = await res.json()
      if (res.ok) {
        setHfTokenStatus({ hasToken: true, tokenPrefix: data.tokenPrefix })
        setHfTestResult({ success: true, message: '✓ Token saved' })
        setHfToken('')
      } else {
        setHfTestResult({ success: false, message: data.error || 'Failed to save' })
      }
    } catch (e: any) {
      setHfTestResult({ success: false, message: e.message })
    } finally {
      setHfSaving(false)
    }
  }

  const handleDeleteHfToken = async () => {
    if (!confirm('Remove HuggingFace token?')) return
    await fetch('/api/admin/huggingface', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'delete' }),
    })
    setHfTokenStatus({ hasToken: false, tokenPrefix: null })
    setHfTestResult(null)
    setHfToken('')
  }

  useEffect(() => {
    fetchData()
    fetchGPUConfig()
    fetchHfStatus()
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
                <label className="block text-sm font-medium mb-2">Job Timeout</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="1"
                    max="24"
                    step="1"
                    value={Math.min(24, Math.max(1, Math.round((gpuConfig.jobTimeout || 3600) / 3600)))}
                    onChange={(e) => {
                      const hours = parseInt(e.target.value)
                      const seconds = hours * 3600 // 1-24 hours mapped to seconds
                      handleUpdateGPUConfig('jobTimeout', String(seconds))
                    }}
                    className="flex-1"
                  />
                  <span className="text-lg font-mono w-20 text-right">
                    {(gpuConfig.jobTimeout || 3600) >= 86400 ? 'Unlimited' : `${Math.round((gpuConfig.jobTimeout || 3600) / 3600)}h`}
                  </span>
                </div>
                <p className="text-xs text-dark-400 mt-1">
                  Max runtime per GPU job. 1h is default; 24h = Unlimited.
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

          <div className="bg-dark-900 rounded-lg p-6 border border-dark-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">🤗 HuggingFace</h3>
              {hfTokenStatus.hasToken && (
                <span className="px-2 py-1 text-xs rounded bg-green-500/20 text-green-300">
                  ✓ Connected {hfTokenStatus.tokenPrefix}
                </span>
              )}
            </div>
            <p className="text-sm text-dark-400 mb-4">
              Add a HuggingFace token to enable automatic downloads of gated models and datasets.
              Get your token at{' '}
              <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:underline">
                huggingface.co/settings/tokens
              </a>
            </p>
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">HF Token</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={hfToken}
                  onChange={(e) => { setHfToken(e.target.value); setHfTestResult(null) }}
                  placeholder={hfTokenStatus.hasToken ? '•••••••••••••••• (leave empty to keep saved)' : 'hf_...'}
                  className="flex-1 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                />
                <button
                  onClick={handleTestHfToken}
                  disabled={!hfToken || hfTesting}
                  className="px-4 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg font-medium transition-colors text-sm whitespace-nowrap"
                >
                  {hfTesting ? 'Testing...' : 'Test'}
                </button>
                <button
                  onClick={handleSaveHfToken}
                  disabled={!hfToken || hfSaving}
                  className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 rounded-lg font-medium transition-colors text-sm whitespace-nowrap"
                >
                  {hfSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
            {hfTestResult && (
              <div className={`p-3 rounded text-sm ${
                hfTestResult.success
                  ? 'bg-green-500/20 border border-green-500/50 text-green-300'
                  : 'bg-red-500/20 border border-red-500/50 text-red-300'
              }`}>
                {hfTestResult.message}
              </div>
            )}
            {hfTokenStatus.hasToken && (
              <button
                onClick={handleDeleteHfToken}
                className="mt-3 px-3 py-1 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Remove saved token
              </button>
            )}
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}
