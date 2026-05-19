import { prisma } from './prisma'
import { buildCurlDownloadInvocation, buildSnapshotDownloadInvocation, isHuggingFaceRepoUrl, modelIdFromHuggingFaceRepoUrl } from './huggingface-utils'
import { redactSecrets } from './secret-redaction'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const CACHE_BASE_DIR = '/opt/AR-3/model_cache'
const PRISMA_INT_MAX = 2147483647

export function clampModelCacheFileSize(size: number | bigint | null | undefined): number {
  const numericSize = Number(size || 0)
  if (!Number.isFinite(numericSize) || numericSize <= 0) return 0
  return Math.min(Math.floor(numericSize), PRISMA_INT_MAX)
}

export async function repairOversizedModelCacheRows(): Promise<number> {
  try {
    return await prisma.$executeRawUnsafe(
      `UPDATE "ModelCache" SET "fileSize" = ${PRISMA_INT_MAX} WHERE "fileSize" > ${PRISMA_INT_MAX}`
    )
  } catch (err) {
    console.warn(`[ModelCache] Failed to repair oversized fileSize rows: ${redactSecrets(err)}`)
    return 0
  }
}

export async function repairInvalidModelCacheDateRows(): Promise<number> {
  try {
    const textRows = await prisma.$executeRawUnsafe(
      `UPDATE "ModelCache"
       SET "createdAt" = "createdAt" || 'Z'
       WHERE typeof("createdAt") = 'text'
         AND "createdAt" LIKE '____-__-__T__:__:__%'
         AND "createdAt" NOT LIKE '%Z'
         AND substr("createdAt", 20) NOT LIKE '%+%'
         AND substr("createdAt", 20) NOT LIKE '%-%'`
    )
    const integerRows = await prisma.$executeRawUnsafe(
      `UPDATE "ModelCache"
       SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt" / 1000.0, 'unixepoch')
       WHERE typeof("createdAt") = 'integer'`
    )
    return Number(textRows || 0) + Number(integerRows || 0)
  } catch (err) {
    console.warn(`[ModelCache] Failed to repair invalid createdAt rows: ${redactSecrets(err)}`)
    return 0
  }
}


export type SnapshotValidationResult = { ok: true } | { ok: false; reason: string }

function findIncompleteDownloads(root: string): string[] {
  const found: string[] = []
  if (!fs.existsSync(root)) return found
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile() && entry.name.endsWith('.incomplete')) found.push(child)
    }
  }
  visit(root)
  return found
}

