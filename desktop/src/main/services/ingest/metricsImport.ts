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
  amountCents: number
  year: number | null
  paymentDate: string | null
  received: boolean
  resolvedBy: 'JP' | 'Trestle' | null
  matchedCaseTitle: string | null
  action: RowAction
  note: string | null
}

export interface MetricsImportPlan {
  schemaOk: boolean
  sourceAppVersion: string | null
  exportedAt: string | null
  rows: PlannedRow[]
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
  const dupPayment = db.prepare(
    `SELECT 1 FROM payments
     WHERE amount_cents = ? AND IFNULL(received_date,'') = IFNULL(?,'')
       AND IFNULL(case_id, -1) = IFNULL(?, -1) AND import_key IS NULL`
  )

  const planned: PlannedRow[] = []
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

    let action: RowAction = 'import'
    let note: string | null = null
    if (keyExists.get(key)) {
      action = 'already-imported'
      note = 'This export row is already in the database.'
    } else if (dupPayment.get(cents, paymentDate, matchedCaseId)) {
      action = 'duplicate-of-existing'
      note =
        'A payment with the same case, amount and date already exists (likely the seeded precedent) — skipped to avoid double-counting.'
    } else if (year === null) {
      action = 'no-year'
      note = 'No paymentDate and no year — imported but excluded from the by-year table.'
    }

    planned.push({
      key,
      rowType: r.rowType,
      infringer: infringer || '(unlabelled)',
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
}

export function commitMetricsImport(
  db: Database.Database,
  exp: MetricsExport,
  plan: MetricsImportPlan
): MetricsImportResult {
  if (!plan.schemaOk) throw new Error('Refusing to import: unexpected schema id')
  const result: MetricsImportResult = { imported: 0, skipped: 0, linkedToCases: 0, legacyRows: 0 }

  const byKey = new Map(plan.rows.map((p) => [p.key, p]))
  const findCaseByLicensee = db.prepare(
    `SELECT id FROM cases WHERE licensee_id = ? ORDER BY status = 'Resolved', opened_at DESC LIMIT 1`
  )
  const insert = db.prepare(
    `INSERT OR IGNORE INTO payments
       (case_id, amount_cents, received_date, received, legacy, resolved_by, year, source_label, import_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const tx = db.transaction(() => {
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
        key
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
