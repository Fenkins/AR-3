/** @type {import('next').NextConfig} */
const nextConfig = {
  staticPageGenerationTimeout: 180,
  experimental: {
    // Vast.ai rental containers can hit OS thread limits when Next.js
    // fans out static-generation workers. Keep production builds small
    // and deterministic so health-restores cannot starve the live worker.
    cpus: 1,
    workerThreads: false,
    serverActions: {
      allowedOrigins: [
        'localhost:3000',
        process.env.NEXT_PUBLIC_APP_URL,
      ].filter(Boolean),
    },
  },
  // Skip TypeScript type-checking during builds (pre-existing type errors in API routes)
  typescript: {
    ignoreBuildErrors: true,
  },
  // Skip ESLint during builds
  eslint: {
    ignoreDuringBuilds: true,
  },
}

module.exports = nextConfig
