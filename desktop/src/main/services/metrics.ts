import type Database from 'better-sqlite3'

/**
 * Settlement metrics (M5). Ported from current-build/src/FAFOApp.jsx Metrics
 * (lines 2755-2835): income by year and infringement type, plus the
 * JP-vs-Trestle resolution-credit split with an explicit Unassigned bucket
 * so the attributed totals never silently misstate the grand total.
 */

export interface ResolverStat {
  who: string
  totalCents: number
  payments: number
  caseCount: number
}

export interface YearRow {
  year: number
  totalCents: number
  count: number
  byType: Record<string, number>
  byResolver: Record<string, number>
}

export interface MetricsSummary {
  years: YearRow[]
  grandTotalCents: number
  resolvers: ResolverStat[]
  unassignedCents: number
  unassignedCases: number
  attributedCents: number
  openCases: number
  resolvedCases: number
}

const RESOLVERS = ['JP', 'Trestle'] as const

export function metricsSummary(db: Database.Database): MetricsSummary {
  const payments = db
    .prepare(
      `SELECT p.amount_cents AS cents,
              COALESCE(p.year, CAST(substr(COALESCE(p.received_date, p.due_date), 1, 4) AS INTEGER)) AS year,
              COALESCE(p.infringement_type, c.type, 'Legacy entry') AS type,
              COALESCE(p.resolved_by, c.resolved_by) AS resolvedBy
       FROM payments p LEFT JOIN cases c ON c.id = p.case_id
       WHERE p.received = 1`
    )
    .all() as Array<{ cents: number; year: number | null; type: string; resolvedBy: string | null }>

  const years = new Map<number, YearRow>()
  for (const p of payments) {
    if (p.year === null) continue
    let row = years.get(p.year)
    if (!row) {
      row = { year: p.year, totalCents: 0, count: 0, byType: {}, byResolver: { Unassigned: 0 } }
      for (const r of RESOLVERS) row.byResolver[r] = 0
      years.set(p.year, row)
    }
    row.totalCents += p.cents
    row.count += 1
    row.byType[p.type] = (row.byType[p.type] ?? 0) + p.cents
    const bucket = p.resolvedBy ?? 'Unassigned'
    row.byResolver[bucket] = (row.byResolver[bucket] ?? 0) + p.cents
  }

  const resolvedCaseCounts = db
    .prepare(
      `SELECT COALESCE(resolved_by, 'Unassigned') AS who, COUNT(*) AS n
       FROM cases WHERE status = 'Resolved' GROUP BY who`
    )
    .all() as Array<{ who: string; n: number }>
  const caseCountFor = (who: string): number =>
    resolvedCaseCounts.find((r) => r.who === who)?.n ?? 0

  const resolvers: ResolverStat[] = RESOLVERS.map((who) => {
    const rows = payments.filter((p) => p.resolvedBy === who)
    return {
      who,
      totalCents: rows.reduce((s, p) => s + p.cents, 0),
      payments: rows.length,
      caseCount: caseCountFor(who)
    }
  })

  const unassigned = payments.filter((p) => !p.resolvedBy)
  const status = db
    .prepare(
      `SELECT SUM(status != 'Resolved') AS open, SUM(status = 'Resolved') AS resolved FROM cases`
    )
    .get() as { open: number | null; resolved: number | null }

  return {
    years: [...years.values()].sort((a, b) => a.year - b.year),
    grandTotalCents: payments.reduce((s, p) => s + p.cents, 0),
    resolvers,
    unassignedCents: unassigned.reduce((s, p) => s + p.cents, 0),
    unassignedCases: caseCountFor('Unassigned'),
    attributedCents: resolvers.reduce((s, r) => s + r.totalCents, 0),
    openCases: status.open ?? 0,
    resolvedCases: status.resolved ?? 0
  }
}

/**
 * Legacy settlement entries (v1 parity). v1 kept these in localStorage under
 * `fafo_legacy_payments` so historical income that predates the case file
 * still counted; v2 stores them as payment rows with legacy = 1.
 */
