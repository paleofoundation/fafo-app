import type Database from 'better-sqlite3'
import type {
  CasePatch,
  CaseRow,
  CaseEvent,
  CaseSource,
  CaseStatus,
  CaseType,
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
  if (licenseeId !== null) flagRepeatInfringer(db, licenseeId, id)
  return getCase(db, id)!.case
}

/**
 * Repeat-infringer detection (improvement 7). A licensee with any prior case
 * is flagged, and the new case's timeline records it — a second infringement
 * is willful, which drives the settlement posture (master reference §10,
 * Rawcology precedent).
 */
export function flagRepeatInfringer(
  db: Database.Database,
  licenseeId: number,
  newCaseId: number
): boolean {
  const prior = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(opened_at) AS firstAt
       FROM cases WHERE licensee_id = ? AND id != ?`
    )
    .get(licenseeId, newCaseId) as { n: number; firstAt: string | null }
  if (prior.n === 0) return false

  db.prepare('UPDATE licensees SET repeat_infringer = 1 WHERE id = ?').run(licenseeId)
  const body = `REPEAT INFRINGER: ${prior.n} prior matter${prior.n === 1 ? '' : 's'} on record for this licensee (earliest ${prior.firstAt}). A second infringement supports willfulness — reflect this in the settlement posture.`
  const exists = db
    .prepare("SELECT 1 FROM case_events WHERE case_id = ? AND kind = 'note' AND body = ?")
    .get(newCaseId, body)
  if (!exists) addEvent(db, newCaseId, 'note', body)
  return true
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

/**
 * What would be destroyed along with a case. Shown before deleting so the
 * choice is informed — deleting a duplicate is routine, but the same call on a
 * real matter would take its payments and letters with it.
 */
export interface CaseDeletionPreview {
  caseId: number
  title: string
  events: number
  deadlines: number
  letters: number
  payments: number
  paymentsCents: number
  evidenceFiles: number
  trackedUrls: number
  settlements: number
}

export function previewCaseDeletion(db: Database.Database, id: number): CaseDeletionPreview {
  const c = db.prepare('SELECT title FROM cases WHERE id = ?').get(id) as
    | { title: string }
    | undefined
  if (!c) throw new Error(`Case ${id} not found`)
  const count = (sql: string): number => (db.prepare(sql).get(id) as { n: number }).n
  const pay = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE case_id = ?'
    )
    .get(id) as { n: number; cents: number }
  return {
    caseId: id,
    title: c.title,
    events: count('SELECT COUNT(*) AS n FROM case_events WHERE case_id = ?'),
    deadlines: count(
      "SELECT COUNT(*) AS n FROM deadlines WHERE ref_table = 'cases' AND ref_id = ?"
    ),
    letters: count('SELECT COUNT(*) AS n FROM letters WHERE case_id = ?'),
    payments: pay.n,
    paymentsCents: pay.cents,
    evidenceFiles: count('SELECT COUNT(*) AS n FROM evidence_files WHERE case_id = ?'),
    trackedUrls: count('SELECT COUNT(*) AS n FROM tracked_urls WHERE case_id = ?'),
    settlements: count('SELECT COUNT(*) AS n FROM settlements WHERE case_id = ?')
  }
}

/**
 * Delete a case and everything hanging off it. Foreign keys are enforced, so
 * children must go first. Evidence rows are references — the underlying files
 * in the archive are never touched.
 */
export function deleteCase(db: Database.Database, id: number): CaseDeletionPreview {
  const preview = previewCaseDeletion(db, id)
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM deadlines WHERE ref_table = 'cases' AND ref_id = ?").run(id)
    db.prepare('DELETE FROM case_events WHERE case_id = ?').run(id)
    db.prepare('DELETE FROM letters WHERE case_id = ?').run(id)
    db.prepare('DELETE FROM payments WHERE case_id = ?').run(id)
    db.prepare('DELETE FROM evidence_files WHERE case_id = ?').run(id)
    db.prepare('DELETE FROM tracked_urls WHERE case_id = ?').run(id)
    db.prepare('DELETE FROM settlements WHERE case_id = ?').run(id)
    db.prepare('UPDATE cases SET watch_item_id = NULL WHERE id = ?').run(id)
    db.prepare('DELETE FROM cases WHERE id = ?').run(id)
  })
  tx()
  return preview
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

/**
 * The agreement facts a matter turns on, pulled from the extracted license:
 * who the licensee legally is, where they are, what they paid, when the term
 * ran, and what the liquidated-damages clause measures.
 *
 * The LD figure is stated as its BASIS, not a number. Under the 2025 template
 * (§E.3.d.ii) it is one year's license fee per month of continued misuse, so
 * the amount depends on how long the misuse ran — that is the settlement
 * calculator's job. Printing a single figure here would be a guess with a
 * dollar sign in front of it.
 */
export interface CaseLicenseFacts {
  businessName: string | null
  address: string | null
  termStart: string | null
  termEnd: string | null
  annualFeeCents: number | null
  revenueBand: string | null
  vintage: string | null
  agreementRef: string | null
  extractionConfidence: number | null
  liquidatedDamages: { applies: boolean; basis: string }
  marks: Array<{ code: string; name: string; regNo: string; regStatus: string }>
}

export function caseLicenseFacts(db: Database.Database, caseId: number): CaseLicenseFacts | null {
  const lic = db
    .prepare(
      `SELECT li.term_start AS termStart, li.term_end AS termEnd, li.vintage,
              li.annual_fee_cents AS annualFeeCents, li.revenue_band AS revenueBand,
              li.extraction_confidence AS extractionConfidence, li.agreement_ref AS agreementRef,
              l.name AS businessName, l.address
       FROM cases c JOIN licenses li ON li.licensee_id = c.licensee_id
       JOIN licensees l ON l.id = li.licensee_id
       WHERE c.id = ? ORDER BY li.term_end IS NULL, li.term_end DESC LIMIT 1`
    )
    .get(caseId) as Omit<CaseLicenseFacts, 'liquidatedDamages' | 'marks'> | undefined
  if (!lic) return null

  const marks = db
    .prepare(
      `SELECT DISTINCT m.code, m.name, m.uspto_reg_no AS regNo, m.reg_status AS regStatus
       FROM cases c JOIN licenses li ON li.licensee_id = c.licensee_id
       JOIN license_marks lm ON lm.license_id = li.id
       JOIN marks m ON m.id = lm.mark_id WHERE c.id = ?`
    )
    .all(caseId) as CaseLicenseFacts['marks']

  const fee = lic.annualFeeCents
  const applies = lic.vintage === '2025'
  return {
    ...lic,
    marks,
    liquidatedDamages: {
      applies,
      basis: applies
        ? `§E.3.d.ii — one year's license fee${fee ? ` ($${(fee / 100).toLocaleString()})` : ''} per month of continued use after termination.`
        : `No liquidated-damages clause in the ${lic.vintage ?? 'this'} agreement. Recovery is measured on the legacy basis: current fee schedule × years of use.`
    }
  }
}

