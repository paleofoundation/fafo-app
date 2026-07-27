import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../../db/migrations'
import { seedIfEmpty } from '../../../db/seed'
import { commitLocalCases, scanLocalCases } from '../localCases'
import { importSignnowSnapshot, type SignnowSnapshot } from '../signnowSnapshot'

function makeFixtureTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fafo-cases-'))
  const mk = (...segments: string[]): string => {
    const p = path.join(root, ...segments)
    fs.mkdirSync(p, { recursive: true })
    return p
  }
  const touch = (dir: string, name: string, content = 'x'): void => {
    fs.writeFileSync(path.join(dir, name), content)
  }

  // Expired-licensee bucket (":" is a literal POSIX byte here, as on the real disk)
  const caveman = mk('Certified:Expired', 'Caveman Foods')
  touch(caveman, 'Caveman Foods Agreement 2021.pdf')
  const cavemanAug = mk('Certified:Expired', 'Caveman Foods', 'August 15, 2022')
  touch(cavemanAug, 'Screen Shot 2022-08-15 at 1.02.03 PM.png')
  touch(cavemanAug, 'Screen Shot 2022-08-15 at 1.05.44 PM.png')
  const cavemanMar = mk('Certified:Expired', 'Caveman Foods', 'March 5, 2024 - Purchased Packaging')
  touch(cavemanMar, 'IMG_0001.jpg')
  const cavemanEmails = mk('Certified:Expired', 'Caveman Foods', 'Emails')
  touch(cavemanEmails, 'Re: Continued Use Notice.eml')

  // Brand : parent-entity relationship folder
  const ayoba = mk('Certified:Expired', 'Ayoba:Stromberg')
  touch(ayoba, 'notes.rtf')
  const weird = mk('Certified:Expired', 'Ayoba:Stromberg', 'Random Folder')
  touch(weird, 'thing.pdf')

  // Matches an EXISTING active case (Rawcology seeded in M1)
  const raw = mk('Certified:Expired', 'Rawcology')
  const rawJan = mk('Certified:Expired', 'Rawcology', 'xJanuary 24, 2024')
  touch(raw, 'RAWCOLOGY INC. License Agreement 2025.pdf')
  touch(rawJan, 'Screen Shot 2024-01-24.png')

  // Never-certified bucket with litigation docs
  const lw = mk('Not Certified', 'Some New Infringer')
  touch(lw, 'Notice of Infringement and Demand.docx')
  touch(lw, '001 Complaint.docx')

  return root
}

describe('local case-folder importer', () => {
  let db: Database.Database
  let root: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
    root = makeFixtureTree()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('scans buckets, parses names/dates, and matches existing licensees', () => {
    const report = scanLocalCases(db, root)
    expect(report.totals.folders).toBe(4)

    const byName = Object.fromEntries(report.folders.map((f) => [f.folderName, f]))

    const caveman = byName['Caveman Foods']!
    expect(caveman.caseType).toBe('Expired License')
    expect(caveman.evidenceSessions).toBe(2)
    expect(caveman.earliestEvidence).toBe('2022-08-15')
    expect(caveman.latestEvidence).toBe('2024-03-05')
    expect(caveman.files).toHaveLength(5)
    expect(caveman.files.filter((f) => f.kind === 'screenshot')).toHaveLength(3)
    expect(caveman.files.filter((f) => f.kind === 'agreement')).toHaveLength(1)
    expect(caveman.files.filter((f) => f.kind === 'email')).toHaveLength(1)

    const ayoba = byName['Ayoba:Stromberg']!
    expect(ayoba.primaryName).toBe('Ayoba')
    expect(ayoba.relatedEntity).toBe('Stromberg')
    expect(ayoba.flags.some((fl) => fl.includes('Random Folder'))).toBe(true)

    const raw = byName['Rawcology']!
    expect(raw.matchedLicenseeName).toBe('Rawcology Inc.')
    expect(raw.existingCaseId).not.toBeNull()

    const lw = byName['Some New Infringer']!
    expect(lw.caseType).toBe('Unlicensed Use - Never Certified')
    expect(lw.files.filter((f) => f.kind === 'court')).toHaveLength(1)
    expect(lw.files.filter((f) => f.kind === 'letter')).toHaveLength(1)
  })

  it('commit links existing matters, creates the rest, and is idempotent', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }

    const report = scanLocalCases(db, root)
    const result = commitLocalCases(db, report)
    expect(result.casesLinked).toBe(1) // Rawcology attaches to the live case
    expect(result.casesCreated).toBe(3)
    expect(result.licenseesCreated).toBe(3)
    expect(result.evidenceAdded).toBeGreaterThan(0)

    const after = db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }
    expect(after.n).toBe(before.n + 3)

    // Rawcology's existing case gained the folder link + import event, no duplicate case
    const rawCase = db
      .prepare("SELECT id, local_folder_path AS p FROM cases WHERE title = 'Rawcology Inc.'")
      .get() as { id: number; p: string | null }
    expect(rawCase.p).toContain('Rawcology')

    // Imported archive cases enter Resolved with legacy flag
    const imported = db
      .prepare("SELECT status, legacy_import AS li FROM cases WHERE title = 'Caveman Foods'")
      .get() as { status: string; li: number }
    expect(imported.status).toBe('Resolved')
    expect(imported.li).toBe(1)

    // Re-scan marks everything imported; re-commit is a no-op
    const rescan = scanLocalCases(db, root)
    expect(rescan.totals.alreadyImported).toBe(4)
    const recommit = commitLocalCases(db, rescan)
    expect(recommit.casesCreated).toBe(0)
    expect(recommit.casesLinked).toBe(0)
    expect(recommit.evidenceAdded).toBe(0)
    expect(recommit.skippedFolders).toBe(4)
  })
})

