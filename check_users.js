const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.user.findMany({ include: { serviceProviders: true } });
  for (const u of users) {
    console.log('User:', u.email, '| SPs:', u.serviceProviders.length, '| Default SP:', u.defaultServiceProviderId ? 'yes' : 'no');
  }
  await prisma.$disconnect();
}
main().catch(console.error);