/**
 * Merging duplicate matters.
 *
 * The duplicates here are not typos — they are the same company arriving by
 * two routes: SignNow says "OTTO'S NATURALS LLC", the folder on disk says
 * "Ottos Naturals", and each creates its own licensee and its own case. So the
 * merge has to fix BOTH levels; joining the cases while leaving two licensee
 * records behind means the License card still reads from whichever one the
 * case happens to point at, and the next import recreates the split.
 *
 * Nothing is discarded. Every child row moves to the survivor, and the fields
 * reconcile toward the more complete/more live value rather than toward
 * whichever case was clicked first.
 */
export interface CaseMergePreview {
  primary: { id: number; title: string; status: CaseStatus; licenseeName: string | null }
  duplicate: { id: number; title: string; status: CaseStatus; licenseeName: string | null }
  moves: {
    events: number
    deadlines: number
    letters: number
    payments: number
    paymentsCents: number
    evidenceFiles: number
    trackedUrls: number
    settlements: number
  }
  /** Evidence rows pointing at a file the survivor already has — dropped, not moved. */
  duplicateEvidence: number
  /** Field-by-field outcome, so the result is visible before committing. */
  resolved: Array<{ field: string; from: string; to: string; changed: boolean }>
  /** Both cases point at different licensees; merging them is the actual fix. */
  licenseesDiffer: boolean
  licenseeMerge: { keep: string; absorb: string; licensesMoved: number; otherCases: number } | null
}

const MERGE_STATUS_RANK: Record<CaseStatus, number> = {
  Open: 0,
  'In Progress': 1,
  Resolved: 2
}
const rank = (s: CaseStatus): number => MERGE_STATUS_RANK[s]

