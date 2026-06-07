// src/routes/razorpay.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { prisma } from '../lib/prisma'
import { ok, created, handleError, error } from '../lib/response'

const router = Router()

// Lazy-load Razorpay to avoid issues if key not set in dev
function getRazorpay() {
  const Razorpay = require('razorpay')
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  })
}

// ── POST /razorpay/create-order — initiate online payment ────
const createOrderSchema = z.object({
  maintenanceId: z.string().uuid(),
})

router.post('/razorpay/create-order', async (req, res) => {
  try {
    const { maintenanceId } = createOrderSchema.parse(req.body)

    const payment = await prisma.maintenancePayment.findUniqueOrThrow({
      where:   { id: maintenanceId },
      include: { flat: { include: { block: true } } },
    })

    if (payment.status === 'PAID') {
      return error(res, 'Payment already completed', 409)
    }

    const razorpay = getRazorpay()
    const amountPaise = Math.round(Number(payment.totalAmount) * 100) // Razorpay takes paise

    const order = await razorpay.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  `rcpt_${maintenanceId.slice(0, 12)}`,
      notes: {
        maintenanceId,
        flatNumber:  payment.flat.flatNumber,
        block:       payment.flat.block.name,
        billingMonth: payment.billingMonth,
      },
    })

    // Record the initiated transaction
    await prisma.paymentTransaction.create({
      data: {
        maintenanceId,
        razorpayOrderId: order.id,
        amount:          payment.totalAmount,
        currency:        'INR',
        mode:            'ONLINE',
        status:          'INITIATED',
        gateway:         'razorpay',
      },
    })

    return ok(res, {
      orderId:      order.id,
      amount:       amountPaise,
      currency:     'INR',
      keyId:        process.env.RAZORPAY_KEY_ID,
      billingMonth: payment.billingMonth,
      flatNumber:   payment.flat.flatNumber,
      block:        payment.flat.block.name,
    })
  } catch (err) { return handleError(res, err) }
})

// ── POST /razorpay/webhook — handle Razorpay payment events ──
// Add this URL in Razorpay Dashboard → Webhooks
// Events to enable: payment.captured, payment.failed
router.post('/razorpay/webhook', async (req: Request, res: Response) => {
  try {
    // Verify Razorpay signature
    const signature  = req.headers['x-razorpay-signature'] as string
    const secret     = process.env.RAZORPAY_WEBHOOK_SECRET!
    const body       = JSON.stringify(req.body)
    const expected   = crypto.createHmac('sha256', secret).update(body).digest('hex')

    if (signature !== expected) {
      return error(res, 'Invalid signature', 401)
    }

    const event   = req.body.event
    const payload = req.body.payload?.payment?.entity

    if (!payload) return ok(res, { received: true })

    const orderId   = payload.order_id
    const paymentId = payload.id

    // Find the transaction by order ID
    const txn = await prisma.paymentTransaction.findUnique({
      where: { razorpayOrderId: orderId },
    })

    if (!txn) {
      console.warn(`Webhook: no transaction found for order ${orderId}`)
      return ok(res, { received: true })
    }

    if (event === 'payment.captured') {
      // Update transaction
      await prisma.paymentTransaction.update({
        where: { id: txn.id },
        data: {
          razorpayPaymentId: paymentId,
          status:            'SUCCESS',
          processedAt:       new Date(),
          gatewayResponse:   payload,
        },
      })

      // Mark maintenance payment as PAID
      const mp = await prisma.maintenancePayment.update({
        where: { id: txn.maintenanceId! },
        data:  { status: 'PAID', paidAt: new Date() },
      })

      // Issue receipt
      const existingReceipt = await prisma.paymentReceipt.findUnique({
        where: { maintenanceId: txn.maintenanceId! },
      })
      if (!existingReceipt) {
        await prisma.paymentReceipt.create({
          data: {
            maintenanceId: txn.maintenanceId!,
            receiptNumber: `RCP-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
            issuedAt:      new Date(),
          },
        })
      }

      // Credit fund ledger
      await prisma.fundLedger.create({
        data: {
          entryType:   'CREDIT',
          amount:      mp.totalAmount,
          balance:     0, // updated by DB trigger
          description: `Online payment — ${mp.billingMonth}`,
          referenceId: txn.id,
          entryDate:   new Date(),
        },
      })

    } else if (event === 'payment.failed') {
      await prisma.paymentTransaction.update({
        where: { id: txn.id },
        data: {
          razorpayPaymentId: paymentId,
          status:            'FAILED',
          gatewayResponse:   payload,
        },
      })
    }

    return ok(res, { received: true })
  } catch (err) { return handleError(res, err) }
})

// ── POST /razorpay/verify — client-side verification ─────────
// Call after Razorpay checkout completes on frontend
const verifySchema = z.object({
  razorpay_order_id:   z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature:  z.string(),
})

router.post('/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = verifySchema.parse(req.body)

    const body     = `${razorpay_order_id}|${razorpay_payment_id}`
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest('hex')

    if (expected !== razorpay_signature) {
      return error(res, 'Payment verification failed', 400)
    }

    return ok(res, { verified: true })
  } catch (err) { return handleError(res, err) }
})

export default router
