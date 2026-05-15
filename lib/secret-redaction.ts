const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bhf_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b[a-f0-9]{64}\b/gi,
  /Authorization:\s*Bearer\s+[^\s'"]+/gi,
  /HF_TOKEN\s*=\s*[^\s'"]+/gi,
  /(api[_-]?key\s*[:=]\s*)[^\s'",}]+/gi,
]

function redactString(input: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => {
    if (pattern.source.startsWith('(api')) {
      return text.replace(pattern, '$1[REDACTED]')
    }
    if (pattern.source.startsWith('Authorization')) {
      return text.replace(pattern, 'Authorization: Bearer [REDACTED]')
    }
    if (pattern.source.startsWith('HF_TOKEN')) {
      return text.replace(pattern, 'HF_TOKEN=[REDACTED]')
    }
    return text.replace(pattern, '[REDACTED]')
  }, input)
}

export function redactSecrets(value: unknown): string {
  if (value instanceof Error) {
    const parts = [value.name, value.message, value.stack].filter(Boolean)
    return redactString(parts.join('\n'))
  }

  if (typeof value === 'string') return redactString(value)

  try {
    return redactString(JSON.stringify(value))
  } catch {
    return redactString(String(value))
  }
}
