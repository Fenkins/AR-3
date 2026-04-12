'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'

interface ServiceProvider {
  id: string
  provider: string
  name: string
  apiKey: string
  isActive: boolean
  createdAt: string
}

const PROVIDER_CONFIG: Record<string, { label: string; icon: string; description: string }> = {
  openai: { 
    label: 'OpenAI', 
    icon: '🟢',
    description: 'GPT-4, GPT-3.5, and more',
  },
  anthropic: { 
    label: 'Anthropic', 
    icon: '🟣',
    description: 'Claude 3 Opus, Sonnet, Haiku',
  },
  google: { 
    label: 'Google', 
    icon: '🔵',
    description: 'Gemini Pro, Gemini 1.5',
  },
  openrouter: { 
    label: 'OpenRouter', 
    icon: '🟠',
    description: 'Access to 100+ models',
  },
  minimax: { 
    label: 'MiniMax', 
    icon: '🔴',
    description: 'abab6, abab5 models',
  },
}

export default function ServiceProviders() {
  const { token } = useAuth()
  const [providers, setProviders] = useState<ServiceProvider[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ServiceProvider | null>(null)
  const [loading, setLoading] = useState(true)
  const [testingKey, setTestingKey] = useState<string | null>(null)

  useEffect(() => {
    fetchProviders()
  }, [])

  const fetchProviders = async () => {
    setLoading(true)
    try {
      const currentToken = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null
      if (!currentToken) {
        console.error('No auth token found')
        setLoading(false)
        return
      }

      const response = await fetch('/api/providers', {
        headers: { Authorization: `Bearer ${currentToken}` },
      })
      
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to parse error response' }))
        throw new Error(err.error || `Providers API error: ${response.status}`)
      }
      
      const data = await response.json()
      setProviders(data.providers || [])
    } catch (error) {
      console.error('Error fetching providers:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this service provider? Agents using it will need to be reassigned.')) return

    try {
      const response = await fetch(`/api/providers/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error)
      }

      fetchProviders()
    } catch (error: any) {
      alert(error.message)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-3xl font-bold">Service Providers</h2>
          <p className="text-dark-400 mt-1">Configure API keys for AI providers</p>
        </div>
        <button
          onClick={() => {
            setEditingProvider(null)
            setShowAddModal(true)
          }}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
        >
          + Add Provider
        </button>
      </div>

      {/* Provider Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {Object.entries(PROVIDER_CONFIG).map(([key, config]) => {
          const provider = providers.find(p => p.provider === key)
          
          return (
            <div
              key={key}
              className={`bg-dark-900 rounded-lg p-6 border-2 transition-all ${
                provider 
                  ? 'border-green-500/50' 
                  : 'border-dark-700 border-dashed'
              }`}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{config.icon}</span>
                  <div>
                    <h3 className="text-xl font-semibold">{config.label}</h3>
                    <p className="text-sm text-dark-400">{config.description}</p>
                  </div>
                </div>
                {provider && (
                  <span className="px-2 py-1 text-xs rounded bg-green-500/20 text-green-300">
                    ✓ Connected
                  </span>
                )}
              </div>

              {provider ? (
                <div className="space-y-3">
                  <div className="text-sm">
                    <div className="text-dark-400">Name: {provider.name}</div>
                    <div className="text-dark-400">
                      Key: ••••••••{provider.apiKey.slice(-4)}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setEditingProvider(provider)
                        setShowAddModal(true)
                      }}
                      className="flex-1 py-2 px-4 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors text-sm"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(provider.id)}
                      className="px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-300 rounded-lg transition-colors text-sm"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setEditingProvider(null)
                    setShowAddModal(true)
                  }}
                  className="w-full py-3 px-4 border-2 border-dashed border-dark-600 hover:border-primary-500 rounded-lg text-dark-400 hover:text-primary-400 transition-colors font-medium"
                >
                  Connect {config.label}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {providers.length === 0 && (
        <div className="text-center py-16">
          <p className="text-dark-400 text-lg mb-4">No service providers configured</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-6 py-3 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
          >
            Add Your First Provider
          </button>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showAddModal && (
        <ProviderModal
          provider={editingProvider}
          onClose={() => {
            setShowAddModal(false)
            setEditingProvider(null)
          }}
          onSuccess={() => {
            setShowAddModal(false)
            setEditingProvider(null)
            fetchProviders()
          }}
        />
      )}
    </div>
  )
}

function ProviderModal({ provider, onClose, onSuccess }: {
  provider: ServiceProvider | null
  onClose: () => void
  onSuccess: () => void
}) {
  const [selectedProvider, setSelectedProvider] = useState(provider?.provider || '')
  const [name, setName] = useState(provider?.name || '')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{success: boolean; models?: number} | null>(null)
  const [error, setError] = useState('')

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  const handleTest = async () => {
    if (!selectedProvider || !apiKey) {
      setError('Provider and API key are required')
      return
    }

    setTesting(true)
    setTestResult(null)
    setError('')

    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ provider: selectedProvider, apiKey }),
      })

      if (!response.ok) {
        throw new Error('Invalid API key')
      }

      const data = await response.json()
      setTestResult({ success: true, models: data.models.length })
      setError('')
    } catch (err: any) {
      setTestResult({ success: false })
      setError(err.message)
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const url = provider ? `/api/providers/${provider.id}` : '/api/providers'
      const method = provider ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          provider: selectedProvider,
          name: name || PROVIDER_CONFIG[selectedProvider]?.label,
          apiKey,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save provider')
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
      <div className="bg-dark-900 rounded-lg p-6 max-w-xl w-full border border-dark-700">
        <h3 className="text-2xl font-bold mb-6">
          {provider ? 'Edit Provider' : 'Add Service Provider'}
        </h3>

        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {testResult && (
          <div className={`mb-4 p-3 rounded text-sm ${
            testResult.success 
              ? 'bg-green-500/20 border border-green-500/50 text-green-300'
              : 'bg-red-500/20 border border-red-500/50 text-red-300'
          }`}>
            {testResult.success 
              ? `✓ Connection successful! Found ${testResult.models} models.`
              : '✗ Connection failed. Check your API key.'}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {!provider && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-dark-300 mb-2">
                Provider
              </label>
              <select
                value={selectedProvider}
                onChange={(e) => {
                  setSelectedProvider(e.target.value)
                  setName('')
                }}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                required
                disabled={!!provider}
              >
                <option value="">Select Provider</option>
                {Object.entries(PROVIDER_CONFIG).map(([key, config]) => (
                  <option key={key} value={key}>
                    {config.icon} {config.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Display Name (optional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={PROVIDER_CONFIG[selectedProvider]?.label}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              API Key
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="flex-1 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                required={!provider}
              />
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !selectedProvider || !apiKey}
                className="px-4 py-2 bg-dark-700 hover:bg-dark-600 disabled:bg-dark-700/50 rounded-lg font-medium transition-colors text-sm whitespace-nowrap"
              >
                {testing ? 'Testing...' : 'Test Key'}
              </button>
            </div>
            <p className="text-xs text-dark-400 mt-2">
              Your API key is encrypted and stored securely
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
              {loading ? 'Saving...' : (provider ? 'Update Provider' : 'Add Provider')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
