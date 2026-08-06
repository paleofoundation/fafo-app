import type Database from 'better-sqlite3'
import { findLicenseeByName } from './matching'

/**
 * Importer for the v1 metrics export (`fafo.metrics.v2`), per the bundle's
 * METRICS_SCHEMA.md. One row per money event; v2 stores at that granularity
 * and aggregates at read time, exactly as the spec requires.
 *
 * Load-bearing rules preserved from v1:
 *  1. Only `received: true` rows are realized income (unreceived rows are still
 *     imported, so a pending settlement isn't lost — just not counted).
 *  2. `resolvedBy: null` is its own Unassigned bucket, never folded in.
 *  3. `year` prefers paymentDate, falls back to the row's year; a row with
 *     neither is reported rather than silently dropped.
 */

export const METRICS_SCHEMA_ID = 'fafo.metrics.v2'

export interface MetricsRow {
  rowType: 'case_payment' | 'legacy_entry'
  caseId?: number | null
  legacyId?: number | null
  infringer?: string
  contact?: string
  infringementType?: string
  caseStatus?: string
  resolvedBy?: 'JP' | 'Trestle' | null
  trademarkIds?: number[]
  settlementPosition?: string
  dateOpened?: string
  amount: number
  paymentDate?: string
  year?: number | null
  received?: boolean
  source?: string
  url?: string
}

export interface MetricsExport {
  schema: string
  exportedAt?: string
  sourceAppVersion?: string
  summary?: {
    totalRows?: number
    receivedRows?: number
    realizedIncome?: number
    byResolver?: Record<string, number>
  }
  rows: MetricsRow[]
}

export type RowAction = 'import' | 'already-imported' | 'duplicate-of-existing' | 'no-year'

export interface PlannedRow {
  key: string
  rowType: MetricsRow['rowType']
  infringer: string
  infringementType: string | null
  amountCents: number
  year: number | null
  paymentDate: string | null
  received: boolean
  resolvedBy: 'JP' | 'Trestle' | null
  matchedCaseTitle: string | null
  action: RowAction
  note: string | null
}

/**
 * A case where the import brings payments AND the database already holds
 * different (non-imported) payments for it. Keeping both double-counts; the
 * export is the authoritative live record, so the stale rows should normally
 * be superseded. Never resolved silently — the totals are shown both ways.
 */
export interface CaseConflict {
  caseId: number
  caseTitle: string
  existing: Array<{ paymentId: number; amountCents: number; date: string | null }>
  incoming: Array<{ amountCents: number; date: string | null }>
  keepBothCents: number
  supersedeCents: number
}

/**
 * An existing payment whose collected/not-collected flag disagrees with the
 * export. The export is the live ledger, so it decides — but flipping a row
 * changes reported income, so it is shown and applied only on request.
 */
export interface StatusFix {
  paymentId: number
  label: string
  amountCents: number
  date: string | null
  currentlyReceived: boolean
  exportSaysReceived: boolean
  currentResolvedBy: 'JP' | 'Trestle' | null
  exportResolvedBy: 'JP' | 'Trestle' | null
}

export interface MetricsImportPlan {
  schemaOk: boolean
  sourceAppVersion: string | null
  exportedAt: string | null
  rows: PlannedRow[]
  conflicts: CaseConflict[]
  statusFixes: StatusFix[]
  totals: {
    rows: number
    toImport: number
    alreadyImported: number
    duplicateOfExisting: number
    withoutYear: number
    realizedIncomeCents: number
  }
  /** Recomputed from rows and checked against the file's summary block. */
  verification: {
    fileRealizedIncomeCents: number | null
    recomputedRealizedIncomeCents: number
    matches: boolean
    resolverIdentityHolds: boolean
    messages: string[]
  }
}

function toCents(amount: number): number {
  return Math.round(amount * 100)
}

/** Stable per-money-event key so re-importing the same export is a no-op. */
export function rowKey(r: MetricsRow): string {
  const id = r.rowType === 'legacy_entry' ? (r.legacyId ?? 'x') : (r.caseId ?? 'x')
  return `v1:${r.rowType}:${id}:${r.paymentDate ?? r.year ?? ''}:${toCents(r.amount)}`
}

