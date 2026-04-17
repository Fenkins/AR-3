'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'

interface Agent {
  id: string
  name: string
  model: string
  role: string
  order: number
  isActive: boolean
  systemPrompt?: string | null
  gpuPromptVariant?: string | null
  serviceProvider: {
    id: string
    provider: string
    name: string
  }
}

interface ServiceProvider {
  id: string
  provider: string
  name: string
}

const AGENT_ROLES = [
  { value: 'THINKING', label: 'Thinking Agent', icon: '🧠' },
  { value: 'INVESTIGATION', label: 'Investigation Agent', icon: '🔍' },
  { value: 'PROPOSITION', label: 'Proposition Agent', icon: '💡' },
  { value: 'PLANNING', label: 'Planning Agent', icon: '📋' },
  { value: 'IMPLEMENTATION', label: 'Implementation Agent', icon: '⚙️' },
  { value: 'TESTING', label: 'Testing Agent', icon: '🧪' },
  { value: 'VERIFICATION', label: 'Verification Agent', icon: '✓' },
  { value: 'EVALUATION', label: 'Evaluation Agent', icon: '⭐' },
  { value: 'GRADING', label: 'Grading Agent', icon: '📝' },
]

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [serviceProviders, setServiceProviders] = useState<ServiceProvider[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPrePopulateModal, setShowPrePopulateModal] = useState(false)
  const [prePopProvider, setPrePopProvider] = useState<string>('')
  const [expandedPromptAgent, setExpandedPromptAgent] = useState<string | null>(null)
  const [editingPrompt, setEditingPrompt] = useState<{ systemPrompt?: string; gpuPromptVariant?: string } | null>(null)

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this agent?')) return

    const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null
    if (!token) return

    try {
      const response = await fetch(`/api/agents/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error)
      }

      fetchData()
    } catch (error: any) {
      alert(error.message)
    }
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null
      if (!token) {
        console.error('No auth token found')
        setLoading(false)
        return
      }

      const [agentsRes, providersRes] = await Promise.all([
        fetch('/api/agents', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/providers', { headers: { Authorization: `Bearer ${token}` } }),
      ])

      if (!agentsRes.ok) {
        const err = await agentsRes.json().catch(() => ({ error: 'Failed to parse error response' }))
        throw new Error(err.error || `Agents API error: ${agentsRes.status}`)
      }
      if (!providersRes.ok) {
        const err = await providersRes.json().catch(() => ({ error: 'Failed to parse error response' }))
        throw new Error(err.error || `Providers API error: ${providersRes.status}`)
      }

      const [agentsData, providersData] = await Promise.all([
        agentsRes.json(),
        providersRes.json(),
      ])

      setAgents(agentsData.agents || [])
      setServiceProviders(providersData.providers || [])
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

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
          <h2 className="text-3xl font-bold">AI Agents</h2>
          <p className="text-dark-400 mt-1">
            Configure agents for each research stage
          </p>
        </div>
        <button
          onClick={() => {
            setEditingAgent(null)
            setShowCreateModal(true)
          }}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
        >
          + New Agent
        </button>
        <div className="relative">
          <button
            onClick={() => setShowPrePopulateModal(true)}
            className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors"
          >
            ⚡ Pre-populate Agents
          </button>
        </div>
      </div>

      {serviceProviders.length === 0 && (
        <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4 mb-6">
          <p className="text-yellow-300">
            ⚠️ You need to configure at least one service provider before creating agents.
          </p>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              window.dispatchEvent(new CustomEvent('navigateToProviders'))
            }}
            className="text-yellow-400 hover:text-yellow-300 underline mt-2 inline-block"
          >
            Go to Service Providers →
          </a>
        </div>
      )}

      {/* Agents by Role */}
      <div className="space-y-6">
        {AGENT_ROLES.map((roleConfig) => {
          const roleAgents = agents.filter(a => a.role === roleConfig.value)
          
          return (
            <div key={roleConfig.value} className="bg-dark-900 rounded-lg border border-dark-700 p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{roleConfig.icon}</span>
                  <div>
                    <h3 className="text-lg font-semibold">{roleConfig.label}</h3>
                    <p className="text-sm text-dark-400">Order: lowest first</p>
                  </div>
                </div>
              </div>

              {roleAgents.length > 0 ? (
                <div className="space-y-2">
                  {roleAgents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between bg-dark-800 rounded p-3"
                    >
                      <div className="flex items-center gap-4">
                        <div>
                          <div className="font-medium">{agent.name}</div>
                          <div className="text-sm text-dark-400">
                            {agent.serviceProvider.name} • {agent.model}
                          </div>
                        </div>
                        <span className="text-xs bg-dark-700 px-2 py-1 rounded">
                          Order: {agent.order}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setEditingAgent(agent)
                            setShowCreateModal(true)
                          }}
                          className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            setExpandedPromptAgent(expandedPromptAgent === agent.id ? null : agent.id)
                            setEditingPrompt({ systemPrompt: agent.systemPrompt || '', gpuPromptVariant: agent.gpuPromptVariant || '' })
                          }}
                          className={`px-3 py-1.5 rounded text-sm transition-colors ${expandedPromptAgent === agent.id ? 'bg-primary-600 text-white' : 'bg-dark-700 hover:bg-dark-600'}`}
                        >
                          Prompts
                        </button>
                        <button
                          onClick={() => handleDelete(agent.id)}
                          className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-300 rounded text-sm transition-colors"
                        >
                          ✕
                        </button>
                      </div>
                      
                      {/* Prompt editor (expanded) */}
                      {expandedPromptAgent === agent.id && editingPrompt && (
                        <div className="mt-3 pt-3 border-t border-dark-600">
                          <div className="mb-3">
                            <label className="text-xs text-dark-400 block mb-1">System Prompt (default)</label>
                            <textarea
                              className="w-full bg-dark-900 border border-dark-600 rounded p-2 text-sm font-mono"
                              rows={4}
                              value={editingPrompt.systemPrompt}
                              onChange={e => setEditingPrompt(p => p ? { ...p, systemPrompt: e.target.value } : null)}
                              placeholder="Enter custom system prompt for this agent..."
                            />
                            <p className="text-xs text-dark-500 mt-1">Overrides the hardcoded stage prompt. Leave blank to use default.</p>
                          </div>
                          <div className="mb-3">
                            <label className="text-xs text-dark-400 block mb-1">GPU Mode Prompt Variant</label>
                            <textarea
                              className="w-full bg-dark-900 border border-dark-600 rounded p-2 text-sm font-mono"
                              rows={4}
                              value={editingPrompt.gpuPromptVariant}
                              onChange={e => setEditingPrompt(p => p ? { ...p, gpuPromptVariant: e.target.value } : null)}
                              placeholder="Enter prompt for GPU execution mode..."
                            />
                            <p className="text-xs text-dark-500 mt-1">Used when this agent runs with useGpu=true. Leave blank to use system prompt.</p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                try {
                                  const token = localStorage.getItem('research_token')
                                  const res = await fetch(`/api/agents/${agent.id}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                    body: JSON.stringify({
                                      systemPrompt: editingPrompt.systemPrompt || null,
                                      gpuPromptVariant: editingPrompt.gpuPromptVariant || null,
                                    }),
                                  })
                                  if (res.ok) {
                                    fetchData()
                                    setExpandedPromptAgent(null)
                                    setEditingPrompt(null)
                                  }
                                } catch (err) {
                                  console.error('Failed to save prompts:', err)
                                }
                              }}
                              className="px-4 py-1.5 bg-primary-600 hover:bg-primary-500 rounded text-sm"
                            >
                              Save Prompts
                            </button>
                            <button
                              onClick={() => {
                                setExpandedPromptAgent(null)
                                setEditingPrompt(null)
                              }}
                              className="px-4 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-dark-400 text-sm italic">No agents configured for this role</p>
              )}
            </div>
          )
        })}
      </div>

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <AgentModal
          agent={editingAgent}
          serviceProviders={serviceProviders}
          onClose={() => {
            setShowCreateModal(false)
            setEditingAgent(null)
          }}
          onSuccess={() => {
            setShowCreateModal(false)
            setEditingAgent(null)
            fetchData()
          }}
        />
      )}

      {/* Pre-populate Modal */}
      {showPrePopulateModal && (
        <PrePopulateModal
          serviceProviders={serviceProviders}
          onClose={() => setShowPrePopulateModal(false)}
          onSuccess={() => {
            setShowPrePopulateModal(false)
            fetchData()
          }}
        />
      )}
    </div>
  )
}

