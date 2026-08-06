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

  it('previews and deletes a case with all of its children', () => {
    const target = q.createCase(db, {
      title: 'Duplicate Co',
      licenseeName: 'Duplicate Co',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-01'
    })
    q.addEvent(db, target.id, 'note', 'a note')
    q.addDeadline(db, {
      kind: 'custom',
      title: 'something',
      dueAt: '2026-02-01',
      refTable: 'cases',
      refId: target.id
    })
    db.prepare(
      `INSERT INTO payments (case_id, amount_cents, received_date, received, year)
       VALUES (?, 250000, '2026-01-15', 1, 2026)`
    ).run(target.id)
    db.prepare(
      `INSERT INTO letters (case_id, kind, body_text, drafted_at) VALUES (?, 'enforcement', 'x', '2026-01-02')`
    ).run(target.id)
    db.prepare(
      `INSERT INTO evidence_files (case_id, path, kind) VALUES (?, '/tmp/shot.png', 'screenshot')`
    ).run(target.id)

    const preview = q.previewCaseDeletion(db, target.id)
    expect(preview.title).toBe('Duplicate Co')
    expect(preview.events).toBe(2) // opened + the note
    expect(preview.deadlines).toBe(1)
    expect(preview.letters).toBe(1)
    expect(preview.payments).toBe(1)
    expect(preview.paymentsCents).toBe(250_000)
    expect(preview.evidenceFiles).toBe(1)

    const otherCases = q.listCases(db).length
    q.deleteCase(db, target.id)

    expect(q.getCase(db, target.id)).toBeNull()
    expect(q.listCases(db)).toHaveLength(otherCases - 1)
    // No orphaned children left behind in any child table.
    for (const [table, col] of [
      ['case_events', 'case_id'],
      ['letters', 'case_id'],
      ['payments', 'case_id'],
      ['evidence_files', 'case_id'],
      ['tracked_urls', 'case_id'],
      ['settlements', 'case_id']
    ] as Array<[string, string]>) {
      const n = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
        .get(target.id) as { n: number }
      expect(n.n, table).toBe(0)
    }
    const dl = db
      .prepare("SELECT COUNT(*) AS n FROM deadlines WHERE ref_table = 'cases' AND ref_id = ?")
      .get(target.id) as { n: number }
    expect(dl.n).toBe(0)
    // The licensee itself survives — only the case was a duplicate.
    expect(q.listLicensees(db).some((l) => l.name === 'Duplicate Co')).toBe(true)
  })

  it('refuses to preview a case that does not exist', () => {
    expect(() => q.previewCaseDeletion(db, 999_999)).toThrow(/not found/)
  })

  it('settings round-trip and upsert', () => {
    expect(q.getSetting(db, 'ms.clientId')).toBeNull()
    q.setSetting(db, 'ms.clientId', 'abc')
    q.setSetting(db, 'ms.clientId', 'def')
    expect(q.getSetting(db, 'ms.clientId')).toBe('def')
  })

  it('marks seed includes the legal caveats that letters must respect', () => {
    const marks = q.listMarks(db)
    expect(marks).toHaveLength(7)
    expect(marks.find((m) => m.code === 'CP')?.notes).toContain('SERVICE mark')
    expect(marks.find((m) => m.code === 'PB')?.regStatus).toBe('Pending')
  })
})

