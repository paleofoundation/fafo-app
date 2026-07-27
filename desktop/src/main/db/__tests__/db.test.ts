import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../migrations'
import { seedIfEmpty } from '../seed'
import * as q from '../queries'

/**
 * M1 acceptance: migrations apply cleanly, the four active matters seed with
 * their known dates, and the deadline surface reports what it must.
 */
describe('db layer (in-memory)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('migrates and seeds idempotently', () => {
    migrate(db)
    seedIfEmpty(db)
    const cases = q.listCases(db)
    expect(cases.filter((c) => c.status !== 'Resolved')).toHaveLength(4)
    expect(cases).toHaveLength(7)
  })

  it('reproduces the four active matters with known dates (M1 acceptance)', () => {
    const cases = q.listCases(db)
    const byTitle = Object.fromEntries(cases.map((c) => [c.title, c]))

    expect(byTitle['The Healthy Crunch Company']?.openedAt).toBe('2025-11-26')
    expect(byTitle['Love Good Foods']?.type).toBe('Unlicensed Use - Change in Ownership')
    expect(byTitle['Rawcology Inc.']?.settlementPosition).toBe('$30,000 opening / $25,000 compromise')
    expect(byTitle['Little West']?.type).toBe('Unlicensed Use - Never Certified')
  })

  it('Healthy Crunch sell-off deadline = license end + 180 days', () => {
    const deadlines = q.listDeadlines(db)
    const hc = deadlines.find((d) => d.title.startsWith('Healthy Crunch'))
    expect(hc?.dueAt).toBe('2026-05-25')
  })

  it('2020-vintage Love Good license carries NO sell-off deadline, only response clock', () => {
    const deadlines = q.listDeadlines(db).filter((d) => d.title.includes('Love Good'))
    expect(deadlines).toHaveLength(1)
    expect(deadlines[0]?.kind).toBe('letter_response')
  })

  it('overdue deadlines surface for today (2026-07-27 fixture)', () => {
    const overdue = q.overdueDeadlines(db, '2026-07-27')
    // Healthy Crunch sell-off (05-25), Love Good response (04-23), Little West docket (05-21)
    expect(overdue.length).toBeGreaterThanOrEqual(3)
    expect(overdue[0]!.dueAt <= overdue[1]!.dueAt).toBe(true)
  })

  it('case CRUD round-trips and logs status changes to the timeline', () => {
    const created = q.createCase(db, {
      title: 'Test Co',
      licenseeName: 'Test Co LLC',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-07-01'
    })
    expect(created.licenseeName).toBe('Test Co LLC')

    q.updateCase(db, created.id, { status: 'Resolved', resolvedBy: 'JP' })
    const after = q.getCase(db, created.id)!
    expect(after.case.status).toBe('Resolved')
    expect(after.case.resolvedAt).not.toBeNull()
    expect(after.events.some((e) => e.kind === 'status_change' && e.body.includes('→ Resolved'))).toBe(true)
  })

  it('licensee matching reuses existing entities by normalized name', () => {
    const a = q.createCase(db, {
      title: 'Rawcology follow-up',
      licenseeName: 'RAWCOLOGY, INC.',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-07-27'
    })
    const rawcology = q.listLicensees(db).filter((l) => l.normalizedName === 'rawcology')
    expect(rawcology).toHaveLength(1)
    expect(a.licenseeId).toBe(rawcology[0]!.id)
  })

  it('marks seed includes the legal caveats that letters must respect', () => {
    const marks = q.listMarks(db)
    expect(marks).toHaveLength(7)
    expect(marks.find((m) => m.code === 'CP')?.notes).toContain('SERVICE mark')
    expect(marks.find((m) => m.code === 'PB')?.regStatus).toBe('Pending')
  })
})
