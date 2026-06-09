// src/routes/residents.ts
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { ok, created, handleError } from '../lib/response'

const router = Router()

const VehicleTypeEnum = z.enum(['CAR','BIKE','SCOOTER','CYCLE','OTHER'])

// GET /residents
router.get('/residents', async (req, res) => {
  try {
    const { q, blockId, page = '1', limit = '25' } = req.query
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1)
    const take = Math.min(100, Math.max(5, parseInt(limit as string, 10) || 25))
    const skip = (pageNum - 1) * take

    const where: any = { isActive: true }

    if (q) {
      where.OR = [
        { name: { contains: q as string, mode: 'insensitive' } },
        { phone: { contains: q as string } },
      ]
    }

    if (blockId) {
      // Use nested relational filter to avoid fetching flat IDs first (prevents extra DB round-trip)
      where.OR = [
        ...(where.OR ?? []),
        { ownerships: { some: { flat: { blockId: blockId as string }, endDate: null } } },
        { tenancies: { some: { flat: { blockId: blockId as string }, isActive: true } } },
      ]
    }

    const persons = await prisma.person.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        altPhone: true,
        email: true,
        ownerships: {
          where: { endDate: null },
          take: 1,
          select: { flat: { select: { id: true, flatNumber: true, status: true, block: { select: { id: true, name: true } } } } },
        },
        tenancies: {
          where: { isActive: true },
          take: 1,
          select: { flat: { select: { id: true, flatNumber: true, status: true, block: { select: { id: true, name: true } } } } },
        },
        vehicles: { where: { isActive: true }, select: { plateNumber: true, type: true } },
      },
      orderBy: { name: 'asc' },
      skip,
      take,
    })
    return ok(res, { page: pageNum, limit: take, data: persons })
  } catch (err) { return handleError(res, err) }
})

// GET /residents/:id
router.get('/residents/:id', async (req, res) => {
  try {
    const person = await prisma.person.findUniqueOrThrow({
      where:   { id: req.params.id },
      include: {
        ownerships: { include: { flat: { include: { block: true } } } },
        tenancies:  { include: { flat: { include: { block: true } } } },
        vehicles:   true,
      },
    })
    return ok(res, person)
  } catch (err) { return handleError(res, err) }
})

// POST /residents
const personSchema = z.object({
  name:     z.string().min(1),
  phone:    z.string().min(7).max(15),
  altPhone: z.string().optional(),
  email:    z.string().email().optional(),
  // Treat empty strings as not-provided so sending "" won't fail validation
  aadhaarLast4: z.preprocess((v) => {
    if (typeof v === 'string' && v.trim() === '') return undefined
    return v
  }, z.string().length(4).optional()),
  panNumber: z.preprocess((v) => {
    if (typeof v === 'string' && v.trim() === '') return undefined
    return v
  }, z.string().optional()),
})

router.post('/residents', async (req, res) => {
  try {
    const data   = personSchema.parse(req.body)
    const person = await prisma.person.create({ data })
    return created(res, person)
  } catch (err) { return handleError(res, err) }
})

// PATCH /residents/:id
router.patch('/residents/:id', async (req, res) => {
  try {
    const data   = personSchema.partial().parse(req.body)
    const person = await prisma.person.update({ where: { id: req.params.id }, data })
    return ok(res, person)
  } catch (err) { return handleError(res, err) }
})

// POST /residents/:id/ownership
router.post('/residents/:id/ownership', async (req, res) => {
  try {
    const data = z.object({
      flatId:       z.string().uuid(),
      sharePercent: z.number().min(1).max(100).default(100),
      startDate:    z.string().transform(d => new Date(d)),
    }).parse(req.body)

    await prisma.ownership.updateMany({
      where: { flatId: data.flatId, endDate: null },
      data:  { endDate: new Date() },
    })
    const ownership = await prisma.ownership.create({
      data: { personId: req.params.id, ...data, isPrimary: true },
    })
    await prisma.flat.update({
      where: { id: data.flatId },
      data:  { status: 'OWNER_OCCUPIED' },
    })
    return created(res, ownership)
  } catch (err) { return handleError(res, err) }
})

