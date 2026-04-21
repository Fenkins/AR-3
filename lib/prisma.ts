import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/**
 * Schema validation at startup.
 * 
 * Prisma 5.x caches the client schema in the server process heap at startup.
 * Changes to schema.prisma + `prisma generate` don't reload the running server.
 * This validation fails fast if the cached client doesn't match the on-disk schema.
 */
export async function validatePrismaSchema(): Promise<{
  valid: boolean
  errors: string[]
}> {
  const errors: string[] = []
  
  // Test 1: Variant.failureMode (key field from schema upgrade)
  try {
    await prisma.variant.findFirst({
      select: { id: true, failureMode: true, approachVerdict: true, gradingWarning: true }
    })
  } catch (e: any) {
    if (e.message?.includes('Unknown argument')) {
      errors.push("missing 'failureMode' on Variant — restart server after prisma generate")
    }
  }
  
  // Test 2: Variant.VariantStep relation (Prisma 5.x PascalCase)
  try {
    await prisma.variant.findFirst({
      include: { VariantStep: { take: 1 } }
    })
  } catch (e: any) {
    if (e.message?.includes('Unknown argument') && e.message?.includes('VariantStep')) {
      errors.push("uses 'steps' instead of 'VariantStep' — restart server after prisma generate")
    }
  }
  
  // Test 3: Experiment.cycleNumber
  try {
    await prisma.experiment.findFirst({ select: { id: true, cycleNumber: true } })
  } catch (e: any) {
    if (e.message?.includes('Unknown argument')) {
      errors.push("missing 'cycleNumber' on Experiment")
    }
  }
  
  // Test 4: Agent.cyclePromptDelta
  try {
    await prisma.agent.findFirst({ select: { id: true, cyclePromptDelta: true } })
  } catch (e: any) {
    if (e.message?.includes('Unknown argument')) {
      errors.push("missing 'cyclePromptDelta' on Agent")
    }
  }
  
  return { valid: errors.length === 0, errors }
}

// Run validation once at module load (server startup)
if (process.env.NODE_ENV === 'production' || process.env.SCHEMA_VALIDATION === 'always') {
  validatePrismaSchema().then(({ valid, errors }) => {
    if (!valid) {
      console.error('[PrismaSchema] VALIDATION FAILED — server will likely crash on first request:')
      errors.forEach(e => console.error('  - ' + e))
      console.error('[PrismaSchema] FIX: killall node; cd /opt/AR-3-fresh && npx prisma generate && nohup npm start > /tmp/nextjs.log 2>&1 &')
    } else {
      console.log('[PrismaSchema] Validation passed')
    }
  }).catch(() => {})
}
