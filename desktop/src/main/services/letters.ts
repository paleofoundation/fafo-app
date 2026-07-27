import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { AMANDA_SYSTEM_PROMPT, buildAmandaUserPrompt } from '../../shared/domain/amandaPrompts'
import { SUMMARY_SYSTEM_PROMPT, buildSummaryUserPrompt } from '../../shared/domain/summaryPrompt'
import { nextResponseThursday, selloffEnd } from '../../shared/domain/deadlines'

/**
 * Letter generation (M4). The prompts are the verbatim v1 AMANDA and
 * SUMMARY v1.0 protocols from shared/domain; this service assembles their
 * inputs from the database and stores drafts in the letters table.
 * Nothing is ever sent automatically — drafts are for Jonathan's review,
 * and "mark as sent" is an explicit human action.
 */

export type LetterKind = 'enforcement' | 'referral_summary'

export interface LetterRow {
  id: number
  caseId: number
  kind: string
  bodyText: string
  draftedAt: string
  sentAt: string | null
  docUrl: string | null
  responseDueAt: string | null
  responseReceivedAt: string | null
  status: string
}

function caseInputs(db: Database.Database, caseId: number): {
  infringer: string
  contact: string | null
  contactEmail: string | null
  caseType: string
  source: string
  url: string | null
  openedAt: string
  settlement: string | null
  resolvedBy: string | null
  trademarkNames: string[]
  notes: string[]
  noteLines: string[]
  payments: string[]
} {
  const c = db
    .prepare(
      `SELECT c.title, c.type, c.status, c.source, c.url, c.opened_at AS openedAt,
              c.settlement_position AS settlement, c.resolved_by AS resolvedBy,
              c.licensee_id AS licenseeId,
              l.name AS licenseeName, l.contact_name AS contact, l.contact_email AS contactEmail
       FROM cases c LEFT JOIN licensees l ON l.id = c.licensee_id WHERE c.id = ?`
    )
    .get(caseId) as
    | {
        title: string
        type: string
        source: string
        url: string | null
        openedAt: string
        settlement: string | null
        resolvedBy: string | null
        licenseeId: number | null
        licenseeName: string | null
        contact: string | null
        contactEmail: string | null
      }
    | undefined
  if (!c) throw new Error(`Case ${caseId} not found`)

  const markNames = c.licenseeId
    ? (
        db
          .prepare(
            `SELECT DISTINCT m.name FROM license_marks lm
             JOIN marks m ON m.id = lm.mark_id
             JOIN licenses li ON li.id = lm.license_id
             WHERE li.licensee_id = ?`
          )
          .all(c.licenseeId) as Array<{ name: string }>
      ).map((r) => r.name)
    : []

  const events = db
    .prepare(
      `SELECT at, kind, body FROM case_events WHERE case_id = ? ORDER BY at ASC, id ASC`
    )
    .all(caseId) as Array<{ at: string; kind: string; body: string }>

  const payments = (
    db
      .prepare(
        `SELECT amount_cents AS cents, COALESCE(received_date, due_date) AS date, received
         FROM payments WHERE case_id = ? ORDER BY date`
      )
      .all(caseId) as Array<{ cents: number; date: string | null; received: number }>
  ).map((p) => `$${(p.cents / 100).toLocaleString()} on ${p.date ?? '?'} — ${p.received ? 'received' : 'pending'}`)

  return {
    infringer: c.licenseeName ?? c.title,
    contact: c.contact,
    contactEmail: c.contactEmail,
    caseType: c.type,
    source: c.source,
    url: c.url,
    openedAt: c.openedAt,
    settlement: c.settlement,
    resolvedBy: c.resolvedBy,
    trademarkNames: markNames.length > 0 ? markNames : ['(marks per case file)'],
    notes: events.map((e) => e.body),
    noteLines: events.map((e) => `[${e.at}] ${e.body}`),
    payments
  }
}

/**
 * Verified license facts for the prompt. v1 had to infer terms from case
 * notes and frequently emitted "Not confirmed from case data"; v2 holds them
 * as extracted structured data, so they are supplied as ground truth. Marks
 * carry their USPTO numbers and registration caveats so letters never
 * overstate (Certified P Paleo is a service mark; Plant-Based is pending).
 */
