// src/routes/payments.ts
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { ok, created, handleError, error } from '../lib/response'

const router = Router()

const PaymentModeEnum   = z.enum(['ONLINE','CASH','UPI','NEFT','CHEQUE'])
const PaymentStatusEnum = z.enum(['PENDING','PAID','PARTIAL','WAIVED','OVERDUE'])

// GET /payments
router.get('/payments', async (req, res) => {
  try {
    const { billingMonth, status, blockId, flatId } = req.query
    const payments = await prisma.maintenancePayment.findMany({
      where: {
        ...(billingMonth ? { billingMonth: billingMonth as string }       : {}),
        ...(status       ? { status: status as string }                   : {}),
        ...(flatId       ? { flatId: flatId as string }                   : {}),
        ...(blockId      ? { flat: { blockId: blockId as string } }       : {}),
      },
      include: {
        flat: {
          include: {
            block:      { select: { name: true } },
            ownerships: {
              where:   { endDate: null },
              include: { person: { select: { name: true, phone: true } } },
              take: 1,
            },
            tenancies: {
              where:   { isActive: true },
              include: { person: { select: { name: true, phone: true } } },
              take: 1,
            },
          },
        },
        transactions: { orderBy: { createdAt: 'desc' }, take: 1 },
        receipt:      true,
      },
      orderBy: [{ billingMonth: 'desc' }, { flat: { flatNumber: 'asc' } }],
    })
    return ok(res, payments)
  } catch (err) { return handleError(res, err) }
})

// GET /payments/defaulters
router.get('/payments/defaulters', async (req, res) => {
  try {
    const defaulters = await prisma.$queryRaw<any[]>`
      SELECT b.name AS block, f."flatNumber", f.id AS "flatId",
             COUNT(*) AS "unpaidMonths",
             SUM(mp."totalAmount") AS "totalDue",
             MIN(mp."dueDate") AS "oldestDue"
      FROM maintenance_payments mp
      JOIN flats f  ON f.id = mp."flatId"
      JOIN blocks b ON b.id = f."blockId"
      WHERE mp.status IN ('PENDING','OVERDUE')
      GROUP BY b.name, f."flatNumber", f.id
      ORDER BY "unpaidMonths" DESC, "totalDue" DESC
    `
    return ok(res, defaulters)
  } catch (err) { return handleError(res, err) }
})

// GET /payments/summary/:billingMonth
router.get('/payments/summary/:billingMonth', async (req, res) => {
  try {
    const { billingMonth } = req.params
    const [total, paid, pending, overdue] = await Promise.all([
      prisma.maintenancePayment.count({ where: { billingMonth } }),
      prisma.maintenancePayment.count({ where: { billingMonth, status: 'PAID' } }),
      prisma.maintenancePayment.count({ where: { billingMonth, status: 'PENDING' } }),
      prisma.maintenancePayment.count({ where: { billingMonth, status: 'OVERDUE' } }),
    ])
    const collected = await prisma.maintenancePayment.aggregate({
      where: { billingMonth, status: 'PAID' },
      _sum:  { totalAmount: true },
    })
    const totalDue = await prisma.maintenancePayment.aggregate({
      where: { billingMonth },
      _sum:  { totalAmount: true },
    })
    return ok(res, {
      billingMonth, total, paid, pending, overdue,
      totalDue:       totalDue._sum.totalAmount ?? 0,
      collected:      collected._sum.totalAmount ?? 0,
      collectionRate: total > 0 ? Math.round((paid / total) * 100) : 0,
    })
  } catch (err) { return handleError(res, err) }
})

// POST /payments/generate-bills
router.post('/payments/generate-bills', async (req, res) => {
  try {
    const { billingMonth, amount, dueDay } = z.object({
      billingMonth: z.string().regex(/^\d{4}-\d{2}$/),
      amount:       z.number().positive().default(200),
      dueDay:       z.number().min(1).max(28).default(10),
    }).parse(req.body)

    const [year, month] = billingMonth.split('-').map(Number)
    const dueDate = new Date(year, month - 1, dueDay)

    const flats = await prisma.flat.findMany({ where: { isActive: true }, select: { id: true } })
    const existing = await prisma.maintenancePayment.findMany({
      where: { billingMonth }, select: { flatId: true },
    })
    const existingIds = new Set(existing.map((e: any) => e.flatId))
    const toCreate = flats
      .filter((f: any) => !existingIds.has(f.id))
      .map((f: any) => ({
        flatId: f.id, billingMonth, amount, lateFee: 0,
        totalAmount: amount, status: 'PENDING', dueDate,
      }))

    const result = await prisma.maintenancePayment.createMany({ data: toCreate })
    return created(res, {
      message: `Generated ${result.count} bills for ${billingMonth}`,
      created: result.count,
      skipped: flats.length - result.count,
    })
  } catch (err) { return handleError(res, err) }
})

