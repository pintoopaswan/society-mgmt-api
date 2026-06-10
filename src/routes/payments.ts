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
        receipt:    true,
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
      // Legacy flow — transaction linked via maintenanceId
      prisma.paymentTransaction.create({
        data: {
          maintenanceId: req.params.id,
          amount: totalAmount, currency: 'INR',
          mode, status: 'SUCCESS', notes, processedAt: paidDate,
          paidMonths:   [payment.billingMonth],
          billingMonth: payment.billingMonth,
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
      blockId:    z.string().optional(),
      flatId:     z.string().optional(),
      blockName:  z.string().optional(),
      flatNumber: z.string().optional(),
    }).parse(req.query)

    let flatId: string | undefined

    if (q.blockId && q.flatId) {
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

    const maints = await prisma.maintenancePayment.findMany({
      where: { flatId }, select: { id: true, billingMonth: true },
    })
    if (maints.length === 0) return ok(res, [])

    const maintIds = maints.map((m: any) => m.id)

    const transactions = await prisma.paymentTransaction.findMany({
      where:   { maintenanceId: { in: maintIds }, status: 'SUCCESS' },
      include: { maintenance: { select: { billingMonth: true } } },
      orderBy: { processedAt: 'asc' },
    })

    const result = transactions.map((t: any) => ({
      date:         t.processedAt ?? t.createdAt,
      amount:       Number(t.amount),
      billingMonth: t.maintenance?.billingMonth ?? null,
      notes:        t.notes ?? null,
    }))

    return ok(res, result)
  } catch (err) { return handleError(res, err) }
})