export function licenseFactsBlock(db: Database.Database, caseId: number): string {
  const lic = db
    .prepare(
      `SELECT li.term_start AS termStart, li.term_end AS termEnd, li.vintage,
              li.annual_fee_cents AS feeCents, li.revenue_band AS band,
              li.extraction_confidence AS confidence, li.agreement_ref AS ref,
              l.name AS licenseeName, l.address
       FROM cases c JOIN licenses li ON li.licensee_id = c.licensee_id
       JOIN licensees l ON l.id = li.licensee_id
       WHERE c.id = ? ORDER BY li.term_end IS NULL, li.term_end DESC LIMIT 1`
    )
    .get(caseId) as
    | {
        termStart: string | null
        termEnd: string | null
        vintage: string
        feeCents: number | null
        band: string | null
        confidence: number | null
        ref: string | null
        licenseeName: string
        address: string | null
      }
    | undefined

  const marks = db
    .prepare(
      `SELECT DISTINCT m.name, m.uspto_reg_no AS regNo, m.reg_status AS regStatus, m.notes
       FROM cases c JOIN licenses li ON li.licensee_id = c.licensee_id
       JOIN license_marks lm ON lm.license_id = li.id
       JOIN marks m ON m.id = lm.mark_id WHERE c.id = ?`
    )
    .all(caseId) as Array<{ name: string; regNo: string; regStatus: string; notes: string | null }>

  const lines: string[] = []
  if (marks.length > 0) {
    lines.push('Marks licensed (verified from the mark register):')
    for (const m of marks) {
      lines.push(
        `- ${m.name} — Reg. No. ${m.regNo} (${m.regStatus})${m.notes ? ` — CAVEAT: ${m.notes}` : ''}`
      )
    }
  }
  if (lic) {
    if (lic.address) lines.push(`Licensee address of record: ${lic.address}`)
    if (lic.ref) lines.push(`Agreement on file: ${lic.ref.replace('signnow:', '')}`)
    if (lic.termStart || lic.termEnd) {
      lines.push(`License term: ${lic.termStart ?? 'unknown'} through ${lic.termEnd ?? 'unknown'}`)
    }
    if (lic.feeCents !== null) {
      lines.push(
        `Annual license fee: $${(lic.feeCents / 100).toLocaleString()}${lic.band ? ` (Band ${lic.band} under the current schedule)` : ''}`
      )
    }
    if (lic.termEnd) {
      const so = selloffEnd(lic.termEnd, lic.vintage === '2020' ? '2020' : '2025')
      lines.push(
        lic.vintage === '2020'
          ? `Agreement vintage: 2020 legacy — NO liquidated damages clause and NO sell-off period (immediate cessation required at ${lic.termEnd}). Anchor any settlement to the current pricing schedule, not a contractual formula.`
          : `Agreement vintage: current template — §E.3.d.ii liquidated damages (one year's fee per month of continued misuse) and §E.3.c 180-day sell-off applying to physical inventory only, ending ${so}. Digital channels required immediate remediation at ${lic.termEnd}.`
      )
    }
    if (lic.confidence !== null && lic.confidence < 0.7) {
      lines.push(
        `NOTE: these terms were machine-extracted at ${Math.round(lic.confidence * 100)}% confidence and are NOT yet human-verified — state them as subject to confirmation against the executed agreement.`
      )
    }
  }
  if (lines.length === 0) {
    return '\n\nVERIFIED LICENSE FACTS: none on file — do not assert license terms, dates, or fees that are not in the case notes above.'
  }
  return `\n\nVERIFIED LICENSE FACTS (from the executed agreement and mark register — use these rather than inferring, and do not contradict them):\n${lines.join('\n')}`
}

export async function generateLetter(
  db: Database.Database,
  apiKey: string,
  caseId: number,
  kind: LetterKind
): Promise<LetterRow> {
  const i = caseInputs(db, caseId)
  const client = new Anthropic({ apiKey })
  const today = new Date().toISOString().slice(0, 10)

  const request =
    kind === 'enforcement'
      ? {
          system: AMANDA_SYSTEM_PROMPT,
          user: buildAmandaUserPrompt({
            trademarkNames: i.trademarkNames,
            infringer: i.infringer,
            caseType: i.caseType,
            source: i.source,
            url: i.url ?? '',
            dateOpened: i.openedAt,
            settlement: i.settlement,
            notes: i.notes
          }),
          maxTokens: 2000
        }
      : {
          system: SUMMARY_SYSTEM_PROMPT,
          user: buildSummaryUserPrompt({
            infringer: i.infringer,
            contact: i.contact,
            contactEmail: i.contactEmail,
            trademarkNames: i.trademarkNames,
            caseType: i.caseType,
            source: i.source,
            url: i.url,
            dateOpened: i.openedAt,
            todayIso: today,
            settlement: i.settlement,
            resolvedBy: i.resolvedBy,
            notes: i.noteLines,
            fileNames: [],
            payments: i.payments
          }),
          maxTokens: 8000
        }

  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user', content: request.user + licenseFactsBlock(db, caseId) }]
  })
  if (response.stop_reason === 'refusal') throw new Error('Letter generation was declined')
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) throw new Error('Letter generation returned no text')

  const id = Number(
    db
      .prepare(
        `INSERT INTO letters (case_id, kind, body_text, drafted_at, status)
         VALUES (?, ?, ?, ?, 'draft')`
      )
      .run(caseId, kind, text, today).lastInsertRowid
  )
  return getLetter(db, id)
}