// POST /payments/:id/record
router.post('/payments/:id/record', async (req, res) => {
  try {
    const { mode, paidAt, lateFee, notes } = z.object({
      mode:    PaymentModeEnum,
      paidAt:  z.string().transform(d => new Date(d)).optional(),
      lateFee: z.number().min(0).default(0),
      notes:   z.string().optional(),
    }).parse(req.body)

    const payment = await prisma.maintenancePayment.findUniqueOrThrow({
      where: { id: req.params.id },
    })

    if (payment.status === 'PAID') {
      return error(res, 'Payment already marked as paid', 409)
    }

    const totalAmount = Number(payment.amount) + Number(lateFee)
    const paidDate    = paidAt ?? new Date()

    await prisma.$transaction([
      prisma.maintenancePayment.update({
        where: { id: req.params.id },
        data:  { status: 'PAID', paidAt: paidDate, lateFee, totalAmount },
      }),
      prisma.paymentTransaction.create({
        data: {
          maintenanceId: req.params.id,
          amount: totalAmount, currency: 'INR',
          mode, status: 'SUCCESS', notes, processedAt: paidDate,
        },
      }),
      prisma.paymentReceipt.create({
        data: {
          maintenanceId: req.params.id,
          receiptNumber: `RCP-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
          issuedAt: new Date(),
        },
      }),
      prisma.fundLedger.create({
        data: {
          entryType: 'CREDIT', amount: totalAmount, balance: 0,
          description: `Maintenance — ${payment.billingMonth}`,
          referenceId: req.params.id, entryDate: paidDate,
        },
      }),
    ])

    const updated = await prisma.maintenancePayment.findUnique({ where: { id: req.params.id } })
    return ok(res, updated)
  } catch (err) { return handleError(res, err) }
})

// PATCH /payments/mark-overdue
router.patch('/payments/mark-overdue', async (req, res) => {
  try {
    const result = await prisma.maintenancePayment.updateMany({
      where: { status: 'PENDING', dueDate: { lt: new Date() } },
      data:  { status: 'OVERDUE' },
    })
    return ok(res, { message: `Marked ${result.count} payments as overdue` })
  } catch (err) { return handleError(res, err) }
})

// GET /payments/history?blockId=&flatId=
router.get('/payments/history', async (req, res) => {
  try {
    const q = z.object({
      blockId: z.string().optional(),
      flatId: z.string().optional(),
      blockName: z.string().optional(),
      flatNumber: z.string().optional(),
    }).parse(req.query)

    let flatId: string | undefined

    if (q.blockId && q.flatId) {
      // prefer explicit IDs
      const flat = await prisma.flat.findUnique({ where: { id: q.flatId } })
      if (!flat || flat.blockId !== q.blockId) return error(res, 'Flat not found in block', 404)
      flatId = q.flatId
    } else if (q.blockName && q.flatNumber) {
      const block = await prisma.block.findUnique({ where: { name: q.blockName } })
      if (!block) return error(res, 'Block not found', 404)
      const flat = await prisma.flat.findFirst({ where: { blockId: block.id, flatNumber: q.flatNumber } })
      if (!flat) return error(res, 'Flat not found in block', 404)
      flatId = flat.id
    } else {
      return error(res, 'Provide blockId+flatId or blockName+flatNumber', 400)
    }

    const maints = await prisma.maintenancePayment.findMany({ where: { flatId }, select: { id: true, billingMonth: true } })
    if (maints.length === 0) return ok(res, [])

    const maintIds = maints.map(m => m.id)

    const transactions = await prisma.paymentTransaction.findMany({
      where: { maintenanceId: { in: maintIds }, status: 'SUCCESS' },
      include: { maintenance: { select: { billingMonth: true } } },
      orderBy: { processedAt: 'asc' },
    })

    const result = transactions.map(t => ({
      date: t.processedAt ?? t.createdAt,
      amount: Number(t.amount),
      billingMonth: t.maintenance?.billingMonth ?? null,
      notes: t.notes ?? null,
    }))

    return ok(res, result)
  } catch (err) { return handleError(res, err) }
})

export default router