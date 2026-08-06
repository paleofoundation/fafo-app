import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { PDFParse } from 'pdf-parse'

/**
 * Email-thread extraction. The archive holds correspondence as PDF exports of
 * Gmail/Outlook threads and the odd .eml — readable one at a time, useless as
 * a record of what happened when. This turns each thread into dated timeline
 * entries on the case.
 *
 * What matters legally is the CLOCK: when a notice went out, when (or whether)
 * they replied, what they promised and by when. So each message is reduced to
 * a date, a direction, and one line — not a summary of the thread as a whole,
 * which would collapse exactly the dates the enforcement posture turns on.
 *
 * A message with no determinable date is dropped rather than guessed at. An
 * undated entry in a timeline is worse than a missing one: it reads as fact.
 */

/** paleofoundation.com / paleofriendly.com senders are us; everything else is them. */
const OUR_DOMAINS = /@(paleofoundation|paleofriendly|paleocertified)\.(com|org)/i
const COUNSEL = /@(trestlelaw|trestle)\./i

export interface ThreadMessage {
  /** YYYY-MM-DD. Messages without one are discarded by the caller. */
  sentAt: string | null
  from: string | null
  direction: 'outbound' | 'inbound' | 'counsel' | 'unknown'
  summary: string
  /** The sender committed to an action or a date. */
  isCommitment: boolean
}

export interface ExtractedThread {
  threadSubject: string | null
  messages: ThreadMessage[]
  confidence: number
  notes: string | null
}

const THREAD_SCHEMA = {
  type: 'object',
  properties: {
    thread_subject: {
      type: ['string', 'null'],
      description: 'Subject line of the thread, without Re:/Fwd: prefixes'
    },
    messages: {
      type: 'array',
      description:
        'One entry per message in the thread, oldest first. Include every message that has a determinable date. Omit signature blocks, disclaimers and quoted text repeated from earlier messages.',
      items: {
        type: 'object',
        properties: {
          sent_at: {
            type: ['string', 'null'],
            description:
              'Date the message was sent, YYYY-MM-DD. Null if the thread does not state one — never infer it from surrounding messages.'
          },
          from: {
            type: ['string', 'null'],
            description: 'Sender name and/or email address exactly as it appears'
          },
          summary: {
            type: 'string',
            description:
              'ONE sentence, under 25 words, stating what this message did or said. Factual, no interpretation. E.g. "Confirmed the certification lapsed and asked for the renewal invoice."'
          },
          is_commitment: {
            type: 'boolean',
            description:
              'True if the sender promised an action or named a date — a payment, a removal, a response deadline.'
          }
        },
        required: ['sent_at', 'from', 'summary', 'is_commitment'],
        additionalProperties: false
      }
    },
    confidence: {
      type: 'number',
      description: '0 to 1 — how reliably the thread structure and dates were read'
    },
    notes: {
      type: ['string', 'null'],
      description: 'Anything ambiguous or unreadable, briefly. Null if clean.'
    }
  },
  required: ['thread_subject', 'messages', 'confidence', 'notes'],
  additionalProperties: false
} as const

const SYSTEM = `You extract the message-by-message record from an email thread for a trademark
enforcement case file. The output feeds a legal timeline, so accuracy about DATES and DIRECTION
matters more than completeness.

Rules:
- One entry per message actually sent. A thread quoted inside a later reply is NOT a new message —
  record it once, at its own date.
- If a message's date is not stated in the document, return null for sent_at. Never infer a date
  from position in the thread or from surrounding messages.
- Summaries are one factual sentence. No characterisation, no legal conclusions, no adjectives.
- Do not invent participants, amounts, or deadlines that are not in the text.`

function classify(from: string | null): ThreadMessage['direction'] {
  if (!from) return 'unknown'
  if (COUNSEL.test(from)) return 'counsel'
  if (OUR_DOMAINS.test(from)) return 'outbound'
  return 'inbound'
}

