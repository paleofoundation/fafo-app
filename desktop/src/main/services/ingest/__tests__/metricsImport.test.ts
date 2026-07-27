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
