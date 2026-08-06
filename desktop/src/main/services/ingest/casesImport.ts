import type Database from 'better-sqlite3'
import { CASE_SOURCES, CASE_TYPES } from '../../../shared/types'
import type { CaseSource, CaseStatus, CaseType } from '../../../shared/types'
import { normalizeCompanyName } from '../../../shared/domain/naming'
import { addCasePayment, findDuplicatePayment } from '../metrics'
import { createCase } from '../../db/queries'

/**
 * Bulk case intake from a spreadsheet — paste TSV straight out of Excel or
 * Sheets, or pick a .csv/.tsv file.
 *
 * Two phases like every other importer here: scan produces a per-row verdict
 * and writes nothing, commit applies it. Cases are the record of what was
 * enforced and when, so a silent bad import is expensive to unpick — every
 * defaulted field and every skipped row is reported rather than assumed.
 *
 * Mark codes are deliberately NOT importable: a case's marks are derived from
 * the licensee's license record (license_marks), so importing them here would
 * create a second, diverging source of truth.
 */

export const CASE_IMPORT_FIELDS = [
  'matter',
  'licensee',
  'type',
  'status',
  'opened',
  'source',
  'url',
  'settlement',
  'credit',
  'resolved',
  'amount',
  'paidOn',
  'notes'
] as const

export type CaseImportField = (typeof CASE_IMPORT_FIELDS)[number]

/** Header aliases, compared after lowercasing and stripping non-alphanumerics. */
const HEADER_ALIASES: Record<CaseImportField, string[]> = {
  matter: ['matter', 'case', 'casename', 'name', 'title', 'infringer', 'brand', 'company'],
  licensee: ['licensee', 'licenseename', 'legalname', 'legalentity', 'entity', 'registrant'],
  type: ['type', 'infringementtype', 'casetype', 'violation', 'violationtype'],
  status: ['status', 'casestatus', 'stage', 'state'],
  opened: [
    'opened',
    'openedat',
    'dateopened',
    'opendate',
    'startdate',
    'start',
    'date',
    'dateidentified',
    'identified',
    'discovered'
  ],
  source: ['source', 'channel', 'where', 'foundon', 'platform', 'medium'],
  url: ['url', 'link', 'website', 'weblink', 'listing'],
  settlement: ['settlement', 'settlementposition', 'demand', 'position', 'ask'],
  credit: ['credit', 'resolvedby', 'resolutioncredit', 'owner', 'handledby', 'assignedto', 'lead'],
  resolved: ['resolved', 'resolvedat', 'dateresolved', 'closed', 'closedate', 'dateclosed'],
  amount: ['amount', 'payment', 'paid', 'amountpaid', 'recovered', 'settlementamount', 'income'],
  paidOn: ['paidon', 'paymentdate', 'datepaid', 'received', 'receiveddate', 'datereceived'],
  notes: ['notes', 'note', 'comment', 'comments', 'detail', 'details', 'description']
}

const STATUS_ALIASES: Array<[RegExp, CaseStatus]> = [
  [/^(resolved|closed|complete|completed|settled|paid|done|failed)$/, 'Resolved'],
  [/^(open|new|active|identified|flagged)$/, 'Open'],
  [/(progress|negotiat|litigat|trestle|auditing|sent|submitted|pending|response)/, 'In Progress']
]

const TYPE_ALIASES: Array<[RegExp, CaseType]> = [
  [/expired|lapsed|expiry/, 'Expired License'],
  [/never\s*certified|nevercert|no\s*license|unlicensed.*never/, 'Unlicensed Use - Never Certified'],
  [/ownership|acquisition|acquired|change\s*in\s*owner/, 'Unlicensed Use - Change in Ownership'],
  [/unlicensed|infring|misuse/, 'Unlicensed Use']
]

const SOURCE_ALIASES: Array<[RegExp, CaseSource]> = [
  [/amazon|amzn/, 'Amazon'],
  [/instagram|facebook|tiktok|social|twitter|linkedin/, 'Social Media'],
  [/packag|label|pouch|box/, 'Product Packaging'],
  [/retail|store|shelf|whole\s*foods|sprouts|kroger|target|costco/, 'Third-Party Retail'],
  [/web|site|url|online|shopify/, 'Website']
]

