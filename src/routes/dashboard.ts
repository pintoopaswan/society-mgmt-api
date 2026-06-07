// src/routes/dashboard.ts
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { ok, created, handleError } from '../lib/response'

const router = Router()

// ── GET /dashboard — main KPI summary ────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const now          = new Date()
    const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    const [
      totalFlats,
      occupiedFlats,
      vacantFlats,
      totalResidents,
      currentMonthStats,
      fundBalance,
      recentPayments,
      topDefaulters,
    ] = await Promise.all([
      // Flat counts
      prisma.flat.count({ where: { isActive: true } }),
      prisma.flat.count({ where: { isActive: true, status: { not: 'VACANT' } } }),
      prisma.flat.count({ where: { isActive: true, status: 'VACANT' } }),

      // Resident count
      prisma.person.count({ where: { isActive: true } }),

      // Current month payment stats
      prisma.maintenancePayment.groupBy({
        by:    ['status'],
        where: { billingMonth },
        _count: true,
        _sum:   { totalAmount: true },
      }),

      // Latest fund balance
      prisma.fundLedger.findFirst({
        orderBy: { entryDate: 'desc' },
        select:  { balance: true, entryDate: true },
      }),

      // Recent 10 payments
      prisma.maintenancePayment.findMany({
        where:   { status: 'PAID' },
        orderBy: { paidAt: 'desc' },
        take:    10,
        include: {
          flat: {
            include: {
              block:      { select: { name: true } },
              ownerships: {
                where:   { endDate: null },
                include: { person: { select: { name: true } } },
                take:    1,
              },
            },
          },
        },
      }),

      // Top 5 defaulters
      prisma.$queryRaw<any[]>`
        SELECT b.name AS block, f."flatNumber", COUNT(*) AS "unpaidMonths",
               SUM(mp."totalAmount") AS "totalDue"
        FROM maintenance_payments mp
        JOIN flats f ON f.id = mp."flatId"
        JOIN blocks b ON b.id = f."blockId"
        WHERE mp.status IN ('PENDING','OVERDUE')
        GROUP BY b.name, f."flatNumber"
        ORDER BY "unpaidMonths" DESC
        LIMIT 5
      `,
    ])

    // Reshape payment stats
    const statsMap = Object.fromEntries(
      currentMonthStats.map(s => [s.status, { count: s._count, amount: s._sum.totalAmount ?? 0 }])
    )
    const paidCount = statsMap['PAID']?.count ?? 0
    const totalBilled = currentMonthStats.reduce((s, r) => s + r._count, 0)

    return ok(res, {
      flats: { total: totalFlats, occupied: occupiedFlats, vacant: vacantFlats },
      residents: { total: totalResidents },
      currentMonth: {
        billingMonth,
        paid:           paidCount,
        pending:        statsMap['PENDING']?.count ?? 0,
        overdue:        statsMap['OVERDUE']?.count ?? 0,
        collected:      statsMap['PAID']?.amount ?? 0,
        collectionRate: totalBilled > 0 ? Math.round((paidCount / totalBilled) * 100) : 0,
      },
      fund: {
        balance:   fundBalance?.balance ?? 0,
        asOf:      fundBalance?.entryDate ?? null,
      },
      recentPayments,
      topDefaulters,
    })
  } catch (err) { return handleError(res, err) }
})

// ── GET /dashboard/fund-ledger — fund transaction history ─────
router.get('/dashboard/fund-ledger', async (req, res) => {
  try {
    const { page = '1', limit = '20' } = req.query
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string)

    const [entries, total] = await Promise.all([
      prisma.fundLedger.findMany({
        orderBy: { entryDate: 'desc' },
        skip,
        take:    parseInt(limit as string),
      }),
      prisma.fundLedger.count(),
    ])

    return ok(res, { entries, total, page: parseInt(page as string) })
  } catch (err) { return handleError(res, err) }
})

// ── GET /dashboard/expenses — expense list ────────────────────
router.get('/dashboard/expenses', async (req, res) => {
  try {
    const { category, from, to } = req.query

    const expenses = await prisma.expense.findMany({
      where: {
        ...(category ? { category: category as any } : {}),
        ...(from || to ? {
          expenseDate: {
            ...(from ? { gte: new Date(from as string) } : {}),
            ...(to   ? { lte: new Date(to as string) }   : {}),
          },
        } : {}),
      },
      orderBy: { expenseDate: 'desc' },
    })
    return ok(res, expenses)
  } catch (err) { return handleError(res, err) }
})

// ── POST /dashboard/expenses — add expense ────────────────────
const expenseSchema = z.object({
  category:    z.enum(['MAINTENANCE','UTILITIES','SECURITY','REPAIR','SALARY','MISC']),
  description: z.string().min(1),
  amount:      z.number().positive(),
  vendor:      z.string().optional(),
  expenseDate: z.string().transform(d => new Date(d)),
  approvedBy:  z.string().optional(),
})

router.post('/dashboard/expenses', async (req, res) => {
  try {
    const data = expenseSchema.parse(req.body)

    const [expense] = await prisma.$transaction([
      prisma.expense.create({ data }),
      prisma.fundLedger.create({
        data: {
          entryType:   'DEBIT',
          amount:      data.amount,
          balance:     0, // updated by DB trigger
          description: `${data.category}: ${data.description}`,
          entryDate:   data.expenseDate,
        },
      }),
    ])

    return created(res, expense)
  } catch (err) { return handleError(res, err) }
})

// ── GET /dashboard/announcements ──────────────────────────────
router.get('/dashboard/announcements', async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({
      where: {
        isPublished: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { publishedAt: 'desc' },
      take:    20,
    })
    return ok(res, announcements)
  } catch (err) { return handleError(res, err) }
})

// ── POST /dashboard/announcements ────────────────────────────
const announcementSchema = z.object({
  title:    z.string().min(1),
  body:     z.string().min(1),
  category: z.enum(['NOTICE', 'CIRCULAR', 'ALERT', 'EVENT']),
  publish:  z.boolean().default(false),
  expiresAt: z.string().transform(d => new Date(d)).optional(),
})

router.post('/dashboard/announcements', async (req, res) => {
  try {
    const { publish, ...rest } = announcementSchema.parse(req.body)
    const announcement = await prisma.announcement.create({
      data: {
        ...rest,
        isPublished: publish,
        publishedAt: publish ? new Date() : null,
      },
    })
    return created(res, announcement)
  } catch (err) { return handleError(res, err) }
})

export default router
