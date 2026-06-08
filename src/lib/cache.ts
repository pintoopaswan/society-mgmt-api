// src/lib/cache.ts
import Redis from 'ioredis'

const redisUrl = process.env.REDIS_URL || ''
let redisClient: Redis | null = null

if (redisUrl) {
  redisClient = new Redis(redisUrl)
  redisClient.on('error', (err) => console.warn('Redis error', err))
}

// Simple in-memory fallback cache
const memoryCache = new Map<string, { value: string; expiresAt: number }>()

export async function cacheGet(key: string): Promise<string | null> {
  if (redisClient) {
    try { return await redisClient.get(key) } catch (e) { console.warn('Redis GET failed', e); redisClient = null }
  }
  const entry = memoryCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { memoryCache.delete(key); return null }
  return entry.value
}

export async function cacheSet(key: string, value: string, ttlSec = 30): Promise<void> {
  if (redisClient) {
    try { await redisClient.set(key, value, 'EX', ttlSec) ; return } catch (e) { console.warn('Redis SET failed', e); redisClient = null }
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 })
}

export async function cacheDel(key: string): Promise<void> {
  if (redisClient) {
    try { await redisClient.del(key); return } catch (e) { console.warn('Redis DEL failed', e); redisClient = null }
  }
  memoryCache.delete(key)
}
