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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function api(key: string, pathname: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}${pathname}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    if (res.status === 429 && attempt <= 4) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10)
      await sleep((Number.isFinite(retryAfter) ? retryAfter : 15 * attempt) * 1000)
      continue
    }
    if (!res.ok) {
      throw new Error(
        `SignNow API ${res.status} on ${pathname}${res.status === 401 ? ' — key invalid or revoked' : ''}`
      )
    }
    return res.json()
  }
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

/**
 * Raw shape of GET /user/documentsv2 (verified live 2026-07-27): a bare
 * ARRAY of documents; pagination is `per_page` + `page` (1-based) — `limit`
 * and `offset` are silently ignored. The agreements live here as individual
 * documents (the account has 0 multi-document "document groups"); the
 * claude.ai connector's "305 groups" were these same documents unified.
 */
export interface RawDocument {
  id?: string
  document_name?: string
  updated?: string | number
  template?: boolean
  entity_type?: string
  field_invites?: Array<{ status?: string; email?: string }>
}

export function mapRawDocument(raw: RawDocument): SnapshotGroup | null {
  if (!raw.id || !raw.document_name) return null
  if (raw.template === true) return null // template library, not an executed agreement
  if (raw.entity_type && raw.entity_type !== 'document') return null

  const invites = raw.field_invites ?? []
  const statuses = invites.map((i) => i.status ?? '')
  const inviteStatus =
    invites.length === 0
      ? null
      : statuses.every((s) => s === 'fulfilled')
        ? 'completed'
        : statuses.some((s) => s === 'pending' || s === 'created')
          ? 'pending'
          : statuses.some((s) => s === 'expired')
            ? 'expired'
            : (statuses[0] ?? null)

  return {
    id: raw.id,
    name: raw.document_name,
    invite_status: inviteStatus,
    participant_emails: [...new Set(invites.map((i) => i.email).filter((e): e is string => Boolean(e)))],
    signed: invites.length > 0 && statuses.every((s) => s === 'fulfilled'),
    last_updated: typeof raw.updated === 'string' ? parseInt(raw.updated, 10) : (raw.updated ?? null)
  }
}

export async function fetchAllDocuments(key: string): Promise<SnapshotGroup[]> {
  const out: SnapshotGroup[] = []
  const perPage = 100
  let effectivePageSize: number | null = null
  for (let page = 1; ; page++) {
    const items = (await api(key, `/user/documentsv2?per_page=${perPage}&page=${page}`)) as RawDocument[]
    if (!Array.isArray(items) || items.length === 0) break
    // The server may cap per_page below what we asked — learn the real page
    // size from the first page so the stop condition can't fire early.
    effectivePageSize ??= items.length
    for (const raw of items) {
      const mapped = mapRawDocument(raw)
      if (mapped) out.push(mapped)
    }
    if (items.length < effectivePageSize) break
    if (page > 60) throw new Error('SignNow pagination runaway — aborting after 60 pages')
    await sleep(400) // stay under the rate limit
  }
  return out
}

export interface SignnowSyncOutcome {
  identity: SignnowIdentity
  apiTotal: number
  imported: SnapshotImportResult
  syncedAt: string
}

export async function syncSignnow(db: Database.Database, key: string): Promise<SignnowSyncOutcome> {
  const identity = await getIdentity(key)
  const documents = await fetchAllDocuments(key)
  const snapshot: SignnowSnapshot = {
    exportedAt: new Date().toISOString(),
    source: 'signnow-api',
    total: documents.length,
    groups: documents
  }
  const total = documents.length
  const imported = importSignnowSnapshot(db, snapshot)
  const syncedAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO sync_state (source, cursor, last_full_sync_at) VALUES ('signnow', ?, ?)
     ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, last_full_sync_at = excluded.last_full_sync_at`
  ).run(`${identity.email}|${total}`, syncedAt)
  return { identity, apiTotal: total, imported, syncedAt }
}
