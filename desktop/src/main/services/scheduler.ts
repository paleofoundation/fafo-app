import type Database from 'better-sqlite3'
import { lifecycleRoll } from './lifecycle'
import { syncSignnow } from './signnowApi'
import { runExtraction } from './ingest/extractionRunner'
import { scanMail } from './graphMail'
import { msAccessToken } from './msgraph'
import { getSecret, SECRET_ANTHROPIC_API_KEY, SECRET_SIGNNOW_API_KEY } from '../secrets'

/**
 * Job scheduler: jobs table is the source of truth; anything overdue runs at
 * launch (catch-up — the app can't assume it was open at 3am) and a 15-minute
 * tick keeps a long-running instance current. Patrol cadence is daily-scale,
 * so late execution is harmless; true timestamps are always recorded.
 */

const TICK_MS = 15 * 60 * 1000

const JOB_KINDS = ['lifecycle_roll', 'signnow_sync', 'license_extraction', 'mail_scan'] as const
type JobKind = (typeof JOB_KINDS)[number]

function nextNightly(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCHours(8, 0, 0, 0) // ~3am US Central
  return d.toISOString()
}

function ensureJobs(db: Database.Database): void {
  const exists = db.prepare('SELECT 1 FROM jobs WHERE kind = ?')
  const insert = db.prepare('INSERT INTO jobs (kind, next_run_at) VALUES (?, ?)')
  for (const kind of JOB_KINDS) {
    if (!exists.get(kind)) insert.run(kind, new Date().toISOString())
  }
}

async function runJob(db: Database.Database, kind: JobKind): Promise<string> {
  switch (kind) {
    case 'lifecycle_roll': {
      const r = lifecycleRoll(db, new Date().toISOString().slice(0, 10))
      return `expiring:${r.toExpiring} expired:${r.toExpired} watch+:${r.watchOpened} renewed:${r.watchRenewed} deadlines+:${r.deadlinesCreated}`
    }
    case 'signnow_sync': {
      const key = getSecret(SECRET_SIGNNOW_API_KEY)
      if (!key) return 'skipped — no API key stored'
      const r = await syncSignnow(db, key)
      return `as ${r.identity.email}: ${r.apiTotal} groups, +${r.imported.licensesCreated} licenses, ${r.imported.licensesUpdated} updated`
    }
    case 'mail_scan': {
      try {
        const token = await msAccessToken(db)
        const r = await scanMail(db, token)
        return `${r.messagesSeen} messages, ${r.matched} matched to cases, ${r.clocksStopped} response clocks stopped`
      } catch (err) {
        // Not signed in to Outlook is an expected state, not a failure.
        const m = err instanceof Error ? err.message : String(err)
        return m.includes('Not signed in') ? 'skipped — Outlook not connected' : `error — ${m}`
      }
    }
    case 'license_extraction': {
      const signnow = getSecret(SECRET_SIGNNOW_API_KEY)
      const anthropic = getSecret(SECRET_ANTHROPIC_API_KEY)
      if (!signnow || !anthropic) return 'skipped — SignNow and Anthropic keys both required'
      const r = await runExtraction(db, { signnow, anthropic }, 40)
      return `extracted ${r.ok}/${r.processed}, ${r.failed} failed, ${r.remaining} remaining`
    }
  }
}

export async function runDueJobs(db: Database.Database): Promise<void> {
  ensureJobs(db)
  const now = new Date().toISOString()
  const due = db
    .prepare('SELECT id, kind FROM jobs WHERE next_run_at IS NOT NULL AND next_run_at <= ?')
    .all(now) as Array<{ id: number; kind: JobKind }>
  for (const job of due) {
    let status: string
    try {
      status = `ok — ${await runJob(db, job.kind)}`
    } catch (err) {
      status = `error — ${err instanceof Error ? err.message : String(err)}`
    }
    db.prepare('UPDATE jobs SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      status,
      nextNightly(),
      job.id
    )
  }
}

let timer: NodeJS.Timeout | null = null

export function startScheduler(db: Database.Database): void {
  void runDueJobs(db) // catch-up at launch
  if (timer) return
  timer = setInterval(() => void runDueJobs(db), TICK_MS)
  timer.unref?.()
}
