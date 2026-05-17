const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const exp = await prisma.experiment.findFirst({
    where: { phase: 'IMPLEMENTATION' },
    orderBy: { createdAt: 'desc' }
  });
  if (exp) {
    console.log('Phase:', exp.phase);
    console.log('Prompt:', exp.prompt ? exp.prompt.substring(0, 1000) : 'NULL');
  } else {
    console.log('No IMPLEMENTATION experiment found');
    const allPhases = await prisma.experiment.findMany({ select: { phase: true }, distinct: ['phase'], take: 20 });
    console.log('Available phases:', allPhases.map(e => e.phase));
  }
  await prisma.$disconnect();
}
main().catch(console.error);
