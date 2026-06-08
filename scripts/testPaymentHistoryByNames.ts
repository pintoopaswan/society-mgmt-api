import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const blockName = 'BLOCK-1'
const flatNumber = '102'

async function main(){
  try{
    const block = await prisma.block.findUnique({ where: { name: blockName } })
    if (!block) return console.error('Block not found')

    const flat = await prisma.flat.findFirst({ where: { blockId: block.id, flatNumber } })
    if (!flat) return console.error('Flat not found in block')

    const maints = await prisma.maintenancePayment.findMany({ where: { flatId: flat.id }, select: { id: true, billingMonth: true } })
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
