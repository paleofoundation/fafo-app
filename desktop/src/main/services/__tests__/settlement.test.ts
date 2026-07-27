import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrations'
import { quoteSettlement } from '../settlement'
import { nextResponseThursday } from '../../../shared/domain/deadlines'

describe('response clock (protocol: EOD Thursday)', () => {
  it('gives at least 3 days, else slips to the following Thursday', () => {
    expect(nextResponseThursday('2026-07-27')).toBe('2026-07-30') // Mon → Thu (3d)
    expect(nextResponseThursday('2026-07-28')).toBe('2026-08-06') // Tue → only 2d, slip
    expect(nextResponseThursday('2026-07-30')).toBe('2026-08-06') // Thu → next Thu
    expect(nextResponseThursday('2026-07-31')).toBe('2026-08-06') // Fri → 6d
  })
})

describe('settlement calculator', () => {
  let db: Database.Database

  function seedCase(vintage: '2020' | '2025', termEnd: string, feeCents: number | null): number {
    const lid = Number(
      db.prepare("INSERT INTO licensees (name, normalized_name) VALUES ('Acme', 'acme')").run()
        .lastInsertRowid
    )
    db.prepare(
      `INSERT INTO licenses (licensee_id, vintage, term_end, annual_fee_cents, status)
       VALUES (?, ?, ?, ?, 'expired')`
    ).run(lid, vintage, termEnd, feeCents)
    return Number(
      db
        .prepare(
          `INSERT INTO cases (licensee_id, title, type, status, source, opened_at)
           VALUES (?, 'Acme', 'Expired License', 'Open', 'Website', '2026-01-01')`
        )
        .run(lid).lastInsertRowid
    )
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
  })

  it('2025 vintage: damages accrue from sell-off end, LD formula', () => {
    const caseId = seedCase('2025', '2025-11-26', 1_000_000) // $10,000/yr
    const q = quoteSettlement(db, caseId, '2026-07-27')
    expect(q.formula).toBe('ld')
    expect(q.selloffEnd).toBe('2026-05-25') // +180d
    expect(q.monthsOfMisuse).toBe(3) // 05-25 → 07-27
    expect(q.opening).toBe(30_000)
    expect(q.compromiseLow).toBe(24_000)
    expect(q.compromiseHigh).toBe(25_500)
    expect(q.notes).toContain('sell-off end')
  })

  it('2020 legacy: no sell-off, accrues from license end, legacy formula', () => {
    const caseId = seedCase('2020', '2023-07-30', 1_000_000)
    const q = quoteSettlement(db, caseId, '2026-07-30')
    expect(q.formula).toBe('legacy')
    expect(q.selloffEnd).toBeNull()
    expect(q.monthsOfMisuse).toBe(36)
    expect(q.opening).toBe(30_000) // $10k × 3 years
    expect(q.notes).toContain('no sell-off')
  })

  it('refuses to guess when the term end is unknown', () => {
    const caseId = seedCase('2025', null as unknown as string, 1_000_000)
    expect(() => quoteSettlement(db, caseId)).toThrow(/term end is unknown/)
  })
})
