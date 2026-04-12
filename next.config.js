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
  // Allow any host in production (for Vast.ai dynamic URLs)
  allowedDevOrigins: process.env.NEXT_PUBLIC_APP_URL ? [process.env.NEXT_PUBLIC_APP_URL] : [],
}

module.exports = nextConfig