function caseForMerge(
  db: Database.Database,
  id: number
): {
  id: number
  title: string
  type: CaseType
  status: CaseStatus
  source: CaseSource
  url: string | null
  openedAt: string
  resolvedAt: string | null
  resolvedBy: 'JP' | 'Trestle' | null
  settlementPosition: string | null
  localFolderPath: string | null
  driveFolderId: string | null
  licenseeId: number | null
  licenseeName: string | null
} {
  const row = db
    .prepare(
      `SELECT c.id, c.title, c.type, c.status, c.source, c.url, c.opened_at AS openedAt,
              c.resolved_at AS resolvedAt, c.resolved_by AS resolvedBy,
              c.settlement_position AS settlementPosition,
              c.local_folder_path AS localFolderPath, c.drive_folder_id AS driveFolderId,
              c.licensee_id AS licenseeId, l.name AS licenseeName
       FROM cases c LEFT JOIN licensees l ON l.id = c.licensee_id WHERE c.id = ?`
    )
    .get(id)
  if (!row) throw new Error(`Case ${id} not found`)
  return row as ReturnType<typeof caseForMerge>
}

/** The survivor's field values after a merge. Prefers live status, earliest start, and any value over none. */
function reconcile(
  primary: ReturnType<typeof caseForMerge>,
  duplicate: ReturnType<typeof caseForMerge>
): Record<string, string | null> {
  const firstOf = (a: string | null, b: string | null): string | null => a ?? b
  return {
    // A matter that is still live somewhere is still live.
    status: rank(primary.status) <= rank(duplicate.status) ? primary.status : duplicate.status,
    // The matter began when the earlier of the two records says it did.
    opened_at: primary.openedAt <= duplicate.openedAt ? primary.openedAt : duplicate.openedAt,
    resolved_at: firstOf(primary.resolvedAt, duplicate.resolvedAt),
    resolved_by: firstOf(primary.resolvedBy, duplicate.resolvedBy),
    url: firstOf(primary.url, duplicate.url),
    settlement_position: firstOf(primary.settlementPosition, duplicate.settlementPosition),
    // Only one case may own a folder path (unique index), and the duplicate's
    // row is going away — so adopt it if the survivor has none.
    local_folder_path: firstOf(primary.localFolderPath, duplicate.localFolderPath),
    drive_folder_id: firstOf(primary.driveFolderId, duplicate.driveFolderId)
  }
}

