function normalizeHttpBase(value: string | undefined | null): string | null {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function isLocalHttpBase(value: string): boolean {
  try {
    const parsed = new URL(value)
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(parsed.hostname)
  } catch {
    return false
  }
}

export function getInternalGpuApiBase(): string {
  const explicit = normalizeHttpBase(process.env.AR3_INTERNAL_API_BASE)
  if (explicit) return explicit

  const nextauth = normalizeHttpBase(process.env.NEXTAUTH_URL)
  if (nextauth && isLocalHttpBase(nextauth)) return nextauth

  const port = String(process.env.PORT || '3000').trim() || '3000'
  const safePort = /^\d{2,5}$/.test(port) ? port : '3000'
  return `http://127.0.0.1:${safePort}`
}