export function getLetter(db: Database.Database, id: number): LetterRow {
  return db
    .prepare(
      `SELECT id, case_id AS caseId, kind, body_text AS bodyText, drafted_at AS draftedAt,
              sent_at AS sentAt, doc_drive_id AS docUrl, response_due_at AS responseDueAt,
              response_received_at AS responseReceivedAt, status
       FROM letters WHERE id = ?`
    )
    .get(id) as LetterRow
}

export function listLetters(db: Database.Database, caseId: number): LetterRow[] {
  return db
    .prepare(
      `SELECT id, case_id AS caseId, kind, body_text AS bodyText, drafted_at AS draftedAt,
              sent_at AS sentAt, doc_drive_id AS docUrl, response_due_at AS responseDueAt,
              response_received_at AS responseReceivedAt, status
       FROM letters WHERE case_id = ? ORDER BY drafted_at DESC, id DESC`
    )
    .all(caseId) as LetterRow[]
}

/**
 * Mark a letter sent: starts the response clock (protocol Thursday) as a
 * dashboard deadline and logs the timeline event. Sending itself happens
 * outside the app (or later via Graph) — this records the fact.
 */
export function markLetterSent(db: Database.Database, letterId: number): LetterRow {
  const letter = getLetter(db, letterId)
  if (!letter) throw new Error(`Letter ${letterId} not found`)
  const today = new Date().toISOString().slice(0, 10)
  const due = nextResponseThursday(today)
  db.prepare(
    `UPDATE letters SET sent_at = ?, response_due_at = ?, status = 'sent' WHERE id = ?`
  ).run(today, due, letterId)
  db.prepare(
    `INSERT INTO deadlines (ref_table, ref_id, kind, title, due_at)
     VALUES ('cases', ?, 'letter_response', ?, ?)`
  ).run(
    letter.caseId,
    `${letter.kind === 'enforcement' ? 'AMANDA letter' : 'Referral summary'} sent ${today} — response due (protocol: EOD Thursday)`,
    due
  )
  db.prepare(`INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'letter_sent', ?)`).run(
    letter.caseId,
    today,
    `${letter.kind === 'enforcement' ? 'Enforcement letter' : 'Referral summary'} marked sent; response clock runs to ${due}.`
  )
  return getLetter(db, letterId)
}

// Brand palette, matching the proven Drive output (FORMAT TEST.html) and the
// docs-mcp renderer: navy display headings, slate section headings.
const NAVY = '#26366C'
const SLATE = '#2B3540'

/**
 * Markdown → branded HTML for the docs-mcp renderer.
 *
 * SUMMARY v1.0 output is Markdown (`# 1. Parties`, `## 1a. …`), so heading
 * lines must become real headings — wrapping every line in <p> would render
 * literal "#" characters in the Google Doc. Verified against the v1 output in
 * Drive: Cases/Zint Nutrition/FAFO Legal Referral Summary — MCB Star LLC.
 */
export function letterToHtml(title: string, bodyText: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*/g, '$1<em>$2</em>')

  const out: string[] = [
    `<h1 style="font-family:Georgia,serif;color:${NAVY};border-bottom:2px solid ${NAVY}">${esc(title)}</h1>`
  ]
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${paragraph.map(inline).join('<br/>')}</p>`)
    paragraph = []
  }

  for (const line of bodyText.split('\n')) {
    const t = line.trim()
    if (t === '') {
      flush()
      continue
    }
    if (t === '---' || t === '***') {
      flush()
      out.push('<hr>')
      continue
    }
    const heading = t.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      flush()
      const level = heading[1]!.length
      const body = inline(heading[2]!)
      if (level === 1) {
        out.push(
          `<h1 style="font-family:Georgia,serif;color:${NAVY};border-bottom:2px solid ${NAVY}">${body}</h1>`
        )
      } else if (level === 2) {
        out.push(`<h2 style="font-family:Georgia,serif;color:${SLATE}">${body}</h2>`)
      } else {
        out.push(`<h3 style="color:${SLATE}">${body}</h3>`)
      }
      continue
    }
    const bullet = t.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      flush()
      out.push(`<ul><li>${inline(bullet[1]!)}</li></ul>`)
      continue
    }
    paragraph.push(t)
  }
  flush()
  return out.join('\n')
}
