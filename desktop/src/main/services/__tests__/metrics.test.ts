import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrations'
import { seedIfEmpty } from '../../db/seed'
import {
  addCasePayment,
  addLegacyPayment,
  brandFeed,
  confirmSettlementPayment,
  findDuplicatePayment,
  listCasePayments,
  listLegacyPayments,
  markPaymentReceived,
  updateCasePayment,
  metricsSummary,
  parseSettlementAmountCents,
  policingRecord,
  policingRecordMarkdown,
  removeCasePayment,
  removeLegacyPayment,
  unrecordedSettlements
} from '../metrics'
import { createCase, getCase } from '../../db/queries'

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

describe('legacy entries and unrecorded settlements', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('legacy entries count toward totals and can be removed', () => {
    const before = metricsSummary(db).grandTotalCents
    const e = addLegacyPayment(db, {
      label: 'Older matter',
      type: 'Expired License',
      amountCents: 500_000,
      year: 2021,
      resolvedBy: 'JP'
    })
    const after = metricsSummary(db)
    expect(after.grandTotalCents).toBe(before + 500_000)
    expect(after.years.find((y) => y.year === 2021)!.totalCents).toBe(500_000)
    expect(after.resolvers.find((r) => r.who === 'JP')!.totalCents).toBe(500_000)
    // The entry's own infringement type drives the by-type split (v1 parity),
    // rather than collapsing into a generic "Legacy entry" bucket.
    expect(after.years.find((y) => y.year === 2021)!.byType['Expired License']).toBe(500_000)
    expect(listLegacyPayments(db)[0]!.type).toBe('Expired License')
    expect(listLegacyPayments(db)).toHaveLength(1)

    removeLegacyPayment(db, e.id)
    expect(listLegacyPayments(db)).toHaveLength(0)
    expect(metricsSummary(db).grandTotalCents).toBe(before)
  })

  it('parses k-notation and dollar amounts', () => {
    expect(parseSettlementAmountCents('Paid settlement, 17k')).toBe(1_700_000)
    expect(parseSettlementAmountCents('7.5k license')).toBe(750_000)
    expect(parseSettlementAmountCents('$10,000 + full cessation')).toBe(1_000_000)
    expect(parseSettlementAmountCents('cessation only')).toBeNull()
  })

  it('classifies demands as positions so unpaid money is never booked as income', () => {
    const rawc = db.prepare("SELECT id FROM cases WHERE title = 'Rawcology Inc.'").get() as {
      id: number
    }
    const hc = db
      .prepare("SELECT id FROM cases WHERE title = 'The Healthy Crunch Company'")
      .get() as { id: number }
    db.prepare("UPDATE cases SET settlement_position = 'Paid settlement, 17k' WHERE id = ?").run(
      hc.id
    )

    const s = unrecordedSettlements(db)
    const byCase = Object.fromEntries(s.map((x) => [x.caseId, x]))
    // "$30,000 opening / $25,000 compromise" is a negotiating position
    expect(byCase[rawc.id]!.reading).toBe('position')
    expect(byCase[hc.id]!.reading).toBe('received')
    expect(byCase[hc.id]!.suggestedCents).toBe(1_700_000)
  })

  it('confirming a suggestion books the payment and logs it, then drops it from the queue', () => {
    const hc = db
      .prepare("SELECT id FROM cases WHERE title = 'The Healthy Crunch Company'")
      .get() as { id: number }
    const before = metricsSummary(db).grandTotalCents
    expect(unrecordedSettlements(db).some((s) => s.caseId === hc.id)).toBe(true)

    confirmSettlementPayment(db, hc.id, 1_000_000, '2026-03-15', 'Trestle')

    expect(metricsSummary(db).grandTotalCents).toBe(before + 1_000_000)
    expect(metricsSummary(db).resolvers.find((r) => r.who === 'Trestle')!.totalCents).toBe(1_000_000)
    // Once a payment exists the case leaves the review queue.
    expect(unrecordedSettlements(db).some((s) => s.caseId === hc.id)).toBe(false)
    const ev = db
      .prepare("SELECT body FROM case_events WHERE case_id = ? AND kind = 'payment'")
      .get(hc.id) as { body: string }
    expect(ev.body).toContain('$10,000')
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

describe('case payment ledger', () => {
  let db: Database.Database
  let caseId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
    caseId = createCase(db, {
      title: 'Ledger Co',
      licenseeName: 'Ledger Co',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-05'
    }).id
  })

  const baseline = (): number => metricsSummary(db).grandTotalCents

  it('a received payment lands in the metrics for its received year', () => {
    const before = baseline()
    addCasePayment(db, caseId, { amountCents: 1_000_000, received: true, date: '2026-03-14' })

    const m = metricsSummary(db)
    expect(m.grandTotalCents).toBe(before + 1_000_000)
    const y = m.years.find((r) => r.year === 2026)!
    expect(y.totalCents).toBe(1_000_000)
    // Type falls through to the case's, so it isn't filed as a legacy entry.
    expect(y.byType['Expired License']).toBe(1_000_000)
  })

  it('an expected payment is recorded but stays out of the income rollups', () => {
    const before = baseline()
    addCasePayment(db, caseId, { amountCents: 500_000, received: false, date: '2026-09-01' })

    expect(metricsSummary(db).grandTotalCents).toBe(before)
    const [p] = listCasePayments(db, caseId)
    expect(p!.received).toBe(false)
    expect(p!.dueDate).toBe('2026-09-01')
    expect(p!.receivedDate).toBeNull()
  })

  it('marking an expected payment received books it under the date it arrived', () => {
    const p = addCasePayment(db, caseId, {
      amountCents: 500_000,
      received: false,
      date: '2026-12-20'
    })
    // Cheque cut in December, cleared in January — the money is 2027 income.
    markPaymentReceived(db, p.id, '2027-01-08')

    const m = metricsSummary(db)
    expect(m.years.find((r) => r.year === 2026)?.totalCents ?? 0).toBe(0)
    expect(m.years.find((r) => r.year === 2027)!.totalCents).toBe(500_000)

    const [row] = listCasePayments(db, caseId)
    expect(row!.received).toBe(true)
    expect(row!.dueDate).toBe('2026-12-20')
    expect(row!.receivedDate).toBe('2027-01-08')
    // The timeline entry is corrected in place rather than duplicated.
    const events = getCase(db, caseId)!.events.filter((e) => e.kind === 'payment')
    expect(events).toHaveLength(1)
    expect(events[0]!.body).toContain('received')
    expect(events[0]!.at).toBe('2027-01-08')
  })

  it('resolution credit follows the case unless the payment overrides it', () => {
    addCasePayment(db, caseId, { amountCents: 100_000, received: true, date: '2026-02-01' })
    addCasePayment(db, caseId, {
      amountCents: 200_000,
      received: true,
      date: '2026-02-02',
      resolvedBy: 'Trestle'
    })

    // With the case unassigned, the inheriting row is unassigned too.
    let m = metricsSummary(db)
    expect(m.years.find((r) => r.year === 2026)!.byResolver['Unassigned']).toBe(100_000)
    expect(m.years.find((r) => r.year === 2026)!.byResolver['Trestle']).toBe(200_000)

    // Crediting the case later moves the inheriting row and leaves the override.
    db.prepare("UPDATE cases SET resolved_by = 'JP' WHERE id = ?").run(caseId)
    m = metricsSummary(db)
    expect(m.years.find((r) => r.year === 2026)!.byResolver['JP']).toBe(100_000)
    expect(m.years.find((r) => r.year === 2026)!.byResolver['Trestle']).toBe(200_000)

    const rows = listCasePayments(db, caseId)
    expect(rows[0]!.resolvedBy).toBeNull()
    expect(rows[0]!.effectiveResolvedBy).toBe('JP')
    expect(rows[1]!.resolvedBy).toBe('Trestle')
  })

  it('flags a same amount-and-date payment already on the ledger under another case', () => {
    addCasePayment(db, caseId, { amountCents: 750_000, received: true, date: '2026-04-01' })
    const other = createCase(db, {
      title: 'Other Co',
      licenseeName: 'Other Co',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-05'
    }).id

    const match = findDuplicatePayment(db, other, 750_000, '2026-04-01')
    expect(match?.label).toBe('Ledger Co')
    expect(match?.sameCase).toBe(false)
    expect(findDuplicatePayment(db, caseId, 750_000, '2026-04-01')?.sameCase).toBe(true)
    // A different amount or date is a different payment.
    expect(findDuplicatePayment(db, other, 750_001, '2026-04-01')).toBeNull()
    expect(findDuplicatePayment(db, other, 750_000, '2026-04-02')).toBeNull()
  })

  it('removing a payment takes it out of the metrics and retracts its timeline claim', () => {
    const before = baseline()
    const p = addCasePayment(db, caseId, {
      amountCents: 300_000,
      received: true,
      date: '2026-05-05'
    })
    expect(metricsSummary(db).grandTotalCents).toBe(before + 300_000)

    removeCasePayment(db, p.id)
    expect(metricsSummary(db).grandTotalCents).toBe(before)
    expect(listCasePayments(db, caseId)).toHaveLength(0)

    const events = getCase(db, caseId)!.events.filter((e) => e.kind === 'payment')
    expect(events).toHaveLength(1)
    expect(events[0]!.body).toContain('Removed')
  })

  it('editing a payment corrects the amount, date and credit in the rollups', () => {
    const before = baseline()
    const p = addCasePayment(db, caseId, {
      amountCents: 100_000,
      received: true,
      date: '2026-03-01'
    })
    // Typo: should have been $9,500 on 2026-04-02, credited to Trestle.
    updateCasePayment(db, p.id, {
      amountCents: 950_000,
      received: true,
      date: '2026-04-02',
      resolvedBy: 'Trestle'
    })

    const m = metricsSummary(db)
    expect(m.grandTotalCents).toBe(before + 950_000)
    expect(m.years.find((r) => r.year === 2026)!.byResolver['Trestle']).toBe(950_000)

    const [row] = listCasePayments(db, caseId)
    expect(row!.amountCents).toBe(950_000)
    expect(row!.receivedDate).toBe('2026-04-02')
    expect(row!.resolvedBy).toBe('Trestle')
    // One timeline entry, corrected — not a second one contradicting the first.
    const events = getCase(db, caseId)!.events.filter((e) => e.kind === 'payment')
    expect(events).toHaveLength(1)
    expect(events[0]!.body).toContain('9,500.00')
    expect(events[0]!.at).toBe('2026-04-02')
  })

  it('editing a received payment back to expected clears its collection date', () => {
    const before = baseline()
    const p = addCasePayment(db, caseId, {
      amountCents: 400_000,
      received: true,
      date: '2026-06-01'
    })
    // Booked in error — the cheque never cleared.
    updateCasePayment(db, p.id, { amountCents: 400_000, received: false, date: '2026-06-01' })

    expect(metricsSummary(db).grandTotalCents).toBe(before)
    const [row] = listCasePayments(db, caseId)
    expect(row!.received).toBe(false)
    expect(row!.receivedDate).toBeNull()
    expect(row!.dueDate).toBe('2026-06-01')
  })

  it('marking an edited installment received keeps the due date it was measured against', () => {
    const p = addCasePayment(db, caseId, {
      amountCents: 250_000,
      received: false,
      date: '2026-08-15'
    })
    updateCasePayment(db, p.id, { amountCents: 250_000, received: true, date: '2026-08-20' })
    const [row] = listCasePayments(db, caseId)
    expect(row!.dueDate).toBe('2026-08-15')
    expect(row!.receivedDate).toBe('2026-08-20')
  })

  it('rejects amounts and dates that would corrupt the rollups', () => {
    expect(() =>
      addCasePayment(db, caseId, { amountCents: 0, received: true, date: '2026-01-01' })
    ).toThrow(/greater than zero/)
    expect(() =>
      addCasePayment(db, caseId, { amountCents: -500, received: true, date: '2026-01-01' })
    ).toThrow(/greater than zero/)
    expect(() =>
      addCasePayment(db, caseId, { amountCents: 1000, received: true, date: '05/05/2026' })
    ).toThrow(/YYYY-MM-DD/)
    expect(() =>
      addCasePayment(db, 999_999, { amountCents: 1000, received: true, date: '2026-01-01' })
    ).toThrow(/not found/)
    expect(() => markPaymentReceived(db, 999_999, '2026-01-01')).toThrow(/not found/)
    expect(() => removeCasePayment(db, 999_999)).toThrow(/not found/)
    expect(() =>
      updateCasePayment(db, 999_999, { amountCents: 1000, received: true, date: '2026-01-01' })
    ).toThrow(/not found/)
  })
})
