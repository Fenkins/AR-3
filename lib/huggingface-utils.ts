export interface CacheDownloadSpec {
  fileName: string
  downloadUrl: string
  description: string
}

export interface ProcessInvocation {
  command: string
  args: string[]
  env: Record<string, string>
}

const HF_REPO_ID = '[a-zA-Z0-9][a-zA-Z0-9_.-]{1,50}/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}'
const HF_URL_RE = new RegExp(`https?:\\/\\/(?:www\\.)?huggingface\\.co\\/(${HF_REPO_ID})(?:\\/[^\\s)\\]}>"']*)?`, 'g')
const BARE_MODEL_ID_RE = new RegExp(`\\b(${HF_REPO_ID})\\b`, 'g')

function normalizeHfUrl(url: string): string {
  return url.replace(/^https?:\/\/(?:www\.)?huggingface\.co\//, 'https://huggingface.co/')
}

function repoUrl(modelId: string): string {
  return `https://huggingface.co/${modelId}`
}

function isShardedModelFile(url: string): boolean {
  return /\/[^/]+-\d{5}-of-\d{5}\.safetensors(?:\?|$)/.test(url)
}

function addDownload(downloads: CacheDownloadSpec[], seen: Set<string>, spec: CacheDownloadSpec): void {
  if (seen.has(spec.downloadUrl)) return
  seen.add(spec.downloadUrl)
  downloads.push(spec)
}

/**
 * Parse machine/actionable HuggingFace downloads from an LLM-provided downloads section.
 *
 * Critical guardrail: bare model-id parsing is run only on text with full URLs removed,
 * so path fragments like "LLaDA-8B-Base/resolve" or "main/model.safetensors" from
 * https://huggingface.co/owner/model/resolve/main/file are never treated as repos.
 */
export function parseHuggingFaceDownloads(text: string, limit = 5): CacheDownloadSpec[] {
  const downloads: CacheDownloadSpec[] = []
  const seen = new Set<string>()
  const urlSpans: Array<[number, number]> = []

  for (const match of Array.from(text.matchAll(HF_URL_RE))) {
    const rawUrl = normalizeHfUrl(match[0].replace(/[.,;:]+$/, ''))
    const modelId = match[1]
    urlSpans.push([match.index || 0, (match.index || 0) + match[0].length])

    if (isShardedModelFile(rawUrl)) {
      addDownload(downloads, seen, {
        fileName: modelId.replace('/', '_'),
        downloadUrl: repoUrl(modelId),
        description: `${modelId} snapshot`,
      })
    } else if (rawUrl.includes('/resolve/') || rawUrl.includes('/blob/')) {
      const label = rawUrl.split('/').pop() || modelId.replace('/', '_')
      addDownload(downloads, seen, { fileName: label, downloadUrl: rawUrl, description: label })
    } else {
      addDownload(downloads, seen, { fileName: modelId.replace('/', '_'), downloadUrl: repoUrl(modelId), description: modelId })
    }

    if (downloads.length >= limit) return downloads.slice(0, limit)
  }

  const chars = text.split('')
  for (const [start, end] of urlSpans) {
    for (let i = start; i < end; i++) chars[i] = ' '
  }
  const textWithoutUrls = chars.join('')

  for (const match of Array.from(textWithoutUrls.matchAll(BARE_MODEL_ID_RE))) {
    const modelId = match[1]
    const lower = modelId.toLowerCase()
    if (lower.includes('resolve') || lower.includes('blob') || lower.startsWith('main/')) continue
    addDownload(downloads, seen, {
      fileName: modelId.split('/').pop() || modelId.replace('/', '_'),
      downloadUrl: repoUrl(modelId),
      description: modelId,
    })
    if (downloads.length >= limit) break
  }

  return downloads.slice(0, limit)
}

export function isHuggingFaceRepoUrl(downloadUrl: string): boolean {
  return /https?:\/\/(?:www\.)?huggingface\.co\/[a-zA-Z0-9][a-zA-Z0-9_.-]{1,50}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\/?$/.test(downloadUrl)
}

export function modelIdFromHuggingFaceRepoUrl(downloadUrl: string): string {
  return normalizeHfUrl(downloadUrl).replace('https://huggingface.co/', '').replace(/\/$/, '')
}

export function buildSnapshotDownloadInvocation(modelId: string, cacheDir: string, hfToken = ''): ProcessInvocation {
  const env: Record<string, string> = { HF_HUB_CACHE: cacheDir }
  if (hfToken) env.HF_TOKEN = hfToken
  return {
    command: 'python3',
    args: [
      '-c',
      'from huggingface_hub import snapshot_download; import sys; print(snapshot_download(repo_id=sys.argv[1], local_files_only=False))',
      modelId,
    ],
    env,
  }
}

export function buildCurlDownloadInvocation(downloadUrl: string, outputPath: string, hfToken = ''): ProcessInvocation {
  const args = ['-L']
  if (hfToken) args.push('-H', `Authorization: Bearer ${hfToken}`)
  args.push('-o', outputPath, downloadUrl)
  return { command: 'curl', args, env: {} }
}
