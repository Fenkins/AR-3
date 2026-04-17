import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

export interface AIConfig {
  provider: string
  apiKey: string
  model: string
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIResponse {
  content: string
  tokensUsed: number
  cost: number
}

export async function callAI(config: AIConfig, messages: AIMessage[]): Promise<AIResponse> {
  switch (config.provider.toLowerCase()) {
    case 'openai':
      return callOpenAI(config, messages)
    case 'anthropic':
      return callAnthropic(config, messages)
    case 'google':
      return callGoogle(config, messages)
    case 'openrouter':
      return callOpenRouter(config, messages)
    case 'minimax':
      return callMiniMax(config, messages)
    default:
      throw new Error(`Unsupported provider: ${config.provider}`)
  }
}

async function callOpenAI(config: AIConfig, messages: AIMessage[]): Promise<AIResponse> {
  const openai = new OpenAI({ apiKey: config.apiKey })
  
  const completion = await openai.chat.completions.create({
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature: 0.7,
  })

  const content = completion.choices[0]?.message?.content || ''
  const tokensUsed = completion.usage?.total_tokens || 0
  const cost = estimateCost(config.provider, config.model, tokensUsed)

  return { content: stripThinkingTags(content), tokensUsed, cost }
}

async function callAnthropic(config: AIConfig, messages: AIMessage[]): Promise<AIResponse> {
  const anthropic = new Anthropic({ apiKey: config.apiKey })
  
  const systemMessage = messages.find(m => m.role === 'system')
  const userMessages = messages.filter(m => m.role !== 'system')

  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: 4000,
    system: systemMessage?.content,
    messages: userMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }))
  })

  const content = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
  const cost = estimateCost(config.provider, config.model, tokensUsed)

  return { content, tokensUsed, cost }
}

async function callGoogle(config: AIConfig, messages: AIMessage[]): Promise<AIResponse> {
  const genAI = new GoogleGenerativeAI(config.apiKey)
  const model = genAI.getGenerativeModel({ model: config.model })

  const systemMessage = messages.find(m => m.role === 'system')
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()

  const chat = model.startChat({
    systemInstruction: systemMessage?.content,
  })

  const result = await chat.sendMessage(lastUserMessage?.content || '')
  const content = result.response.text()
  const tokensUsed = Math.ceil(content.length / 4) // Estimate
  const cost = estimateCost(config.provider, config.model, tokensUsed)

  return { content, tokensUsed, cost }
}

async function callOpenRouter(config: AIConfig, messages: AIMessage[]): Promise<AIResponse> {
  const openai = new OpenAI({
    apiKey: config.apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
  })

  const completion = await openai.chat.completions.create({
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature: 0.7,
  })

  const content = completion.choices[0]?.message?.content || ''
  const tokensUsed = completion.usage?.total_tokens || 0
  const cost = estimateCost(config.provider, config.model, tokensUsed)

  return { content, tokensUsed, cost }
}

async function callMiniMax(config: AIConfig, messages: AIMessage[]): Promise<AIResponse> {
  // MiniMax uses OpenAI-compatible API
  // Use global endpoint (api.minimax.io) for international keys
  const openai = new OpenAI({
    apiKey: config.apiKey,
    baseURL: 'https://api.minimax.io/v1',
    timeout: 180000, // 180 second timeout - MiniMax can be slow, especially with long responses
    maxRetries: 1,   // Only 1 retry - fail fast, don't multiply wait time
  })

  console.log('[MiniMax] Making API call with:', { model: config.model, messageCount: messages.length })
  console.log('[MiniMax] Using API key prefix:', config.apiKey.substring(0, 10) + '...')
  console.log('[MiniMax] Endpoint:', openai.baseURL)

  let completion
  try {
    console.log('[MiniMax] Sending request...')
    completion = await openai.chat.completions.create({
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: 4000,  // Cap response to keep context window manageable
      temperature: 0.7,
      stream: false,
    })
    console.log('[MiniMax] Response received, choices:', completion.choices?.length)
  } catch (error: any) {
    console.error('[MiniMax] API call failed:', error?.message || error)
    console.error('[MiniMax] Response:', error?.response?.data || 'No response data')
    throw error
  }

  const content = completion.choices[0]?.message?.content || ''
  console.log('[MiniMax] Raw content preview:', content.substring(0, 100))
  const tokensUsed = completion.usage?.total_tokens || 0
  const cost = estimateCost(config.provider, config.model, tokensUsed)

  return { content, tokensUsed, cost }
}

function stripThinkingTags(text: string): string {
  if (!text) return text
  return text
    .replace(/<(?:think|thought|thinking|reflect|introspect|reasoning|analysis|commentary|notes|scratchpad|memo|submission|working|observation|findings|details|result|output|step|summary|explain|interpretation)[^>]*>[\s\S]*?<\/(?:think|thought|thinking|reflect|introspect|reasoning|analysis|commentary|notes|scratchpad|memo|submission|working|observation|findings|details|result|output|step|summary|explain|interpretation)>/gi, '')
    .replace(/<[^<>]+>([\s\S]*?)<\/[\w-]+>/gi, '$1')
    .replace(/\[(?:t|q|r|n|c|d|p|fn|fd|cd|bd|md|rd|nd|pd|td)\]/gi, '')
    .replace(/\s*\n{2,}\s*/g, '\n\n')
    .trim()
}

function estimateCost(provider: string, model: string, tokens: number): number {
  // Rough cost estimates per 1K tokens
  const costs: Record<string, number> = {
    'openai-gpt-4': 0.03,
    'openai-gpt-3.5': 0.002,
    'anthropic-claude': 0.008,
    'google-gemini': 0.00025,
    'openrouter': 0.01,
    'minimax': 0.005,
  }

  const baseCost = costs[provider.toLowerCase()] || 0.01
  return (tokens / 1000) * baseCost
}

export async function fetchModels(provider: string, apiKey: string): Promise<string[]> {
  try {
    switch (provider.toLowerCase()) {
      case 'openai': {
        const openai = new OpenAI({ apiKey })
        const models = await openai.models.list()
        return models.data
          .filter(m => m.id.includes('gpt'))
          .map(m => m.id)
          .sort()
      }
      case 'anthropic': {
        // Anthropic has a fixed set of models
        return [
          'claude-3-opus-20240229',
          'claude-3-sonnet-20240229',
          'claude-3-haiku-20240307',
          'claude-2.1',
        ]
      }
      case 'google': {
        return [
          'gemini-pro',
          'gemini-1.5-pro',
          'gemini-1.5-flash',
        ]
      }
      case 'openrouter': {
        const openai = new OpenAI({
          apiKey,
          baseURL: 'https://openrouter.ai/api/v1',
        })
        const models = await openai.models.list()
        return models.data.map(m => m.id).sort()
      }
      case 'minimax': {
        // MiniMax Global API models
        return [
          'MiniMax-M2.7',
          'MiniMax-M2.7-highspeed',
          'MiniMax-M2.5',
          'MiniMax-M2.5-highspeed',
          'MiniMax-M2',
          'MiniMax-M2-her',
        ]
      }
      default:
        return []
    }
  } catch (error) {
    console.error('Error fetching models:', error)
    return []
  }
}
