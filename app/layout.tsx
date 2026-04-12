import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { AuthProvider } from '@/contexts/AuthContext'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Research Platform',
  description: 'Interactive research platform for autonomous agent-driven software invention',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-dark-950 text-dark-100`}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  )
}
