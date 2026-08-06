import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../../db/migrations'
import { seedIfEmpty } from '../../../db/seed'
import { metricsSummary } from '../../metrics'
import {
  commitMetricsImport,
  parseCsvExport,
  planMetricsImport,
  type MetricsExport
} from '../metricsImport'

// Fixtures vendored from the v1 metrics-export bundle into docs/fixtures, so
// the suite doesn't depend on the original download still being present.
const BUNDLE = path.resolve(__dirname, '../../../../../../docs/fixtures')
const hasBundle = fs.existsSync(path.join(BUNDLE, 'metrics-seed-example.json'))

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedIfEmpty(db)
  return db
}

describe('v1 metrics export importer', () => {
  let db: Database.Database

  beforeEach(() => {
    db = freshDb()
  })

  const sample: MetricsExport = {
    schema: 'fafo.metrics.v2',
    sourceAppVersion: 'v1.0.4-r67',
    summary: { realizedIncome: 12000 },
    rows: [
      {
        rowType: 'legacy_entry',
        legacyId: 7,
        infringer: 'Old Matter Co',
        infringementType: 'Expired License',
        resolvedBy: 'JP',
        amount: 9000,
        year: 2021,
        received: true
      },
      {
        rowType: 'case_payment',
        caseId: 999,
        infringer: 'Rawcology Inc.',
        infringementType: 'Expired License',
        resolvedBy: 'Trestle',
        amount: 3000,
        paymentDate: '2025-09-01',
        year: 2025,
        received: true
      }
    ]
  }

  it('rejects an unexpected schema id', () => {
    const plan = planMetricsImport(db, { ...sample, schema: 'something.else' })
    expect(plan.schemaOk).toBe(false)
    expect(plan.verification.messages[0]).toContain('Unexpected schema')
    expect(() => commitMetricsImport(db, { ...sample, schema: 'x' }, plan)).toThrow(/Refusing/)
  })

  it('imports legacy and case rows, linking case rows to the matching case', () => {
    const before = metricsSummary(db).grandTotalCents
    const plan = planMetricsImport(db, sample)
    expect(plan.totals.toImport).toBe(2)

    const r = commitMetricsImport(db, sample, plan)
    expect(r.imported).toBe(2)
    expect(r.linkedToCases).toBe(1) // Rawcology matched
    expect(r.legacyRows).toBe(1)

    const m = metricsSummary(db)
    expect(m.grandTotalCents).toBe(before + 1_200_000)
    expect(m.resolvers.find((x) => x.who === 'JP')!.totalCents).toBe(900_000)
    expect(m.resolvers.find((x) => x.who === 'Trestle')!.totalCents).toBe(300_000)
    // Rule 2: the three buckets always reconcile to the total.
    expect(m.attributedCents + m.unassignedCents).toBe(m.grandTotalCents)
  })

  it('is idempotent — re-importing the same export changes nothing', () => {
    commitMetricsImport(db, sample, planMetricsImport(db, sample))
    const after = metricsSummary(db).grandTotalCents

    const plan2 = planMetricsImport(db, sample)
    expect(plan2.totals.alreadyImported).toBe(2)
    expect(plan2.totals.toImport).toBe(0)
    const r2 = commitMetricsImport(db, sample, plan2)
    expect(r2.imported).toBe(0)
    expect(metricsSummary(db).grandTotalCents).toBe(after)
  })

  it('does not double-count payments already seeded from the same v1 presets', () => {
    // v2 seeds Allive $4,000 on 2023-06-01 from the same v1 preset case.
    const dupe: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 201,
          infringer: 'Allive Europe UAB',
          infringementType: 'Unlicensed Use - Never Certified',
          resolvedBy: null,
          amount: 4000,
          paymentDate: '2023-06-01',
          year: 2023,
          received: true
        }
      ]
    }
    const before = metricsSummary(db).grandTotalCents
    const plan = planMetricsImport(db, dupe)
    expect(plan.rows[0]!.action).toBe('duplicate-of-existing')
    commitMetricsImport(db, dupe, plan)
    expect(metricsSummary(db).grandTotalCents).toBe(before)
  })

  it('keeps unreceived rows out of income but still imports them', () => {
    const pending: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 500,
          infringer: 'Little West',
          infringementType: 'Unlicensed Use - Never Certified',
          resolvedBy: null,
          amount: 15000,
          paymentDate: '2026-02-01',
          year: 2026,
          received: false
        }
      ]
    }
    const before = metricsSummary(db).grandTotalCents
    commitMetricsImport(db, pending, planMetricsImport(db, pending))
    expect(metricsSummary(db).grandTotalCents).toBe(before) // rule 1
    const row = db.prepare('SELECT received FROM payments WHERE import_key IS NOT NULL').get() as {
      received: number
    }
    expect(row.received).toBe(0)
  })

  it('preserves infringementType on rows with no case, driving the by-type split', () => {
    // METRICS_SCHEMA.md: infringementType "drives the by-type breakdown".
    // Without it every case-less row collapses into one "Legacy entry" bucket.
    const typed: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'legacy_entry',
          legacyId: 11,
          infringer: 'Historic A',
          infringementType: 'Expired License',
          resolvedBy: null,
          amount: 1000,
          year: 2020,
          received: true
        },
        {
          rowType: 'legacy_entry',
          legacyId: 12,
          infringer: 'Historic B',
          infringementType: 'Unlicensed Use - Never Certified',
          resolvedBy: null,
          amount: 2000,
          year: 2020,
          received: true
        }
      ]
    }
    commitMetricsImport(db, typed, planMetricsImport(db, typed))
    const y2020 = metricsSummary(db).years.find((y) => y.year === 2020)!
    expect(y2020.byType['Expired License']).toBe(100_000)
    expect(y2020.byType['Unlicensed Use - Never Certified']).toBe(200_000)
    expect(y2020.byType['Legacy entry']).toBeUndefined()
  })

  it('detects stale payments the export replaces, and can supersede them', () => {
    // v2 seeded Yoleez as $3,000 + $5,250; the live v1 export records a single
    // $7,500 payment. Keeping both would report $15,750 for one settlement.
    const yoleez: MetricsExport = {
      schema: 'fafo.metrics.v2',
      exportedAt: '2026-08-06T09:34:52.186Z',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 203,
          infringer: 'Yoleez LLC',
          infringementType: 'Expired License',
          resolvedBy: 'Trestle',
          amount: 7500,
          paymentDate: '2025-08-04',
          year: 2025,
          received: true
        }
      ]
    }
    const plan = planMetricsImport(db, yoleez)
    expect(plan.conflicts).toHaveLength(1)
    const c = plan.conflicts[0]!
    expect(c.caseTitle).toBe('Yoleez LLC')
    expect(c.existing).toHaveLength(2)
    expect(c.keepBothCents).toBe(1_575_000) // 3,000 + 5,250 + 7,500
    expect(c.supersedeCents).toBe(750_000) // 7,500
    expect(plan.verification.messages.join(' ')).toContain('double-count')

    const before = metricsSummary(db).grandTotalCents
    const r = commitMetricsImport(db, yoleez, plan, true)
    expect(r.supersededPayments).toBe(2)
    // Net effect: the stale $8,250 leaves, the authoritative $7,500 arrives.
    expect(metricsSummary(db).grandTotalCents).toBe(before - 825_000 + 750_000)
    const ev = db
      .prepare("SELECT body FROM case_events WHERE kind = 'import' AND body LIKE 'Superseded%'")
      .get() as { body: string }
    expect(ev.body).toContain('$3,000')
  })

  it('leaves stale payments alone when superseding is declined', () => {
    const yoleez: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 203,
          infringer: 'Yoleez LLC',
          infringementType: 'Expired License',
          resolvedBy: 'Trestle',
          amount: 7500,
          paymentDate: '2025-08-04',
          year: 2025,
          received: true
        }
      ]
    }
    const before = metricsSummary(db).grandTotalCents
    const plan = planMetricsImport(db, yoleez)
    const r = commitMetricsImport(db, yoleez, plan, false)
    expect(r.supersededPayments).toBe(0)
    expect(metricsSummary(db).grandTotalCents).toBe(before + 750_000)
  })

  it('does not report a conflict when the export exactly reproduces what is on file', () => {
    const allive: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 201,
          infringer: 'Allive Europe UAB',
          infringementType: 'Unlicensed Use - Never Certified',
          resolvedBy: null,
          amount: 4000,
          paymentDate: '2023-06-01',
          year: 2023,
          received: true
        }
      ]
    }
    const plan = planMetricsImport(db, allive)
    expect(plan.rows[0]!.action).toBe('duplicate-of-existing')
    expect(plan.conflicts).toHaveLength(0)
  })

  it('corrects an on-file payment the export says was never collected, without deleting it', () => {
    // The app recorded Allive as collected; suppose the export says it wasn't.
    // The row must be corrected in place — deleting it would make a re-import
    // re-add the row, and treating it as stale would double-handle it.
    const notCollected: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 201,
          infringer: 'Allive Europe UAB',
          infringementType: 'Unlicensed Use - Never Certified',
          resolvedBy: 'JP',
          amount: 4000,
          paymentDate: '2023-06-01',
          year: 2023,
          received: false
        }
      ]
    }
    const before = metricsSummary(db).grandTotalCents
    const plan = planMetricsImport(db, notCollected)
    expect(plan.conflicts).toHaveLength(0) // accounted for, not stale
    expect(plan.statusFixes).toHaveLength(1)
    expect(plan.statusFixes[0]!.currentlyReceived).toBe(true)
    expect(plan.statusFixes[0]!.exportSaysReceived).toBe(false)
    expect(plan.statusFixes[0]!.exportResolvedBy).toBe('JP')

    const r = commitMetricsImport(db, notCollected, plan, true)
    expect(r.statusCorrected).toBe(1)
    expect(r.supersededPayments).toBe(0)
    expect(metricsSummary(db).grandTotalCents).toBe(before - 400_000)

    // Still exactly one row for it, and a re-import is a no-op.
    const rows = db
      .prepare('SELECT received, resolved_by AS who FROM payments WHERE amount_cents = 400000')
      .all() as Array<{ received: number; who: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.received).toBe(0)
    expect(rows[0]!.who).toBe('JP')
    const again = commitMetricsImport(db, notCollected, planMetricsImport(db, notCollected), true)
    expect(again.imported).toBe(0)
  })

  it('detects the same settlement filed under a differently-named case', () => {
    // v2 seeds Yoleez as $3,000 + $5,250; a separate case also carries the
    // real $7,500. A per-case duplicate check misses this and books it twice.
    db.prepare(
      `INSERT INTO cases (licensee_id, title, type, status, source, opened_at)
       VALUES (NULL, 'Eramir LLC / Yoleez', 'Expired License', 'Resolved', 'Website', '2025-01-01')`
    ).run()
    const other = db.prepare("SELECT id FROM cases WHERE title = 'Eramir LLC / Yoleez'").get() as {
      id: number
    }
    db.prepare(
      `INSERT INTO payments (case_id, amount_cents, received_date, received, year)
       VALUES (?, 750000, '2025-08-04', 1, 2025)`
    ).run(other.id)

    const exp: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [
        {
          rowType: 'case_payment',
          caseId: 203,
          infringer: 'Yoleez LLC',
          infringementType: 'Expired License',
          resolvedBy: 'Trestle',
          amount: 7500,
          paymentDate: '2025-08-04',
          year: 2025,
          received: true
        }
      ]
    }
    const plan = planMetricsImport(db, exp)
    // Recognised as already on file under the other case name…
    expect(plan.rows[0]!.action).toBe('duplicate-of-existing')
    expect(plan.rows[0]!.note).toContain('Eramir LLC / Yoleez')
    // …and the orphaned seed rows are still surfaced as superseded.
    const yoleez = plan.conflicts.find((c) => c.caseTitle === 'Yoleez LLC')!
    expect(yoleez.existing).toHaveLength(2)

    commitMetricsImport(db, exp, plan, true)
    const total = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents),0) c FROM payments WHERE received = 1 AND amount_cents IN (300000,525000,750000)`
      )
      .get() as { c: number }
    expect(total.c).toBe(750_000) // the one real settlement, not $15,750
  })

  it('flags summary drift but trusts the rows', () => {
    const drifted: MetricsExport = { ...sample, summary: { realizedIncome: 99999 } }
    const plan = planMetricsImport(db, drifted)
    expect(plan.verification.matches).toBe(false)
    expect(plan.verification.messages.join(' ')).toContain('Trusting the rows')
    expect(plan.verification.recomputedRealizedIncomeCents).toBe(1_200_000)
  })

  it('reports rows with no date and no year rather than dropping them', () => {
    const noYear: MetricsExport = {
      schema: 'fafo.metrics.v2',
      rows: [{ rowType: 'legacy_entry', legacyId: 3, infringer: 'X', amount: 100, received: true }]
    }
    const plan = planMetricsImport(db, noYear)
    expect(plan.rows[0]!.action).toBe('no-year')
    expect(plan.totals.withoutYear).toBe(1)
    commitMetricsImport(db, noYear, plan)
    expect(
      (db.prepare('SELECT COUNT(*) n FROM payments WHERE import_key IS NOT NULL').get() as { n: number }).n
    ).toBe(1)
  })

  it('parses the CSV form to the same shape', () => {
    const csv = [
      'rowType,caseId,legacyId,infringer,contact,infringementType,caseStatus,resolvedBy,trademarkIds,settlementPosition,dateOpened,amount,paymentDate,year,received,source,url',
      'case_payment,202,,Laitram / Prime Shrimp LLC,,Unlicensed Use - Never Certified,Resolved,,1,"$6,000",2023-01-01,6000,2023-08-01,2023,true,Website,'
    ].join('\n')
    const parsed = parseCsvExport(csv)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!.amount).toBe(6000)
    expect(parsed.rows[0]!.infringer).toBe('Laitram / Prime Shrimp LLC')
    expect(parsed.rows[0]!.received).toBe(true)
  })
})

describe.skipIf(!hasBundle)('against the real example bundle', () => {
  it('plans the shipped JSON example and verifies its summary', () => {
    const db = freshDb()
    const exp = JSON.parse(
      fs.readFileSync(path.join(BUNDLE, 'metrics-seed-example.json'), 'utf8')
    ) as MetricsExport
    const plan = planMetricsImport(db, exp)
    expect(plan.schemaOk).toBe(true)
    expect(plan.verification.matches).toBe(true) // recomputed == file summary
    expect(plan.verification.resolverIdentityHolds).toBe(true)
    // All four rows are the v1 presets v2 already seeded — none should import.
    expect(plan.totals.duplicateOfExisting).toBe(4)
    expect(plan.totals.toImport).toBe(0)
  })

  it('parses the shipped CSV example to the same row count', () => {
    const csv = fs.readFileSync(path.join(BUNDLE, 'metrics-seed-example.csv'), 'utf8')
    expect(parseCsvExport(csv).rows).toHaveLength(4)
  })
})