export interface LegacyEntryInput {
  label: string
  type: string
  amountCents: number
  year: number
  receivedDate?: string | null
  resolvedBy?: 'JP' | 'Trestle' | null
}

export interface LegacyEntry extends LegacyEntryInput {
  id: number
}

export function addLegacyPayment(db: Database.Database, input: LegacyEntryInput): LegacyEntry {
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (case_id, amount_cents, received_date, received, legacy, resolved_by, year, source_label, infringement_type)
         VALUES (NULL, ?, ?, 1, 1, ?, ?, ?, ?)`
      )
      .run(
        input.amountCents,
        input.receivedDate ?? null,
        input.resolvedBy ?? null,
        input.year,
        input.label,
        input.type
      ).lastInsertRowid
  )
  return { ...input, id }
}

export function listLegacyPayments(db: Database.Database): LegacyEntry[] {
  return (
    db
      .prepare(
        `SELECT id, source_label AS label, amount_cents AS amountCents, year,
                received_date AS receivedDate, resolved_by AS resolvedBy,
                infringement_type AS type
         FROM payments WHERE legacy = 1 ORDER BY year DESC, id DESC`
      )
      .all() as Array<Omit<LegacyEntry, 'type'> & { type: string | null }>
  ).map((r) => ({ ...r, type: r.type ?? 'Legacy entry' }))
}

export function removeLegacyPayment(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM payments WHERE id = ? AND legacy = 1').run(id)
}

/**
 * Settlement amounts recorded as free text on a case (typically from the
 * tracking-sheet import) that have no payment row, so they are invisible to
 * the income rollups.
 *
 * These are SUGGESTIONS ONLY. Settlement text is ambiguous — "Paid settlement,
 * 17k" is money received, while "$30,000 opening / $25,000 compromise" is a
 * negotiating position and "$30,000 cessation OR $40,000 new license" is a
 * pair of options. Converting them automatically would invent income, so each
 * is classified and must be confirmed by a human before it becomes a payment.
 */
export interface SettlementSuggestion {
  caseId: number
  caseTitle: string
  settlementText: string
  suggestedCents: number | null
  /** 'received' — text asserts payment; 'position' — a demand/offer, likely not received */
  reading: 'received' | 'position'
  year: number
}

const POSITION_WORDS =
  /\b(opening|compromise|demand|suggested|proposed|offer|preferred|position|OR|per agreement|TBD|pending|litigation)\b/i
const RECEIVED_WORDS = /\b(paid|settled|received|completed|collected|recovered)\b/i

export function parseSettlementAmountCents(text: string): number | null {
  // "17k", "7.5k"
  const k = text.match(/(\d+(?:\.\d+)?)\s*k\b/i)
  if (k) return Math.round(parseFloat(k[1]!) * 1000 * 100)
  // "$10,000.00"
  const d = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/)
  if (d) return Math.round(parseFloat(d[1]!.replace(/,/g, '')) * 100)
  return null
}

export function unrecordedSettlements(db: Database.Database): SettlementSuggestion[] {
  const rows = db
    .prepare(
      `SELECT c.id AS caseId, c.title AS caseTitle, c.settlement_position AS text,
              COALESCE(c.resolved_at, c.opened_at) AS whenAt
       FROM cases c
       WHERE c.settlement_position IS NOT NULL AND TRIM(c.settlement_position) != ''
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.case_id = c.id)
       ORDER BY c.title`
    )
    .all() as Array<{ caseId: number; caseTitle: string; text: string; whenAt: string }>

  const out: SettlementSuggestion[] = []
  for (const r of rows) {
    const cents = parseSettlementAmountCents(r.text)
    if (cents === null) continue
    // A position reading wins over a received reading when both appear, so an
    // unpaid demand is never silently booked as income.
    const reading: 'received' | 'position' = POSITION_WORDS.test(r.text)
      ? 'position'
      : RECEIVED_WORDS.test(r.text)
        ? 'received'
        : 'position'
    out.push({
      caseId: r.caseId,
      caseTitle: r.caseTitle,
      settlementText: r.text,
      suggestedCents: cents,
      reading,
      year: parseInt(r.whenAt.slice(0, 4), 10)
    })
  }
  return out
}

/** Confirm a suggestion (possibly edited) as a real received payment. */
export function confirmSettlementPayment(
  db: Database.Database,
  caseId: number,
  amountCents: number,
  receivedDate: string,
  resolvedBy: 'JP' | 'Trestle' | null
): void {
  db.prepare(
    `INSERT INTO payments (case_id, amount_cents, received_date, received, legacy, resolved_by, year)
     VALUES (?, ?, ?, 1, 0, ?, ?)`
  ).run(caseId, amountCents, receivedDate, resolvedBy, parseInt(receivedDate.slice(0, 4), 10))
  db.prepare(
    "INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'payment', ?)"
  ).run(
    caseId,
    receivedDate,
    `Payment of $${(amountCents / 100).toLocaleString()} recorded as received (confirmed from the settlement note).`
  )
}

/**
 * Per-mark policing record (M5, improvement 19). Supports the validity /
 * anti-abandonment posture: every enforcement action taken for a given mark,
 * in date order, with outcomes.
 */
export interface PolicingEntry {
  caseTitle: string
  type: string
  status: string
  openedAt: string
  resolvedAt: string | null
  settlement: string | null
  lettersSent: number
  evidenceCount: number
  recoveredCents: number
}

export interface PolicingRecord {
  markCode: string
  markName: string
  usptoRegNo: string
  regStatus: string
  generatedAt: string
  entries: PolicingEntry[]
  totalRecoveredCents: number
  /** Matters that exist but can't yet be attributed to any mark (no extracted
   * license marks for that licensee). Reported so the record is never read as
   * a complete enforcement history when it isn't. */
  unattributableCases: number
  totalCases: number
}

export function policingRecord(db: Database.Database, markCode: string): PolicingRecord {
  const mark = db
    .prepare(
      'SELECT code, name, uspto_reg_no AS regNo, reg_status AS regStatus FROM marks WHERE code = ?'
    )
    .get(markCode) as
    | { code: string; name: string; regNo: string; regStatus: string }
    | undefined
  if (!mark) throw new Error(`Unknown mark code: ${markCode}`)

  const entries = db
    .prepare(
      `SELECT DISTINCT c.id, c.title, c.type, c.status, c.opened_at AS openedAt,
              c.resolved_at AS resolvedAt, c.settlement_position AS settlement
       FROM cases c
       JOIN licenses li ON li.licensee_id = c.licensee_id
       JOIN license_marks lm ON lm.license_id = li.id
       JOIN marks m ON m.id = lm.mark_id
       WHERE m.code = ?
       ORDER BY c.opened_at`
    )
    .all(markCode) as Array<{
    id: number
    title: string
    type: string
    status: string
    openedAt: string
    resolvedAt: string | null
    settlement: string | null
  }>

  const letterCount = db.prepare(
    "SELECT COUNT(*) AS n FROM letters WHERE case_id = ? AND sent_at IS NOT NULL"
  )
  const evidenceCount = db.prepare('SELECT COUNT(*) AS n FROM evidence_files WHERE case_id = ?')
  const recovered = db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE case_id = ? AND received = 1'
  )

  const rows: PolicingEntry[] = entries.map((e) => ({
    caseTitle: e.title,
    type: e.type,
    status: e.status,
    openedAt: e.openedAt,
    resolvedAt: e.resolvedAt,
    settlement: e.settlement,
    lettersSent: (letterCount.get(e.id) as { n: number }).n,
    evidenceCount: (evidenceCount.get(e.id) as { n: number }).n,
    recoveredCents: (recovered.get(e.id) as { cents: number }).cents
  }))

  const coverage = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM cases) AS total,
         (SELECT COUNT(*) FROM cases c WHERE NOT EXISTS (
            SELECT 1 FROM licenses li JOIN license_marks lm ON lm.license_id = li.id
            WHERE li.licensee_id = c.licensee_id)) AS unattributable`
    )
    .get() as { total: number; unattributable: number }

  return {
    markCode: mark.code,
    markName: mark.name,
    usptoRegNo: mark.regNo,
    regStatus: mark.regStatus,
    generatedAt: new Date().toISOString().slice(0, 10),
    entries: rows,
    totalRecoveredCents: rows.reduce((s, r) => s + r.recoveredCents, 0),
    unattributableCases: coverage.unattributable,
    totalCases: coverage.total
  }
}