export function previewCaseMerge(
  db: Database.Database,
  primaryId: number,
  duplicateId: number
): CaseMergePreview {
  if (primaryId === duplicateId) throw new Error('A case cannot be merged into itself')
  const primary = caseForMerge(db, primaryId)
  const duplicate = caseForMerge(db, duplicateId)

  const count = (sql: string): number =>
    (db.prepare(sql).get(duplicateId) as { n: number }).n

  const dupEvidence = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM evidence_files d
         WHERE d.case_id = ? AND d.path IS NOT NULL
           AND EXISTS (SELECT 1 FROM evidence_files p WHERE p.case_id = ? AND p.path = d.path)`
      )
      .get(duplicateId, primaryId) as { n: number }
  ).n

  const pay = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents FROM payments WHERE case_id = ?'
    )
    .get(duplicateId) as { n: number; cents: number }

  const after = reconcile(primary, duplicate)
  const before: Record<string, string | null> = {
    status: primary.status,
    opened_at: primary.openedAt,
    resolved_at: primary.resolvedAt,
    resolved_by: primary.resolvedBy,
    url: primary.url,
    settlement_position: primary.settlementPosition,
    local_folder_path: primary.localFolderPath,
    drive_folder_id: primary.driveFolderId
  }
  const LABELS: Record<string, string> = {
    status: 'Status',
    opened_at: 'Opened',
    resolved_at: 'Resolved',
    resolved_by: 'Resolution credit',
    url: 'URL',
    settlement_position: 'Settlement position',
    local_folder_path: 'Local folder',
    drive_folder_id: 'Drive folder'
  }
  const resolved = Object.keys(after).map((field) => ({
    field: LABELS[field] ?? field,
    from: before[field] ?? '—',
    to: after[field] ?? '—',
    changed: (before[field] ?? null) !== (after[field] ?? null)
  }))

  const licenseesDiffer =
    primary.licenseeId !== null &&
    duplicate.licenseeId !== null &&
    primary.licenseeId !== duplicate.licenseeId

  return {
    primary: {
      id: primary.id,
      title: primary.title,
      status: primary.status,
      licenseeName: primary.licenseeName
    },
    duplicate: {
      id: duplicate.id,
      title: duplicate.title,
      status: duplicate.status,
      licenseeName: duplicate.licenseeName
    },
    moves: {
      events: count('SELECT COUNT(*) AS n FROM case_events WHERE case_id = ?'),
      deadlines: count(
        "SELECT COUNT(*) AS n FROM deadlines WHERE ref_table = 'cases' AND ref_id = ?"
      ),
      letters: count('SELECT COUNT(*) AS n FROM letters WHERE case_id = ?'),
      payments: pay.n,
      paymentsCents: pay.cents,
      evidenceFiles: count('SELECT COUNT(*) AS n FROM evidence_files WHERE case_id = ?'),
      trackedUrls: count('SELECT COUNT(*) AS n FROM tracked_urls WHERE case_id = ?'),
      settlements: count('SELECT COUNT(*) AS n FROM settlements WHERE case_id = ?')
    },
    duplicateEvidence: dupEvidence,
    resolved,
    licenseesDiffer,
    licenseeMerge: licenseesDiffer
      ? {
          keep: primary.licenseeName ?? '(unnamed)',
          absorb: duplicate.licenseeName ?? '(unnamed)',
          licensesMoved: (
            db
              .prepare('SELECT COUNT(*) AS n FROM licenses WHERE licensee_id = ?')
              .get(duplicate.licenseeId) as { n: number }
          ).n,
          otherCases: (
            db
              .prepare('SELECT COUNT(*) AS n FROM cases WHERE licensee_id = ? AND id != ?')
              .get(duplicate.licenseeId, duplicateId) as { n: number }
          ).n
        }
      : null
  }
}

export interface CaseMergeResult extends CaseMergePreview {
  mergedLicensee: boolean
}

export function mergeCases(
  db: Database.Database,
  primaryId: number,
  duplicateId: number,
  opts: { mergeLicensee: boolean } = { mergeLicensee: true }
): CaseMergeResult {
  const preview = previewCaseMerge(db, primaryId, duplicateId)
  const primary = caseForMerge(db, primaryId)
  const duplicate = caseForMerge(db, duplicateId)
  const after = reconcile(primary, duplicate)
  const mergeLicensee = opts.mergeLicensee && preview.licenseesDiffer

  db.transaction(() => {
    // Free the duplicate's folder path first — it is uniquely indexed, and the
    // survivor may be about to adopt it.
    db.prepare('UPDATE cases SET local_folder_path = NULL WHERE id = ?').run(duplicateId)

    // Evidence the survivor already references would violate the unique path
    // index on the way across, and is the same file either way.
    db.prepare(
      `DELETE FROM evidence_files WHERE case_id = ? AND path IS NOT NULL
         AND EXISTS (SELECT 1 FROM evidence_files p WHERE p.case_id = ? AND p.path = evidence_files.path)`
    ).run(duplicateId, primaryId)

    for (const sql of [
      'UPDATE case_events SET case_id = ? WHERE case_id = ?',
      'UPDATE letters SET case_id = ? WHERE case_id = ?',
      'UPDATE payments SET case_id = ? WHERE case_id = ?',
      'UPDATE evidence_files SET case_id = ? WHERE case_id = ?',
      'UPDATE tracked_urls SET case_id = ? WHERE case_id = ?',
      'UPDATE settlements SET case_id = ? WHERE case_id = ?'
    ]) {
      db.prepare(sql).run(primaryId, duplicateId)
    }
    db.prepare(
      "UPDATE deadlines SET ref_id = ? WHERE ref_table = 'cases' AND ref_id = ?"
    ).run(primaryId, duplicateId)

    db.prepare(
      `UPDATE cases SET status = ?, opened_at = ?, resolved_at = ?, resolved_by = ?,
              url = ?, settlement_position = ?, local_folder_path = ?, drive_folder_id = ?
       WHERE id = ?`
    ).run(
      after.status,
      after.opened_at,
      after.resolved_at,
      after.resolved_by,
      after.url,
      after.settlement_position,
      after.local_folder_path,
      after.drive_folder_id,
      primaryId
    )

    if (mergeLicensee && primary.licenseeId !== null && duplicate.licenseeId !== null) {
      // Keep the absorbed name as an alias so a future import matches it here
      // instead of creating the split all over again.
      db.prepare(
        `UPDATE licensees
            SET aka_names = TRIM(COALESCE(aka_names || '; ', '') || ?),
                address = COALESCE(address, (SELECT address FROM licensees WHERE id = ?)),
                contact_email = COALESCE(contact_email, (SELECT contact_email FROM licensees WHERE id = ?)),
                contact_name = COALESCE(contact_name, (SELECT contact_name FROM licensees WHERE id = ?)),
                local_folder_path = COALESCE(local_folder_path, (SELECT local_folder_path FROM licensees WHERE id = ?)),
                repeat_infringer = MAX(repeat_infringer, (SELECT repeat_infringer FROM licensees WHERE id = ?))
          WHERE id = ?`
      ).run(
        duplicate.licenseeName ?? '',
        duplicate.licenseeId,
        duplicate.licenseeId,
        duplicate.licenseeId,
        duplicate.licenseeId,
        duplicate.licenseeId,
        primary.licenseeId
      )
      db.prepare('UPDATE licenses SET licensee_id = ? WHERE licensee_id = ?').run(
        primary.licenseeId,
        duplicate.licenseeId
      )
      db.prepare('UPDATE cases SET licensee_id = ? WHERE licensee_id = ?').run(
        primary.licenseeId,
        duplicate.licenseeId
      )
      db.prepare('UPDATE tracked_urls SET licensee_id = ? WHERE licensee_id = ?').run(
        primary.licenseeId,
        duplicate.licenseeId
      )
      db.prepare('DELETE FROM licensees WHERE id = ?').run(duplicate.licenseeId)
    }

    db.prepare('UPDATE cases SET watch_item_id = NULL WHERE id = ?').run(duplicateId)
    db.prepare('DELETE FROM cases WHERE id = ?').run(duplicateId)

    const moved = Object.entries(preview.moves)
      .filter(([k, v]) => k !== 'paymentsCents' && v > 0)
      .map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`)
      .join(', ')
    db.prepare(
      "INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'import', ?)"
    ).run(
      primaryId,
      new Date().toISOString().slice(0, 10),
      `Merged duplicate case "${duplicate.title}" (#${duplicateId}) into this matter` +
        (moved ? `: ${moved}` : ' (it had no attached records)') +
        (preview.duplicateEvidence > 0
          ? `. ${preview.duplicateEvidence} evidence reference${preview.duplicateEvidence === 1 ? '' : 's'} already present here, so dropped`
          : '') +
        (mergeLicensee ? `. Licensee "${preview.licenseeMerge?.absorb}" folded in as an alias.` : '.')
    )
  })()

  return { ...preview, mergedLicensee: mergeLicensee }
}

