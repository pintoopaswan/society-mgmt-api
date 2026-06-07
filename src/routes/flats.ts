// src/routes/flats.ts
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { ok, handleError, error } from '../lib/response'

const router = Router()

const FlatStatusEnum = z.enum(['VACANT', 'OWNER_OCCUPIED', 'RENTED', 'LOCKED'])

// GET /blocks
router.get('/blocks', async (req, res) => {
  try {
    const blocks = await prisma.block.findMany({
      where: { isActive: true },
      include: {
        flats: { select: { status: true }, where: { isActive: true } },
      },
      orderBy: { name: 'asc' },
    })
    const data = blocks.map((b: any) => ({
      id:         b.id,
      name:       b.name,
      totalFlats: b.totalFlats,
      vacant:     b.flats.filter((f: any) => f.status === 'VACANT').length,
      occupied:   b.flats.filter((f: any) => f.status !== 'VACANT').length,
    }))
    return ok(res, data)
  } catch (err) { return handleError(res, err) }
})

// GET /blocks/:blockId/flats
router.get('/blocks/:blockId/flats', async (req, res) => {
  try {
    const flats = await prisma.flat.findMany({
      where: { blockId: req.params.blockId, isActive: true },
      include: {
        ownerships: {
          where: { endDate: null },
          include: { person: { select: { id: true, name: true, phone: true } } },
        },
        tenancies: {
          where: { isActive: true },
          include: { person: { select: { id: true, name: true, phone: true } } },
        },
      },
      orderBy: { flatNumber: 'asc' },
    })
    return ok(res, flats)
  } catch (err) { return handleError(res, err) }
})

// GET /flats
router.get('/flats', async (req, res) => {
  try {
    const { status, blockId, floor } = req.query
    const flats = await prisma.flat.findMany({
      where: {
        isActive: true,
        ...(status  ? { status:  status as string }               : {}),
        ...(blockId ? { blockId: blockId as string }              : {}),
        ...(floor   ? { floor:   parseInt(floor as string) }      : {}),
      },
      include: {
        block:      { select: { name: true } },
        ownerships: {
          where:   { endDate: null },
          include: { person: { select: { name: true, phone: true } } },
        },
        tenancies: {
          where:   { isActive: true },
          include: { person: { select: { name: true, phone: true } } },
        },
        vehicles: { where: { isActive: true } },
      },
      orderBy: [{ block: { name: 'asc' } }, { flatNumber: 'asc' }],
    })
    return ok(res, flats)
  } catch (err) { return handleError(res, err) }
})

// GET /flats/:id
router.get('/flats/:id', async (req, res) => {
  try {
    const flat = await prisma.flat.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        block:      true,
        ownerships: { include: { person: true } },
        tenancies:  { include: { person: true } },
        vehicles:   { where: { isActive: true } },
        payments:   { orderBy: { billingMonth: 'desc' }, take: 12 },
      },
    })
    return ok(res, flat)
  } catch (err) { return handleError(res, err) }
})

// PATCH /flats/:id/status
router.patch('/flats/:id/status', async (req, res) => {
  try {
    const { status } = z.object({ status: FlatStatusEnum }).parse(req.body)
    const flat = await prisma.flat.update({
      where: { id: req.params.id },
      data:  { status },
    })
    return ok(res, flat)
  } catch (err) { return handleError(res, err) }
})

export default router