// src/routes/search.ts
import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { ok, handleError } from '../lib/response'

const router = Router()

// GET /search?q=...
// Searches across: person name, phone, flat number, block name, vehicle plate
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim()
    if (!q || q.length < 2) return ok(res, [])

    const isPhone = /^\d+$/.test(q)
    const isFlat = /^\d{3}$/.test(q)
    const isPlate = /^[A-Z]{2}\d{2}/.test(q.toUpperCase())
    const qUpper = q.toUpperCase()

    const results: any[] = []

    // Prepare queries but run in parallel to avoid sequential DB waits
    const vehicleQuery = (isPlate || (!isPhone && !isFlat))
      ? prisma.vehicle.findMany({
          where: { plateNumber: { contains: qUpper }, isActive: true },
          select: {
            plateNumber: true,
            type: true,
            make: true,
            color: true,
            person: { select: { id: true, name: true, phone: true } },
            flat: { select: { id: true, flatNumber: true, status: true, block: { select: { id: true, name: true } } } },
          },
          take: 5,
        })
      : Promise.resolve([])

    const flatsQuery = (isFlat || (!isPhone && !isPlate))
      ? prisma.flat.findMany({
          where: { flatNumber: { contains: q }, isActive: true },
          select: {
            id: true,
            flatNumber: true,
            status: true,
            block: { select: { id: true, name: true } },
            ownerships: { where: { endDate: null }, select: { person: { select: { id: true, name: true, phone: true } } } },
            tenancies: { where: { isActive: true }, select: { person: { select: { id: true, name: true, phone: true } } } },
          },
          take: 10,
        })
      : Promise.resolve([])

    const personsQuery = prisma.person.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
          ...(q.length >= 3 ? [{ altPhone: { contains: q } }] : []),
        ],
      },
      select: {
        id: true,
        name: true,
        phone: true,
        altPhone: true,
        email: true,
        ownerships: { where: { endDate: null }, select: { flat: { select: { id: true, flatNumber: true, status: true, block: { select: { id: true, name: true } } } } } },
        tenancies: { where: { isActive: true }, select: { flat: { select: { id: true, flatNumber: true, status: true, block: { select: { id: true, name: true } } } } } },
        vehicles: { where: { isActive: true }, select: { plateNumber: true, type: true, make: true, color: true } },
      },
      take: 20,
    })

    const [vehicles, flats, persons] = await Promise.all([vehicleQuery, flatsQuery, personsQuery])

    // Process vehicles
    for (const v of vehicles) {
      results.push({
        type: 'vehicle',
        matchedOn: 'Vehicle No.',
        matchedValue: v.plateNumber,
        person: v.person ? { id: v.person.id, name: v.person.name, phone: v.person.phone } : null,
        flat: v.flat ? { id: v.flat.id, block: v.flat.block.name, flatNumber: v.flat.flatNumber, status: v.flat.status } : null,
        vehicle: { plateNumber: v.plateNumber, type: v.type, make: v.make, color: v.color },
        role: 'Owner',
      })
    }

    // Process flats
    for (const f of flats) {
      const label = `${f.block.name} · ${f.flatNumber}`
      for (const o of f.ownerships) {
        results.push({
          type: 'flat',
          matchedOn: 'Flat No.',
          matchedValue: label,
          person: { id: o.person.id, name: o.person.name, phone: o.person.phone },
          flat: { id: f.id, block: f.block.name, flatNumber: f.flatNumber, status: f.status },
          role: 'Owner',
        })
      }
      for (const t of f.tenancies) {
        results.push({
          type: 'flat',
          matchedOn: 'Flat No.',
          matchedValue: label,
          person: { id: t.person.id, name: t.person.name, phone: t.person.phone },
          flat: { id: f.id, block: f.block.name, flatNumber: f.flatNumber, status: f.status },
          role: 'Tenant',
        })
      }
      if (f.ownerships.length === 0 && f.tenancies.length === 0) {
        results.push({
          type: 'flat',
          matchedOn: 'Flat No.',
          matchedValue: `${f.block.name} · ${f.flatNumber}`,
          person: null,
          flat: { id: f.id, block: f.block.name, flatNumber: f.flatNumber, status: f.status },
          role: null,
        })
      }
    }

    // Process persons
    for (const p of persons) {
      const matchedOn = p.phone?.includes(q) ? 'Phone' : p.altPhone?.includes(q) ? 'Alt Phone' : 'Name'
      const matchedValue = matchedOn === 'Name' ? p.name : p.phone

      for (const o of p.ownerships) {
        results.push({ type: 'person', matchedOn, matchedValue, person: { id: p.id, name: p.name, phone: p.phone, altPhone: p.altPhone, email: p.email }, flat: { id: o.flat.id, block: o.flat.block.name, flatNumber: o.flat.flatNumber, status: o.flat.status }, vehicles: p.vehicles, role: 'Owner' })
      }
      for (const t of p.tenancies) {
        results.push({ type: 'person', matchedOn, matchedValue, person: { id: p.id, name: p.name, phone: p.phone, altPhone: p.altPhone, email: p.email }, flat: { id: t.flat.id, block: t.flat.block.name, flatNumber: t.flat.flatNumber, status: t.flat.status }, vehicles: p.vehicles, role: 'Tenant' })
      }
      if (p.ownerships.length === 0 && p.tenancies.length === 0) {
        results.push({ type: 'person', matchedOn, matchedValue, person: { id: p.id, name: p.name, phone: p.phone, altPhone: p.altPhone, email: p.email }, flat: null, vehicles: p.vehicles, role: null })
      }
    }

    // Deduplicate by person.id + flat.id combo
    const seen  = new Set<string>()
    const deduped = results.filter(r => {
      const key = `${r.person?.id ?? 'noperson'}-${r.flat?.id ?? 'noflat'}-${r.role}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return ok(res, deduped.slice(0, 30))
  } catch (err) { return handleError(res, err) }
})

export default router
