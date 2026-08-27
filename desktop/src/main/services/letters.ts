import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { AMANDA_SYSTEM_PROMPT, buildAmandaUserPrompt } from '../../shared/domain/amandaPrompts'
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  SCREENSHOT_MARKER,
  type EvidenceManifest,
  type ScreenshotExhibit
} from '../../shared/domain/summaryPrompt'
import { nextResponseThursday, selloffEnd, usDate } from '../../shared/domain/deadlines'
import { evidenceDate, selectReferralScreenshots } from './referralShots'

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


/**
 * What the case actually holds, for the referral's evidence section.
 *
 * Screenshots are grouped into dated capture sessions instead of listed: a case
 * with 160 PNGs proves use on eleven dates, and eleven dates is the fact counsel
 * needs. Everything else — the agreement, letters, emails, court filings — is
 * named individually, because each is a separate exhibit.
 */
function evidenceManifest(db: Database.Database, caseId: number): EvidenceManifest {
  const rows = db
    .prepare(
      `SELECT path, kind, dated_at AS datedAt, mtime
       FROM evidence_files WHERE case_id = ?`
    )
    .all(caseId) as Array<{
    path: string | null
    kind: string
    datedAt: string | null
    mtime: string | null
  }>

  const byKind = new Map<string, number>()
  const sessions = new Map<string, number>()
  const documents: EvidenceManifest['documents'] = []
  const dates: string[] = []

  for (const r of rows) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1)
    // Read the date from the filename and parent folder, not just the stored
    // dated_at — a test-purchase folder like "Order - July 19, 2026" and phone
    // photos named PXL_20260719_… carry the date the scan missed, and counsel
    // needs those dates to weigh a capture against a promise made earlier.
    const date = r.path ? evidenceDate(r.path, r.datedAt, r.mtime) : r.datedAt
    if (date) dates.push(date)
    if (r.kind === 'screenshot' || r.kind === 'video') {
      if (date) sessions.set(date, (sessions.get(date) ?? 0) + 1)
    } else if (r.path) {
      documents.push({ name: r.path.split('/').pop() ?? r.path, kind: r.kind, date })
    }
  }
  dates.sort()

  return {
    total: rows.length,
    byKind: [...byKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    documents: documents.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
    captureSessions: [...sessions.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null
  }
}

/** Dated inter-party messages — extracted email threads and letters sent. */
function correspondenceLines(db: Database.Database, caseId: number): string[] {
  return (
    db
      .prepare(
        `SELECT at, kind, body FROM case_events
         WHERE case_id = ? AND kind IN ('email','letter_sent','response')
         ORDER BY at ASC, id ASC`
      )
      .all(caseId) as Array<{ at: string; kind: string; body: string }>
  ).map((e) => `[${usDate(e.at)}] (${e.kind.replace('_', ' ')}) ${e.body}`)
}

/** Open clocks counsel inherits with the matter. */
function deadlineLines(db: Database.Database, caseId: number): string[] {
  return (
    db
      .prepare(
        `SELECT due_at AS dueAt, kind, title FROM deadlines
         WHERE ref_table = 'cases' AND ref_id = ? AND dismissed = 0 AND satisfied_at IS NULL
         ORDER BY due_at ASC`
      )
      .all(caseId) as Array<{ dueAt: string; kind: string; title: string }>
  ).map((d) => `[due ${usDate(d.dueAt)}] (${d.kind.replace('_', ' ')}) ${d.title}`)
}


/** Addresses on our own side of the correspondence. */
const OUR_DOMAIN = /paleofoundation\.(org|com)/i

/**
 * The person actually corresponding, as of the latest message on file.
 *
 * The licensee record holds whoever was contact when the case was opened, and
 * that goes stale: Awake Chocolate's record still named the recipient of the
 * termination letter from April, four months after the matter had been handed
 * to Adam Deremo, who is the one making their argument. A referral that names
 * the wrong person sends counsel to the wrong person.
 */
export function latestCounterparty(
  db: Database.Database,
  caseId: number
): { name: string | null; email: string | null } | null {
  const rows = db
    .prepare(
      `SELECT body FROM case_events WHERE case_id = ? AND kind = 'email'
       ORDER BY at DESC, id DESC`
    )
    .all(caseId) as Array<{ body: string }>

  for (const r of rows) {
    const sep = r.body.indexOf(': ')
    if (sep <= 0) continue
    const from = r.body.slice(0, sep).trim()
    if (!from || OUR_DOMAIN.test(from)) continue
    const email = from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null
    if (email && OUR_DOMAIN.test(email)) continue
    const name = from
      .replace(email ?? '', '')
      .replace(/[<>(),;"]/g, '')
      .trim()
    if (!name && !email) continue
    return { name: name || null, email }
  }
  return null
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
  evidence: EvidenceManifest
  correspondence: string[]
  deadlines: string[]
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

  // FAFO's own bookkeeping must not reach outside counsel. The v1 Awake
  // referral told Trestle the matter had been "administratively defaulted to
  // Resolved upon archive import" and listed import flags on unrecognised
  // subfolders — internal housekeeping, reported as case history.
  const events = db
    .prepare(
      `SELECT at, kind, body FROM case_events
       WHERE case_id = ? AND kind NOT IN ('import', 'status_change', 'evidence')
         AND body NOT LIKE 'Sheet import%'
         AND body NOT LIKE 'Status:%'
         AND body NOT LIKE '%exported to Drive:%'
         AND body NOT LIKE '%saved to /%'
       ORDER BY at ASC, id ASC`
    )
    .all(caseId) as Array<{ at: string; kind: string; body: string }>

  const payments = (
    db
      .prepare(
        `SELECT amount_cents AS cents, COALESCE(received_date, due_date) AS date, received
         FROM payments WHERE case_id = ? ORDER BY date`
      )
      .all(caseId) as Array<{ cents: number; date: string | null; received: number }>
  ).map((p) => `$${(p.cents / 100).toLocaleString()} on ${p.date ? usDate(p.date) : '?'} — ${p.received ? 'received' : 'pending'}`)

  // Correspondence outranks the licensee record — see latestCounterparty.
  const current = latestCounterparty(db, caseId)
  return {
    infringer: c.licenseeName ?? c.title,
    contact: current?.name ?? c.contact,
    contactEmail: current?.email ?? c.contactEmail,
    caseType: c.type,
    source: c.source,
    url: c.url,
    openedAt: c.openedAt,
    settlement: c.settlement,
    resolvedBy: c.resolvedBy,
    trademarkNames: markNames.length > 0 ? markNames : ['(marks per case file)'],
    notes: events.map((e) => e.body),
    noteLines: events.map((e) => `[${usDate(e.at)}] ${e.body}`),
    payments,
    evidence: evidenceManifest(db, caseId),
    correspondence: correspondenceLines(db, caseId),
    deadlines: deadlineLines(db, caseId)
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
      lines.push(`License term: ${lic.termStart ? usDate(lic.termStart) : 'unknown'} through ${lic.termEnd ? usDate(lic.termEnd) : 'unknown'}`)
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
          ? `Agreement vintage: 2020 legacy — NO liquidated damages clause and NO sell-off period (immediate cessation required at ${usDate(lic.termEnd)}). Anchor any settlement to the current pricing schedule, not a contractual formula.`
          : `Agreement vintage: current template — §E.3.d.ii liquidated damages (one year's fee per month of continued misuse) and §E.3.c 180-day sell-off applying to physical inventory only, ending ${usDate(so)}. Digital channels required immediate remediation at ${usDate(lic.termEnd)}.`
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
  // Chosen now, not at export: the drafted prose cites these exhibit letters.
  const shots = kind === 'enforcement' ? [] : selectReferralScreenshots(db, caseId)

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
            evidence: i.evidence,
            correspondence: i.correspondence,
            deadlines: i.deadlines,
            payments: i.payments,
            screenshots: shots
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
        `INSERT INTO letters (case_id, kind, body_text, drafted_at, status, exhibits_json)
         VALUES (?, ?, ?, ?, 'draft', ?)`
      )
      .run(caseId, kind, text, today, shots.length ? JSON.stringify(shots) : null)
      .lastInsertRowid
  )
  return getLetter(db, id)
}


export interface SupersededSweep {
  /** Drafts removed. */
  deleted: number
  /** Left alone because they were sent or exported — those are record. */
  keptOnRecord: number
  /** The draft that survives as current. */
  keptNewestId: number | null
}

/**
 * Delete one letter.
 *
 * No case_event is written. A discarded draft is not case history, and a note
 * saying one was deleted would be exactly the kind of internal housekeeping
 * that has to be filtered back out of the next referral.
 */
export function deleteLetter(db: Database.Database, id: number): void {
  const row = db.prepare('SELECT id FROM letters WHERE id = ?').get(id) as
    | { id: number }
    | undefined
  if (!row) throw new Error(`Letter ${id} not found`)
  db.prepare('DELETE FROM letters WHERE id = ?').run(id)
}

/**
 * Clear out superseded drafts of one kind on a case, keeping the newest.
 *
 * Regenerating a referral leaves the previous attempt behind — Awake Chocolate
 * had four. Anything sent or exported to Drive is left alone whatever its age:
 * that is a record of what went out, not a draft.
 */
export function deleteSupersededLetters(
  db: Database.Database,
  caseId: number,
  kind: LetterKind
): SupersededSweep {
  const rows = db
    .prepare(
      `SELECT id, sent_at AS sentAt, doc_drive_id AS docUrl FROM letters
       WHERE case_id = ? AND kind = ?
       ORDER BY drafted_at DESC, id DESC`
    )
    .all(caseId, kind) as Array<{ id: number; sentAt: string | null; docUrl: string | null }>
  if (rows.length === 0) return { deleted: 0, keptOnRecord: 0, keptNewestId: null }

  const newest = rows[0]!
  const onRecord = (r: (typeof rows)[number]): boolean => r.sentAt !== null || r.docUrl !== null
  const doomed = rows.slice(1).filter((r) => !onRecord(r))

  const del = db.prepare('DELETE FROM letters WHERE id = ?')
  db.transaction(() => {
    for (const r of doomed) del.run(r.id)
  })()

  return {
    deleted: doomed.length,
    keptOnRecord: rows.slice(1).length - doomed.length,
    keptNewestId: newest.id
  }
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

/** The captures this letter's prose cites, frozen when it was drafted. */
export function letterExhibits(db: Database.Database, letterId: number): ScreenshotExhibit[] {
  const row = db.prepare('SELECT exhibits_json AS json FROM letters WHERE id = ?').get(letterId) as
    | { json: string | null }
    | undefined
  if (!row?.json) return []
  try {
    const parsed = JSON.parse(row.json)
    return Array.isArray(parsed) ? (parsed as ScreenshotExhibit[]) : []
  } catch {
    return []
  }
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
// Heading and caption colour now live in the renderers' stylesheets (letterPdf
// PAGE_CSS for local, the docs-mcp server for Drive) — letterToHtml emits class
// hooks only, so the two paths cannot drift apart in their inline styles.


/**
 * Swap the drafter's marker for one placeholder line per exhibit, so the
 * renderer can turn each into an image the Docs service will fetch and inline.
 */
function placeExhibits(bodyText: string, exhibits: ScreenshotExhibit[]): string {
  if (exhibits.length === 0) return bodyText.split(SCREENSHOT_MARKER).join('')
  const block = exhibits.map((e) => `@@IMG:${e.label}@@`).join('\n')
  if (bodyText.includes(SCREENSHOT_MARKER)) {
    return bodyText.split(SCREENSHOT_MARKER).join(block)
  }
  const lines = bodyText.split('\n')
  const settlement = lines.findIndex((l) => /^#\s*4\./.test(l.trim()))
  if (settlement === -1) return `${bodyText}\n\n${block}`
  return [...lines.slice(0, settlement), block, '', ...lines.slice(settlement)].join('\n')
}

/**
 * Markdown → branded HTML for the docs-mcp renderer.
 *
 * SUMMARY v1.0 output is Markdown (`# 1. Parties`, `## 1a. …`), so heading
 * lines must become real headings — wrapping every line in <p> would render
 * literal "#" characters in the Google Doc. Verified against the v1 output in
 * Drive: Cases/Zint Nutrition/FAFO Legal Referral Summary — MCB Star LLC.
 */
export function letterToHtml(
  title: string,
  bodyText: string,
  exhibits: ScreenshotExhibit[] = [],
  /**
   * How the captures reach the page. The Docs service stages each image to
   * Drive itself and only needs the marker attribute; a local HTML or PDF file
   * has no service behind it, so the bytes ride inline.
   */
  images: 'marker' | 'inline' = 'marker'
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*/g, '$1<em>$2</em>')

  // SUMMARY v2.0 opens with its own "# LEGAL REFERRAL SUMMARY" heading, so
  // prepending the document title stacked two bordered H1s on the first page.
  // Only supply a title heading when the body does not already start with one.
  const startsWithHeading = /^\s*#\s+\S/.test(bodyText)
  const out: string[] = startsWithHeading ? [] : [`<h1 class="fafo-h1">${esc(title)}</h1>`]
  let paragraph: string[] = []
  // The referral opens with a centered title block — the title line plus the
  // "v." party stack — held open until the first numbered section begins.
  let titleOpen = false

  // The drafter is told to close §3b with the marker. If it dropped the line —
  // or an older letter predates the convention — the captures still have to
  // reach counsel, so they go in ahead of §4 rather than nowhere.
  const source = placeExhibits(bodyText, exhibits)
  const flush = (): void => {
    if (paragraph.length === 0) return
    // In the title block each line is its own paragraph, so the "v." party
    // stack centres line-by-line and the docs-mcp parser (which drops <br/>)
    // keeps the breaks. Elsewhere the lines join with <br/> as one paragraph.
    if (titleOpen) {
      for (const l of paragraph) out.push(`<p>${inline(l)}</p>`)
    } else {
      out.push(`<p>${paragraph.map(inline).join('<br/>')}</p>`)
    }
    paragraph = []
  }

  for (const line of source.split('\n')) {
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
      const numbered = /^\d+\.\s/.test(heading[2]!.trim())
      // The first heading is the document title; open the centered block. The
      // first NUMBERED heading ("1. Parties") ends it.
      if (level === 1 && !numbered && !titleOpen && out.length === 0) {
        out.push('<div class="fafo-titleblock">')
        titleOpen = true
      } else if (titleOpen && (numbered || level >= 2)) {
        out.push('</div>')
        titleOpen = false
      }
      if (level === 1) {
        out.push(`<h1 class="fafo-h1">${body}</h1>`)
      } else if (level === 2) {
        out.push(`<h2 class="fafo-h2">${body}</h2>`)
      } else {
        out.push(`<h3 class="fafo-h3">${body}</h3>`)
      }
      continue
    }
    const exhibit = t.match(/^@@IMG:(.+)@@$/)
    if (exhibit) {
      flush()
      const ex = exhibits.find((e) => e.label === exhibit[1])
      const bytes = (ex as { dataBase64?: string } | undefined)?.dataBase64
      if (images === 'inline' && bytes) {
        out.push(
          `<img class="exhibit" alt="Exhibit ${esc(exhibit[1]!)}" src="data:image/jpeg;base64,${bytes}">`
        )
      } else {
        out.push(`<img data-fafo-image="${esc(exhibit[1]!)}">`)
      }
      if (ex) {
        const where = ex.platform ? `${ex.platform}, ` : ''
        const when = ex.date ? `captured ${usDate(ex.date)}` : 'capture date not recorded'
        out.push(
          `<p class="fafo-caption"><em>Exhibit ${esc(ex.label)} — ${esc(where)}${esc(when)}</em></p>`
        )
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
  // A referral with no numbered sections would leave the title block open.
  if (titleOpen) out.push('</div>')
  return out.join('\n')
}
