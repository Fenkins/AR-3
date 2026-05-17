const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const count = await prisma.experiment.count();
  const spaces = await prisma.space.findMany({ where: { status: 'RUNNING' }, include: { experiments: { select: { id: true } } } });
  for (const s of spaces) {
    console.log(s.name + ' | ' + s.experiments.length + ' exps | ' + s.totalTokens + ' tokens');
  }
  console.log('Total experiments:', count);
  await prisma.$disconnect();
}
main().catch(console.error);
