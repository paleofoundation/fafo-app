import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../../db/migrations'
import { seedIfEmpty } from '../../../db/seed'
import { commitSheets, parseSheetRows, scanSheets, type SheetsExport } from '../sheetsImport'

/** Mirrors the real Drive export: artifact empty-header + alignment rows, then the true header as a content row; 2025 table duplicated across both sheets. */
const TABLE_2025 = `| | | | | |
|---|---|---|---|---|
| Case | Status | Start date | End date | Notes |
| Yo Mama's Foods | Completed | 10/24/2024 | 3/3/2025 | |
| Laitram Machinery Inc. dba Prime Shrimp LLC | Completed | 4/8/2025 | | 17k settlement |
| Little West | Litigation | 8/11/2025 | | 10k settlement |`

const EXPORT: SheetsExport = {
  exportedAt: '2026-07-27T13:00:00Z',
  sheets: [
    {
      title: 'Infringement Cases',
      fileId: 'f1',
      content: `| | | | | |
|---|---|---|---|---|
| Case | Status | Start date | End date | Notes |
| The Healthy Crunch Company | Submitted to Trestle | 2/3/2026 | | |
| Bioriginal | Completed | | | 5k - 3/4/26 |
| Love Good Foods | Negotiations | 4/7/2026 | | |

${TABLE_2025}`
    },
    { title: '2025 Infringement', fileId: 'f2', content: TABLE_2025 }
  ]
}

describe('sheets importer', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  it('parses rows, skips artifact/header rows, dedupes the duplicated 2025 table', () => {
    const rows = parseSheetRows(EXPORT)
    expect(rows).toHaveLength(6) // 3 current + 3 from 2025 (duplicate table collapsed)
    expect(rows.find((r) => r.caseName === "Yo Mama's Foods")?.startDate).toBe('2024-10-24')
    expect(rows.find((r) => r.caseName === 'Bioriginal')?.notes).toBe('5k - 3/4/26')
  })

  it('scan matches seeded cases, maps statuses, and flags conflicts', () => {
    const scan = scanSheets(db, EXPORT)
    const byName = Object.fromEntries(scan.rows.map((r) => [r.caseName, r]))

    // Healthy Crunch: seeded as In Progress; sheet "Submitted to Trestle" → In Progress → clean attach
    expect(byName['The Healthy Crunch Company']?.action).toBe('attach')
    // Little West: seeded In Progress, sheet Litigation → In Progress → attach
    expect(byName['Little West']?.action).toBe('attach')
    // Bioriginal: unknown → create; Completed → Resolved
    expect(byName['Bioriginal']?.action).toBe('create')
    expect(byName['Bioriginal']?.mappedStatus).toBe('Resolved')
  })

  it('commit attaches events, creates stubs, fills empty settlement, and is idempotent', () => {
    const scan = scanSheets(db, EXPORT)
    const result = commitSheets(db, scan)
    expect(result.eventsAttached).toBe(4) // HC, Love Good, Little West, Prime Shrimp (matches seeded Laitram / Prime Shrimp LLC)
    expect(result.casesCreated).toBe(2) // Bioriginal, Yo Mama's Foods
    expect(result.licenseesCreated).toBe(2)

    // Prime Shrimp seeded case had settlement "$6,000" already — must NOT be overwritten
    const prime = db
      .prepare("SELECT settlement_position AS s FROM cases WHERE title = 'Laitram / Prime Shrimp LLC'")
      .get() as { s: string }
    expect(prime.s).toBe('$6,000')

    // No statuses disagree in this fixture (Prime Shrimp is Resolved in both
    // sources), so no CONFLICT markers may appear anywhere.
    const conflicts = db
      .prepare("SELECT COUNT(*) AS n FROM case_events WHERE body LIKE '%CONFLICT%'")
      .get() as { n: number }
    expect(conflicts.n).toBe(0)
    expect(result.conflictsAttached).toBe(0)

    const rescan = scanSheets(db, EXPORT)
    expect(rescan.totals.alreadyImported).toBeGreaterThanOrEqual(4)
    const recommit = commitSheets(db, rescan)
    expect(recommit.eventsAttached + recommit.casesCreated).toBe(
      rescan.rows.length - rescan.totals.alreadyImported
    )
  })
})