export function parseCsvExport(text: string): MetricsExport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) throw new Error('CSV export has no data rows')
  const split = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = !inQ
      } else if (c === ',' && !inQ) {
        out.push(cur)
        cur = ''
      } else cur += c
    }
    out.push(cur)
    return out
  }
  const header = split(lines[0]!)
  const rows: MetricsRow[] = lines.slice(1).map((line) => {
    const cells = split(line)
    const get = (name: string): string => {
      const i = header.indexOf(name)
      return i === -1 ? '' : (cells[i] ?? '').trim()
    }
    const resolved = get('resolvedBy')
    return {
      rowType: (get('rowType') || 'case_payment') as MetricsRow['rowType'],
      caseId: get('caseId') ? parseInt(get('caseId'), 10) : null,
      legacyId: get('legacyId') ? parseInt(get('legacyId'), 10) : null,
      infringer: get('infringer'),
      infringementType: get('infringementType'),
      caseStatus: get('caseStatus'),
      resolvedBy: resolved === 'JP' || resolved === 'Trestle' ? resolved : null,
      settlementPosition: get('settlementPosition'),
      amount: parseFloat(get('amount') || '0'),
      paymentDate: get('paymentDate') || undefined,
      year: get('year') ? parseInt(get('year'), 10) : null,
      received: get('received').toLowerCase() !== 'false',
      source: get('source'),
      url: get('url')
    }
  })
  return { schema: METRICS_SCHEMA_ID, rows }
}