/**
 * Likely duplicates, for finding the pairs rather than remembering them.
 * Scored on how the split actually happens: the same normalized company name
 * arriving from two sources, or two titles that differ only by punctuation,
 * suffix or spacing.
 */
export interface DuplicateSuggestion {
  a: { id: number; title: string; status: CaseStatus; licenseeName: string | null; files: number }
  b: { id: number; title: string; status: CaseStatus; licenseeName: string | null; files: number }
  score: number
  reason: string
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function duplicateCaseSuggestions(db: Database.Database): DuplicateSuggestion[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.status, c.licensee_id AS licenseeId, l.name AS licenseeName,
              l.normalized_name AS norm,
              (SELECT COUNT(*) FROM evidence_files f WHERE f.case_id = c.id) AS files
       FROM cases c LEFT JOIN licensees l ON l.id = c.licensee_id`
    )
    .all() as Array<{
    id: number
    title: string
    status: CaseStatus
    licenseeId: number | null
    licenseeName: string | null
    norm: string | null
    files: number
  }>

  const out: DuplicateSuggestion[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!
      const b = rows[j]!
      if (a.licenseeId !== null && a.licenseeId === b.licenseeId) {
        out.push({ ...pair(a, b), score: 1, reason: 'Same licensee record' })
        continue
      }
      const [ta, tb] = [squash(a.title), squash(b.title)]
      const [na, nb] = [squash(a.norm ?? ''), squash(b.norm ?? '')]
      if (ta && ta === tb) out.push({ ...pair(a, b), score: 0.95, reason: 'Identical name' })
      else if (na && na === nb)
        out.push({ ...pair(a, b), score: 0.9, reason: 'Same company after normalising' })
      else if (na && nb && na.length > 5 && (na.startsWith(nb) || nb.startsWith(na)))
        out.push({ ...pair(a, b), score: 0.6, reason: 'One company name extends the other' })
      else if (ta && tb && ta.length > 5 && (ta.startsWith(tb) || tb.startsWith(ta)))
        out.push({ ...pair(a, b), score: 0.5, reason: 'One title extends the other' })
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 40)
}

function pair(
  a: { id: number; title: string; status: CaseStatus; licenseeName: string | null; files: number },
  b: { id: number; title: string; status: CaseStatus; licenseeName: string | null; files: number }
): Omit<DuplicateSuggestion, 'score' | 'reason'> {
  const trim = (x: typeof a): DuplicateSuggestion['a'] => ({
    id: x.id,
    title: x.title,
    status: x.status,
    licenseeName: x.licenseeName,
    files: x.files
  })
  return { a: trim(a), b: trim(b) }
}
