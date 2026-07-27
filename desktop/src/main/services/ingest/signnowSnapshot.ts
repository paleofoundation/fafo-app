import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { normalizeCompanyName, parseSignnowGroupName } from '../../../shared/domain/naming'

/**
 * Imports the SignNow catalog snapshot (exported via the claude.ai connector
 * into userData/import/signnow-catalog.json) as the licensee/license ledger.
 *
 * This is metadata-only: company + year from the group name, signer emails,
 * signed status. Term dates and mark bundles live inside the PDFs and arrive
 * later via the extraction pipeline (live SignNow REST once API credentials
 * exist) — so every license row here carries LOW extraction_confidence and
 * vintage is a year-based guess for review, never a silent fact.
 */

export interface SnapshotGroup {
  id: string
  name: string
  invite_status: string | null
  participant_emails: string[]
  signed: boolean
  last_updated: number | null
}

export interface SignnowSnapshot {
  exportedAt: string
  source: string
  total: number
  groups: SnapshotGroup[]
}

/** Module stays electron-free (vitest-able) — callers pass the userData dir. */
export function snapshotPath(userDataDir: string): string {
  return path.join(userDataDir, 'import', 'signnow-catalog.json')
}

export function readSnapshot(file: string): SignnowSnapshot {
  if (!fs.existsSync(file)) {
    throw new Error(
      `SignNow snapshot not found at ${file} — export it first (or wait for the M2 live sync).`
    )
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SignnowSnapshot
  if (!Array.isArray(parsed.groups)) throw new Error('Malformed snapshot: missing groups[]')
  return parsed
}

export interface SnapshotImportResult {
  groupsSeen: number
  licenseesCreated: number
  licensesCreated: number
  licensesUpdated: number
  unparsedNames: string[]
  activeLicenses: number
}

export function importSignnowSnapshot(
  db: Database.Database,
  snapshot: SignnowSnapshot
): SnapshotImportResult {
  const result: SnapshotImportResult = {
    groupsSeen: 0,
    licenseesCreated: 0,
    licensesCreated: 0,
    licensesUpdated: 0,
    unparsedNames: [],
    activeLicenses: 0
  }

  const findLicensee = db.prepare('SELECT id FROM licensees WHERE normalized_name = ?')
  const insertLicensee = db.prepare(
    'INSERT INTO licensees (name, normalized_name, contact_email) VALUES (?, ?, ?)'
  )
  const fillContact = db.prepare(
    'UPDATE licensees SET contact_email = COALESCE(contact_email, ?) WHERE id = ?'
  )
  const findLicense = db.prepare('SELECT id FROM licenses WHERE signnow_group_id = ?')
  const insertLicense = db.prepare(
    `INSERT INTO licenses (licensee_id, signnow_group_id, vintage, status, agreement_ref, extraction_confidence)
     VALUES (?, ?, ?, ?, ?, 0.3)`
  )
  const updateLicenseStatus = db.prepare('UPDATE licenses SET status = ? WHERE id = ?')

  // Latest agreement year per licensee decides which license is the live one.
  const latestYearByLicensee = new Map<string, number>()
  const parsedGroups: Array<{ g: SnapshotGroup; company: string; year: number | null }> = []
  for (const g of snapshot.groups) {
    const parsed = parseSignnowGroupName(g.name)
    if (!parsed) {
      result.unparsedNames.push(g.name)
      continue
    }
    parsedGroups.push({ g, company: parsed.company, year: parsed.year })
    const norm = normalizeCompanyName(parsed.company)
    const y = parsed.year ?? 0
    if (y > (latestYearByLicensee.get(norm) ?? -1)) latestYearByLicensee.set(norm, y)
  }

  const currentYear = new Date().getUTCFullYear()

  const tx = db.transaction(() => {
    for (const { g, company, year } of parsedGroups) {
      result.groupsSeen += 1
      const norm = normalizeCompanyName(company)

      let licenseeId: number
      const existing = findLicensee.get(norm) as { id: number } | undefined
      const signerEmail = g.participant_emails[0] ?? null
      if (existing) {
        licenseeId = existing.id
        if (signerEmail) fillContact.run(signerEmail, licenseeId)
      } else {
        licenseeId = Number(insertLicensee.run(company, norm, signerEmail).lastInsertRowid)
        result.licenseesCreated += 1
      }

      // Status heuristic (review-flagged by low confidence, corrected by PDF
      // extraction later): the licensee's latest signed agreement is 'active'
      // when its year is current-or-future; everything older is superseded.
      const isLatest = (year ?? 0) === latestYearByLicensee.get(norm)
      const status = !g.signed
        ? 'active' // unsigned/pending groups don't assert anything yet
        : isLatest
          ? (year ?? 0) >= currentYear
            ? 'active'
            : 'expired'
          : 'renewed'

      const found = findLicense.get(g.id) as { id: number } | undefined
      if (found) {
        updateLicenseStatus.run(status, found.id)
        result.licensesUpdated += 1
      } else {
        const vintage = (year ?? currentYear) <= 2020 ? '2020' : '2025'
        insertLicense.run(licenseeId, g.id, vintage, status, `signnow:${g.name}`)
        result.licensesCreated += 1
      }
      if (status === 'active') result.activeLicenses += 1
    }
  })
  tx()
  return result
}
