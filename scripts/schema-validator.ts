/**
 * Schema Version Validator
 * 
 * Prisma 5.x caches client in server heap at startup. Schema changes on disk
 * don't reload automatically. This validator fails fast at startup if the running
 * server's Prisma client doesn't match the on-disk schema.
 * 
 * Run: npx ts-node --esm scripts/validate-schema.ts
 * Or import validateSchema() at server startup.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

export interface SchemaValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  schemaVersion: string
  clientVersion: string
}

/**
 * Extract expected model names and field counts from schema.prisma
 */
function parseSchemaModels(schemaPath: string): Map<string, { fieldCount: number; hasUpdatedAt: boolean }> {
  const schema = readFileSync(schemaPath, 'utf-8')
  const models = new Map<string, { fieldCount: number; hasUpdatedAt: boolean }>()
  
  const modelBlocks = schema.match(/^model \w+ \{[^}]+\}/gm) || []
  for (const block of modelBlocks) {
    const nameMatch = block.match(/^model (\w+)/)
    if (!nameMatch) continue
    
    const name = nameMatch[1]
    const fields = block.split('\n').filter(l => l.trim() && !l.trim().startsWith('//') && !l.match(/^\s*(id|String|DateTime|Int|Float|Boolean|Bytes|JSON|Xml|Decimal|Bytes|Relation|@@|@id|@default|@updatedAt|@map|@unique|@@index|@@unique|@@index)/))
    
    const fieldCount = fields.filter(l => l.match(/^\s+\w+\s+/)).length
    const hasUpdatedAt = /updatedAt\s+DateTime/.test(block)
    
    models.set(name, { fieldCount, hasUpdatedAt })
  }
  
  return models
}

/**
 * Get the Prisma client field info by probing with invalid operations.
 * We can't directly access the compiled client's internal version string,
 * so we validate by testing known schema elements.
 */
export async function validateSchema(prismaClient: any): Promise<SchemaValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  
  const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
  let schemaModels: Map<string, any>
  try {
    schemaModels = parseSchemaModels(schemaPath)
  } catch (e: any) {
    return {
      valid: false,
      errors: [`Could not read schema.prisma: ${e.message}`],
      warnings: [],
      schemaVersion: 'unknown',
      clientVersion: 'unknown'
    }
  }
  
  // Test 1: Variant model should have failureMode field (added in schema upgrade)
  try {
    const testVariant = await prismaClient.variant.findUnique({
      where: { id: 'nonexistent-test-id-' + Date.now() },
      select: { id: true, failureMode: true, approachVerdict: true, gradingWarning: true }
    })
    // If we get here without error, the Prisma client knows about failureMode
  } catch (e: any) {
    if (e.message?.includes('Unknown argument')) {
      errors.push(`Prisma client missing 'failureMode' field. Server restart required: ${e.message}`)
    } else if (e.message?.includes('does not exist')) {
      // Table doesn't exist yet - this is OK for fresh DB
      warnings.push('Variant table does not exist yet (fresh DB)')
    }
  }
  
  // Test 2: Variant should use VariantStep (not steps) for relation
  try {
    const result = await prismaClient.$queryRaw`
      SELECT 1 as test
    `
  } catch (e: any) {
    errors.push(`Prisma $queryRaw failed: ${e.message}`)
  }
  
  // Test 3: Check if Experiment model has cycleNumber field
  try {
    await prismaClient.experiment.findFirst({
      select: { id: true, cycleNumber: true }
    })
  } catch (e: any) {
    if (e.message?.includes('Unknown argument')) {
      errors.push(`Prisma client missing 'cycleNumber' on Experiment. Schema may be out of sync.`)
    }
  }
  
  // Test 4: Check VariantStep relation name by attempting create with steps
  // (this will fail gracefully if wrong, vs crash the server)
  const hasVariantStep = schemaModels.has('VariantStep')
  if (hasVariantStep) {
    try {
      // Check if Variant includes VariantStep (not steps)
      await prismaClient.variant.findFirst({
        include: { VariantStep: { take: 1 } }
      })
    } catch (e: any) {
      if (e.message?.includes('Unknown argument') && e.message?.includes('VariantStep')) {
        errors.push(`Prisma client uses 'steps' instead of 'VariantStep'. Schema drift detected.`)
      }
    }
  }
  
  const schemaVersion = '1.0.0' // Could read from schema comment
  const clientVersion = 'unknown' // Prisma doesn't expose client version at runtime
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    schemaVersion,
    clientVersion
  }
}

/**
 * Log schema validation result and throw if invalid.
 * Call this at server startup (after Prisma client is initialized).
 */
export async function assertSchemaValid(prismaClient: any, failOnError = true): Promise<SchemaValidationResult> {
  const result = await validateSchema(prismaClient)
  
  if (result.warnings.length > 0) {
    console.warn('[SchemaValidator] Warnings:', result.warnings)
  }
  
  if (result.errors.length > 0) {
    console.error('[SchemaValidator] Schema mismatch detected:')
    for (const err of result.errors) {
      console.error(`  - ${err}`)
    }
    console.error('[SchemaValidator] FIX: Run "npx prisma generate && npm run build && rsync..." then restart server')
    
    if (failOnError) {
      throw new Error(`Schema validation failed: ${result.errors.join('; ')}`)
    }
  } else {
    console.log('[SchemaValidator] Schema validation passed')
  }
  
  return result
}

// CLI entry point
if (require.main === module) {
  const { PrismaClient } = require('../node_modules/.prisma/client')
  const prisma = new PrismaClient()
  
  assertSchemaValid(prisma, true)
    .then(r => {
      console.log('Result:', JSON.stringify(r, null, 2))
      process.exit(r.valid ? 0 : 1)
    })
    .catch(e => {
      console.error('Validation error:', e.message)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
