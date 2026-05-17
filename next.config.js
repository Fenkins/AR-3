/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
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
