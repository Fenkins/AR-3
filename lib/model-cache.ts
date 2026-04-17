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
    // Use wget or curl to download
    const { execSync } = require('child_process')
    try {
      execSync(`curl -L -o "${filePath}" "${downloadUrl}" 2>/dev/null`, { stdio: 'pipe' })
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath)
        fileSize = stats.size
      }
    } catch (err) {
      console.error(`[ModelCache] Download failed for ${downloadUrl}:`, err)
      throw new Error(`Failed to download from ${downloadUrl}`)
    }
  }
  
  // Calculate checksum if file exists
  let checksum: string | null = null
  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath)
    checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex')
    
    if (expectedChecksum && checksum !== expectedChecksum) {
      fs.unlinkSync(filePath)
      throw new Error(`Checksum mismatch for ${fileName}: expected ${expectedChecksum}, got ${checksum}`)
    }
  }
  
  // Save to database
  const entry = await prisma.modelCache.create({
    data: {
      spaceId,
      fileName,
      filePath,
      fileSize: fileSize,
      downloadUrl: downloadUrl || null,
      checksum,
      description: description || null,
    },
  })
  
  return {
    ...entry,
    fileSize: Number(entry.fileSize),
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
