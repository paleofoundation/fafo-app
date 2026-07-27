import type Database from 'better-sqlite3'
import { normalizeCompanyName } from '../../../shared/domain/naming'

/**
 * Licensee resolution across data sources (SignNow group names, archive
 * folder names, sheet rows). Exact normalized equality first; then token-set
 * overlap so "Love Good Foods" finds "Love Good Foods (1000747000 Ontario
 * Inc)" and "Laitram Machinery Inc. dba Prime Shrimp LLC" finds
 * "Laitram / Prime Shrimp LLC". Ambiguity (two close candidates) returns no
 * match — a human resolves it, per the review-queue principle.
 */

export interface LicenseeMatch {
  id: number
  name: string
  exact: boolean
}

function tokens(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter((t) => t.length > 0))
}

export function findLicenseeByName(db: Database.Database, rawName: string): LicenseeMatch | null {
  const norm = normalizeCompanyName(rawName)
  if (!norm) return null

  const exact = db
    .prepare('SELECT id, name FROM licensees WHERE normalized_name = ?')
    .get(norm) as { id: number; name: string } | undefined
  if (exact) return { ...exact, exact: true }

  const queryTokens = tokens(norm)
  if (queryTokens.size === 0) return null

  const all = db
    .prepare('SELECT id, name, normalized_name AS n FROM licensees')
    .all() as Array<{ id: number; name: string; n: string }>

  let best: { id: number; name: string; score: number } | null = null
  let secondBest = 0
  for (const cand of all) {
    const candTokens = tokens(cand.n)
    let shared = 0
    for (const t of queryTokens) if (candTokens.has(t)) shared += 1
    if (shared < 2) continue // one shared word is never enough to merge entities
    const union = queryTokens.size + candTokens.size - shared
    const score = shared / union
    if (best === null || score > best.score) {
      secondBest = best?.score ?? 0
      best = { id: cand.id, name: cand.name, score }
    } else if (score > secondBest) {
      secondBest = score
    }
  }

  if (!best || best.score < 0.6) return null
  if (best.score - secondBest < 0.1) return null // ambiguous — human decides
  return { id: best.id, name: best.name, exact: false }
}
