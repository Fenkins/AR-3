export interface ThinkingSetupResponse {
  content: string
  tokensUsed: number
  cost: number
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = String(value || '').replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength - 1) + '…' : singleLine
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'unknown error')
  return truncateSingleLine(raw, 180)
}

export function buildFallbackThinkingSetupResponse(
  researchGoal: string,
  error: unknown
): ThinkingSetupResponse {
  const goal = truncateSingleLine(researchGoal, 420)
  const reason = safeErrorMessage(error)
  const focusHint = /ode|differential|trajectory|latent/i.test(goal)
    ? 'Focus on ODE/trajectory structure, measurable dynamics, and GPU-verifiable numerical evidence.'
    : 'Focus on concrete hypotheses, measurable outputs, and GPU-verifiable evidence.'

  return {
    tokensUsed: 0,
    cost: 0,
    content: [
      'Using deterministic fallback setup because the thinking-model setup call failed.',
      `Failure reason: ${reason}.`,
      `Research goal: ${goal || 'No research goal provided.'}`,
      'Recommended stages: Investigation, Proposition, Planning, Implementation, Testing, Verification, Evaluation.',
      focusHint,
      'Estimated complexity: complex; proceed with the full all-stage pipeline and generate variants lazily during execution.',
    ].join(' '),
  }
}