export type CaseRowAction = 'create' | 'duplicate' | 'error'

export interface CaseImportRow {
  line: number
  matter: string
  licensee: string
  type: CaseType
  status: CaseStatus
  source: CaseSource
  openedAt: string
  url: string | null
  settlement: string | null
  resolvedAt: string | null
  resolvedBy: 'JP' | 'Trestle' | null
  amountCents: number | null
  paidOn: string | null
  notes: string | null
  action: CaseRowAction
  /** Existing case this row duplicates. */
  matchedCaseTitle: string | null
  /** Why it errored, or which fields were defaulted / adjusted. */
  messages: string[]
  /** True when the money on this row already exists on the ledger. */
  paymentDuplicate: boolean
}

export interface CaseImportScan {
  /** Fields the header actually mapped to, in column order. */
  recognized: CaseImportField[]
  /** Header cells that matched nothing and will be ignored. */
  unrecognized: string[]
  rows: CaseImportRow[]
  totals: {
    rows: number
    create: number
    duplicate: number
    error: number
    withPayments: number
    paymentDuplicates: number
    recoveredCents: number
  }
}

export interface CaseImportResult {
  casesCreated: number
  paymentsRecorded: number
  paymentsSkipped: number
  notesAdded: number
  skipped: number
}

/**
 * Splits CSV or TSV. The delimiter is inferred from the header line: a tab
 * anywhere means TSV, which is what a spreadsheet paste produces. Quoted CSV
 * fields (including embedded commas, quotes and newlines) are handled — matter
 * names like "Ron's Schoolhouse Grille, Inc." are the norm here, not the edge.
 */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const headerLine = src.slice(0, src.indexOf('\n') === -1 ? undefined : src.indexOf('\n'))
  const delim = headerLine.includes('\t') ? '\t' : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''))
}

const normHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function mapHeader(cells: string[]): {
  map: Array<CaseImportField | null>
  unrecognized: string[]
} {
  const used = new Set<CaseImportField>()
  const map: Array<CaseImportField | null> = []
  const unrecognized: string[] = []

  for (const cell of cells) {
    const n = normHeader(cell)
    let hit: CaseImportField | null = null
    for (const field of CASE_IMPORT_FIELDS) {
      if (used.has(field)) continue
      if (HEADER_ALIASES[field].includes(n)) {
        hit = field
        break
      }
    }
    if (hit) used.add(hit)
    else if (cell !== '') unrecognized.push(cell)
    map.push(hit)
  }
  return { map, unrecognized }
}

/** ISO passes through; M/D/YYYY and M/D/YY (spreadsheet default) are converted. */
export function toIsoDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (slash) {
    const year = slash[3]!.length === 2 ? `20${slash[3]}` : slash[3]!
    return `${year}-${slash[1]!.padStart(2, '0')}-${slash[2]!.padStart(2, '0')}`
  }
  return null
}

