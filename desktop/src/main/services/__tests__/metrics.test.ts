import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrations'
import { seedIfEmpty } from '../../db/seed'
import { brandFeed, metricsSummary, policingRecord, policingRecordMarkdown } from '../metrics'
import { createCase } from '../../db/queries'

describe('metrics summary', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('rolls up seeded precedent payments by year with an explicit Unassigned bucket', () => {
    const m = metricsSummary(db)
    // Seed: Allive $4,000 (2023), Prime Shrimp $6,000 (2023), Yoleez $3,000 + $5,250 (2023)
    expect(m.grandTotalCents).toBe(1_825_000)
    expect(m.years).toHaveLength(1)
    expect(m.years[0]!.year).toBe(2023)
    expect(m.years[0]!.count).toBe(4)

    // Nothing is attributed yet, so all of it must land in Unassigned —
    // attributed + unassigned always reconciles to the grand total.
    expect(m.attributedCents).toBe(0)
    expect(m.unassignedCents).toBe(1_825_000)
    expect(m.attributedCents + m.unassignedCents).toBe(m.grandTotalCents)
  })

  it('attributes payments once resolution credit is set', () => {
    const c = db.prepare("SELECT id FROM cases WHERE title = 'Allive Europe UAB'").get() as {
      id: number
    }
    db.prepare("UPDATE cases SET resolved_by = 'JP' WHERE id = ?").run(c.id)
    const m = metricsSummary(db)
    expect(m.resolvers.find((r) => r.who === 'JP')!.totalCents).toBe(400_000)
    expect(m.unassignedCents).toBe(1_425_000)
    expect(m.attributedCents + m.unassignedCents).toBe(m.grandTotalCents)
  })
})

describe('policing record', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('lists enforcement actions for a mark with registration caveats intact', () => {
    // Healthy Crunch is seeded with a CP + PF license and an open case.
    const r = policingRecord(db, 'CP')
    expect(r.markCode).toBe('CP')
    expect(r.usptoRegNo).toBe('4767643')
    expect(r.entries.some((e) => e.caseTitle === 'The Healthy Crunch Company')).toBe(true)

    const md = policingRecordMarkdown(r)
    expect(md).toContain('# Policing Record —')
    expect(md).toContain('4767643')
    expect(md).toContain('The Healthy Crunch Company')
  })

  it('rejects an unknown mark rather than emitting an empty record', () => {
    expect(() => policingRecord(db, 'NOPE')).toThrow(/Unknown mark code/)
  })

  it('discloses unattributed matters so the record is never read as complete', () => {
    // Seeded precedent cases (Allive, Prime Shrimp, Yoleez) have no licenses,
    // so they cannot be attributed to a mark and must be disclosed as excluded.
    const r = policingRecord(db, 'CP')
    expect(r.unattributableCases).toBeGreaterThan(0)
    expect(r.totalCases).toBeGreaterThan(r.entries.length)
    const md = policingRecordMarkdown(r)
    expect(md).toContain('Coverage note')
    expect(md).toContain('subset')
  })
})

describe('repeat-infringer flagging', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('flags a licensee opening a second matter and notes willfulness', () => {
    const second = createCase(db, {
      title: 'Rawcology Inc.',
      licenseeName: 'Rawcology Inc.',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-07-27'
    })
    const licensee = db
      .prepare('SELECT repeat_infringer AS flag FROM licensees WHERE id = ?')
      .get(second.licenseeId) as { flag: number }
    expect(licensee.flag).toBe(1)

    const events = db
      .prepare("SELECT body FROM case_events WHERE case_id = ? AND kind = 'note'")
      .all(second.id) as Array<{ body: string }>
    expect(events.some((e) => e.body.includes('REPEAT INFRINGER'))).toBe(true)
    expect(events.some((e) => e.body.includes('willfulness'))).toBe(true)
  })

  it('does not flag a first-time infringer', () => {
    const first = createCase(db, {
      title: 'Brand New Co',
      licenseeName: 'Brand New Co',
      type: 'Unlicensed Use - Never Certified',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-07-27'
    })
    const licensee = db
      .prepare('SELECT repeat_infringer AS flag FROM licensees WHERE id = ?')
      .get(first.licenseeId) as { flag: number }
    expect(licensee.flag).toBe(0)
  })
})

describe('brand feed', () => {
  it('reports certified vs expired with marks and through-date', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)

    const feed = brandFeed(db)
    expect(feed.schema).toBe('fafo.brand-feed/v1')
    const hc = feed.brands.find((b) => b.brand === 'The Healthy Crunch Company')!
    expect(hc.status).toBe('expired') // seeded license status is 'expired'
    expect(hc.marks.sort()).toEqual(['CP', 'PF'])
    expect(hc.certifiedThrough).toBeNull()
  })
})
