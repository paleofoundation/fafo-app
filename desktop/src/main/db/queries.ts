import type Database from 'better-sqlite3'
import type {
  CasePatch,
  CaseRow,
  CaseEvent,
  Deadline,
  EventKind,
  Licensee,
  Mark,
  NewCaseInput,
  NewDeadlineInput
} from '../../shared/types'
import { normalizeCompanyName } from '../../shared/domain/naming'

const CASE_SELECT = `
  SELECT c.id, c.licensee_id AS licenseeId, c.watch_item_id AS watchItemId, c.title,
         c.type, c.status, c.source, c.url, c.opened_at AS openedAt,
         c.resolved_at AS resolvedAt, c.resolved_by AS resolvedBy,
         c.settlement_position AS settlementPosition, c.drive_folder_id AS driveFolderId,
         c.local_folder_path AS localFolderPath, c.legacy_import AS legacyImport,
         l.name AS licenseeName
  FROM cases c LEFT JOIN licensees l ON l.id = c.licensee_id`

function attachMarkCodes(db: Database.Database, rows: CaseRow[]): CaseRow[] {
  const stmt = db.prepare(`
    SELECT DISTINCT m.code FROM license_marks lm
    JOIN marks m ON m.id = lm.mark_id
    JOIN licenses li ON li.id = lm.license_id
    WHERE li.licensee_id = ?`)
  for (const row of rows) {
    row.markCodes = row.licenseeId
      ? (stmt.all(row.licenseeId) as Array<{ code: string }>).map((r) => r.code)
      : []
  }
  return rows
}

export function listCases(db: Database.Database): CaseRow[] {
  const rows = db.prepare(`${CASE_SELECT} ORDER BY c.status = 'Resolved', c.opened_at DESC`).all() as CaseRow[]
  return attachMarkCodes(db, rows)
}

export function getCase(
  db: Database.Database,
  id: number
): { case: CaseRow; events: CaseEvent[]; deadlines: Deadline[] } | null {
  const row = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) as CaseRow | undefined
  if (!row) return null
  attachMarkCodes(db, [row])
  const events = db
    .prepare(
      `SELECT id, case_id AS caseId, at, kind, body, ref_table AS refTable, ref_id AS refId
       FROM case_events WHERE case_id = ? ORDER BY at ASC, id ASC`
    )
    .all(id) as CaseEvent[]
  const deadlines = db
    .prepare(
      `SELECT id, ref_table AS refTable, ref_id AS refId, kind, title, due_at AS dueAt,
              satisfied_at AS satisfiedAt, dismissed
       FROM deadlines WHERE ref_table = 'cases' AND ref_id = ? AND dismissed = 0
       ORDER BY due_at ASC`
    )
    .all(id) as Deadline[]
  return { case: row, events, deadlines }
}

export function createCase(db: Database.Database, input: NewCaseInput): CaseRow {
  let licenseeId: number | null = null
  if (input.licenseeName?.trim()) {
    const norm = normalizeCompanyName(input.licenseeName)
    const existing = db.prepare('SELECT id FROM licensees WHERE normalized_name = ?').get(norm) as
      | { id: number }
      | undefined
    licenseeId = existing
      ? existing.id
      : Number(
          db
            .prepare('INSERT INTO licensees (name, normalized_name) VALUES (?, ?)')
            .run(input.licenseeName.trim(), norm).lastInsertRowid
        )
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO cases (licensee_id, title, type, status, source, url, opened_at, settlement_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        licenseeId,
        input.title,
        input.type,
        input.status,
        input.source,
        input.url ?? null,
        input.openedAt,
        input.settlementPosition ?? null
      ).lastInsertRowid
  )
  addEvent(db, id, 'status_change', `Case opened (${input.status})`, input.openedAt)
  return getCase(db, id)!.case
}

const CASE_PATCH_COLUMNS: Record<keyof CasePatch, string> = {
  title: 'title',
  type: 'type',
  status: 'status',
  source: 'source',
  url: 'url',
  openedAt: 'opened_at',
  resolvedAt: 'resolved_at',
  resolvedBy: 'resolved_by',
  settlementPosition: 'settlement_position'
}

