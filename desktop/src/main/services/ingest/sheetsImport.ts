import path from 'node:path'
import type Database from 'better-sqlite3'
import { normalizeCompanyName } from '../../../shared/domain/naming'
import { findLicenseeByName } from './matching'

/**
 * Importer for the two Google Sheets Jonathan has tracked infringement in
 * ("Infringement Cases" + "2025 Infringement"), exported via the Drive
 * connector to userData/import/sheets-infringement.json.
 *
 * Columns: Case | Status | Start date | End date | Notes.
 * Known export quirks handled here: the Drive tool emits an empty header row
 * and an alignment row before the real header, and the 2025 table appears
 * verbatim inside BOTH files — rows are deduped by signature.
 *
 * Conflicts (sheet status vs. app status) are surfaced, never auto-applied.
 */

export interface SheetsExport {
  exportedAt: string
  sheets: Array<{ title: string; fileId: string; content?: string; error?: string }>
}

export interface SheetRow {
  sheetTitle: string
  caseName: string
  status: string
  startDate: string | null
  endDate: string | null
  notes: string | null
}

export type SheetRowAction = 'attach' | 'create' | 'conflict-review'

export interface SheetScanRow extends SheetRow {
  mappedStatus: 'Open' | 'In Progress' | 'Resolved'
  matchedCaseId: number | null
  matchedCaseTitle: string | null
  currentCaseStatus: string | null
  action: SheetRowAction
  alreadyImported: boolean
}

export interface SheetsScanResult {
  rows: SheetScanRow[]
  totals: { rows: number; attach: number; create: number; conflicts: number; alreadyImported: number }
}

export function sheetsExportPath(userDataDir: string): string {
  return path.join(userDataDir, 'import', 'sheets-infringement.json')
}

/** In-progress pipeline stages used in the sheets; everything else lands as In Progress with a flag. */
const STATUS_MAP: Record<string, 'Open' | 'In Progress' | 'Resolved'> = {
  completed: 'Resolved',
  failed: 'Resolved',
  'submitted to trestle': 'In Progress',
  'trestle response': 'In Progress',
  'sent to auditing': 'In Progress',
  negotiations: 'In Progress',
  litigation: 'In Progress'
}