export function planMetricsImport(db: Database.Database, exp: MetricsExport): MetricsImportPlan {
  const schemaOk = exp.schema === METRICS_SCHEMA_ID
  const messages: string[] = []
  if (!schemaOk) {
    messages.push(
      `Unexpected schema "${exp.schema ?? '(missing)'}" — expected "${METRICS_SCHEMA_ID}".`
    )
  }

  const keyExists = db.prepare('SELECT 1 FROM payments WHERE import_key = ?')
  const findCaseByLicensee = db.prepare(
    `SELECT id, title FROM cases WHERE licensee_id = ?
     ORDER BY status = 'Resolved', opened_at DESC LIMIT 1`
  )
  // Duplicate detection is keyed on amount + date ACROSS the whole ledger, not
  // per case. The same settlement is often filed under a differently-named
  // case (e.g. "Yoleez LLC" vs "Eramir LLC / Yoleez") or as a legacy row after
  // a name-match miss; a per-case check misses those and books the money twice.
  const dupPayment = db.prepare(
    `SELECT p.id, p.received, p.resolved_by AS resolvedBy,
            COALESCE(c.title, p.source_label, '(legacy)') AS label
     FROM payments p LEFT JOIN cases c ON c.id = p.case_id
     WHERE p.amount_cents = ? AND IFNULL(p.received_date,'') = IFNULL(?,'')
       AND p.import_key IS NULL
     LIMIT 1`
  )

  const planned: PlannedRow[] = []
  const matchedIds = new Map<string, number | null>()
  const statusFixes: StatusFix[] = []
  for (const r of exp.rows) {
    const key = rowKey(r)
    const cents = toCents(r.amount)
    const paymentDate = r.paymentDate && r.paymentDate.trim() !== '' ? r.paymentDate : null
    const year = paymentDate ? parseInt(paymentDate.slice(0, 4), 10) : (r.year ?? null)
    const received = r.received !== false
    const infringer = (r.infringer ?? '').trim()

    let matchedCaseId: number | null = null
    let matchedCaseTitle: string | null = null
    if (r.rowType === 'case_payment' && infringer) {
      const licensee = findLicenseeByName(db, infringer)
      if (licensee) {
        const c = findCaseByLicensee.get(licensee.id) as { id: number; title: string } | undefined
        if (c) {
          matchedCaseId = c.id
          matchedCaseTitle = c.title
        }
      }
    }
    matchedIds.set(key, matchedCaseId)

    let action: RowAction = 'import'
    let note: string | null = null
    const dup = dupPayment.get(cents, paymentDate) as
      | { id: number; received: number; resolvedBy: 'JP' | 'Trestle' | null; label: string }
      | undefined
    if (keyExists.get(key)) {
      action = 'already-imported'
      note = 'This export row is already in the database.'
    } else if (dup) {
      action = 'duplicate-of-existing'
      const sameStatus = (dup.received === 1) === received
      const sameResolver = (dup.resolvedBy ?? null) === (r.resolvedBy ?? null)
      const diffs: string[] = []
      if (!sameStatus) {
        diffs.push(
          `marked ${dup.received === 1 ? 'received' : 'not received'} there, ${received ? 'received' : 'NOT received'} in the export`
        )
      }
      if (!sameResolver) {
        diffs.push(
          `credited to ${dup.resolvedBy ?? 'Unassigned'} there, ${r.resolvedBy ?? 'Unassigned'} in the export`
        )
      }
      note =
        diffs.length === 0
          ? `Already on file as "${dup.label}" — skipped to avoid double-counting.`
          : `Already on file as "${dup.label}", but ${diffs.join('; ')}.`
      if (diffs.length > 0) {
        statusFixes.push({
          paymentId: dup.id,
          label: dup.label,
          amountCents: cents,
          date: paymentDate,
          currentlyReceived: dup.received === 1,
          exportSaysReceived: received,
          currentResolvedBy: dup.resolvedBy ?? null,
          exportResolvedBy: r.resolvedBy ?? null
        })
      }
    } else if (year === null) {
      action = 'no-year'
      note = 'No paymentDate and no year — imported but excluded from the by-year table.'
    }

    planned.push({
      key,
      rowType: r.rowType,
      infringer: infringer || '(unlabelled)',
      infringementType: r.infringementType ?? null,
      amountCents: cents,
      year,
      paymentDate,
      received,
      resolvedBy: r.resolvedBy ?? null,
      matchedCaseTitle,
      action,
      note
    })
  }

  // Conflict detection: a case the import touches that already holds
  // non-imported payments which the import does NOT duplicate exactly.
  const existingFor = db.prepare(
    `SELECT id, amount_cents AS amountCents, received_date AS date
     FROM payments WHERE case_id = ? AND import_key IS NULL AND received = 1`
  )
  const conflicts: CaseConflict[] = []
  const touchedCases = new Map<number, string>()
  for (const p of planned) {
    const caseId = matchedIds.get(p.key)
    if (caseId != null && p.matchedCaseTitle) touchedCases.set(caseId, p.matchedCaseTitle)
  }
  for (const [caseId, caseTitle] of touchedCases) {
    // Match against EVERY incoming row for this case, regardless of received
    // status: a row the export marks uncollected still accounts for the
    // existing record (it gets corrected, not deleted). Deduped rows count too,
    // since the same settlement is often filed under a differently-named case.
    const incomingForCase = planned.filter((p) => matchedIds.get(p.key) === caseId)

    const existing = existingFor.all(caseId) as Array<{
      id: number
      amountCents: number
      date: string | null
    }>
    const stale = existing.filter(
      (e) =>
        !incomingForCase.some(
          (p) => p.amountCents === e.amountCents && (p.paymentDate ?? null) === e.date
        )
    )
    if (stale.length === 0) continue

    const staleCents = stale.reduce((s, e) => s + e.amountCents, 0)
    const incomingCents = incomingForCase
      .filter((p) => p.received)
      .reduce((s, p) => s + p.amountCents, 0)
    conflicts.push({
      caseId,
      caseTitle,
      existing: stale.map((e) => ({ paymentId: e.id, amountCents: e.amountCents, date: e.date })),
      incoming: incomingForCase
        .filter((p) => p.received)
        .map((p) => ({ amountCents: p.amountCents, date: p.paymentDate })),
      keepBothCents: staleCents + incomingCents,
      supersedeCents: incomingCents
    })
  }
  if (conflicts.length > 0) {
    messages.push(
      `${conflicts.length} case${conflicts.length === 1 ? '' : 's'} already hold payments this export replaces — keeping both would double-count.`
    )
  }
  if (statusFixes.length > 0) {
    const delta = statusFixes.reduce(
      (s, f) => s + (f.exportSaysReceived ? f.amountCents : -f.amountCents),
      0
    )
    messages.push(
      `${statusFixes.length} payment${statusFixes.length === 1 ? '' : 's'} disagree with the export on whether the money was collected (${delta >= 0 ? '+' : '−'}$${Math.abs(delta / 100).toLocaleString()} to income if aligned).`
    )
  }

  const willCount = planned.filter(
    (p) => p.received && (p.action === 'import' || p.action === 'no-year')
  )
  const recomputed = planned
    .filter((p) => p.received)
    .reduce((s, p) => s + p.amountCents, 0)
  const fileIncome =
    exp.summary?.realizedIncome !== undefined ? toCents(exp.summary.realizedIncome) : null
  const matches = fileIncome === null || fileIncome === recomputed
  if (!matches) {
    messages.push(
      `Summary drift: the file reports $${(fileIncome! / 100).toLocaleString()} realized, the rows total $${(recomputed / 100).toLocaleString()}. Trusting the rows.`
    )
  }

  // JP + Trestle + Unassigned must reconcile to realized income (v1 rule 2).
  const byResolver = { JP: 0, Trestle: 0, Unassigned: 0 }
  for (const p of planned.filter((x) => x.received)) {
    byResolver[p.resolvedBy ?? 'Unassigned'] += p.amountCents
  }
  const identity = byResolver.JP + byResolver.Trestle + byResolver.Unassigned === recomputed
  if (!identity) messages.push('Resolver split does not reconcile to realized income.')

  return {
    schemaOk,
    sourceAppVersion: exp.sourceAppVersion ?? null,
    exportedAt: exp.exportedAt ?? null,
    rows: planned,
    conflicts,
    statusFixes,
    totals: {
      rows: planned.length,
      toImport: planned.filter((p) => p.action === 'import' || p.action === 'no-year').length,
      alreadyImported: planned.filter((p) => p.action === 'already-imported').length,
      duplicateOfExisting: planned.filter((p) => p.action === 'duplicate-of-existing').length,
      withoutYear: planned.filter((p) => p.action === 'no-year').length,
      realizedIncomeCents: willCount.reduce((s, p) => s + p.amountCents, 0)
    },
    verification: {
      fileRealizedIncomeCents: fileIncome,
      recomputedRealizedIncomeCents: recomputed,
      matches,
      resolverIdentityHolds: identity,
      messages
    }
  }
}

