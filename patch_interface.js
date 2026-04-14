const fs = require('fs');
const content = fs.readFileSync('/opt/AR-3/lib/research-engine.ts', 'utf8');
const old = `export interface SpaceExecutionState {
  spaceId: string
  isRunning: boolean
  isThinkingSetupRunning?: boolean  // guards against duplicate setup calls
  currentStageId: string
  currentPhase: string
  variants: Variant[]
  selectedVariantId?: string
  experiments: any[]
  lastUpdated: Date
}`;
const newBlock = `export interface SpaceExecutionState {
  spaceId: string
  isRunning: boolean
  isThinkingSetupRunning?: boolean  // guards against duplicate setup calls
  currentStageId: string
  currentPhase: string
  variants: Variant[]
  selectedVariantId?: string
  experiments: any[]
  lastUpdated: Date
  // Error tracking for timeout/failure visibility
  lastError?: string
  lastErrorTime?: Date
  lastErrorType?: 'TIMEOUT' | 'RATE_LIMIT' | 'API_ERROR' | 'OTHER'
  retryCount: number
  retryCountByStage: Record<string, number>
}`;
if (content.includes(old)) {
    fs.writeFileSync('/opt/AR-3/lib/research-engine.ts', content.replace(old, newBlock));
    console.log('Patched');
} else {
    console.log('Not found');
}