export function parseMoneyCents(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const k = s.match(/^\$?\s*(\d+(?:\.\d+)?)\s*k$/i)
  if (k) return Math.round(parseFloat(k[1]!) * 1000 * 100)
  const n = parseFloat(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null
}

function matchAlias<T>(value: string, table: Array<[RegExp, T]>): T | null {
  const v = value.toLowerCase().trim()
  if (!v) return null
  for (const [re, out] of table) if (re.test(v)) return out
  return null
}

export function scanCaseImport(db: Database.Database, text: string, today: string): CaseImportScan {
  const grid = parseDelimited(text)
  if (grid.length === 0)
    return {
      recognized: [],
      unrecognized: [],
      rows: [],
      totals: {
        rows: 0,
        create: 0,
        duplicate: 0,
        error: 0,
        withPayments: 0,
        paymentDuplicates: 0,
        recoveredCents: 0
      }
    }

  const { map, unrecognized } = mapHeader(grid[0]!)
  if (!map.includes('matter'))
    throw new Error(
      'No column for the matter name. Add a header row with at least a "Matter" column — see the accepted columns above.'
    )

  const existing = db.prepare('SELECT id, title, licensee_id AS licenseeId FROM cases').all() as Array<{
    id: number
    title: string
    licenseeId: number | null
  }>
  const licenseeNames = new Map(
    (db.prepare('SELECT id, name FROM licensees').all() as Array<{ id: number; name: string }>).map(
      (l) => [l.id, l.name]
    )
  )
  const seen = new Map<string, string>()
  for (const c of existing) {
    const key = `${normalizeCompanyName(licenseeNames.get(c.licenseeId ?? -1) ?? c.title)}|${normalizeCompanyName(c.title)}`
    if (!seen.has(key)) seen.set(key, c.title)
  }

  const rows: CaseImportRow[] = []
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!
    const get = (field: CaseImportField): string => {
      const i = map.indexOf(field)
      return i === -1 ? '' : (cells[i] ?? '')
    }
    const messages: string[] = []
    const matter = get('matter').trim()

    const licensee = get('licensee').trim() || matter

    const rawType = get('type')
    const type = matchAlias(rawType, TYPE_ALIASES) ?? 'Unlicensed Use'
    if (rawType.trim() && !matchAlias(rawType, TYPE_ALIASES))
      messages.push(`type "${rawType}" not recognized — defaulted to Unlicensed Use`)
    else if (!rawType.trim()) messages.push('no type — defaulted to Unlicensed Use')

    const rawResolved = get('resolved')
    const resolvedAt = toIsoDate(rawResolved)
    if (rawResolved.trim() && !resolvedAt) messages.push(`resolved date "${rawResolved}" unreadable`)

    const rawStatus = get('status')
    // A resolution date with no status is unambiguous — the matter is closed.
    const status =
      matchAlias(rawStatus, STATUS_ALIASES) ?? (resolvedAt ? 'Resolved' : ('Open' as CaseStatus))
    if (rawStatus.trim() && !matchAlias(rawStatus, STATUS_ALIASES))
      messages.push(`status "${rawStatus}" not recognized — defaulted to ${status}`)

    const rawSource = get('source')
    const source = matchAlias(rawSource, SOURCE_ALIASES) ?? 'Website'
    if (rawSource.trim() && !matchAlias(rawSource, SOURCE_ALIASES))
      messages.push(`source "${rawSource}" not recognized — defaulted to Website`)

    const rawOpened = get('opened')
    let openedAt = toIsoDate(rawOpened)
    if (rawOpened.trim() && !openedAt) messages.push(`opened date "${rawOpened}" unreadable`)
    if (!openedAt) {
      openedAt = resolvedAt ?? today
      messages.push(`no opened date — used ${openedAt}`)
    }

    const rawCredit = get('credit').trim().toLowerCase()
    const resolvedBy: 'JP' | 'Trestle' | null = /trestle|bruss|roberts|seedborg|counsel|outside/.test(
      rawCredit
    )
      ? 'Trestle'
      : /^(jp|jonathan|pendergrass|in\s*house|internal)/.test(rawCredit)
        ? 'JP'
        : null
    if (rawCredit && !resolvedBy)
      messages.push(`credit "${get('credit')}" not JP or Trestle — left unassigned`)

    const rawAmount = get('amount')
    const amountCents = parseMoneyCents(rawAmount)
    if (rawAmount.trim() && amountCents === null)
      messages.push(`amount "${rawAmount}" unreadable — no payment will be recorded`)

    const rawPaidOn = get('paidOn')
    let paidOn = toIsoDate(rawPaidOn)
    if (rawPaidOn.trim() && !paidOn) messages.push(`payment date "${rawPaidOn}" unreadable`)
    if (amountCents !== null && !paidOn) {
      paidOn = resolvedAt ?? openedAt
      messages.push(`no payment date — booked to ${paidOn}`)
    }

    let action: CaseRowAction = 'create'
    let matchedCaseTitle: string | null = null
    if (!matter) {
      action = 'error'
      messages.unshift('no matter name')
    } else {
      const key = `${normalizeCompanyName(licensee)}|${normalizeCompanyName(matter)}`
      const hit = seen.get(key)
      if (hit) {
        action = 'duplicate'
        matchedCaseTitle = hit
      } else {
        // Reserve it so two identical rows in the same paste don't both create.
        seen.set(key, matter)
      }
    }

    const paymentDuplicate =
      action === 'create' && amountCents !== null && paidOn !== null
        ? findDuplicatePayment(db, -1, amountCents, paidOn) !== null
        : false
    if (paymentDuplicate)
      messages.push('that amount and date are already on the ledger — payment will be skipped')

    rows.push({
      line: r + 1,
      matter,
      licensee,
      type,
      status,
      source,
      openedAt,
      url: get('url').trim() || null,
      settlement: get('settlement').trim() || null,
      resolvedAt,
      resolvedBy,
      amountCents,
      paidOn,
      notes: get('notes').trim() || null,
      action,
      matchedCaseTitle,
      messages,
      paymentDuplicate
    })
  }

  const creating = rows.filter((r) => r.action === 'create')
  return {
    recognized: map.filter((f): f is CaseImportField => f !== null),
    unrecognized,
    rows,
    totals: {
      rows: rows.length,
      create: creating.length,
      duplicate: rows.filter((r) => r.action === 'duplicate').length,
      error: rows.filter((r) => r.action === 'error').length,
      withPayments: creating.filter((r) => r.amountCents !== null && !r.paymentDuplicate).length,
      paymentDuplicates: rows.filter((r) => r.paymentDuplicate).length,
      recoveredCents: creating
        .filter((r) => !r.paymentDuplicate)
        .reduce((s, r) => s + (r.amountCents ?? 0), 0)
    }
  }
}