export async function extractThreadFromText(
  apiKey: string,
  documentName: string,
  text: string
): Promise<ExtractedThread> {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 4000,
    system: SYSTEM,
    output_config: {
      format: { type: 'json_schema', schema: THREAD_SCHEMA as unknown as Record<string, unknown> }
    },
    messages: [
      {
        role: 'user',
        content: `Extract the message record from this email thread.\n\nFile name: ${documentName}\n\nThread text (may be truncated):\n${text.slice(0, 60000)}`
      }
    ]
  })

  if (response.stop_reason === 'refusal')
    throw new Error('Thread extraction was declined by the model')
  const out = response.content.find((b) => b.type === 'text')?.text
  if (!out) throw new Error('Thread extraction returned no text content')

  const raw = JSON.parse(out) as {
    thread_subject: string | null
    messages: Array<{
      sent_at: string | null
      from: string | null
      summary: string
      is_commitment: boolean
    }>
    confidence: number
    notes: string | null
  }

  return {
    threadSubject: raw.thread_subject,
    messages: raw.messages.map((m) => ({
      sentAt: m.sent_at && /^\d{4}-\d{2}-\d{2}$/.test(m.sent_at) ? m.sent_at : null,
      from: m.from,
      direction: classify(m.from),
      summary: m.summary.trim(),
      isCommitment: m.is_commitment
    })),
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    notes: raw.notes
  }
}

