const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // Create admin user - use updateExisting to preserve existing data
  const hashedPassword = await bcrypt.hash('jkp93p', 12)
  
  // Use update to preserve existing user's agents, providers, spaces
  // Only create if email doesn't exist
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {
      // Don't update - preserve existing user's data
    },
    create: {
      email: 'admin@example.com',
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