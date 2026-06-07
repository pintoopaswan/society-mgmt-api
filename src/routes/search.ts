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

    const isPhone   = /^\d+$/.test(q)
    const isFlat    = /^\d{3}$/.test(q)                    // e.g. "101"
    const isPlate   = /^[A-Z]{2}\d{2}/.test(q.toUpperCase()) // e.g. "CG04AB1234"

    const results: any[] = []

    // ── 1. Search by vehicle plate ────────────────────────────
    if (isPlate || (!isPhone && !isFlat)) {
      const vehicles = await prisma.vehicle.findMany({
        where: {
          plateNumber: { contains: q.toUpperCase() },
          isActive:    true,
        },
        include: {
          person: true,
          flat:   { include: { block: true } },
        },
        take: 5,
      })

      for (const v of vehicles) {
        results.push({
          type:        'vehicle',
          matchedOn:   'Vehicle No.',
          matchedValue: v.plateNumber,
          person: {
            id:    v.person.id,
            name:  v.person.name,
            phone: v.person.phone,
          },
          flat: {
            id:          v.flat.id,
            block:       v.flat.block.name,
            flatNumber:  v.flat.flatNumber,
            status:      v.flat.status,
          },
          vehicle: {
            plateNumber: v.plateNumber,
            type:        v.type,
            make:        v.make,
            color:       v.color,
          },
          role: 'Owner',
        })
      }
    }

    // ── 2. Search by flat number ──────────────────────────────
    if (isFlat || (!isPhone && !isPlate)) {
      const flats = await prisma.flat.findMany({
        where: {
          flatNumber: { contains: q },
          isActive:   true,
        },
        include: {
          block:      true,
          ownerships: {
            where:   { endDate: null },
            include: { person: true },
          },
          tenancies: {
            where:   { isActive: true },
            include: { person: true },
          },
        },
        take: 10,
      })

      for (const f of flats) {
        // Add owners
        for (const o of f.ownerships) {
          results.push({
            type:        'flat',
            matchedOn:   'Flat No.',
            matchedValue: `${f.block.name} · ${f.flatNumber}`,
            person: {
              id:    o.person.id,
              name:  o.person.name,
              phone: o.person.phone,
            },
            flat: {
              id:         f.id,
              block:      f.block.name,
              flatNumber: f.flatNumber,
              status:     f.status,
            },
            role: 'Owner',
          })
        }
        // Add tenants
        for (const t of f.tenancies) {
          results.push({
            type:        'flat',
            matchedOn:   'Flat No.',
            matchedValue: `${f.block.name} · ${f.flatNumber}`,
            person: {
              id:    t.person.id,
              name:  t.person.name,
              phone: t.person.phone,
            },
            flat: {
              id:         f.id,
              block:      f.block.name,
              flatNumber: f.flatNumber,
              status:     f.status,
            },
            role: 'Tenant',
          })
        }
        // Vacant flat with no occupants
        if (f.ownerships.length === 0 && f.tenancies.length === 0) {
          results.push({
            type:        'flat',
            matchedOn:   'Flat No.',
            matchedValue: `${f.block.name} · ${f.flatNumber}`,
            person:      null,
            flat: {
              id:         f.id,
              block:      f.block.name,
              flatNumber: f.flatNumber,
              status:     f.status,
            },
            role: null,
          })
        }
      }
    }

    // ── 3. Search by person name or phone ─────────────────────
    const persons = await prisma.person.findMany({
      where: {
        isActive: true,
        OR: [
          { name:  { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
          ...(q.length >= 3 ? [{ altPhone: { contains: q } }] : []),
        ],
      },
      include: {
        ownerships: {
          where:   { endDate: null },
          include: { flat: { include: { block: true } } },
        },
        tenancies: {
          where:   { isActive: true },
          include: { flat: { include: { block: true } } },
        },
        vehicles: { where: { isActive: true } },
      },
      take: 20,
    })

    for (const p of persons) {
      const matchedOn = p.phone.includes(q) ? 'Phone' : p.altPhone?.includes(q) ? 'Alt Phone' : 'Name'

      // Owner entries
      for (const o of p.ownerships) {
        results.push({
          type:        'person',
          matchedOn,
          matchedValue: matchedOn === 'Name' ? p.name : p.phone,
          person: {
            id:       p.id,
            name:     p.name,
            phone:    p.phone,
            altPhone: p.altPhone,
            email:    p.email,
          },
          flat: {
            id:         o.flat.id,
            block:      o.flat.block.name,
            flatNumber: o.flat.flatNumber,
            status:     o.flat.status,
          },
          vehicles: p.vehicles,
          role: 'Owner',
        })
      }

      // Tenant entries
      for (const t of p.tenancies) {
        results.push({
          type:        'person',
          matchedOn,
          matchedValue: matchedOn === 'Name' ? p.name : p.phone,
          person: {
            id:       p.id,
            name:     p.name,
            phone:    p.phone,
            altPhone: p.altPhone,
            email:    p.email,
          },
          flat: {
            id:         t.flat.id,
            block:      t.flat.block.name,
            flatNumber: t.flat.flatNumber,
            status:     t.flat.status,
          },
          vehicles: p.vehicles,
          role: 'Tenant',
        })
      }

      // Person with no flat linked
      if (p.ownerships.length === 0 && p.tenancies.length === 0) {
        results.push({
          type:        'person',
          matchedOn,
          matchedValue: matchedOn === 'Name' ? p.name : p.phone,
          person: {
            id:       p.id,
            name:     p.name,
            phone:    p.phone,
            altPhone: p.altPhone,
            email:    p.email,
          },
          flat:     null,
          vehicles: p.vehicles,
          role:     null,
        })
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