export interface MetricsImportResult {
  imported: number
  skipped: number
  linkedToCases: number
  legacyRows: number
  supersededPayments: number
  statusCorrected: number
}

/**
 * @param supersedeConflicts when true, delete the stale non-imported payments
 * identified in `plan.conflicts` so the export's figures stand alone. Always a
 * deliberate choice by the operator — the plan shows both totals first.
 */
export function commitMetricsImport(
  db: Database.Database,
  exp: MetricsExport,
  plan: MetricsImportPlan,
  supersedeConflicts = false
): MetricsImportResult {
  if (!plan.schemaOk) throw new Error('Refusing to import: unexpected schema id')
  const result: MetricsImportResult = {
    imported: 0,
    skipped: 0,
    linkedToCases: 0,
    legacyRows: 0,
    supersededPayments: 0,
    statusCorrected: 0
  }

  const byKey = new Map(plan.rows.map((p) => [p.key, p]))
  const findCaseByLicensee = db.prepare(
    `SELECT id FROM cases WHERE licensee_id = ? ORDER BY status = 'Resolved', opened_at DESC LIMIT 1`
  )
  const insert = db.prepare(
    `INSERT OR IGNORE INTO payments
       (case_id, amount_cents, received_date, received, legacy, resolved_by, year, source_label, import_key, infringement_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const deletePayment = db.prepare('DELETE FROM payments WHERE id = ? AND import_key IS NULL')
  const logSupersede = db.prepare(
    "INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'import', ?)"
  )

  const tx = db.transaction(() => {
    if (supersedeConflicts) {
      const today = new Date().toISOString().slice(0, 10)
      const alignRow = db.prepare(
        'UPDATE payments SET received = ?, resolved_by = ? WHERE id = ?'
      )
      for (const f of plan.statusFixes) {
        if (
          alignRow.run(f.exportSaysReceived ? 1 : 0, f.exportResolvedBy, f.paymentId).changes === 1
        ) {
          result.statusCorrected += 1
        }
      }
      for (const c of plan.conflicts) {
        for (const e of c.existing) {
          if (deletePayment.run(e.paymentId).changes === 1) result.supersededPayments += 1
        }
        logSupersede.run(
          c.caseId,
          today,
          `Superseded ${c.existing.length} earlier payment record${c.existing.length === 1 ? '' : 's'} (${c.existing
            .map((e) => `$${(e.amountCents / 100).toLocaleString()}${e.date ? ` on ${e.date}` : ''}`)
            .join(', ')}) with the v1 metrics export of ${plan.exportedAt?.slice(0, 10) ?? 'unknown date'}.`
        )
      }
    }
    for (const r of exp.rows) {
      const key = rowKey(r)
      const p = byKey.get(key)
      if (!p || p.action === 'already-imported' || p.action === 'duplicate-of-existing') {
        result.skipped += 1
        continue
      }
      let caseId: number | null = null
      if (r.rowType === 'case_payment' && (r.infringer ?? '').trim()) {
        const licensee = findLicenseeByName(db, r.infringer!.trim())
        if (licensee) {
          const c = findCaseByLicensee.get(licensee.id) as { id: number } | undefined
          caseId = c?.id ?? null
        }
      }
      const isLegacy = r.rowType === 'legacy_entry' || caseId === null
      const info = insert.run(
        caseId,
        p.amountCents,
        p.paymentDate,
        p.received ? 1 : 0,
        isLegacy ? 1 : 0,
        p.resolvedBy,
        p.year,
        p.infringer,
        key,
        // Only needed when there's no case to inherit the type from; a matched
        // case row keeps deriving its type from the case itself.
        caseId === null ? (r.infringementType ?? null) : null
      )
      if (info.changes === 1) {
        result.imported += 1
        if (caseId !== null) result.linkedToCases += 1
        else result.legacyRows += 1
      } else {
        result.skipped += 1
      }
    }
  })
  tx()
  return result
}
