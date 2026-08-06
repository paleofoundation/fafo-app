import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../../db/migrations'
import { seedIfEmpty } from '../../../db/seed'
import { createCase, getCase } from '../../../db/queries'
import {
  emailCandidates,
  emailExtractionCounts,
  emlToText,
  looksLikeBulkMail
} from '../emailThreads'

describe('eml text reduction', () => {
  it('keeps the headers that carry the clock and drops routing noise', () => {
    const raw = [
      'Received: from mx.example.com by inbound.example.net',
      'X-Spam-Score: 0.1',
      'From: ops@brand.example',
      'Date: Tue, 14 Apr 2026 09:12:00 -0700',
      'Subject: Re: Certification',
      'Message-ID: <abc@brand.example>',
      '',
      'We pulled the badge from the site yesterday.'
    ].join('\n')
    const out = emlToText(raw)
    expect(out).toContain('From: ops@brand.example')
    expect(out).toContain('Date: Tue, 14 Apr 2026 09:12:00 -0700')
    expect(out).toContain('Subject: Re: Certification')
    expect(out).toContain('We pulled the badge from the site yesterday.')
    expect(out).not.toContain('X-Spam-Score')
    expect(out).not.toContain('Received:')
  })

  it('drops base64 attachment blobs, which are pure token cost', () => {
    const blob = 'A'.repeat(120)
    const out = emlToText(`From: a@b.com\n\nHello\n${blob}\nBye`)
    expect(out).toContain('Hello')
    expect(out).toContain('Bye')
    expect(out).not.toContain(blob)
  })
})

describe('email extraction queue', () => {
  let db: Database.Database
  let dir: string
  let caseId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fafo-email-'))
    caseId = createCase(db, {
      title: 'Thread Co',
      licenseeName: 'Thread Co',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-01'
    }).id
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const addFile = (name: string, kind = 'email'): number => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, 'From: a@b.com\n\nbody')
    return Number(
      db
        .prepare(
          "INSERT INTO evidence_files (case_id, path, kind, source) VALUES (?, ?, ?, 'local_import')"
        )
        .run(caseId, p, kind).lastInsertRowid
    )
  }

  it('queues only unread email files, and only for the requested case', () => {
    const a = addFile('one.pdf')
    addFile('two.eml')
    addFile('shot.png', 'screenshot') // not email — never queued

    const other = createCase(db, {
      title: 'Other Co',
      licenseeName: 'Other Co',
      type: 'Expired License',
      status: 'Open',
      source: 'Website',
      openedAt: '2026-01-01'
    }).id
    const p = path.join(dir, 'other.pdf')
    fs.writeFileSync(p, 'x')
    db.prepare(
      "INSERT INTO evidence_files (case_id, path, kind, source) VALUES (?, ?, 'email', 'local_import')"
    ).run(other, p)

    expect(emailCandidates(db, 50, caseId).map((c) => c.fileName).sort()).toEqual([
      'one.pdf',
      'two.eml'
    ])
    expect(emailCandidates(db, 50).length).toBe(3)

    // Marking one read takes it out of the queue and moves the counter.
    db.prepare('UPDATE evidence_files SET extracted_at = ? WHERE id = ?').run('2026-08-06', a)
    expect(emailCandidates(db, 50, caseId).map((c) => c.fileName)).toEqual(['two.eml'])
    expect(emailExtractionCounts(db, caseId)).toEqual({ total: 2, extracted: 1, pending: 1 })
  })

  it('counts scope to a case and to the whole file when asked', () => {
    addFile('one.pdf')
    addFile('two.eml')
    expect(emailExtractionCounts(db, caseId)).toEqual({ total: 2, extracted: 0, pending: 2 })
    expect(emailExtractionCounts(db).total).toBe(2)
  })

  it('respects the batch limit so a run has a bounded cost', () => {
    for (let i = 0; i < 5; i++) addFile(`t${i}.pdf`)
    expect(emailCandidates(db, 2, caseId)).toHaveLength(2)
  })

  it('writes email events that land in the case timeline in date order', () => {
    const evidenceId = addFile('thread.pdf')
    const insert = db.prepare(
      `INSERT INTO case_events (case_id, at, kind, body, ref_table, ref_id)
       VALUES (?, ?, 'email', ?, 'evidence_files', ?)`
    )
    insert.run(caseId, '2026-03-02', 'them@brand.example: Asked for more time.', evidenceId)
    insert.run(caseId, '2026-02-14', 'jp@paleofoundation.com: Sent the notice.', evidenceId)

    const events = getCase(db, caseId)!.events.filter((e) => e.kind === 'email')
    expect(events.map((e) => e.at)).toEqual(['2026-02-14', '2026-03-02'])
    expect(events[0]!.refTable).toBe('evidence_files')
    expect(events[0]!.refId).toBe(evidenceId)
  })
})

describe('bulk-mail screening', () => {
  const NEWSLETTER = `Jonathan Pendergrass <jinthemad@gmail.com>
Jonathan, spill the tea! Your favorite? 👀
1 message
The Empowered Cookie <no-reply@loox.io> Fri, Nov 14, 2025 at 12:03 PM
Tell us what you thought.
Unsubscribe from these emails`

  const REAL_THREAD = `From: Kennedy Velikonja kennedy.velikonja@awakechocolate.com
Subject: Re: Upcoming Certification Renewal
Date: April 15, 2026 at 4:20 PM
To: Jonathan Pendergrass jonathand@paleofoundation.org

Thanks for the reminder — we are reviewing the renewal internally.`

  it('screens out a newsletter that got filed into a case folder', () => {
    expect(looksLikeBulkMail(NEWSLETTER)).toBe(true)
  })

  it('never screens out real correspondence', () => {
    expect(looksLikeBulkMail(REAL_THREAD)).toBe(false)
  })

  it('requires BOTH signals — one alone must not drop a genuine thread', () => {
    // An unsubscribe footer quoted inside a real reply.
    expect(
      looksLikeBulkMail(`${REAL_THREAD}\n\n> Unsubscribe from these emails`)
    ).toBe(false)
    // A no-reply notification that is still a real notice with no unsubscribe.
    expect(
      looksLikeBulkMail('From: no-reply@signnow.com\nYour document was signed on April 2, 2026.')
    ).toBe(false)
  })
})
