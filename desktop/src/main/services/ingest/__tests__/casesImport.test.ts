import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../../db/migrations'
import { seedIfEmpty } from '../../../db/seed'
import { createCase, listCases, getCase } from '../../../db/queries'
import { listCasePayments, metricsSummary } from '../../metrics'
import {
  commitCaseImport,
  parseDelimited,
  parseMoneyCents,
  scanCaseImport,
  toIsoDate
} from '../casesImport'

const TODAY = '2026-08-06'

describe('case list parsing', () => {
  it('splits TSV, which is what a spreadsheet paste produces', () => {
    const grid = parseDelimited('Matter\tType\nAcme\tExpired License')
    expect(grid).toEqual([
      ['Matter', 'Type'],
      ['Acme', 'Expired License']
    ])
  })

  it('handles quoted CSV fields containing commas — the norm for legal entity names', () => {
    const grid = parseDelimited('Matter,Type\n"Ron\'s Schoolhouse Grille, Inc.",Unlicensed Use')
    expect(grid[1]).toEqual(["Ron's Schoolhouse Grille, Inc.", 'Unlicensed Use'])
  })

  it('handles escaped quotes and blank lines', () => {
    const grid = parseDelimited('Matter\n"The ""Real"" Paleo Co"\n\n')
    expect(grid[1]).toEqual(['The "Real" Paleo Co'])
    expect(grid).toHaveLength(2)
  })

  it('reads both date formats and rejects anything else', () => {
    expect(toIsoDate('2026-03-01')).toBe('2026-03-01')
    expect(toIsoDate('3/1/2026')).toBe('2026-03-01')
    expect(toIsoDate('3/1/26')).toBe('2026-03-01')
    expect(toIsoDate('March 1 2026')).toBeNull()
    expect(toIsoDate('')).toBeNull()
  })

  it('reads money in the forms the sheets actually use', () => {
    expect(parseMoneyCents('$10,000.00')).toBe(1_000_000)
    expect(parseMoneyCents('10000')).toBe(1_000_000)
    expect(parseMoneyCents('17k')).toBe(1_700_000)
    expect(parseMoneyCents('cessation only')).toBeNull()
    expect(parseMoneyCents('0')).toBeNull()
  })
})

