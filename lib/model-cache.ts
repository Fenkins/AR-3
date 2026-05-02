import { prisma } from './prisma'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const CACHE_BASE_DIR = '/opt/AR-3/model_cache'

export interface CacheEntry {
  id: string
  spaceId: string
  fileName: string
  filePath: string
  fileSize: number
  downloadUrl?: string | null
  checksum?: string | null
  description?: string | null
  status: 'DOWNLOADING' | 'COMPLETED' | 'FAILED'
  createdAt: Date
}

export interface AddCacheOptions {
  spaceId: string
  fileName: string
  downloadUrl?: string
  description?: string
  expectedChecksum?: string
}

function getSpaceCacheDir(spaceId: string): string {
  return path.join(CACHE_BASE_DIR, spaceId)
}

/** Get HuggingFace token from SystemConfig (returns empty string if not set) */
export async function getHfToken(): Promise<string> {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'huggingface_token' },
    })
    return config?.value || ''
  } catch {
    return ''
  }
}

function ensureSpaceDir(spaceId: string): void {
  const dir = getSpaceCacheDir(spaceId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export async function addToCache(options: AddCacheOptions): Promise<CacheEntry> {
  const { spaceId, fileName, downloadUrl, description, expectedChecksum } = options
  
  ensureSpaceDir(spaceId)
  const filePath = path.join(getSpaceCacheDir(spaceId), fileName)
  
  let fileSize = 0
  
  // If downloadUrl provided, download the file
  if (downloadUrl) {
    const { execSync } = require('child_process')
    try {
      const isHfUrl = downloadUrl.includes('huggingface.co')
      const hfToken = isHfUrl ? await getHfToken() : ''

      // Check if this is a HuggingFace model ID (e.g. "gpt2", "llada-8b") vs a direct file URL
      const isModelId = isHfUrl && !downloadUrl.includes('/resolve/') && !downloadUrl.includes('/blob/')

      if (isModelId) {
        // Use huggingface_hub snapshot_download for full model repo download
        // Set HF_HUB_CACHE so download goes directly to our space cache
        const modelId = downloadUrl.replace('https://huggingface.co/', '')
        const spaceDir = getSpaceCacheDir(spaceId)
        if (!fs.existsSync(spaceDir)) fs.mkdirSync(spaceDir, { recursive: true })
        const tokenEnv = hfToken ? `HF_TOKEN=${hfToken}` : ''
        const cmd = `${tokenEnv} HF_HUB_CACHE=${spaceDir} python3 -c "
from huggingface_hub import snapshot_download
path = snapshot_download(repo_id='${modelId}', local_files_only=False)
print(path)
"`
        try {
          const output = execSync(cmd, { stdio: 'pipe', timeout: 300000 }).toString().trim()
          const cachedPath = output.split('\n').pop().trim()
          // cachedPath is like: /space_cache/models--Qwen--Qwen2.5-1.5B/snapshots/<hash>/
          // The model repo root (with config.json, model.safetensors) is:
          //   /space_cache/models--Qwen--Qwen2.5-1.5B/snapshots/<hash>/
          // We store this path as the "file path" so GPU code can load directly from it.
          // The structure mirrors standard HF cache: owner/model/snapshots/hash/ files
          const destModelDir = path.join(spaceDir, modelId.replace('/', '_'))
          if (!fs.existsSync(destModelDir)) {
            fs.mkdirSync(destModelDir, { recursive: true })
          }
          fileSize = 1  // Model repo — size tracked separately
          console.log(`[ModelCache] Downloaded model ${modelId} to ${cachedPath}`)
        } catch (err: any) {
          console.error(`[ModelCache] snapshot_download failed for ${modelId}:`, err.message)
          throw new Error(`Failed to download model ${modelId}: ${err.message}`)
        }
      } else {
        // Direct file URL — use curl with auth header
        const authHeader = hfToken ? `-H "Authorization: Bearer ${hfToken}"` : ''
        const cmd = `curl -L ${authHeader} -o "${filePath}" "${downloadUrl}" 2>/dev/null`
        execSync(cmd, { stdio: 'pipe', timeout: 300000 })
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath)
          fileSize = stats.size
        }
      }
    } catch (err) {
      console.error(`[ModelCache] Download failed for ${downloadUrl}:`, err)
      // Mark entry as FAILED in DB so polling can detect it
      try {
        await prisma.modelCache.update({ where: { id: entry.id }, data: { status: 'FAILED' } })
      } catch {}
      throw new Error(`Failed to download from ${downloadUrl}`)
    }
  }
  
  // Calculate checksum if file exists and is a file (not a directory/model repo)
  let checksum: string | null = null
  if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
    const fileBuffer = fs.readFileSync(filePath)
    checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex')

    if (expectedChecksum && checksum !== expectedChecksum) {
      fs.unlinkSync(filePath)
      throw new Error(`Checksum mismatch for ${fileName}: expected ${expectedChecksum}, got ${checksum}`)
    }
  }
  
  // Save to database with DOWNLOADING status
  const entry = await prisma.modelCache.create({
    data: {
      spaceId,
      fileName,
      filePath,
      fileSize: fileSize,
      downloadUrl: downloadUrl || null,
      checksum,
      description: description || null,
      status: 'DOWNLOADING',
    },
  })

  // Mark as COMPLETED after successful download (model repos skip the file existence check)
  const isModelRepo = downloadUrl?.includes('huggingface.co') && !downloadUrl.includes('/resolve/') && !downloadUrl.includes('/blob/')
  if (isModelRepo || (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory())) {
    await prisma.modelCache.update({ where: { id: entry.id }, data: { status: 'COMPLETED' } })
  }

  return {
    ...entry,
    fileSize: Number(entry.fileSize),
    status: 'COMPLETED' as const,
  }
}

export async function getSpaceCache(spaceId: string): Promise<CacheEntry[]> {
  const entries = await prisma.modelCache.findMany({
    where: { spaceId },
    orderBy: { createdAt: 'asc' },
  })
  
  return entries.map(e => ({
    ...e,
    fileSize: Number(e.fileSize),
    status: (e.status as 'DOWNLOADING' | 'COMPLETED' | 'FAILED') || 'DOWNLOADING',
  }))
}

export async function getSpaceCacheSize(spaceId: string): Promise<number> {
  const result = await prisma.modelCache.aggregate({
    where: { spaceId },
    _sum: { fileSize: true },
  })
  return Number(result._sum.fileSize || 0)
}

export async function removeFromCache(id: string): Promise<void> {
  const entry = await prisma.modelCache.findUnique({ where: { id } })
  if (!entry) return
  
  // Delete file from disk
  if (fs.existsSync(entry.filePath)) {
    fs.unlinkSync(entry.filePath)
  }
  
  // Delete from database
  await prisma.modelCache.delete({ where: { id } })
}

export async function clearSpaceCache(spaceId: string): Promise<void> {
  const entries = await prisma.modelCache.findMany({ where: { spaceId } })
  
  // Delete all files from disk
  for (const entry of entries) {
    if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath)
    }
  }
  
  // Remove space cache directory if empty
  const spaceDir = getSpaceCacheDir(spaceId)
  if (fs.existsSync(spaceDir)) {
    try {
      fs.rmdirSync(spaceDir)
    } catch {
      // Directory not empty, ignore
    }
  }
  
  // Delete from database
  await prisma.modelCache.deleteMany({ where: { spaceId } })
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}
