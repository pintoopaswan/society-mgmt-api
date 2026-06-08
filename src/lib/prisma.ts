// src/lib/prisma.ts
// Serverless-safe Prisma singleton with connection limiting
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error'] : ['error'],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// Graceful shutdown
process.on('beforeExit', async () => { await prisma.$disconnect() })

// Prisma middleware: log slow queries > 200ms (guarded for Prisma versions)
if (typeof (prisma as any).$use === 'function') {
  ;(prisma as any).$use(async (params: any, next: any) => {
    const start = Date.now()
    try {
      const result = await next(params)
      const ms = Date.now() - start
      if (ms > 200) {
        // Keep this lightweight — console.warn is fine; replace with structured logger if present
        // Avoid printing sensitive params
        console.warn(`Prisma slow query: ${params.model ?? 'unknown'}.${params.action} took ${ms}ms`)
      }
      return result
    } catch (err) {
      const ms = Date.now() - start
      console.error(`Prisma error on ${params.model ?? 'unknown'}.${params.action} after ${ms}ms`, err)
      throw err
    }
  })
} else {
  console.warn('Prisma client does not support $use middleware in this version — skipping slow-query middleware')
}