export function updateCase(db: Database.Database, id: number, patch: CasePatch): CaseRow {
  const before = getCase(db, id)
  if (!before) throw new Error(`Case ${id} not found`)
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, col] of Object.entries(CASE_PATCH_COLUMNS) as Array<[keyof CasePatch, string]>) {
    if (key in patch) {
      sets.push(`${col} = ?`)
      values.push(patch[key] ?? null)
    }
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }
  if (patch.status && patch.status !== before.case.status) {
    const at = new Date().toISOString().slice(0, 10)
    addEvent(db, id, 'status_change', `Status: ${before.case.status} → ${patch.status}`, at)
    if (patch.status === 'Resolved' && !patch.resolvedAt) {
      db.prepare('UPDATE cases SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(at, id)
    }
  }
  return getCase(db, id)!.case
}

export function addEvent(
  db: Database.Database,
  caseId: number,
  kind: EventKind,
  body: string,
  at?: string
): CaseEvent {
  const atIso = at ?? new Date().toISOString().slice(0, 10)
  const id = Number(
    db
      .prepare('INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, ?, ?)')
      .run(caseId, atIso, kind, body).lastInsertRowid
  )
  return db
    .prepare(
      `SELECT id, case_id AS caseId, at, kind, body, ref_table AS refTable, ref_id AS refId
       FROM case_events WHERE id = ?`
    )
    .get(id) as CaseEvent
}

export function listDeadlines(db: Database.Database): Deadline[] {
  return db
    .prepare(
      `SELECT d.id, d.ref_table AS refTable, d.ref_id AS refId, d.kind, d.title,
              d.due_at AS dueAt, d.satisfied_at AS satisfiedAt, d.dismissed,
              CASE WHEN d.ref_table = 'cases' THEN c.title END AS caseTitle
       FROM deadlines d LEFT JOIN cases c ON d.ref_table = 'cases' AND c.id = d.ref_id
       WHERE d.dismissed = 0
       ORDER BY d.satisfied_at IS NULL DESC, d.due_at ASC`
    )
    .all() as Deadline[]
}

export function addDeadline(db: Database.Database, input: NewDeadlineInput): Deadline {
  const id = Number(
    db
      .prepare('INSERT INTO deadlines (ref_table, ref_id, kind, title, due_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.refTable ?? null, input.refId ?? null, input.kind, input.title, input.dueAt)
      .lastInsertRowid
  )
  return db
    .prepare(
      `SELECT id, ref_table AS refTable, ref_id AS refId, kind, title, due_at AS dueAt,
              satisfied_at AS satisfiedAt, dismissed FROM deadlines WHERE id = ?`
    )
    .get(id) as Deadline
}

export function satisfyDeadline(db: Database.Database, id: number, satisfied: boolean): void {
  db.prepare('UPDATE deadlines SET satisfied_at = ? WHERE id = ?').run(
    satisfied ? new Date().toISOString().slice(0, 10) : null,
    id
  )
}

export function dismissDeadline(db: Database.Database, id: number): void {
  db.prepare('UPDATE deadlines SET dismissed = 1 WHERE id = ?').run(id)
}

export function listMarks(db: Database.Database): Mark[] {
  return db
    .prepare(
      `SELECT id, code, name, program, uspto_reg_no AS usptoRegNo, reg_status AS regStatus, notes
       FROM marks ORDER BY id`
    )
    .all() as Mark[]
}

export function listLicensees(db: Database.Database): Licensee[] {
  return db
    .prepare(
      `SELECT id, name, normalized_name AS normalizedName, aka_names AS akaNames,
              contact_name AS contactName, contact_email AS contactEmail,
              contact_phone AS contactPhone, address, drive_folder_id AS driveFolderId,
              local_folder_path AS localFolderPath, repeat_infringer AS repeatInfringer
       FROM licensees ORDER BY name`
    )
    .all() as Licensee[]
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(key, value)
}

export function overdueDeadlines(db: Database.Database, todayIso: string): Deadline[] {
  return db
    .prepare(
      `SELECT d.id, d.ref_table AS refTable, d.ref_id AS refId, d.kind, d.title,
              d.due_at AS dueAt, d.satisfied_at AS satisfiedAt, d.dismissed,
              CASE WHEN d.ref_table = 'cases' THEN c.title END AS caseTitle
       FROM deadlines d LEFT JOIN cases c ON d.ref_table = 'cases' AND c.id = d.ref_id
       WHERE d.dismissed = 0 AND d.satisfied_at IS NULL AND d.due_at < ?
       ORDER BY d.due_at ASC`
    )
    .all(todayIso) as Deadline[]
}
