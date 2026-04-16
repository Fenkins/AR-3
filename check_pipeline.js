const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const count = await prisma.experiment.count();
  console.log('Total experiments:', count);
  const spaces = await prisma.space.findMany({ where: { status: 'RUNNING' } });
  for (const s of spaces) {
    const expCount = await prisma.experiment.count({ where: { spaceId: s.id } });
    console.log(`${s.name} | ${s.status} | ${expCount} exps | tokens: ${s.totalTokens}`);
  }
  await prisma.$disconnect();
}
main().catch(console.error);