export function policingRecordMarkdown(r: PolicingRecord): string {
  const money = (c: number): string => `$${(c / 100).toLocaleString()}`
  const head = [
    `# Policing Record — ${r.markName}`,
    ``,
    `**Mark code:** ${r.markCode}  `,
    `**USPTO Reg. No.:** ${r.usptoRegNo} (${r.regStatus})  `,
    `**Prepared:** ${r.generatedAt} by Paleo Certified, Inc. dba The Paleo Foundation  `,
    `**Enforcement actions on record:** ${r.entries.length}  `,
    `**Total recovered:** ${money(r.totalRecoveredCents)}`,
    ``,
    `This record documents enforcement activity undertaken to police the mark above.`,
    ``,
    ...(r.unattributableCases > 0
      ? [
          `> **Coverage note.** ${r.unattributableCases} of ${r.totalCases} matters on file are not yet attributed to a specific mark, because the governing agreement has not been parsed for its licensed marks. Those matters are excluded from the table below, so this record is a **subset** of total enforcement activity. Complete license-term extraction before relying on it as a full history.`,
          ``
        ]
      : []),
    `| Opened | Matter | Type | Status | Letters | Evidence | Resolved | Recovered |`,
    `|---|---|---|---|---|---|---|---|`
  ]
  const body = r.entries.map(
    (e) =>
      `| ${e.openedAt} | ${e.caseTitle} | ${e.type} | ${e.status} | ${e.lettersSent} | ${e.evidenceCount} | ${e.resolvedAt ?? '—'} | ${e.recoveredCents ? money(e.recoveredCents) : '—'} |`
  )
  return [...head, ...body].join('\n')
}

