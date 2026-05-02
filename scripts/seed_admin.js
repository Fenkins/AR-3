const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function seed() {
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      password: bcrypt.hashSync('jkp93p', 10),
      username: 'admin',
      role: 'ADMIN'
    }
  });
  console.log('Admin seeded:', admin.email);
  await prisma.user.disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
