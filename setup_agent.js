const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.findUnique({ where: { email: 'admin@example.com' } });
  if (!admin) { console.log('No admin user'); return; }
  console.log('Admin:', admin.email, 'id:', admin.id);

  // Check existing providers
  const existing = await prisma.serviceProvider.findMany({ where: { userId: admin.id } });
  console.log('Existing providers:', existing.length);
  for (const p of existing) console.log(' -', p.name, '|', p.provider);

  // Create MiniMax provider if none
  let provider = existing.find(p => p.provider === 'minimax');
  if (!provider) {
    provider = await prisma.serviceProvider.create({
      data: {
        userId: admin.id,
        name: 'MiniMax',
        provider: 'minimax',
        apiKey: 'sk-cp-yJytENTvc4E7bBHVllEOgEDqbL_s0QZHw13kK7esImaypXbFidGJUnmI0NkMSNkAnoz1Ba3dN8KeciQjPfHnjcB4RLPjadF1jjRy6Cn6lmjo65SQdZ7kNCc',
      }
    });
    console.log('Created provider:', provider.name, provider.provider);
  } else {
    console.log('Using existing provider:', provider.name);
  }

  // Create research agent if none
  const existingAgents = await prisma.agent.findMany({ where: { userId: admin.id } });
  if (existingAgents.length === 0) {
    const agent = await prisma.agent.create({
      data: {
        userId: admin.id,
        serviceProviderId: provider.id,
        name: 'Researcher',
        role: 'RESEARCHER',
        model: 'MiniMax-M2.7',
      }
    });
    console.log('Created agent:', agent.name, agent.role, agent.model);
  } else {
    console.log('Existing agents:', existingAgents.length);
    for (const a of existingAgents) console.log(' -', a.name, '|', a.role, '|', a.model);
  }

  await prisma.$disconnect();
}
main().catch(console.error);
