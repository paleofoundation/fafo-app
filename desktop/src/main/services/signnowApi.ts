import type Database from 'better-sqlite3'
import {
  importSignnowSnapshot,
  type SignnowSnapshot,
  type SnapshotGroup,
  type SnapshotImportResult
} from './ingest/signnowSnapshot'

/**
 * Live SignNow REST client. Electron-free (fetch + injected key) so it's
 * testable and reusable. Mirrors the shapes already proven by the snapshot
 * path — the sync IS the snapshot importer, fed from the API instead of a
 * file, so idempotency and review-flagging behave identically.
 */

const BASE = 'https://api.signnow.com'

export interface SignnowIdentity {
  email: string
  firstName: string
  lastName: string
}

async function api(key: string, pathname: string): Promise<unknown> {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`SignNow API ${res.status} on ${pathname}${res.status === 401 ? ' — key invalid or revoked' : ''}`)
  }
  return res.json()
}

export async function getIdentity(key: string): Promise<SignnowIdentity> {
  const u = (await api(key, '/user')) as {
    primary_email?: string
    email?: string
    first_name?: string
    last_name?: string
  }
  return {
    email: u.primary_email ?? u.email ?? 'unknown',
    firstName: u.first_name ?? '',
    lastName: u.last_name ?? ''
  }
}

interface RawGroupPage {
  document_groups?: Array<{
    id?: string
    group_id?: string
    group_name?: string
    name?: string
    last_updated?: number | string
    invite_id?: string | null
    invite_status?: string | null
    state?: string
    documents?: unknown[]
  }>
  document_group_total_count?: number
}

function mapGroup(raw: NonNullable<RawGroupPage['document_groups']>[number]): SnapshotGroup | null {
  const id = raw.id ?? raw.group_id
  const name = raw.group_name ?? raw.name
  if (!id || !name) return null
  const inviteStatus = raw.invite_status ?? raw.state ?? null
  return {
    id,
    name,
    invite_status: inviteStatus,
    // The groups listing doesn't carry participant emails; the connector
    // snapshot already filled contacts, and PDF extraction refines later.
    participant_emails: [],
    signed: inviteStatus === 'completed' || inviteStatus === 'fulfilled',
    last_updated:
      typeof raw.last_updated === 'string' ? parseInt(raw.last_updated, 10) : (raw.last_updated ?? null)
  }
}

export async function fetchAllGroups(key: string): Promise<{ groups: SnapshotGroup[]; total: number }> {
  const groups: SnapshotGroup[] = []
  const limit = 50
  let offset = 0
  let total = 0
  for (;;) {
    const page = (await api(key, `/user/documentgroups?limit=${limit}&offset=${offset}`)) as RawGroupPage
    total = page.document_group_total_count ?? total
    const items = page.document_groups ?? []
    for (const raw of items) {
      const mapped = mapGroup(raw)
      if (mapped) groups.push(mapped)
    }
    offset += limit
    if (items.length === 0 || groups.length >= total) break
  }
  return { groups, total }
}

export interface SignnowSyncOutcome {
  identity: SignnowIdentity
  apiTotal: number
  imported: SnapshotImportResult
  syncedAt: string
}

export async function syncSignnow(db: Database.Database, key: string): Promise<SignnowSyncOutcome> {
  const identity = await getIdentity(key)
  const { groups, total } = await fetchAllGroups(key)
  const snapshot: SignnowSnapshot = {
    exportedAt: new Date().toISOString(),
    source: 'signnow-api',
    total,
    groups
  }
  const imported = importSignnowSnapshot(db, snapshot)
  const syncedAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO sync_state (source, cursor, last_full_sync_at) VALUES ('signnow', ?, ?)
     ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, last_full_sync_at = excluded.last_full_sync_at`
  ).run(`${identity.email}|${total}`, syncedAt)
  return { identity, apiTotal: total, imported, syncedAt }
}