/**
 * Brand feed (M5, improvement 20): certified-brand status for
 * paleofoundation.com, schema-documented and decoupled from the site repo.
 */
export interface BrandFeedEntry {
  brand: string
  status: 'certified' | 'expired'
  marks: string[]
  certifiedThrough: string | null
}

export function brandFeed(db: Database.Database): {
  schema: string
  generatedAt: string
  brands: BrandFeedEntry[]
} {
  const rows = db
    .prepare(
      `SELECT l.name AS brand,
              MAX(CASE WHEN li.status IN ('active','expiring') THEN 1 ELSE 0 END) AS isActive,
              MAX(CASE WHEN li.status IN ('active','expiring') THEN li.term_end END) AS through
       FROM licensees l JOIN licenses li ON li.licensee_id = l.id
       GROUP BY l.id ORDER BY l.name`
    )
    .all() as Array<{ brand: string; isActive: number; through: string | null }>

  const marksFor = db.prepare(
    `SELECT DISTINCT m.code FROM licensees l
     JOIN licenses li ON li.licensee_id = l.id
     JOIN license_marks lm ON lm.license_id = li.id
     JOIN marks m ON m.id = lm.mark_id
     WHERE l.name = ?`
  )

  return {
    schema: 'fafo.brand-feed/v1',
    generatedAt: new Date().toISOString(),
    brands: rows.map((r) => ({
      brand: r.brand,
      status: r.isActive ? 'certified' : 'expired',
      marks: (marksFor.all(r.brand) as Array<{ code: string }>).map((m) => m.code),
      certifiedThrough: r.isActive ? r.through : null
    }))
  }
}
