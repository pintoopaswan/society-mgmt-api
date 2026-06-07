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
    const { q, blockId } = req.query

    const where: any = { isActive: true }

    if (q) {
      where.OR = [
        { name:  { contains: q as string, mode: 'insensitive' } },
        { phone: { contains: q as string } },
      ]
    }

    if (blockId) {
      // Get flat IDs in that block first, then filter persons
      const flatsInBlock = await prisma.flat.findMany({
        where:  { blockId: blockId as string },
        select: { id: true },
      })
      const flatIds = flatsInBlock.map((f: any) => f.id)

      where.OR = [
        ...(where.OR ?? []),
        { ownerships: { some: { flatId: { in: flatIds }, endDate: null } } },
        { tenancies:  { some: { flatId: { in: flatIds }, isActive: true } } },
      ]
    }

    const persons = await prisma.person.findMany({
      where,
      include: {
        ownerships: {
          where:   { endDate: null },
          include: { flat: { include: { block: { select: { name: true } } } } },
        },
        tenancies: {
          where:   { isActive: true },
          include: { flat: { include: { block: { select: { name: true } } } } },
        },
        vehicles: { where: { isActive: true } },
      },
      orderBy: { name: 'asc' },
      take: 100,
    })
    return ok(res, persons)
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
  name:         z.string().min(1),
  phone:        z.string().min(7).max(15),
  altPhone:     z.string().optional(),
  email:        z.string().email().optional(),
  aadhaarLast4: z.string().length(4).optional(),
  panNumber:    z.string().optional(),
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

export default router