// POST /residents/:id/tenancy
router.post('/residents/:id/tenancy', async (req, res) => {
  try {
    const data = z.object({
      flatId:     z.string().uuid(),
      startDate:  z.string().transform(d => new Date(d)),
      rentAmount: z.number().min(0).default(0),
      deposit:    z.number().min(0).default(0),
    }).parse(req.body)

    await prisma.tenancy.updateMany({
      where: { flatId: data.flatId, isActive: true },
      data:  { isActive: false, endDate: new Date() },
    })
    const tenancy = await prisma.tenancy.create({
      data: { tenantId: req.params.id, ...data, isActive: true },
    })
    await prisma.flat.update({
      where: { id: data.flatId },
      data:  { status: 'RENTED' },
    })
    return created(res, tenancy)
  } catch (err) { return handleError(res, err) }
})

// DELETE /residents/:id/tenancy/:tenancyId
router.delete('/residents/:id/tenancy/:tenancyId', async (req, res) => {
  try {
    const tenancy = await prisma.tenancy.update({
      where: { id: req.params.tenancyId },
      data:  { isActive: false, endDate: new Date() },
    })
    const ownership = await prisma.ownership.findFirst({
      where: { flatId: tenancy.flatId, endDate: null },
    })
    await prisma.flat.update({
      where: { id: tenancy.flatId },
      data:  { status: ownership ? 'OWNER_OCCUPIED' : 'VACANT' },
    })
    return ok(res, tenancy)
  } catch (err) { return handleError(res, err) }
})

// POST /residents/:id/vehicle
router.post('/residents/:id/vehicle', async (req, res) => {
  try {
    const data = z.object({
      flatId:      z.string().uuid(),
      type:        VehicleTypeEnum,
      plateNumber: z.string().min(1),
      make:        z.string().optional(),
      model:       z.string().optional(),
      color:       z.string().optional(),
      parkingSlot: z.string().optional(),
    }).parse(req.body)
    const vehicle = await prisma.vehicle.create({
      data: { ...data, personId: req.params.id },
    })
    return created(res, vehicle)
  } catch (err) { return handleError(res, err) }
})

// POST /residents/:id/vehicles  (bulk create)
router.post('/residents/:id/vehicles', async (req, res) => {
  try {
    const bodySchema = z.object({
      vehicles: z.array(z.object({
        flatId:      z.string().uuid(),
        type:        VehicleTypeEnum,
        plateNumber: z.string().min(1),
        make:        z.string().optional(),
        model:       z.string().optional(),
        color:       z.string().optional(),
        parkingSlot: z.string().optional(),
      })).min(1),
    })

    const { vehicles } = bodySchema.parse(req.body)

    // Check duplicate plate numbers within the request (case-insensitive)
    const normalized = vehicles.map(v => v.plateNumber.trim().toLowerCase())
    const dupes = normalized.filter((p, i) => normalized.indexOf(p) !== i)
    if (dupes.length) throw new Error(`Duplicate plate numbers in request: ${[...new Set(dupes)].join(', ')}`)

    // Check for existing vehicles in DB with same plate numbers (case-insensitive)
    const plateChecks = vehicles.map(v => ({ plateNumber: { equals: v.plateNumber, mode: 'insensitive' as any } }))
    const existing = await prisma.vehicle.findMany({ where: { OR: plateChecks }, select: { plateNumber: true } })
    if (existing.length) {
      const plates = existing.map(e => e.plateNumber).join(', ')
      throw new Error(`Plate number(s) already exist: ${plates}`)
    }

    // Transactional create: all succeed or all fail
    const createdVehicles = await prisma.$transaction(async (tx) => {
      const created: any[] = []
      for (const v of vehicles) {
        const rec = await tx.vehicle.create({ data: { ...v, personId: req.params.id } })
        created.push(rec)
      }
      return created
    })

    return created(res, { count: createdVehicles.length, vehicles: createdVehicles })
  } catch (err) { return handleError(res, err) }
})

export default router