function AgentModal({ agent, serviceProviders, onClose, onSuccess }: {
  agent: Agent | null
  serviceProviders: ServiceProvider[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [name, setName] = useState(agent?.name || '')
  const [serviceProviderId, setServiceProviderId] = useState(agent?.serviceProvider.id || '')
  const [model, setModel] = useState(agent?.model || '')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [role, setRole] = useState(agent?.role || 'THINKING')
  const [order, setOrder] = useState(agent?.order || 0)
  const [loading, setLoading] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [error, setError] = useState('')

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('research_token') : null

  // Fetch models when provider changes
  useEffect(() => {
    if (serviceProviderId) {
      fetchModels()
    }
  }, [serviceProviderId])

  const fetchModels = async () => {
    const provider = serviceProviders.find(p => p.id === serviceProviderId)
    if (!provider) return

    setFetchingModels(true)
    setError('')

    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          provider: provider.provider,
          apiKey: '', // API key is stored on server
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to fetch models')
      }

      const data = await response.json()
      setAvailableModels(data.models)
      if (data.models.length > 0 && !model) {
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
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          name,
          serviceProviderId,
          model,
          role,
          order,
        }),
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

  const selectedProvider = serviceProviders.find(p => p.id === serviceProviderId)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-lg p-6 max-w-xl w-full border border-dark-700">
        <h3 className="text-2xl font-bold mb-6">
          {agent ? 'Edit Agent' : 'Create New Agent'}
        </h3>

        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
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

          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Service Provider
            </label>
            <select
              value={serviceProviderId}
              onChange={(e) => {
                setServiceProviderId(e.target.value)
                setModel('')
              }}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
            >
              <option value="">Select Provider</option>
              {serviceProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Model {fetchingModels && <span className="text-dark-400">(Loading...)</span>}
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              required
              disabled={!serviceProviderId || fetchingModels}
            >
              <option value="">Select Model</option>
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {!availableModels.includes(model) && model && (
                <option value={model}>{model}</option>
              )}
            </select>
            {selectedProvider && (
              <p className="text-xs text-dark-400 mt-1">
                Models from {selectedProvider.name}
              </p>
            )}
          </div>

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
              {AGENT_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.icon} {r.label}</option>
              ))}
            </select>
          </div>

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

