import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main(){
  try{
    const flat = await prisma.flat.findFirst({ include: { block: true } })
    console.log(JSON.stringify(flat, null, 2))
  }catch(e){
    console.error(e)
    process.exit(1)
  }finally{
    await prisma.$disconnect()
  }
}

main()
