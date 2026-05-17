const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function check() {
  const spaces = await prisma.space.findMany({ orderBy: { createdAt: 'desc' } })
  console.log('=== Spaces ===')
  console.log(spaces.length === 0 ? 'NONE (good)' : spaces.map(s => s.id + ' | ' + s.name + ' | ' + s.status).join('\n'))

  const experiments = await prisma.experiment.findMany({ orderBy: { createdAt: 'desc' } })
  console.log('\n=== Experiments ===')
  console.log(experiments.length === 0 ? 'NONE (good)' : experiments.length + ' found')

  const variants = await prisma.variant.findMany({ orderBy: { createdAt: 'desc' } })
  console.log('\n=== Variants ===')
  console.log(variants.length === 0 ? 'NONE (good)' : variants.length + ' found')

  const breakthroughs = await prisma.breakthrough.findMany({ orderBy: { createdAt: 'desc' } })
  console.log('\n=== Breakthroughs ===')
  console.log(breakthroughs.length === 0 ? 'NONE (good)' : breakthroughs.length + ' found')

  const jobs = await prisma.gPUJob.findMany({ orderBy: { createdAt: 'desc' } })
  console.log('\n=== GPU Jobs ===')
  console.log(jobs.length === 0 ? 'NONE (good)' : jobs.length + ' found')

  await prisma.$disconnect()
}
check().catch(console.error)