/** Strip .eml headers down to something worth sending, keeping the dates. */
export function emlToText(raw: string): string {
  // Keep the envelope headers that carry the clock, drop routing noise.
  const keep = /^(from|to|cc|date|sent|subject):/i
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  let inHeaders = true
  for (const line of lines) {
    if (inHeaders) {
      if (line.trim() === '') {
        inHeaders = false
        out.push('')
        continue
      }
      if (keep.test(line)) out.push(line)
      continue
    }
    // Body: drop base64 attachment blobs, which are pure token cost.
    if (/^[A-Za-z0-9+/]{76,}={0,2}$/.test(line.trim())) continue
    out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Runner: read indexed email files, extract, write timeline entries.
// ---------------------------------------------------------------------------


export interface EmailCandidate {
  evidenceId: number
  caseId: number
  caseTitle: string
  filePath: string
  fileName: string
}

export interface EmailExtractionProgress {
  processed: number
  total: number
  current: string
  ok: number
  failed: number
}

export interface EmailExtractionResult {
  processed: number
  ok: number
  failed: number
  /** Screened out as bulk mail before reaching the model. */
  skipped: number
  eventsWritten: number
  undatedDropped: number
  errors: string[]
  remaining: number
}

const READABLE = /\.(pdf|eml|txt|md)$/i

/**
 * Marketing mail that got filed into a case folder by accident — a newsletter
 * that happened to land in the same inbox. Extracting it costs an API call and
 * puts a junk entry on a legal timeline, so it is screened out before the
 * model sees it.
 *
 * Deliberately conservative: BOTH a no-reply sender AND an unsubscribe footer
 * are required. Real correspondence quoted inside a thread can carry one or
 * the other, and dropping genuine correspondence is far worse than paying for
 * the occasional newsletter.
 */
export function looksLikeBulkMail(text: string): boolean {
  const head = text.slice(0, 3000)
  const noReply = /(^|[\s<])(no-?reply|donotreply|notifications?|mailer)@/i.test(head)
  const unsubscribe = /\bunsubscribe\b|\bmanage (your )?preferences\b|\bopt out\b/i.test(text)
  return noReply && unsubscribe
}

export function emailCandidates(
  db: Database.Database,
  limit: number,
  caseId?: number
): EmailCandidate[] {
  return db
    .prepare(
      `SELECT e.id AS evidenceId, e.case_id AS caseId, c.title AS caseTitle, e.path AS filePath
       FROM evidence_files e JOIN cases c ON c.id = e.case_id
       WHERE e.kind = 'email' AND e.path IS NOT NULL AND e.extracted_at IS NULL
         ${caseId === undefined ? '' : 'AND e.case_id = ?'}
       ORDER BY c.status != 'Resolved' DESC, e.id
       LIMIT ?`
    )
    .all(...(caseId === undefined ? [limit] : [caseId, limit]))
    .map((r) => {
      const row = r as Omit<EmailCandidate, 'fileName'>
      return { ...row, fileName: path.basename(row.filePath) }
    })
}

export function emailExtractionCounts(
  db: Database.Database,
  caseId?: number
): { total: number; extracted: number; pending: number } {
  const where = caseId === undefined ? '' : 'AND case_id = ?'
  const args = caseId === undefined ? [] : [caseId]
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(extracted_at IS NOT NULL) AS extracted
       FROM evidence_files WHERE kind = 'email' AND path IS NOT NULL ${where}`
    )
    .get(...args) as { total: number; extracted: number | null }
  const extracted = row.extracted ?? 0
  return { total: row.total, extracted, pending: row.total - extracted }
}

async function readDocument(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) })
    try {
      return (await parser.getText()).text
    } finally {
      await parser.destroy()
    }
  }
  const raw = fs.readFileSync(filePath, 'utf8')
  return ext === '.eml' ? emlToText(raw) : raw
}

export async function runEmailExtraction(
  db: Database.Database,
  apiKey: string,
  limit: number,
  opts: { caseId?: number; onProgress?: (p: EmailExtractionProgress) => void } = {}
): Promise<EmailExtractionResult> {
  const batch = emailCandidates(db, limit, opts.caseId)
  const result: EmailExtractionResult = {
    processed: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    eventsWritten: 0,
    undatedDropped: 0,
    errors: [],
    remaining: 0
  }

  // Re-reading a thread replaces its entries rather than appending a second
  // copy of the same conversation to the timeline.
  const clearPrior = db.prepare(
    "DELETE FROM case_events WHERE ref_table = 'evidence_files' AND ref_id = ? AND kind = 'email'"
  )
  const insertEvent = db.prepare(
    `INSERT INTO case_events (case_id, at, kind, body, ref_table, ref_id)
     VALUES (?, ?, 'email', ?, 'evidence_files', ?)`
  )
  const markDone = db.prepare(
    'UPDATE evidence_files SET extracted_at = ?, extraction_note = ? WHERE id = ?'
  )

  for (const c of batch) {
    opts.onProgress?.({
      processed: result.processed,
      total: batch.length,
      current: c.fileName,
      ok: result.ok,
      failed: result.failed
    })
    try {
      if (!READABLE.test(c.filePath))
        throw new Error(`unsupported file type (${path.extname(c.filePath) || 'none'})`)
      if (!fs.existsSync(c.filePath)) throw new Error('file no longer on disk')

      const text = await readDocument(c.filePath)
      if (text.trim().length < 40) throw new Error('no readable text (scanned image?)')
      if (looksLikeBulkMail(text)) throw new Error('bulk/marketing mail, not correspondence')

      const thread = await extractThreadFromText(apiKey, c.fileName, text)
      const dated = thread.messages.filter((m) => m.sentAt !== null)
      const dropped = thread.messages.length - dated.length

      db.transaction(() => {
        clearPrior.run(c.evidenceId)
        for (const m of dated) {
          const who = m.from ? `${m.from}: ` : ''
          const flag = m.isCommitment ? ' [commitment]' : ''
          insertEvent.run(c.caseId, m.sentAt, `${who}${m.summary}${flag}`, c.evidenceId)
        }
        markDone.run(
          new Date().toISOString(),
          [
            thread.threadSubject ? `Subject: ${thread.threadSubject}` : null,
            `${dated.length} dated message${dated.length === 1 ? '' : 's'}`,
            dropped > 0 ? `${dropped} undated, dropped` : null,
            `confidence ${Math.round(thread.confidence * 100)}%`,
            thread.notes
          ]
            .filter(Boolean)
            .join(' · '),
          c.evidenceId
        )
      })()

      result.eventsWritten += dated.length
      result.undatedDropped += dropped
      result.ok += 1
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (message.includes('bulk/marketing')) {
        result.skipped += 1
      } else {
        result.failed += 1
        result.errors.push(`${c.caseTitle} / ${c.fileName}: ${message}`)
      }
      // Record the failure so a bad file doesn't block the queue forever, but
      // keep extracted_at NULL for transient errors so a retry picks them up.
      if (/unsupported file type|no readable text|no longer on disk|bulk\/marketing/.test(message)) {
        markDone.run(new Date().toISOString(), `Skipped: ${message}`, c.evidenceId)
      }
    }
    result.processed += 1
  }

  result.remaining = emailExtractionCounts(db, opts.caseId).pending
  return result
}
