const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function seed() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required for seeding the admin user');
  }

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      password: bcrypt.hashSync(adminPassword, 10),
      username: 'admin',
      role: 'ADMIN'
    }
  });
  console.log('Admin seeded:', admin.email);
  await prisma.user.disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
