/**
 * Custom Next.js server with schema validation at startup.
 * 
 * This replaces the standard `npm start` to ensure the Prisma client
 * is validated BEFORE the first request is handled.
 * 
 * Usage: npx ts-node --esm server.ts
 * Or compiled: node dist/server.js
 */

import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { PrismaClient } from './node_modules/.prisma/client'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()
const port = parseInt(process.env.PORT || '3000', 10)

// Validate Prisma schema before starting server
async function validateAndStart() {
  console.log('[Startup] Initializing Prisma client...')
  const prisma = new PrismaClient()
  
  try {
    // Quick connectivity check
    await prisma.$connect()
    console.log('[Startup] DB connected successfully')
    
    // Schema validation
    console.log('[Startup] Validating Prisma schema...')
    const errors: string[] = []
    
    // Test 1: Variant.failureMode field (key field added in schema upgrade)
    try {
      await prisma.variant.findFirst({
        select: { id: true, failureMode: true, approachVerdict: true, gradingWarning: true }
      })
      console.log('[Startup] ✓ Variant.failureMode field recognized')
    } catch (e: any) {
      if (e.message?.includes('Unknown argument')) {
        errors.push(`FAIL: Prisma client missing 'failureMode' on Variant. Server restart required.`)
      }
    }
    
    // Test 2: Variant.VariantStep relation (Prisma 5.x uses PascalCase)
    try {
      await prisma.variant.findFirst({
        include: { VariantStep: { take: 1 } }
      })
      console.log('[Startup] ✓ Variant.VariantStep relation recognized')
    } catch (e: any) {
      if (e.message?.includes('Unknown argument') && e.message?.includes('VariantStep')) {
        errors.push(`FAIL: Prisma client uses 'steps' instead of 'VariantStep'. Schema drift.`)
      } else if (!e.message?.includes('does not exist')) {
        // Table might be empty - that's OK
        console.log('[Startup] ✓ Variant.VariantStep relation queryable (table may be empty)')
      }
    }
    
    // Test 3: Experiment.cycleNumber
    try {
      await prisma.experiment.findFirst({
        select: { id: true, cycleNumber: true }
      })
      console.log('[Startup] ✓ Experiment.cycleNumber field recognized')
    } catch (e: any) {
      if (e.message?.includes('Unknown argument')) {
        errors.push(`FAIL: Prisma client missing 'cycleNumber' on Experiment.`)
      }
    }
    
    // Test 4: Agent.cyclePromptDelta
    try {
      await prisma.agent.findFirst({
        select: { id: true, cyclePromptDelta: true }
      })
      console.log('[Startup] ✓ Agent.cyclePromptDelta field recognized')
    } catch (e: any) {
      if (e.message?.includes('Unknown argument')) {
        errors.push(`FAIL: Prisma client missing 'cyclePromptDelta' on Agent.`)
      }
    }
    
    await prisma.$disconnect()
    
    if (errors.length > 0) {
      console.error('\n[Startup] SCHEMA VALIDATION FAILED:')
      for (const err of errors) console.error('  ' + err)
      console.error('\n[Startup] FIX: Run the following commands then restart:')
      console.error('  cd /opt/AR-3-fresh && npx prisma generate')
      console.error('  killall node')
      console.error('  nohup npm start > /tmp/nextjs.log 2>&1 &')
      console.error('')
      process.exit(1)
    }
    
    console.log('[Startup] ✓ Schema validation passed')
    console.log('[Startup] Starting Next.js server...\n')
    
  } catch (e: any) {
    console.error('[Startup] FATAL: Could not initialize Prisma:', e.message)
    process.exit(1)
  }
  
  // Start Next.js
  app.prepare().then(() => {
    createServer((req, res) => {
      const parsedUrl = parse(req.url!, true)
      handle(req, res, parsedUrl)
    }).listen(port, () => {
      console.log(`[Server] Running on http://localhost:${port}`)
    })
  })
}

validateAndStart()
