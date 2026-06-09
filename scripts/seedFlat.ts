import { prisma } from '../src/lib/prisma'

async function main() {
  const blockName = 'SEED_BLOCK_FOR_TESTS'
  const flatNumber = '101'

  const block = await prisma.block.upsert({
    where: { name: blockName },
    update: {},
    create: { name: blockName, description: 'Seed block for automated tests', totalFlats: 1 },
  })

  let flat = await prisma.flat.findFirst({ where: { blockId: block.id, flatNumber } })
  if (!flat) {
    flat = await prisma.flat.create({
      data: {
        blockId: block.id,
        flatNumber,
        floor: 1,
        type: 'BHK_2',
        status: 'VACANT',
        monthlyMaintenance: 1000,
      },
    })
  }

  console.log(JSON.stringify({ blockId: block.id, flatId: flat.id }))
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