// GET /payments/history/summary
// Returns one row per PaymentTransaction.
// Uses only columns guaranteed to exist in the current schema.
// New fields (transactionId, paidMonths etc.) are read via COALESCE so the
// query works both before and after the multi-month migration.
router.get('/payments/history/summary', async (req, res) => {
  try {
    const q = z.object({
      year:  z.string().regex(/^\d{4}$/).optional(),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      block: z.string().optional(),
    }).parse(req.query)

    // ── Build WHERE fragments ────────────────────────────────────────────────
    const conditions: string[] = [`mp.status = 'PAID'`]
    const params: any[]        = []
    let   pi = 1

    if (q.month) {
      conditions.push(`mp."billingMonth" = $${pi++}`)
      params.push(q.month)
    } else if (q.year) {
      conditions.push(`mp."billingMonth" LIKE $${pi++}`)
      params.push(`${q.year}-%`)
    }

    if (q.block) {
      conditions.push(`b.name = $${pi++}`)
      params.push(q.block)
    }

    const where = conditions.join(' AND ')

    // ── Check which new columns actually exist in the DB ─────────────────────
    const colCheck = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'maintenance_payments'
        AND column_name = 'transactionId'
    `
    const hasTransactionId = colCheck.length > 0

    let rows: any[]

    if (hasTransactionId) {
      // ── Post-migration query: group by transactionId ──────────────────────
      rows = await prisma.$queryRawUnsafe<any[]>(`
        SELECT
          pt.id                                                  AS "id",
          COALESCE(pt."processedAt", pt."createdAt")             AS "date",
          pt.amount::float                                       AS "amount",
          pt.mode                                                AS "mode",
          pt.notes                                               AS "notes",
          mp."billingMonth"                                      AS "billingMonth",
          b.name                                                 AS "block",
          f."flatNumber"                                         AS "flatNumber",
          pr."receiptNumber"                                     AS "receiptNumber"
        FROM maintenance_payments mp
        JOIN payment_transactions pt
          ON pt.id = mp."transactionId"
          OR (mp."transactionId" IS NULL AND pt."maintenanceId" = mp.id)
        JOIN flats f   ON f.id = mp."flatId"
        JOIN blocks b  ON b.id = f."blockId"
        LEFT JOIN payment_receipts pr
          ON pr."transactionId" = pt.id OR pr."maintenanceId" = mp.id
        WHERE ${where}
        ORDER BY pt."processedAt" DESC NULLS LAST
      `, ...params)
    } else {
      // ── Pre-migration query: legacy maintenanceId join only ───────────────
      rows = await prisma.$queryRawUnsafe<any[]>(`
        SELECT
          pt.id                                                  AS "id",
          COALESCE(pt."processedAt", pt."createdAt")             AS "date",
          pt.amount::float                                       AS "amount",
          pt.mode                                                AS "mode",
          pt.notes                                               AS "notes",
          mp."billingMonth"                                      AS "billingMonth",
          b.name                                                 AS "block",
          f."flatNumber"                                         AS "flatNumber",
          pr."receiptNumber"                                     AS "receiptNumber"
        FROM maintenance_payments mp
        JOIN payment_transactions pt ON pt."maintenanceId" = mp.id
        JOIN flats f   ON f.id = mp."flatId"
        JOIN blocks b  ON b.id = f."blockId"
        LEFT JOIN payment_receipts pr ON pr."maintenanceId" = mp.id
        WHERE ${where}
          AND pt.status = 'SUCCESS'
        ORDER BY pt."processedAt" DESC NULLS LAST
      `, ...params)
    }

    // Deduplicate — multi-month transactions join multiple maintenance rows
    const seen = new Set<string>()
    const deduped = rows.filter(r => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })

    return ok(res, deduped.map(r => ({
      id:             r.id,
      transactionRef: r.transactionRef ?? null,
      date:           r.date,
      amount:         Number(r.amount),
      lateFee:        Number(r.lateFee ?? 0),
      mode:           r.mode,
      notes:          r.notes ?? null,
      paidMonths:     Array.isArray(r.paidMonths) && r.paidMonths.length
                        ? r.paidMonths
                        : [r.billingMonth].filter(Boolean),
      billingMonth:   r.billingMonth ?? null,
      block:          r.block ?? null,
      flatNumber:     r.flatNumber ?? null,
      receiptNumber:  r.receiptNumber ?? null,
    })))
  } catch (err: any) {
    console.error('[/payments/history/summary]', err?.message ?? err)
    return handleError(res, err)
  }
})


// POST /payments/record-by-flat
// Creates ONE PaymentTransaction covering one or more billing months.
// MaintenancePayment rows are coverage markers only (status=PAID, transactionId set).
router.post('/payments/record-by-flat', async (req, res) => {
  try {
    const monthPattern = /^\d{4}-\d{2}$/
    const singleMonth  = z.string().regex(monthPattern, 'billingMonth must be YYYY-MM')

    const body = z.object({
      blockName:    z.string().min(1),
      flatNumber:   z.string().min(1),
      billingMonth: z.union([singleMonth, z.array(singleMonth).min(1)]),
      amount:       z.number().positive(),
      mode:         PaymentModeEnum,
      paidAt:       z.string().datetime({ offset: true }).optional(),
      lateFee:      z.number().min(0).default(0),
      notes:        z.string().optional(),
    }).parse(req.body)

    const months: string[] = [
      ...new Set(Array.isArray(body.billingMonth) ? body.billingMonth : [body.billingMonth]),
    ].sort()

    const primaryMonth = months[months.length - 1]
    const paidAt       = body.paidAt ? new Date(body.paidAt) : new Date()
    const totalAmount  = body.amount + body.lateFee

    // ── Resolve block & flat ──────────────────────────────────────────────────
    const block = await prisma.block.findUnique({ where: { name: body.blockName } })
    if (!block) return error(res, `Block "${body.blockName}" not found`, 404)

    const flat = await prisma.flat.findFirst({
      where: { blockId: block.id, flatNumber: body.flatNumber },
    })
    if (!flat)          return error(res, `Flat "${body.flatNumber}" not found in ${body.blockName}`, 404)
    if (!flat.isActive) return error(res, `Flat "${body.flatNumber}" is inactive`, 422)

    // ── Guard: already-paid months ────────────────────────────────────────────
    const alreadyPaid = await prisma.maintenancePayment.findMany({
      where:  { flatId: flat.id, billingMonth: { in: months }, status: 'PAID' },
      select: { billingMonth: true },
    })
    const alreadyPaidMonths = alreadyPaid.map((p: any) => p.billingMonth)
    const toProcess = months.filter(m => !alreadyPaidMonths.includes(m))

    if (toProcess.length === 0) {
      return error(res, `All selected months already paid for ${body.blockName} / Flat ${body.flatNumber}`, 409)
    }

    // ── Find or create maintenance coverage markers ───────────────────────────
    // Fetch flat with monthlyMaintenance so coverage rows satisfy the positive-amount constraint
    const flatWithMaint = await prisma.flat.findUnique({
      where:  { id: flat.id },
      select: { monthlyMaintenance: true },
    })
    const monthlyAmount = Number(flatWithMaint?.monthlyMaintenance ?? body.amount)

    const existingMaints = await prisma.maintenancePayment.findMany({
      where: { flatId: flat.id, billingMonth: { in: toProcess } },
    })
    const existingMap = new Map(existingMaints.map((p: any) => [p.billingMonth, p]))

    const missingMonths = toProcess.filter(m => !existingMap.has(m))
    if (missingMonths.length > 0) {
      await prisma.maintenancePayment.createMany({
        data: missingMonths.map(m => {
          const [y, mo] = m.split('-').map(Number)
          return {
            flatId:      flat.id,
            billingMonth: m,
            amount:      monthlyAmount,   // satisfies chk_mp_positive_amount
            lateFee:     0,
            totalAmount: monthlyAmount,
            status:      'PENDING',
            dueDate:     new Date(y, mo - 1, 10),
          }
        }),
      })
      const fresh = await prisma.maintenancePayment.findMany({
        where: { flatId: flat.id, billingMonth: { in: missingMonths } },
      })
      fresh.forEach((p: any) => existingMap.set(p.billingMonth, p))
    }

    const maintRecords = toProcess.map(m => existingMap.get(m)!)

    // ── Atomic persist ────────────────────────────────────────────────────────
    const receiptNumber = `RCP-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`

    const result = await prisma.$transaction(async (tx) => {
      // Per-month amount: spread total evenly; anchor month absorbs rounding remainder
      const perMonth     = Math.floor(body.amount / toProcess.length)
      const anchorAmount = body.amount - perMonth * (toProcess.length - 1)

      // For each billing month: create one PaymentTransaction linked via maintenanceId
      // (the only valid FK in the schema), update MaintenancePayment to PAID,
      // and create a receipt keyed on maintenanceId.
      const txnIds: string[] = []
      for (let i = 0; i < maintRecords.length; i++) {
        const maint      = maintRecords[i]
        const isAnchor   = maint.billingMonth === primaryMonth
        const monthAmt   = isAnchor ? anchorAmount : perMonth
        const monthFee   = isAnchor ? body.lateFee : 0
        const monthTotal = monthAmt + monthFee

        const paymentTx = await tx.paymentTransaction.create({
          data: {
            maintenanceId: maint.id,    // ← only valid FK in schema
            amount:        monthTotal,
            currency:      'INR',
            mode:          body.mode,
            status:        'SUCCESS',
            notes:         body.notes ?? null,
            processedAt:   paidAt,
          },
        })
        txnIds.push(paymentTx.id)

        await tx.maintenancePayment.update({
          where: { id: maint.id },
          data:  { status: 'PAID', paidAt, lateFee: monthFee, totalAmount: monthTotal },
        })

        // PaymentReceipt.maintenanceId is the only FK in schema
        await tx.paymentReceipt.create({
          data: {
            maintenanceId: maint.id,
            receiptNumber: isAnchor ? receiptNumber : `${receiptNumber}-${i + 1}`,
            issuedAt:      new Date(),
          },
        })
      }

      // Single fund-ledger CREDIT for the full combined amount
      await tx.fundLedger.create({
        data: {
          entryType:   'CREDIT',
          amount:      totalAmount,
          balance:     0,
          description: `Maintenance — ${toProcess.join(', ')} (${body.blockName} / ${body.flatNumber})`,
          referenceId: txnIds[txnIds.length - 1],
          entryDate:   paidAt,
        },
      })

      return txnIds[txnIds.length - 1]
    })

    const updated = await prisma.paymentTransaction.findUnique({
      where:   { id: result },
      include: {
        maintenance: {
          include: {
            flat:    { include: { block: { select: { name: true } } } },
            receipt: true,
          },
        },
      },
    })

    return ok(res, {
      transaction:     updated,
      processedMonths: toProcess,
      skippedMonths:   alreadyPaidMonths,
    })
  } catch (err) { return handleError(res, err) }
})


// PATCH /payments/transaction/:txId/edit
// Edits a PaymentTransaction — the single source of truth.
// Does NOT touch individual MaintenancePayment coverage markers.
router.patch('/payments/transaction/:txId/edit', async (req, res) => {
  try {
    const body = z.object({
      mode:    PaymentModeEnum.optional(),
      paidAt:  z.string().datetime({ offset: true }).optional(),
      amount:  z.number().positive().optional(),
      lateFee: z.number().min(0).optional(),
      notes:   z.string().optional(),
    }).parse(req.body)

    const tx = await prisma.paymentTransaction.findUnique({
      where:   { id: req.params.txId },
      include: {
        maintenance: { include: { flat: { include: { block: { select: { name: true } } } } } },
      },
    })
    if (!tx)                     return error(res, 'Transaction not found', 404)
    if (tx.status !== 'SUCCESS') return error(res, 'Only successful transactions can be edited', 422)

    // lateFee and paidMonths are not schema fields — derive from maintenance relation
    const oldLateFee = 0   // not stored on transaction; treat prior amount as base
    const newAmount  = body.amount  ?? Number(tx.amount)
    const newLateFee = body.lateFee ?? oldLateFee
    const newTotal   = newAmount + newLateFee
    const oldTotal   = Number(tx.amount)
    const delta      = newTotal - oldTotal
    const newPaidAt  = body.paidAt ? new Date(body.paidAt) : undefined

    const maint      = (tx as any).maintenance
    const blockName  = maint?.flat?.block?.name ?? '?'
    const flatNumber = maint?.flat?.flatNumber  ?? '?'
    const billingMon = maint?.billingMonth ?? '?'

    await prisma.$transaction(async (prismaClient) => {
      await prismaClient.paymentTransaction.update({
        where: { id: tx.id },
        data: {
          ...(body.mode  !== undefined && { mode: body.mode }),
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(newPaidAt               && { processedAt: newPaidAt }),
          ...((body.amount !== undefined || body.lateFee !== undefined) && {
            amount: newTotal,   // total incl. any late fee adjustment
          }),
        },
      })

      if (delta !== 0) {
        await prismaClient.fundLedger.create({
          data: {
            entryType:   delta > 0 ? 'CREDIT' : 'DEBIT',
            amount:      Math.abs(delta),
            balance:     0,
            description: `Payment correction — ${billingMon} (${blockName} / ${flatNumber})`,
            referenceId: tx.id,
            entryDate:   new Date(),
          },
        })
      }
    })

    const updated = await prisma.paymentTransaction.findUnique({
      where:   { id: tx.id },
      include: {
        maintenance: {
          include: {
            flat:    { include: { block: { select: { name: true } } } },
            receipt: true,
          },
        },
      },
    })

    return ok(res, updated)
  } catch (err) { return handleError(res, err) }
})


// DELETE /payments/transaction/:txId
// Reverses a PaymentTransaction: marks the linked MaintenancePayment back to PENDING,
// deletes the receipt, and posts a DEBIT correction to the fund ledger.
router.delete('/payments/transaction/:txId', async (req, res) => {
  try {
    const tx = await prisma.paymentTransaction.findUnique({
      where:   { id: req.params.txId },
      include: {
        maintenance: {
          include: {
            flat:    { include: { block: { select: { name: true } } } },
            receipt: true,
          },
        },
      },
    })
    if (!tx) return error(res, 'Transaction not found', 404)

    const maint      = (tx as any).maintenance
    const blockName  = maint?.flat?.block?.name ?? '?'
    const flatNumber = maint?.flat?.flatNumber  ?? '?'
    const billingMon = maint?.billingMonth ?? '?'

    await prisma.$transaction(async (prismaClient) => {
      // 1. Delete receipt if it exists (keyed on maintenanceId in schema)
      if (maint?.receipt) {
        await prismaClient.paymentReceipt.delete({ where: { id: maint.receipt.id } })
      }

      // 2. Reverse the MaintenancePayment back to PENDING
      if (maint) {
        await prismaClient.maintenancePayment.update({
          where: { id: maint.id },
          data:  { status: 'PENDING', paidAt: null, lateFee: 0, totalAmount: maint.amount },
        })
      }

      // 3. Delete the transaction itself
      await prismaClient.paymentTransaction.delete({ where: { id: tx.id } })

      // 4. DEBIT the fund ledger to reverse the credit
      await prismaClient.fundLedger.create({
        data: {
          entryType:   'DEBIT',
          amount:      Number(tx.amount),
          balance:     0,
          description: `Payment deleted — ${billingMon} (${blockName} / ${flatNumber})`,
          referenceId: tx.id,
          entryDate:   new Date(),
        },
      })
    })

    return ok(res, { message: 'Payment deleted successfully' })
  } catch (err) { return handleError(res, err) }
})

export default router