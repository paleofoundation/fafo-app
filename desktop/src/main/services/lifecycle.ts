import type Database from 'better-sqlite3'
import { addDays, selloffEnd, type AgreementVintage } from '../../shared/domain/deadlines'

/**
 * The nightly lifecycle roll — the heart of improvement #1:
 * Licensed → Expiring → Watch → (Case). Pure DB logic, idempotent.
 *
 *  - active licenses within 60d of term_end  → status 'expiring' + watch item
 *    (reason 'expiring') + "license ends" deadline
 *  - licenses past term_end                  → status 'expired' + watch item
 *    (reason 'expired') + sell-off deadline for 2025-vintage agreements
 *  - licensees with a NEWER active agreement → open watch items close as
 *    'renewed' and their pending deadlines are dismissed
 *
 * Expiring ≠ infringing: watch items generate record-keeping and (in M3)
 * screenshot patrols — never letters.
 */

export interface LifecycleRollResult {
  toExpiring: number
  toExpired: number
  watchOpened: number
  watchRenewed: number
  deadlinesCreated: number
}

const EXPIRING_WINDOW_DAYS = 60

export function lifecycleRoll(db: Database.Database, todayIso: string): LifecycleRollResult {
  const result: LifecycleRollResult = {
    toExpiring: 0,
    toExpired: 0,
    watchOpened: 0,
    watchRenewed: 0,
    deadlinesCreated: 0
  }

  const horizon = addDays(todayIso, EXPIRING_WINDOW_DAYS)

  const openWatch = db.prepare(
    "SELECT id FROM watch_items WHERE license_id = ? AND status = 'watching'"
  )
  const insertWatch = db.prepare(
    `INSERT INTO watch_items (licensee_id, license_id, opened_at, reason, status, next_check_at)
     VALUES (?, ?, ?, ?, 'watching', ?)`
  )
  const deadlineExists = db.prepare(
    "SELECT 1 FROM deadlines WHERE ref_table = 'watch_items' AND ref_id = ? AND kind = ?"
  )
  const insertDeadline = db.prepare(
    'INSERT INTO deadlines (ref_table, ref_id, kind, title, due_at) VALUES (?, ?, ?, ?, ?)'
  )

  function ensureWatch(
    licenseeId: number,
    licenseId: number,
    reason: 'expiring' | 'expired',
    nextCheckAt: string
  ): number {
    const existing = openWatch.get(licenseId) as { id: number } | undefined
    if (existing) return existing.id
    result.watchOpened += 1
    return Number(insertWatch.run(licenseeId, licenseId, todayIso, reason, nextCheckAt).lastInsertRowid)
  }

  function ensureDeadline(watchId: number, kind: string, title: string, dueAt: string): void {
    if (deadlineExists.get(watchId, kind)) return
    insertDeadline.run('watch_items', watchId, kind, title, dueAt)
    result.deadlinesCreated += 1
  }

  const tx = db.transaction(() => {
    // active → expiring
    const expiring = db
      .prepare(
        `SELECT li.id, li.licensee_id AS licenseeId, li.term_end AS termEnd, l.name
         FROM licenses li JOIN licensees l ON l.id = li.licensee_id
         WHERE li.status = 'active' AND li.term_end IS NOT NULL AND li.term_end <= ? AND li.term_end >= ?`
      )
      .all(horizon, todayIso) as Array<{ id: number; licenseeId: number; termEnd: string; name: string }>
    for (const li of expiring) {
      db.prepare("UPDATE licenses SET status = 'expiring' WHERE id = ?").run(li.id)
      result.toExpiring += 1
      const watchId = ensureWatch(li.licenseeId, li.id, 'expiring', li.termEnd)
      ensureDeadline(watchId, 'custom', `${li.name} — license ends ${li.termEnd}; renewal not yet on file`, li.termEnd)
    }

    // active/expiring → expired
    const expired = db
      .prepare(
        `SELECT li.id, li.licensee_id AS licenseeId, li.term_end AS termEnd, li.vintage, l.name
         FROM licenses li JOIN licensees l ON l.id = li.licensee_id
         WHERE li.status IN ('active','expiring') AND li.term_end IS NOT NULL AND li.term_end < ?`
      )
      .all(todayIso) as Array<{
      id: number
      licenseeId: number
      termEnd: string
      vintage: AgreementVintage
      name: string
    }>
    for (const li of expired) {
      db.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").run(li.id)
      result.toExpired += 1
      const selloff = selloffEnd(li.termEnd, li.vintage)
      const watchId = ensureWatch(li.licenseeId, li.id, 'expired', addDays(todayIso, 30))
      if (selloff) {
        ensureDeadline(
          watchId,
          'selloff_end',
          `${li.name} — sell-off window ends (license ended ${li.termEnd}); spot check`,
          selloff
        )
      } else {
        ensureDeadline(
          watchId,
          'patrol_spot_check',
          `${li.name} — license ended ${li.termEnd} (2020 vintage: NO sell-off); check for continued use`,
          addDays(li.termEnd, 7)
        )
      }
    }

    // renewal detection: open watch item but licensee now holds a different active license
    const renewed = db
      .prepare(
        `SELECT w.id FROM watch_items w
         WHERE w.status = 'watching' AND EXISTS (
           SELECT 1 FROM licenses li2
           WHERE li2.licensee_id = w.licensee_id AND li2.status = 'active'
             AND (w.license_id IS NULL OR li2.id != w.license_id)
         )`
      )
      .all() as Array<{ id: number }>
    for (const w of renewed) {
      db.prepare("UPDATE watch_items SET status = 'renewed' WHERE id = ?").run(w.id)
      db.prepare(
        "UPDATE deadlines SET dismissed = 1 WHERE ref_table = 'watch_items' AND ref_id = ? AND satisfied_at IS NULL"
      ).run(w.id)
      result.watchRenewed += 1
    }
  })
  tx()
  return result
}
