import { prisma } from './prisma'
import { buildCurlDownloadInvocation, buildSnapshotDownloadInvocation, isHuggingFaceRepoUrl, modelIdFromHuggingFaceRepoUrl } from './huggingface-utils'
import { redactSecrets } from './secret-redaction'
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
  let filePath = path.join(getSpaceCacheDir(spaceId), fileName)
  let fileSize = 0
  let checksum: string | null = null

  // Create the DB row before any network work so callers can poll DOWNLOADING/FAILED/COMPLETED.
  const entry = await prisma.modelCache.create({
    data: {
      spaceId,
      fileName,
      filePath,
      fileSize: 0,
      downloadUrl: downloadUrl || null,
      checksum: null,
      description: description || null,
      status: downloadUrl ? 'DOWNLOADING' : 'COMPLETED',
    },
  })

  try {
    if (downloadUrl) {
      const { execFileSync } = require('child_process')
      const isHfUrl = downloadUrl.includes('huggingface.co')
      const hfToken = isHfUrl ? await getHfToken() : ''

      // HuggingFace model repo URL (https://huggingface.co/owner/model): download the full snapshot
      // and persist the actual loadable snapshot path, not an invented cache path.
      const isModelId = isHfUrl && isHuggingFaceRepoUrl(downloadUrl)

      if (isModelId) {
        const modelId = modelIdFromHuggingFaceRepoUrl(downloadUrl)
        const spaceDir = getSpaceCacheDir(spaceId)
        if (!fs.existsSync(spaceDir)) fs.mkdirSync(spaceDir, { recursive: true })
        const invocation = buildSnapshotDownloadInvocation(modelId, spaceDir, hfToken)
        const output = execFileSync(invocation.command, invocation.args, {
          stdio: 'pipe',
          timeout: 300000,
          env: { ...process.env, ...invocation.env },
        }).toString().trim()
        const cachedPath = output.split('\n').pop()?.trim()
        if (!cachedPath) throw new Error(`snapshot_download produced no path for ${modelId}`)
        filePath = cachedPath
        fileSize = 1 // model repo; actual aggregate size is expensive to compute and not needed for loading
        console.log(`[ModelCache] Downloaded model ${modelId} to ${cachedPath}`)
      } else {
        const invocation = buildCurlDownloadInvocation(downloadUrl, filePath, hfToken)
        execFileSync(invocation.command, invocation.args, {
          stdio: 'pipe',
          timeout: 300000,
          env: { ...process.env, ...invocation.env },
        })
        if (!fs.existsSync(filePath)) throw new Error(`download did not create ${filePath}`)
        const stats = fs.statSync(filePath)
        fileSize = stats.size
      }
    }

    // Calculate checksum if file exists and is a file (not a directory/model repo)
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      const fileBuffer = fs.readFileSync(filePath)
      checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex')

      if (expectedChecksum && checksum !== expectedChecksum) {
        fs.unlinkSync(filePath)
        throw new Error(`Checksum mismatch for ${fileName}: expected ${expectedChecksum}, got ${checksum}`)
      }
    }

    await prisma.modelCache.update({
      where: { id: entry.id },
      data: { filePath, fileSize, checksum, status: 'COMPLETED' },
    })

    return {
      ...entry,
      filePath,
      fileSize,
      checksum,
      status: 'COMPLETED' as const,
    }
  } catch (err) {
    const redactedError = redactSecrets(err)
    console.error(`[ModelCache] Download failed for ${downloadUrl}: ${redactedError}`)
    try {
      await prisma.modelCache.update({ where: { id: entry.id }, data: { status: 'FAILED' } })
    } catch {}
    throw new Error(`Failed to download from ${downloadUrl}: ${redactedError}`)
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