describe('case import scan and commit', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('creates cases, maps loose headers, and records the money as received income', () => {
    const before = metricsSummary(db).grandTotalCents
    const text = [
      'Infringer,Violation,Date Identified,Stage,Handled By,Settlement Amount,Date Paid,Link',
      'Acme Foods,expired,3/1/2026,completed,Trestle,"$12,500",4/2/2026,acme.example',
      'Bogus Bars,never certified,2026-02-14,negotiations,JP,,,bogusbars.example'
    ].join('\n')

    const scan = scanCaseImport(db, text, TODAY)
    expect(scan.totals).toMatchObject({ rows: 2, create: 2, duplicate: 0, error: 0 })
    expect(scan.recognized).toContain('matter')
    expect(scan.unrecognized).toEqual([])

    const [acme, bogus] = scan.rows
    expect(acme!.type).toBe('Expired License')
    expect(acme!.status).toBe('Resolved')
    expect(acme!.openedAt).toBe('2026-03-01')
    expect(acme!.resolvedBy).toBe('Trestle')
    expect(acme!.amountCents).toBe(1_250_000)
    expect(acme!.paidOn).toBe('2026-04-02')
    expect(bogus!.type).toBe('Unlicensed Use - Never Certified')
    expect(bogus!.status).toBe('In Progress')
    expect(bogus!.resolvedBy).toBe('JP')

    const result = commitCaseImport(db, scan)
    expect(result).toMatchObject({ casesCreated: 2, paymentsRecorded: 1, skipped: 0 })

    const created = listCases(db).find((c) => c.title === 'Acme Foods')!
    expect(created.status).toBe('Resolved')
    expect(created.resolvedBy).toBe('Trestle')
    expect(created.url).toBe('acme.example')

    // The money lands in the rollups under the year it was paid, credited to
    // the case's resolver rather than pinned onto the payment row.
    const m = metricsSummary(db)
    expect(m.grandTotalCents).toBe(before + 1_250_000)
    expect(m.years.find((y) => y.year === 2026)!.byResolver['Trestle']).toBe(1_250_000)
    expect(listCasePayments(db, created.id)[0]!.resolvedBy).toBeNull()
  })

  it('flags rows that already exist rather than creating a second copy', () => {
    createCase(db, {
      title: 'Acme Foods',
      licenseeName: 'Acme Foods',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-01'
    })
    const scan = scanCaseImport(db, 'Matter\nACME FOODS, INC.\nNew Co', TODAY)
    expect(scan.rows[0]!.action).toBe('duplicate')
    expect(scan.rows[0]!.matchedCaseTitle).toBe('Acme Foods')
    expect(scan.rows[1]!.action).toBe('create')

    const result = commitCaseImport(db, scan)
    expect(result.casesCreated).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('does not create the same matter twice from one paste', () => {
    const scan = scanCaseImport(db, 'Matter\nDouble Co\nDouble Co.', TODAY)
    expect(scan.totals.create).toBe(1)
    expect(scan.rows[1]!.action).toBe('duplicate')
  })

  it('skips money already on the ledger instead of double-counting it', () => {
    // The seed carries Allive's $4,000 on 2023-06-15 as a precedent payment.
    const existing = db
      .prepare("SELECT amount_cents AS cents, received_date AS date FROM payments LIMIT 1")
      .get() as { cents: number; date: string }
    const before = metricsSummary(db).grandTotalCents

    const scan = scanCaseImport(
      db,
      `Matter,Amount,Date Paid\nSome Other Brand,${existing.cents / 100},${existing.date}`,
      TODAY
    )
    expect(scan.rows[0]!.paymentDuplicate).toBe(true)
    expect(scan.totals.recoveredCents).toBe(0)
    expect(scan.rows[0]!.messages.join(' ')).toMatch(/already on the ledger/)

    const result = commitCaseImport(db, scan)
    expect(result.casesCreated).toBe(1)
    expect(result.paymentsRecorded).toBe(0)
    expect(result.paymentsSkipped).toBe(1)
    expect(metricsSummary(db).grandTotalCents).toBe(before)
  })

  it('reports every defaulted field instead of silently guessing', () => {
    const scan = scanCaseImport(db, 'Matter,Type,Status,Opened\nVague Co,mystery,limbo,not a date', TODAY)
    const msgs = scan.rows[0]!.messages.join(' | ')
    expect(msgs).toMatch(/type "mystery" not recognized/)
    expect(msgs).toMatch(/status "limbo" not recognized/)
    expect(msgs).toMatch(/opened date "not a date" unreadable/)
    expect(scan.rows[0]!.openedAt).toBe(TODAY)
    expect(scan.rows[0]!.action).toBe('create')
  })

  it('treats a resolution date with no status as closed', () => {
    const scan = scanCaseImport(db, 'Matter,Resolved\nClosed Co,2026-05-05', TODAY)
    expect(scan.rows[0]!.status).toBe('Resolved')
    // With no opened date the resolution date is used, never a future-dated today.
    expect(scan.rows[0]!.openedAt).toBe('2026-05-05')
    commitCaseImport(db, scan)
    const c = listCases(db).find((x) => x.title === 'Closed Co')!
    expect(c.resolvedAt).toBe('2026-05-05')
  })

  it('rejects a row with no matter name and imports the rest', () => {
    const scan = scanCaseImport(db, 'Matter,Type\n,Expired License\nReal Co,Expired License', TODAY)
    expect(scan.rows[0]!.action).toBe('error')
    expect(scan.rows[0]!.messages[0]).toBe('no matter name')
    expect(commitCaseImport(db, scan)).toMatchObject({ casesCreated: 1, skipped: 1 })
  })

  it('refuses a sheet with no matter column rather than importing nonsense', () => {
    expect(() => scanCaseImport(db, 'Foo,Bar\n1,2', TODAY)).toThrow(/matter name/i)
  })

  it('seeds the first timeline entry from the notes column', () => {
    const scan = scanCaseImport(
      db,
      'Matter,Notes,Opened\nNoted Co,Found on their shop page,2026-04-01',
      TODAY
    )
    commitCaseImport(db, scan)
    const c = listCases(db).find((x) => x.title === 'Noted Co')!
    const events = getCase(db, c.id)!.events
    expect(events.some((e) => e.kind === 'import' && e.body === 'Found on their shop page')).toBe(
      true
    )
  })

  it('links a separate licensee name to the same entity as an existing case', () => {
    const scan = scanCaseImport(
      db,
      'Matter,Licensee\nRawcology follow-up,"Rawcology, Inc."',
      TODAY
    )
    expect(scan.rows[0]!.licensee).toBe('Rawcology, Inc.')
    commitCaseImport(db, scan)
    // Seeded Rawcology licensee is reused, and the repeat-infringer flag fires.
    const rows = db
      .prepare("SELECT repeat_infringer AS flag FROM licensees WHERE normalized_name = 'rawcology'")
      .all() as Array<{ flag: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.flag).toBe(1)
  })
})
