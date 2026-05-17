const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com'
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required for seeding the admin user')
  }

  // Create admin user - use updateExisting to preserve existing data
  const hashedPassword = await bcrypt.hash(adminPassword, 12)
  
  // Use update to preserve existing user's agents, providers, spaces
  // Only create if email doesn't exist
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      // Don't update - preserve existing user's data
    },
    create: {
      email: adminEmail,
      password: hashedPassword,
      username: 'admin',
      role: 'ADMIN',
      isActive: true,
    },
  })

  console.log('Admin user ready:', admin.email)

  // Set default config
  await prisma.systemConfig.upsert({
    where: { key: 'REGISTRATION_ENABLED' },
    update: {},
    create: {
      key: 'REGISTRATION_ENABLED',
      value: 'true',
      description: 'Allow new user registration',
    },
  })

  console.log('Database seed complete!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
