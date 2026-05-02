import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { addToCache, getSpaceCache, getSpaceCacheSize, removeFromCache, clearSpaceCache } from '@/lib/model-cache'

// GET: list cache entries for a space, or get total size
// Query params: spaceId (required), action (optional: 'size')
// Also supports polling: ?spaceId=X&checkUrls=url1,url2 (returns status for specific URLs)
export async function GET(request: NextRequest) {
  const auth = await authMiddleware(request)
  if ('json' in auth) return auth

  const { searchParams } = new URL(request.url)
  const spaceId = searchParams.get('spaceId')
  const action = searchParams.get('action')
  const checkUrls = searchParams.get('checkUrls') // comma-separated downloadUrls to poll

  if (!spaceId) {
    return NextResponse.json({ error: 'spaceId required' }, { status: 400 })
  }

  if (action === 'size') {
    const size = await getSpaceCacheSize(spaceId)
    return NextResponse.json({ spaceId, size })
  }

  const entries = await getSpaceCache(spaceId)

  // Polling mode: return status for specific URLs
  if (checkUrls) {
    const targetUrls = checkUrls.split(',').map(u => u.trim())
    const statusMap: Record<string, string> = {}
    for (const url of targetUrls) {
      const entry = entries.find(e => e.downloadUrl === url || e.fileName === url)
      statusMap[url] = entry ? (entry.status || 'DOWNLOADING') : 'NOT_FOUND'
    }
    return NextResponse.json({ spaceId, statuses: statusMap, entries })
  }

  return NextResponse.json({ spaceId, entries })
}

// POST: add a file/model to cache
export async function POST(request: NextRequest) {
  const auth = await authMiddleware(request)
  if ('json' in auth) return auth

  try {
    const body = await request.json()
    const { spaceId, fileName, downloadUrl, description, expectedChecksum } = body

    if (!spaceId || !fileName) {
      return NextResponse.json({ error: 'spaceId and fileName required' }, { status: 400 })
    }

    const entry = await addToCache({
      spaceId,
      fileName,
      downloadUrl,
      description,
      expectedChecksum,
    })

    return NextResponse.json({ entry }, { status: 201 })
  } catch (error: any) {
    console.error('[ModelCache] Error:', error)
    return NextResponse.json({ error: error.message || 'Failed to add to cache' }, { status: 500 })
  }
}

// DELETE: remove a specific entry or all entries for a space
export async function DELETE(request: NextRequest) {
  const auth = await authMiddleware(request)
  if ('json' in auth) return auth

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  const spaceId = searchParams.get('spaceId')

  if (!id && !spaceId) {
    return NextResponse.json({ error: 'id or spaceId required' }, { status: 400 })
  }

  try {
    if (id) {
      await removeFromCache(id)
      return NextResponse.json({ message: 'Entry removed' })
    } else if (spaceId) {
      await clearSpaceCache(spaceId)
      return NextResponse.json({ message: 'Space cache cleared' })
    }
  } catch (error: any) {
    console.error('[ModelCache] Delete error:', error)
    return NextResponse.json({ error: error.message || 'Failed to delete' }, { status: 500 })
  }
}
