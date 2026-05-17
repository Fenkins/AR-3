const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const phases = await prisma.experiment.groupBy({ by: ['phase'], _count: { phase: true } });
  console.log('Phases:', JSON.stringify(phases));
  const recent = await prisma.experiment.findFirst({ orderBy: { createdAt: 'desc' }, include: { space: true } });
  if (recent) {
    console.log('Most recent exp - phase:', recent.phase, 'space:', recent.space.name);
    console.log('Prompt:', recent.prompt ? recent.prompt.substring(0, 500) : 'NULL');
  }
  await prisma.$disconnect();
}
main().catch(console.error);
