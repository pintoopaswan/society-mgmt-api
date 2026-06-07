// src/lib/response.ts
import { Response } from 'express'
import { ZodError } from 'zod'

// Safely serialize BigInt values returned by Prisma $queryRaw
function serialize(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  ))
}

export function ok(res: Response, data: unknown, status = 200) {
  return res.status(status).json({ success: true, data: serialize(data) })
}

export function created(res: Response, data: unknown) {
  return ok(res, data, 201)
}

export function error(res: Response, message: string, status = 400, details?: unknown) {
  return res.status(status).json({ success: false, message, ...(details ? { details } : {}) })
}

export function handleError(res: Response, err: unknown) {
  if (err instanceof ZodError) {
    return error(res, 'Validation error', 422, err.flatten().fieldErrors)
  }
  // Prisma unique constraint
  if ((err as any)?.code === 'P2002') {
    const field = (err as any)?.meta?.target?.[0] ?? 'field'
    return error(res, `A record with this ${field} already exists`, 409)
  }
  // Prisma not found
  if ((err as any)?.code === 'P2025') {
    return error(res, 'Record not found', 404)
  }
  console.error(err)
  return error(res, 'Internal server error', 500)
}
