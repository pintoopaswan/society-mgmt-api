// src/index.ts
import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import flatsRouter     from './routes/flats'
import residentsRouter from './routes/residents'
import paymentsRouter  from './routes/payments'
import dashboardRouter from './routes/dashboard'
import razorpayRouter  from './routes/razorpay'
import searchRouter    from './routes/search'

const app = express()

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) ?? []

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true,
}))

app.use('/api/razorpay/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.get('/health',     (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))

app.use('/api', flatsRouter)
app.use('/api', residentsRouter)
app.use('/api', paymentsRouter)
app.use('/api', dashboardRouter)
app.use('/api', razorpayRouter)
app.use('/api', searchRouter)

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` })
})

if (require.main === module) {
  const PORT = process.env.PORT ?? 3000
  app.listen(PORT, () => console.log(`🚀 API running at http://localhost:${PORT}`))
}

export default app
module.exports = app