export function commitCaseImport(db: Database.Database, scan: CaseImportScan): CaseImportResult {
  const result: CaseImportResult = {
    casesCreated: 0,
    paymentsRecorded: 0,
    paymentsSkipped: 0,
    notesAdded: 0,
    skipped: 0
  }

  db.transaction(() => {
    for (const row of scan.rows) {
      if (row.action !== 'create') {
        result.skipped += 1
        continue
      }
      const created = createCase(db, {
        title: row.matter,
        licenseeName: row.licensee,
        type: row.type,
        status: row.status,
        source: row.source,
        url: row.url ?? undefined,
        openedAt: row.openedAt,
        settlementPosition: row.settlement ?? undefined
      })
      result.casesCreated += 1

      // createCase only takes the opening fields; resolution is a later state.
      if (row.status === 'Resolved' || row.resolvedAt || row.resolvedBy) {
        db.prepare('UPDATE cases SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(
          row.resolvedAt ?? row.openedAt,
          row.resolvedBy,
          created.id
        )
      }

      if (row.notes) {
        db.prepare(
          "INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'import', ?)"
        ).run(created.id, row.openedAt, row.notes)
        result.notesAdded += 1
      }

      if (row.amountCents !== null && row.paidOn) {
        if (row.paymentDuplicate) result.paymentsSkipped += 1
        else {
          addCasePayment(db, created.id, {
            amountCents: row.amountCents,
            received: true,
            date: row.paidOn,
            // Credit is set on the case, so the payment inherits it.
            resolvedBy: null
          })
          result.paymentsRecorded += 1
        }
      } else if (row.amountCents !== null) {
        result.paymentsSkipped += 1
      }
    }
  })()

  return result
}

/** Column reference shown in the UI so the expected sheet shape is discoverable. */
export const CASE_IMPORT_COLUMN_HELP: Array<{
  field: CaseImportField
  required: boolean
  accepts: string
}> = [
  { field: 'matter', required: true, accepts: 'Case / brand name. Also: Case, Name, Infringer, Company' },
  { field: 'licensee', required: false, accepts: 'Legal entity if different from the matter name' },
  { field: 'type', required: false, accepts: CASE_TYPES.join(' · ') + ' — fuzzy matched' },
  { field: 'status', required: false, accepts: 'Open · In Progress · Resolved (also Completed, Negotiations, Litigation)' },
  { field: 'opened', required: false, accepts: 'YYYY-MM-DD or M/D/YYYY' },
  { field: 'source', required: false, accepts: CASE_SOURCES.join(' · ') },
  { field: 'url', required: false, accepts: 'Infringing listing or site' },
  { field: 'settlement', required: false, accepts: 'Settlement position, free text' },
  { field: 'credit', required: false, accepts: 'JP or Trestle' },
  { field: 'resolved', required: false, accepts: 'Date resolved — sets status to Resolved' },
  { field: 'amount', required: false, accepts: 'Money recovered — records a received payment' },
  { field: 'paidOn', required: false, accepts: 'Date the money arrived (defaults to the resolved date)' },
  { field: 'notes', required: false, accepts: 'Seeds the first timeline entry' }
]