function PrePopulateModal({ serviceProviders, onClose, onSuccess }: {
  serviceProviders: ServiceProvider[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState<'provider' | 'model'>('provider')

  const handleFetchModels = async () => {
    if (!provider || !apiKey) {
      setError('Provider and API key are required')
      return
    }
    setFetchingModels(true)
    setError('')
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('research_token') : null
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider, apiKey }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch models')
      setModels(data.models || [])
      if (data.models.length > 0) setSelectedModel(data.models[0])
      setStep('model')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setFetchingModels(false)
    }
  }

  const handleCreateProviderAndAgents = async () => {
    if (!provider || !apiKey || !selectedModel) {
      setError('All fields are required')
      return
    }
    setLoading(true)
    setError('')
    try {
      const token = localStorage.getItem('research_token')
      // Create or use existing provider
      const providerRes = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider, apiKey, name: `${provider} (${selectedModel})` }),
      })
      const providerData = await providerRes.json()
      if (!providerRes.ok) throw new Error(providerData.error || 'Failed to create provider')
      const serviceProviderId = providerData.provider?.id || providerData.id

      // Create all agents
      const agentsToCreate = [
        { name: 'Thinking Agent', role: 'THINKING', order: 0 },
        { name: 'Investigation Agent', role: 'INVESTIGATION', order: 1 },
        { name: 'Proposition Agent', role: 'PROPOSITION', order: 2 },
        { name: 'Planning Agent', role: 'PLANNING', order: 3 },
        { name: 'Implementation Agent', role: 'IMPLEMENTATION', order: 4 },
        { name: 'Testing Agent', role: 'TESTING', order: 5 },
        { name: 'Verification Agent', role: 'VERIFICATION', order: 6 },
        { name: 'Evaluation Agent', role: 'EVALUATION', order: 7 },
        { name: 'Grading Agent', role: 'GRADING', order: 8 },
      ]

      for (const agent of agentsToCreate) {
        await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: agent.name,
            serviceProviderId,
            model: selectedModel,
            role: agent.role,
            order: agent.order,
          }),
        })
      }


      onSuccess()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const PROVIDERS = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'minimax', label: 'MiniMax' },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 rounded-lg p-6 max-w-lg w-full border border-dark-700">
        <h3 className="text-2xl font-bold mb-6">⚡ Pre-populate Agents</h3>

        <p className="text-dark-400 mb-4">Create a service provider and all 9 research agents at once.</p>


        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {step === 'provider' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-dark-300 mb-2">Provider</label>
              <select
                value={provider}
                onChange={(e) => { setProvider(e.target.value); setApiKey(''); setModels([]); }}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              >
                <option value="">Select Provider</option>
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-dark-300 mb-2">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter API key"
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              />
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
                type="button"
                onClick={handleFetchModels}
                disabled={!provider || !apiKey || fetchingModels}
                className="flex-1 py-2 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-600/50 rounded-lg font-medium transition-colors"
              >
                {fetchingModels ? 'Loading...' : 'Fetch Models'}
              </button>
            </div>
          </>
        )}

        {step === 'model' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-dark-300 mb-2">Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              >
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <div className="mb-6 p-4 bg-dark-800 rounded-lg">
              <h4 className="font-medium mb-2">Agents to be created:</h4>
              <ul className="text-sm text-dark-300 space-y-1">
                {['Thinking', 'Investigation', 'Proposition', 'Planning', 'Implementation', 'Testing', 'Verification', 'Evaluation', 'Grading'].map((name) => (
                  <li key={name}>• {name} Agent</li>
                ))}
              </ul>
              <p className="text-xs text-dark-400 mt-3">Provider: {PROVIDERS.find(p => p.value === provider)?.label}</p>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep('provider')}
                className="flex-1 py-2 px-4 bg-dark-700 hover:bg-dark-600 rounded-lg font-medium transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleCreateProviderAndAgents}
                disabled={loading}
                className="flex-1 py-2 px-4 bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 rounded-lg font-medium transition-colors"
              >
                {loading ? 'Creating...' : 'Create All Agents'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
