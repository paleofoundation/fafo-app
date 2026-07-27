import type Database from 'better-sqlite3'

/**
 * Outlook response scan (M4, improvement 14/15): pulls recent inbox messages
 * via Microsoft Graph, matches senders against licensee contact emails,
 * attaches matches to case timelines, and stops open response clocks.
 * Read-only against the mailbox; dedupes by exact event body.
 */

export interface MailScanResult {
  messagesSeen: number
  matched: number
  clocksStopped: number
}

interface GraphMessage {
  subject?: string
  receivedDateTime?: string
  from?: { emailAddress?: { address?: string; name?: string } }
}

export async function scanMail(db: Database.Database, accessToken: string): Promise<MailScanResult> {
  const cursorRow = db
    .prepare("SELECT cursor FROM sync_state WHERE source = 'graph_mail'")
    .get() as { cursor: string | null } | undefined
  const since =
    cursorRow?.cursor ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

  const result: MailScanResult = { messagesSeen: 0, matched: 0, clocksStopped: 0 }

  // licensee contact emails → licensee ids (case-insensitive)
  const emailMap = new Map<string, number>()
  for (const row of db
    .prepare('SELECT id, contact_email AS email FROM licensees WHERE contact_email IS NOT NULL')
    .all() as Array<{ id: number; email: string }>) {
    emailMap.set(row.email.toLowerCase(), row.id)
  }

  const latestCaseFor = db.prepare(
    `SELECT id FROM cases WHERE licensee_id = ?
     ORDER BY status = 'Resolved', opened_at DESC LIMIT 1`
  )
  const eventExists = db.prepare(
    "SELECT 1 FROM case_events WHERE case_id = ? AND kind = 'response' AND body = ?"
  )
  const insertEvent = db.prepare(
    "INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'response', ?)"
  )
  const openLetters = db.prepare(
    `SELECT id, sent_at AS sentAt FROM letters
     WHERE case_id = ? AND status = 'sent' AND response_received_at IS NULL`
  )
  const closeLetter = db.prepare(
    "UPDATE letters SET response_received_at = ?, status = 'responded' WHERE id = ?"
  )
  const satisfyClock = db.prepare(
    `UPDATE deadlines SET satisfied_at = ?
     WHERE ref_table = 'cases' AND ref_id = ? AND kind = 'letter_response' AND satisfied_at IS NULL`
  )

  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/messages?$select=subject,from,receivedDateTime` +
    `&$filter=receivedDateTime ge ${encodeURIComponent(since)}` +
    `&$orderby=receivedDateTime asc&$top=100`
  let maxSeen = since

  for (let page = 0; url && page < 5; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`Graph /me/messages ${res.status}`)
    const data = (await res.json()) as { value?: GraphMessage[]; '@odata.nextLink'?: string }
    for (const msg of data.value ?? []) {
      result.messagesSeen += 1
      const received = msg.receivedDateTime ?? ''
      if (received > maxSeen) maxSeen = received
      const addr = msg.from?.emailAddress?.address?.toLowerCase()
      if (!addr) continue
      const licenseeId = emailMap.get(addr)
      if (licenseeId === undefined) continue

      const c = latestCaseFor.get(licenseeId) as { id: number } | undefined
      if (!c) continue
      result.matched += 1

      const day = received.slice(0, 10)
      const body = `Email from ${addr}: "${msg.subject ?? '(no subject)'}" (${day})`
      if (!eventExists.get(c.id, body)) insertEvent.run(c.id, day, body)

      for (const letter of openLetters.all(c.id) as Array<{ id: number; sentAt: string | null }>) {
        if (letter.sentAt && received.slice(0, 10) >= letter.sentAt) {
          closeLetter.run(day, letter.id)
          satisfyClock.run(day, c.id)
          result.clocksStopped += 1
        }
      }
    }
    url = data['@odata.nextLink'] ?? null
  }

  db.prepare(
    `INSERT INTO sync_state (source, cursor, last_full_sync_at) VALUES ('graph_mail', ?, ?)
     ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, last_full_sync_at = excluded.last_full_sync_at`
  ).run(maxSeen, new Date().toISOString())

  return result
}
