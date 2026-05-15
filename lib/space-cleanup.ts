import * as fs from 'fs'
import * as path from 'path'

export interface SpaceWorkbenchCleanupResult {
  root: string
  removed: string[]
  skipped: string[]
  errors: Array<{ path: string; error: string }>
}

function isSafeSpaceWorkbenchName(name: string, spaceId: string): boolean {
  if (!spaceId || spaceId.includes('/') || spaceId.includes('..')) return false
  if (name === spaceId) return true
  return name.startsWith(`${spaceId}-`)
}

export function removeSpaceWorkbenchDirs(
  spaceId: string,
  root = process.env.AR3_WORKBENCH_ROOT || '/tmp/ar3-workbenches'
): SpaceWorkbenchCleanupResult {
  const result: SpaceWorkbenchCleanupResult = { root, removed: [], skipped: [], errors: [] }

  if (!spaceId || spaceId.includes('/') || spaceId.includes('..')) {
    throw new Error(`Unsafe spaceId for workbench cleanup: ${spaceId}`)
  }

  if (!fs.existsSync(root)) return result

  const rootReal = fs.realpathSync(root)
  for (const entry of fs.readdirSync(rootReal, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!isSafeSpaceWorkbenchName(entry.name, spaceId)) {
      result.skipped.push(path.join(rootReal, entry.name))
      continue
    }

    const target = path.join(rootReal, entry.name)
    const targetReal = fs.realpathSync(target)
    if (!targetReal.startsWith(rootReal + path.sep)) {
      result.errors.push({ path: target, error: 'Refusing to remove path outside workbench root' })
      continue
    }

    try {
      fs.rmSync(targetReal, { recursive: true, force: true })
      result.removed.push(targetReal)
    } catch (error: any) {
      result.errors.push({ path: targetReal, error: error?.message || String(error) })
    }
  }

  return result
}
