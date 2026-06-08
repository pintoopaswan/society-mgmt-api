import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const blockId = '5a32713f-c1b0-47cb-9334-c5a5b09602af'
const flatId  = '2f211497-c7aa-45d6-8ad9-9d14e9bfb0c0'

async function main(){
  try{
    const flat = await prisma.flat.findUnique({ where: { id: flatId } })
    if (!flat || flat.blockId !== blockId) return console.error('Flat not found in block')

    const maints = await prisma.maintenancePayment.findMany({ where: { flatId }, select: { id: true, billingMonth: true } })
    if (maints.length === 0) return console.log('[]')

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

    console.log(JSON.stringify(result, null, 2))
  }catch(e){
    console.error(e)
    process.exit(1)
  }finally{
    await prisma.$disconnect()
  }
}

main()
