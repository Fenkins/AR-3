'use client'

import { useState, useEffect } from 'react'

const EMBEDDING_PROVIDER_CONFIG: Record<string, { label: string; icon: string; description: string; defaultModel: string; supportsDimensions: boolean; requiresEndpoint?: boolean }> = {
  openai: { 
    label: 'OpenAI', 
    icon: '🟢', 
    description: 'text-embedding-3-small (1536d), text-embedding-3-large (3072d), text-embedding-ada-002 (1536d)',
    defaultModel: 'text-embedding-3-small',
    supportsDimensions: true,
  },
  azure: { 
    label: 'Azure OpenAI', 
    icon: '🔷', 
    description: 'Azure-hosted OpenAI embedding models with enterprise security',
    defaultModel: 'text-embedding-ada-002',
    supportsDimensions: true,
    requiresEndpoint: true,
  },
  google: { 
    label: 'Google Gemini', 
    icon: '🔵', 
    description: 'Gemini embedding-001 model (768d)',
    defaultModel: 'embedding-001',
    supportsDimensions: false,
  },
  cohere: { 
    label: 'Cohere', 
    icon: '🌊', 
    description: 'embed-english-v3.0 (1024d), embed-multilingual-v3.0 (1024d)',
    defaultModel: 'embed-english-v3.0',
    supportsDimensions: true,
  },
  huggingface: { 
    label: 'HuggingFace', 
    icon: '🤗', 
    description: 'Sentence transformers - all-MiniLM-L6-v2 (384d), BGE models',
    defaultModel: 'sentence-transformers/all-MiniLM-L6-v2',
    supportsDimensions: false,
  },
}