export function validateLoadableSnapshotPath(filePath: string): SnapshotValidationResult {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'snapshot_path_missing' }
    const stat = fs.statSync(filePath)
    const incomplete = stat.isDirectory() ? findIncompleteDownloads(filePath) : []
    if (incomplete.length > 0) return { ok: false, reason: `incomplete_downloads=${incomplete.length}` }
    const indexPath = stat.isDirectory() ? path.join(filePath, 'model.safetensors.index.json') : ''
    if (!indexPath || !fs.existsSync(indexPath)) return { ok: true }
    let parsed: any
    try {
      parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    } catch {
      return { ok: false, reason: 'invalid_index=model.safetensors.index.json' }
    }
    const weightMap = parsed && typeof parsed === 'object' && parsed.weight_map && typeof parsed.weight_map === 'object'
      ? parsed.weight_map
      : {}
    const shards = Array.from(new Set(Object.values(weightMap).map(String).filter(Boolean)))
    const root = fs.realpathSync(filePath)
    const unsafe = shards.filter(shard => {
      if (path.isAbsolute(shard)) return true
      const resolved = path.resolve(filePath, shard)
      const relative = path.relative(root, resolved)
      return relative.startsWith('..') || path.isAbsolute(relative)
    })
    if (unsafe.length > 0) return { ok: false, reason: `unsafe_shard_path=${unsafe.slice(0, 5).join(', ')}` }
    const missing = shards.filter(shard => !fs.existsSync(path.join(filePath, shard)))
    if (missing.length > 0) return { ok: false, reason: `missing_shards=${missing.length}: ${missing.slice(0, 5).join(', ')}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `snapshot_validation_error=${redactSecrets(err)}` }
  }
}

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

export function getSpaceCacheDiskSize(spaceId: string): number {
  return getPathSizeBytes(getSpaceCacheDir(spaceId))
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

function getPathSizeBytes(filePath: string, seen = new Set<string>()): number {
  try {
    if (!fs.existsSync(filePath)) return 0
    const stats = fs.lstatSync(filePath)
    const inodeKey = `${stats.dev}:${stats.ino}`
    if (seen.has(inodeKey)) return 0
    seen.add(inodeKey)

    // Use allocated blocks instead of logical file size. HuggingFace caches use
    // symlinks and deduplicated blobs, so summing stat.size can report more
    // bytes than the disk actually has.
    if (!stats.isDirectory()) return (stats.blocks || 0) * 512

    let total = 0
    for (const entry of fs.readdirSync(filePath, { withFileTypes: true })) {
      total += getPathSizeBytes(path.join(filePath, entry.name), seen)
    }
    return total
  } catch {
    return 0
  }
}

export function getCacheEntrySizeBytes(entry: { filePath: string; fileSize: number | bigint }): number {
  const diskSize = getPathSizeBytes(entry.filePath)
  return diskSize > 0 ? diskSize : Number(entry.fileSize || 0)
}

export async function addToCache(options: AddCacheOptions): Promise<CacheEntry> {
  const { spaceId, fileName, downloadUrl, description, expectedChecksum } = options
  await repairOversizedModelCacheRows()
  await repairInvalidModelCacheDateRows()

  ensureSpaceDir(spaceId)
  let filePath = path.join(getSpaceCacheDir(spaceId), fileName)
  let fileSize = 0
  let checksum: string | null = null

  const existing = await prisma.modelCache.findFirst({
    where: {
      spaceId,
      fileName,
      downloadUrl: downloadUrl || null,
      status: 'COMPLETED',
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing && fs.existsSync(existing.filePath) && (downloadUrl || (expectedChecksum && existing.checksum === expectedChecksum))) {
    const actualSize = getPathSizeBytes(existing.filePath)
    const descriptionWithActualSize = actualSize > PRISMA_INT_MAX
      ? `${description || existing.description || ''}${description || existing.description ? '; ' : ''}actual_size_bytes=${actualSize}; fileSize capped at Prisma Int max when artifact exceeds 2GiB`
      : (description || existing.description || null)
    const refreshed = await prisma.modelCache.update({
      where: { id: existing.id },
      data: {
        filePath: existing.filePath,
        fileSize: clampModelCacheFileSize(actualSize || existing.fileSize),
        description: descriptionWithActualSize,
        status: 'COMPLETED',
      },
    })
    return {
      ...refreshed,
      fileSize: actualSize || Number(refreshed.fileSize),
      status: 'COMPLETED' as const,
    }
  }

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
        const invocation = buildSnapshotDownloadInvocation(modelId, filePath, hfToken)
        const output = execFileSync(invocation.command, invocation.args, {
          stdio: 'pipe',
          timeout: 300000,
          env: { ...process.env, ...invocation.env },
        }).toString().trim()
        const cachedPath = output.split('\n').pop()?.trim()
        if (!cachedPath) throw new Error(`snapshot_download produced no path for ${modelId}`)
        filePath = cachedPath
        fileSize = getPathSizeBytes(cachedPath)
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

    const snapshotValidation = validateLoadableSnapshotPath(filePath)
    if (!snapshotValidation.ok) {
      throw new Error(`Downloaded snapshot is not loadable: ${snapshotValidation.reason}`)
    }

    const descriptionWithActualSize = fileSize > PRISMA_INT_MAX
      ? `${description || ''}${description ? '; ' : ''}actual_size_bytes=${fileSize}; fileSize capped at Prisma Int max when artifact exceeds 2GiB`
      : (description || null)

    await prisma.modelCache.update({
      where: { id: entry.id },
      data: { filePath, fileSize: clampModelCacheFileSize(fileSize), checksum, description: descriptionWithActualSize, status: 'COMPLETED' },
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
  await repairOversizedModelCacheRows()
  await repairInvalidModelCacheDateRows()
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
  await repairOversizedModelCacheRows()
  await repairInvalidModelCacheDateRows()
  const entries = await prisma.modelCache.findMany({
    where: { spaceId, status: 'COMPLETED' },
    select: { filePath: true, fileSize: true },
  })
  const trackedSize = entries.reduce((total, entry) => total + getCacheEntrySizeBytes(entry), 0)
  return Math.max(trackedSize, getSpaceCacheDiskSize(spaceId))
}

export async function removeFromCache(id: string): Promise<void> {
  const entry = await prisma.modelCache.findUnique({ where: { id } })
  if (!entry) return
  
  // Delete file or downloaded snapshot directory from disk.
  if (fs.existsSync(entry.filePath)) {
    fs.rmSync(entry.filePath, { recursive: true, force: true })
  }
  
  // Delete from database
  await prisma.modelCache.delete({ where: { id } })
}

export async function clearSpaceCache(spaceId: string): Promise<void> {
  const entries = await prisma.modelCache.findMany({ where: { spaceId } })
  
  // Delete all files/snapshot directories from disk
  for (const entry of entries) {
    if (fs.existsSync(entry.filePath)) {
      fs.rmSync(entry.filePath, { recursive: true, force: true })
    }
  }
  
  // Remove space cache directory if empty
  const spaceDir = getSpaceCacheDir(spaceId)
  if (fs.existsSync(spaceDir)) {
    fs.rmSync(spaceDir, { recursive: true, force: true })
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
