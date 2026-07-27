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
              COALESCE(c.type, 'Legacy entry') AS type,
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
