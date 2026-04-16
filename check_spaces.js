const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const spaces = await prisma.space.findMany({ include: { experiments: true } });
  for (const s of spaces) {
    console.log(s.name, '|', s.status, '|', s.currentPhase, '|', s.totalTokens, 'tokens |', s.experiments.length, 'exps');
  }
  await prisma.$disconnect();
}
main().catch(console.error);