describe('signnow snapshot importer', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  const snapshot: SignnowSnapshot = {
    exportedAt: '2026-07-27T12:00:00Z',
    source: 'test',
    total: 5,
    groups: [
      { id: 'g1', name: 'CALCHEF FOODS LLC License Agreement 2026', invite_status: 'completed', participant_emails: ['catherinep@kevinsnaturalfoods.com'], signed: true, last_updated: 1784813558 },
      { id: 'g2', name: 'CALCHEF FOODS LLC License Agreement 2025', invite_status: 'completed', participant_emails: [], signed: true, last_updated: 1750000000 },
      { id: 'g3', name: 'OLD CO License Agreement 2019', invite_status: 'completed', participant_emails: [], signed: true, last_updated: 1600000000 },
      { id: 'g4', name: 'RAWCOLOGY INC. License Agreement 2025', invite_status: 'completed', participant_emails: ['tara@rawcology.com'], signed: true, last_updated: 1750000001 },
      { id: 'g5', name: 'Paleo Certified Inc. Settlement Agreement', invite_status: 'completed', participant_emails: [], signed: true, last_updated: 1779203593 }
    ]
  }

  it('builds the ledger with year-based status and vintage guesses', () => {
    const result = importSignnowSnapshot(db, snapshot)
    expect(result.groupsSeen).toBe(4)
    expect(result.unparsedNames).toEqual(['Paleo Certified Inc. Settlement Agreement'])
    expect(result.licensesCreated).toBe(4)

    const calchef = db
      .prepare(
        `SELECT li.status, li.vintage FROM licenses li
         JOIN licensees l ON l.id = li.licensee_id
         WHERE l.name = 'CALCHEF FOODS LLC' ORDER BY li.agreement_ref`
      )
      .all() as Array<{ status: string; vintage: string }>
    expect(calchef).toHaveLength(2)
    expect(calchef.map((c) => c.status).sort()).toEqual(['active', 'renewed'])

    const old = db
      .prepare(
        `SELECT li.status, li.vintage FROM licenses li
         JOIN licensees l ON l.id = li.licensee_id WHERE l.name = 'OLD CO'`
      )
      .get() as { status: string; vintage: string }
    expect(old.vintage).toBe('2020')
    expect(old.status).toBe('expired')

    // Rawcology reuses the licensee seeded in M1 — no duplicate entity
    const rawcology = db
      .prepare("SELECT COUNT(*) AS n FROM licensees WHERE normalized_name = 'rawcology'")
      .get() as { n: number }
    expect(rawcology.n).toBe(1)
  })

  it('collapses duplicate copies of the same agreement — signed copy wins', () => {
    const withDupes: SignnowSnapshot = {
      exportedAt: '2026-07-27T14:00:00Z',
      source: 'test',
      total: 3,
      groups: [
        { id: 'd1', name: 'NATURAL SINS LLC License Agreement 2026', invite_status: null, participant_emails: [], signed: false, last_updated: 1780000000 },
        { id: 'd2', name: 'NATURAL SINS LLC License Agreement 2026', invite_status: 'completed', participant_emails: ['arodriguez@naturalsinsonline.com'], signed: true, last_updated: 1780931507 },
        { id: 'd3', name: 'NATURAL SINS LLC License Agreement 2026', invite_status: null, participant_emails: [], signed: false, last_updated: 1781000000 }
      ]
    }
    const r = importSignnowSnapshot(db, withDupes)
    expect(r.groupsSeen).toBe(3)
    expect(r.duplicatesSkipped).toBe(2)
    expect(r.licensesCreated).toBe(1)
    const row = db
      .prepare(
        `SELECT li.signnow_group_id AS id FROM licenses li
         JOIN licensees l ON l.id = li.licensee_id WHERE l.name = 'NATURAL SINS LLC'`
      )
      .get() as { id: string }
    expect(row.id).toBe('d2') // the signed copy, despite d3 being newer
  })

  it('re-import updates rather than duplicates', () => {
    importSignnowSnapshot(db, snapshot)
    const second = importSignnowSnapshot(db, snapshot)
    expect(second.licensesCreated).toBe(0)
    expect(second.licensesUpdated).toBe(4)
    expect(second.licenseesCreated).toBe(0)
    const count = db.prepare('SELECT COUNT(*) AS n FROM licenses').get() as { n: number }
    // 4 from snapshot + 2 seeded in M1 (Healthy Crunch, Love Good)
    expect(count.n).toBe(6)
  })
})