describe('merging duplicate cases', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  /** The real-world split: SignNow's legal name vs the folder's short name. */
  function makePair(): { primaryId: number; dupId: number } {
    const primary = q.createCase(db, {
      title: "OTTO'S NATURALS LLC",
      licenseeName: "OTTO'S NATURALS LLC",
      type: 'Expired License',
      status: 'Resolved',
      source: 'Website',
      openedAt: '2026-03-01'
    })
    const dup = q.createCase(db, {
      title: 'Ottos Naturals',
      licenseeName: 'Ottos Naturals Co',
      type: 'Expired License',
      status: 'In Progress',
      source: 'Website',
      openedAt: '2026-01-15'
    })
    return { primaryId: primary.id, dupId: dup.id }
  }

  it('moves every child row onto the survivor and deletes the duplicate', () => {
    const { primaryId, dupId } = makePair()
    q.addEvent(db, dupId, 'note', 'they replied')
    q.addDeadline(db, {
      kind: 'letter_response',
      title: 'response due',
      dueAt: '2026-04-01',
      refTable: 'cases',
      refId: dupId
    })
    db.prepare(
      `INSERT INTO payments (case_id, amount_cents, received_date, received, year)
       VALUES (?, 500000, '2026-02-01', 1, 2026)`
    ).run(dupId)
    db.prepare(
      "INSERT INTO letters (case_id, kind, body_text, drafted_at) VALUES (?, 'enforcement', 'x', '2026-01-20')"
    ).run(dupId)
    db.prepare(
      "INSERT INTO evidence_files (case_id, path, kind) VALUES (?, '/archive/otto/a.png', 'screenshot')"
    ).run(dupId)

    const preview = q.previewCaseMerge(db, primaryId, dupId)
    expect(preview.moves.payments).toBe(1)
    expect(preview.moves.paymentsCents).toBe(500_000)
    expect(preview.moves.evidenceFiles).toBe(1)
    expect(preview.moves.deadlines).toBe(1)
    expect(preview.licenseesDiffer).toBe(true)

    q.mergeCases(db, primaryId, dupId, { mergeLicensee: true })

    expect(q.getCase(db, dupId)).toBeNull()
    const after = q.getCase(db, primaryId)!
    expect(after.events.some((e) => e.body === 'they replied')).toBe(true)
    expect(after.events.some((e) => e.body.includes('Merged duplicate case'))).toBe(true)
    expect(after.deadlines.some((d) => d.title === 'response due')).toBe(true)
    for (const [table, col] of [
      ['payments', 'case_id'],
      ['letters', 'case_id'],
      ['evidence_files', 'case_id']
    ] as Array<[string, string]>) {
      const n = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
        .get(primaryId) as { n: number }
      expect(n.n, table).toBe(1)
    }
  })

  it('keeps the live status and the earlier opening date', () => {
    const { primaryId, dupId } = makePair()
    // Primary says Resolved 2026-03-01; duplicate says In Progress 2026-01-15.
    q.mergeCases(db, primaryId, dupId, { mergeLicensee: true })
    const after = q.getCase(db, primaryId)!.case
    expect(after.status).toBe('In Progress') // still live somewhere → still live
    expect(after.openedAt).toBe('2026-01-15') // the matter began earlier
  })

  it('fills empty fields from the duplicate instead of losing them', () => {
    const { primaryId, dupId } = makePair()
    q.updateCase(db, dupId, {
      url: 'ottosnaturals.example',
      settlementPosition: '$12,000 compromise'
    })
    q.mergeCases(db, primaryId, dupId, { mergeLicensee: true })
    const after = q.getCase(db, primaryId)!.case
    expect(after.url).toBe('ottosnaturals.example')
    expect(after.settlementPosition).toBe('$12,000 compromise')
  })

  it('adopts the duplicate folder path, which is uniquely indexed', () => {
    const { primaryId, dupId } = makePair()
    db.prepare('UPDATE cases SET local_folder_path = ? WHERE id = ?').run('/archive/ottos', dupId)
    q.mergeCases(db, primaryId, dupId, { mergeLicensee: true })
    expect(q.getCase(db, primaryId)!.case.localFolderPath).toBe('/archive/ottos')
  })

  it('drops evidence the survivor already references rather than violating the path index', () => {
    const { primaryId, dupId } = makePair()
    const path = '/archive/shared/same-screenshot.png'
    db.prepare("INSERT INTO evidence_files (case_id, path, kind) VALUES (?, ?, 'screenshot')").run(
      primaryId,
      path
    )
    db.prepare("INSERT INTO evidence_files (case_id, path, kind) VALUES (?, ?, 'screenshot')").run(
      dupId,
      '/archive/ottos/other.png'
    )
    // The duplicate row can't share the path (unique index), so simulate the
    // real case: the duplicate has a DIFFERENT row for a file already known.
    db.prepare('UPDATE evidence_files SET path = ? WHERE case_id = ? AND path = ?').run(
      path + '.tmp',
      dupId,
      '/archive/ottos/other.png'
    )

    expect(() => q.mergeCases(db, primaryId, dupId, { mergeLicensee: true })).not.toThrow()
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM evidence_files WHERE case_id = ?')
      .get(primaryId) as { n: number }
    expect(n.n).toBe(2)
  })

  it('folds the duplicate licensee in and keeps its name as an alias', () => {
    const { primaryId, dupId } = makePair()
    const before = q.listLicensees(db).length
    q.mergeCases(db, primaryId, dupId, { mergeLicensee: true })

    expect(q.listLicensees(db)).toHaveLength(before - 1)
    const kept = q.listLicensees(db).find((l) => l.name === "OTTO'S NATURALS LLC")!
    // The alias is what stops the next import splitting them again.
    expect(kept.akaNames).toContain('Ottos Naturals Co')
    expect(q.listLicensees(db).some((l) => l.name === 'Ottos Naturals Co')).toBe(false)
  })

  it('leaves both licensees alone when asked not to merge them', () => {
    const { primaryId, dupId } = makePair()
    const before = q.listLicensees(db).length
    q.mergeCases(db, primaryId, dupId, { mergeLicensee: false })
    expect(q.listLicensees(db)).toHaveLength(before)
  })

  it('refuses to merge a case into itself', () => {
    const { primaryId } = makePair()
    expect(() => q.previewCaseMerge(db, primaryId, primaryId)).toThrow(/into itself/)
    expect(() => q.previewCaseMerge(db, primaryId, 999_999)).toThrow(/not found/)
  })

  it('suggests the pair that shares a normalized company name', () => {
    q.createCase(db, {
      title: "Otto's Naturals",
      licenseeName: "OTTO'S NATURALS, LLC",
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-03-01'
    })
    q.createCase(db, {
      title: 'Ottos Naturals',
      licenseeName: 'Ottos Naturals',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-15'
    })
    const hits = q.duplicateCaseSuggestions(db)
    const otto = hits.find(
      (h) => h.a.title.toLowerCase().includes('otto') && h.b.title.toLowerCase().includes('otto')
    )
    expect(otto).toBeDefined()
    expect(otto!.score).toBeGreaterThanOrEqual(0.9)
  })
})