function toIso(mdY: string | null): string | null {
  if (!mdY) return null
  const m = mdY.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return null
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!
  return `${year}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

export function parseSheetRows(exp: SheetsExport): SheetRow[] {
  const rows: SheetRow[] = []
  const seen = new Set<string>()

  for (const sheet of exp.sheets) {
    if (!sheet.content) continue
    for (const line of sheet.content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|')) continue
      const cells = trimmed.split('|').map((c) => c.trim())
      // split('|') yields leading/trailing empties for well-formed rows
      const inner = cells.slice(1, -1)
      if (inner.length < 2) continue
      const first = inner[0] ?? ''
      // skip artifact empty header, alignment rows, and the real header row
      if (first === '' && inner.every((c) => c === '')) continue
      if (inner.every((c) => /^:?-+:?$/.test(c) || c === '')) continue
      if (first.toLowerCase() === 'case') continue

      const row: SheetRow = {
        sheetTitle: sheet.title,
        caseName: first,
        status: inner[1] ?? '',
        startDate: toIso(inner[2] ?? null),
        endDate: toIso(inner[3] ?? null),
        notes: (inner[4] ?? '').trim() || null
      }
      if (!row.caseName) continue
      // Dedupe the duplicated 2025 table across the two files.
      const sig = `${row.caseName}|${row.status}|${row.startDate}|${row.endDate}|${row.notes}`
      if (seen.has(sig)) continue
      seen.add(sig)
      rows.push(row)
    }
  }
  return rows
}

function importEventBody(r: SheetRow): string {
  return (
    `Sheet import (${r.sheetTitle}): status "${r.status}"` +
    (r.startDate ? `, start ${r.startDate}` : '') +
    (r.endDate ? `, end ${r.endDate}` : '') +
    (r.notes ? ` — ${r.notes}` : '')
  )
}

export function scanSheets(db: Database.Database, exp: SheetsExport): SheetsScanResult {
  const rows = parseSheetRows(exp)
  const findCase = db.prepare(
    `SELECT id, title, status FROM cases WHERE licensee_id = ?
     ORDER BY status = 'Resolved', opened_at DESC LIMIT 1`
  )
  const eventExists = db.prepare(
    'SELECT 1 FROM case_events WHERE case_id = ? AND kind = ? AND body = ?'
  )

  const out: SheetScanRow[] = rows.map((r) => {
    const mappedStatus = STATUS_MAP[r.status.toLowerCase()] ?? 'In Progress'
    const licensee = findLicenseeByName(db, r.caseName)
    const found = licensee
      ? ((findCase.get(licensee.id) as { id: number; title: string; status: string } | undefined) ?? null)
      : null
    const alreadyImported =
      found !== null && eventExists.get(found.id, 'import', importEventBody(r)) !== undefined
    const conflict = found !== null && found.status !== mappedStatus
    return {
      ...r,
      mappedStatus,
      matchedCaseId: found?.id ?? null,
      matchedCaseTitle: found?.title ?? null,
      currentCaseStatus: found?.status ?? null,
      action: found === null ? 'create' : conflict ? 'conflict-review' : 'attach',
      alreadyImported
    }
  })

  return {
    rows: out,
    totals: {
      rows: out.length,
      attach: out.filter((r) => r.action === 'attach' && !r.alreadyImported).length,
      create: out.filter((r) => r.action === 'create').length,
      conflicts: out.filter((r) => r.action === 'conflict-review').length,
      alreadyImported: out.filter((r) => r.alreadyImported).length
    }
  }
}

export interface SheetsCommitResult {
  eventsAttached: number
  casesCreated: number
  licenseesCreated: number
  conflictsAttached: number
  skipped: number
}

/**
 * Commit: attaches the sheet row to the matched case as a timeline event
 * (conflict rows too — flagged in the event text, status NEVER overwritten),
 * creates stub cases for unmatched rows. Idempotent via exact-body check.
 */
export function commitSheets(db: Database.Database, scan: SheetsScanResult): SheetsCommitResult {
  const result: SheetsCommitResult = {
    eventsAttached: 0,
    casesCreated: 0,
    licenseesCreated: 0,
    conflictsAttached: 0,
    skipped: 0
  }
  const insertLicensee = db.prepare('INSERT INTO licensees (name, normalized_name) VALUES (?, ?)')
  const insertCase = db.prepare(
    `INSERT INTO cases (licensee_id, title, type, status, source, opened_at, resolved_at, legacy_import)
     VALUES (?, ?, 'Expired License', ?, 'Other', ?, ?, 1)`
  )
  const insertEvent = db.prepare(
    'INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, ?, ?)'
  )
  const fillSettlement = db.prepare(
    'UPDATE cases SET settlement_position = COALESCE(settlement_position, ?) WHERE id = ?'
  )
  const today = new Date().toISOString().slice(0, 10)

  const tx = db.transaction(() => {
    for (const r of scan.rows) {
      if (r.alreadyImported) {
        result.skipped += 1
        continue
      }
      const body = importEventBody(r)
      if (r.matchedCaseId !== null) {
        const finalBody =
          r.action === 'conflict-review'
            ? `${body} [CONFLICT: sheet says ${r.mappedStatus}, case is ${r.currentCaseStatus} — review]`
            : body
        insertEvent.run(r.matchedCaseId, r.startDate ?? today, 'import', finalBody)
        if (r.notes) fillSettlement.run(r.notes, r.matchedCaseId)
        result.eventsAttached += 1
        if (r.action === 'conflict-review') result.conflictsAttached += 1
      } else {
        let licenseeId: number
        const existing = findLicenseeByName(db, r.caseName)
        if (existing) {
          licenseeId = existing.id
        } else {
          licenseeId = Number(
            insertLicensee.run(r.caseName, normalizeCompanyName(r.caseName)).lastInsertRowid
          )
          result.licenseesCreated += 1
        }
        const caseId = Number(
          insertCase.run(
            licenseeId,
            r.caseName,
            r.mappedStatus,
            r.startDate ?? today,
            r.mappedStatus === 'Resolved' ? (r.endDate ?? r.startDate ?? today) : null
          ).lastInsertRowid
        )
        insertEvent.run(caseId, r.startDate ?? today, 'import', body)
        if (r.notes) fillSettlement.run(r.notes, caseId)
        result.casesCreated += 1
      }
    }
  })
  tx()
  return result
}
