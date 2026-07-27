import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { AMANDA_SYSTEM_PROMPT, buildAmandaUserPrompt } from '../../shared/domain/amandaPrompts'
import { SUMMARY_SYSTEM_PROMPT, buildSummaryUserPrompt } from '../../shared/domain/summaryPrompt'
import { nextResponseThursday } from '../../shared/domain/deadlines'

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
    messages: [{ role: 'user', content: request.user }]
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

/** Minimal text→HTML for the branded docs-mcp renderer. */
export function letterToHtml(title: string, bodyText: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
  return `<h1>${esc(title)}</h1>\n${paragraphs}`
}