export default function EmbeddingsView() {
  const [providers, setProviders] = useState<any[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingProvider, setEditingProvider] = useState<any>(null)
  const [preSelectedProviderType, setPreSelectedProviderType] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [testingProvider, setTestingProvider] = useState<any>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [testText, setTestText] = useState('The quick brown fox jumps over the lazy dog')

  const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  useEffect(() => {
    fetchProviders()
  }, [])

  const fetchProviders = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/embeddings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json()
      setProviders(data.providers || [])
    } catch (error) {
      console.error('Error fetching embedding providers:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this embedding provider?')) return

    try {
      const response = await fetch(`/api/embeddings/${id}`, {
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

  const handleTest = async (provider: any) => {
    setTestingProvider(provider.id)
    setTestResult(null)
    setTestLoading(true)

    try {
      const response = await fetch(`/api/embeddings/embed?text=${encodeURIComponent(testText)}&providerId=${provider.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json()
      setTestResult(data)
    } catch (error: any) {
      setTestResult({ error: error.message })
    } finally {
      setTestLoading(false)
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
          <h2 className="text-3xl font-bold">Embeddings</h2>
          <p className="text-dark-400 mt-1">Configure embedding providers for semantic search and document understanding</p>
        </div>
        <button
          onClick={() => {
            setEditingProvider(null)
            setPreSelectedProviderType('')
            setShowAddModal(true)
          }}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
        >
          + Add Embedding Provider
        </button>
      </div>

      {/* Info Banner */}
      <div className="bg-blue-900/20 border border-blue-700/50 rounded-lg p-4 mb-6">
        <p className="text-blue-300 text-sm">
          <span className="font-semibold">💡 Embeddings enable:</span> Semantic search across experiments, 
          document similarity matching, context retrieval for AI responses, and knowledge base integration.
        </p>
      </div>

      {/* Provider Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {Object.entries(EMBEDDING_PROVIDER_CONFIG).map(([key, config]) => {
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
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-dark-400">Model:</span>
                      <span className="text-dark-200 font-mono text-xs">{provider.model}</span>
                    </div>
                    {provider.dimensions && (
                      <div className="flex justify-between">
                        <span className="text-dark-400">Dimensions:</span>
                        <span className="text-dark-200">{provider.dimensions}</span>
                      </div>
                    )}
                    {provider.isDefault && (
                      <div className="flex justify-between">
                        <span className="text-dark-400">Default:</span>
                        <span className="text-yellow-400">⭐ Yes</span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => handleTest(provider)}
                      disabled={testLoading && testingProvider === provider.id}
                      className="flex-1 py-2 px-4 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 rounded-lg font-medium transition-colors text-sm disabled:opacity-50"
                    >
                      {testLoading && testingProvider === provider.id ? 'Testing...' : 'Test'}
                    </button>
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
                    setPreSelectedProviderType(key)
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

      {/* Test Section */}
      {testResult && (
        <div className="bg-dark-900 rounded-lg p-6 border border-dark-700 mb-6">
          <h3 className="text-lg font-semibold mb-4">Test Result</h3>
          {testResult.error ? (
            <div className="p-4 bg-red-500/20 border border-red-500/50 rounded text-red-300">
              <p className="font-semibold">Error:</p>
              <p>{testResult.error}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-dark-800 rounded p-3">
                  <div className="text-sm text-dark-400">Provider</div>
                  <div className="font-semibold">{testResult.provider}</div>
                </div>
                <div className="bg-dark-800 rounded p-3">
                  <div className="text-sm text-dark-400">Model</div>
                  <div className="font-semibold font-mono text-xs">{testResult.model}</div>
                </div>
                <div className="bg-dark-800 rounded p-3">
                  <div className="text-sm text-dark-400">Dimensions</div>
                  <div className="font-semibold">{testResult.dimensions}</div>
                </div>
                <div className="bg-dark-800 rounded p-3">
                  <div className="text-sm text-dark-400">Tokens Used</div>
                  <div className="font-semibold">{testResult.tokensUsed || 'N/A'}</div>
                </div>
              </div>
              {testResult.preview && (
                <div>
                  <div className="text-sm text-dark-400 mb-2">Embedding Preview (first 5 values):</div>
                  <code className="text-xs text-green-400 bg-dark-800 p-3 rounded block overflow-x-auto">
                    [{testResult.preview.join(', ')}, ...]
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Test Input */}
      <div className="bg-dark-900 rounded-lg p-6 border border-dark-700">
        <h3 className="text-lg font-semibold mb-4">Test Embeddings</h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="flex-1 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            placeholder="Enter text to embed..."
          />
          <button
            onClick={() => {
              const defaultProvider = providers.find(p => p.isDefault) || providers[0]
              if (defaultProvider) handleTest(defaultProvider)
            }}
            disabled={providers.length === 0 || testLoading}
            className="px-6 py-2 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-600/50 rounded-lg font-medium transition-colors"
          >
            Test Embedding
          </button>
        </div>
        <p className="text-sm text-dark-400 mt-2">
          {providers.length === 0 
            ? 'Add an embedding provider above to test'
            : `Testing with: ${providers.find(p => p.isDefault)?.name || providers[0]?.name}`}
        </p>
      </div>

      {/* Add/Edit Modal */}
      {showAddModal && (
        <EmbeddingModal
          provider={editingProvider}
          preSelectedProviderType={preSelectedProviderType}
          onClose={() => {
            setShowAddModal(false)
            setEditingProvider(null)
            setPreSelectedProviderType('')
          }}
          onSuccess={() => {
            setShowAddModal(false)
            setEditingProvider(null)
            setPreSelectedProviderType('')
            fetchProviders()
          }}
        />
      )}
    </div>
  )
}

function EmbeddingModal({ provider, preSelectedProviderType, onClose, onSuccess }: { provider: any; preSelectedProviderType?: string; onClose: () => void; onSuccess: () => void }) {
  const [providerType, setProviderType] = useState(provider?.provider || preSelectedProviderType || '')
  const [name, setName] = useState(provider?.name || '')
  const [apiKey, setApiKey] = useState('')
  const [apiEndpoint, setApiEndpoint] = useState(provider?.apiEndpoint || '')
  const [model, setModel] = useState(provider?.model || '')
  const [dimensions, setDimensions] = useState(provider?.dimensions?.toString() || '')
  const [isDefault, setIsDefault] = useState(provider?.isDefault || false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testError, setTestError] = useState('')
  const token = localStorage.getItem('research_token')

  const config = (providerType || preSelectedProviderType) ? EMBEDDING_PROVIDER_CONFIG[providerType || preSelectedProviderType] : null

  const handleFetchModels = async () => {
    const effectiveProviderType = providerType || preSelectedProviderType || ''
    if (!effectiveProviderType || !apiKey) {
      setTestError('Provider and API key are required')
      return
    }
    setFetchingModels(true)
    setTestError('')
    setError('')
    try {
      const token = localStorage.getItem('research_token')
      const res = await fetch('/api/embeddings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: effectiveProviderType, apiKey }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch models')
      setAvailableModels(data.models || [])
      if (data.models.length > 0) setModel(data.models[0])
    } catch (err: any) {
      setTestError(err.message)
    } finally {
      setFetchingModels(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const url = provider ? `/api/embeddings/${provider.id}` : '/api/embeddings'
      const method = provider ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          provider: providerType || preSelectedProviderType || '',
          name,
          apiKey: apiKey || undefined, // Only send if filled
          apiEndpoint: apiEndpoint || undefined,
          model: model || config?.defaultModel,
          dimensions: dimensions ? parseInt(dimensions) : undefined,
          isDefault,
        }),
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || 'Failed to save embedding provider')
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
          {provider ? 'Edit Embedding Provider' : 'Add Embedding Provider'}
        </h3>

        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Provider Type */}
          {!provider && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-dark-300 mb-2">
                Provider Type
              </label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Object.entries(EMBEDDING_PROVIDER_CONFIG).map(([key, cfg]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setProviderType(key)
                      setModel(cfg.defaultModel)
                    }}
                    className={`p-3 rounded-lg border text-left transition-colors ${
                      providerType === key 
                        ? 'border-primary-500 bg-primary-500/20' 
                        : 'border-dark-600 hover:border-dark-500'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xl">{cfg.icon}</span>
                      <span className="font-semibold">{cfg.label}</span>
                    </div>
                    <p className="text-xs text-dark-400">{cfg.defaultModel}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Name */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              placeholder={config?.label || 'My Embeddings'}
            />
          </div>

          {/* API Key */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              API Key {provider && '(leave empty to keep current)'}
            </label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                placeholder="sk-..."
                required={!provider}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            {/* Test API Key & Fetch Models */}
            {!provider && (
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={!providerType && !preSelectedProviderType || !apiKey || fetchingModels}
                className="mt-2 w-full py-2 px-4 bg-primary-600/20 hover:bg-primary-600/30 disabled:opacity-50 rounded-lg text-sm text-primary-400 transition-colors"
              >
                {fetchingModels ? 'Testing API Key...' : 'Test API Key & Fetch Models'}
              </button>
            )}
            {testError && (
              <p className="text-xs text-red-400 mt-1">{testError}</p>
            )}
            {availableModels.length > 0 && (
              <p className="text-xs text-green-400 mt-1">✓ API key valid — {availableModels.length} models available</p>
            )}
          </div>

          {/* API Endpoint (for Azure) */}
          {providerType === 'azure' && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-dark-300 mb-2">
                Azure Endpoint
              </label>
              <input
                type="text"
                value={apiEndpoint}
                onChange={(e) => setApiEndpoint(e.target.value)}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                placeholder="https://your-resource.openai.azure.com"
              />
            </div>
          )}

          {/* Model */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Model
            </label>
            {availableModels.length > 0 ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                placeholder={config?.defaultModel || 'model-name'}
                required
              />
            )}
            {config && (
              <p className="text-sm text-dark-400 mt-1">
                Default: {config.defaultModel} — {config.supportsDimensions ? 'supports custom dimensions' : 'fixed dimensions'}
              </p>
            )}
          </div>

          {/* Dimensions (for OpenAI 3-series) */}
          {config?.supportsDimensions && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-dark-300 mb-2">
                Output Dimensions (optional)
              </label>
              <input
                type="number"
                value={dimensions}
                onChange={(e) => setDimensions(e.target.value)}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
                placeholder="1536 (for text-embedding-3-small)"
              />
              <p className="text-sm text-dark-400 mt-1">
                Reduce output dimensions for smaller vectors. For OpenAI 3-series models.
              </p>
            </div>
          )}

          {/* Default Toggle */}
          <div className="mb-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="w-5 h-5 rounded border-dark-600 bg-dark-800 text-primary-600 focus:ring-primary-500"
              />
              <div>
                <span className="font-medium">Set as default provider</span>
                <p className="text-sm text-dark-400">Used when no specific provider is specified</p>
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
              disabled={loading || (!providerType && !preSelectedProviderType)}
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