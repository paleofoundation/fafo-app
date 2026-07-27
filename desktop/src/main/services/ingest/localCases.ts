import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  normalizeCompanyName,
  parseCaseFolderName,
  parseEvidenceFolderName
} from '../../../shared/domain/naming'

/**
 * Importer for the historical archive at
 * ~/Desktop/PaleoFoundation/LEGAL/Infringement Cases.
 *
 * Two buckets (POSIX names — the ":" is Finder's "/"):
 *   "Certified:Expired"  → former licensees      → type "Expired License"
 *   "Not Certified"      → never licensed        → type "Unlicensed Use - Never Certified"
 *
 * Evidence is referenced IN PLACE — nothing is copied, hashed, or moved
 * (14 GB tree; hashing is deferred until a file is used in an exhibit).
 * The scan is a pure read; commit() writes rows and is idempotent via the
 * unique indexes on cases.local_folder_path and evidence_files.path.
 */

export const DEFAULT_CASES_ROOT =
  '/Users/jonathanpendergrass/Desktop/PaleoFoundation/LEGAL/Infringement Cases'

const BUCKETS: ReadonlyArray<{ dir: string; caseType: string }> = [
  { dir: 'Certified:Expired', caseType: 'Expired License' },
  { dir: 'Not Certified', caseType: 'Unlicensed Use - Never Certified' }
]

/** Folders that are counsel/correspondence organization, not evidence sessions. */
const KNOWN_SUBFOLDERS = /^(emails?|email correspondence|trestle|legal|litigation docs?|settlement|termination|c&d.*)$/i

export interface ScannedFile {
  path: string
  size: number
  mtime: string
  kind: 'screenshot' | 'email' | 'agreement' | 'court' | 'video' | 'letter' | 'other'
  datedAt: string | null
}

export interface ScannedCaseFolder {
  folderPath: string
  folderName: string
  bucket: string
  caseType: string
  primaryName: string
  relatedEntity: string | null
  /** licensee id when a normalized-name match exists in the DB */
  matchedLicenseeId: number | null
  matchedLicenseeName: string | null
  /** case id when the matched licensee already has a case (evidence attaches there) */
  existingCaseId: number | null
  alreadyImported: boolean
  evidenceSessions: number
  files: ScannedFile[]
  earliestEvidence: string | null
  latestEvidence: string | null
  flags: string[]
}

export interface LocalScanReport {
  root: string
  scannedAt: string
  folders: ScannedCaseFolder[]
  totals: {
    folders: number
    files: number
    matchedExisting: number
    newLicensees: number
    alreadyImported: number
    flagged: number
  }
}

function classifyFile(filePath: string, parentLabel: string | null): ScannedFile['kind'] {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.jp2', '.heic'].includes(ext)) return 'screenshot'
  if (['.mp4', '.mov'].includes(ext)) return 'video'
  if (ext === '.eml') return 'email'
  if (/agreement/.test(base)) return 'agreement'
  if (/(complaint|motion|declaration|proposed order|judgment)/.test(base)) return 'court'
  if (/(c&d|cease|demand|notice of infringement|termination|settlement)/.test(base)) return 'letter'
  if (parentLabel && /email/i.test(parentLabel) && ['.pdf', '.docx'].includes(ext)) return 'email'
  return 'other'
}

function walkCaseFolder(folderPath: string): {
  files: ScannedFile[]
  sessions: number
  earliest: string | null
  latest: string | null
  flags: string[]
} {
  const files: ScannedFile[] = []
  const flags: string[] = []
  let sessions = 0
  const dates: string[] = []

  function walk(dir: string, datedAt: string | null, parentLabel: string | null, depth: number): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      flags.push(`unreadable: ${dir}`)
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= 4) {
          flags.push(`too deep, skipped: ${full}`)
          continue
        }
        const parsed = parseEvidenceFolderName(entry.name)
        if (parsed) {
          sessions += 1
          dates.push(parsed.isoDate)
          walk(full, parsed.isoDate, parsed.label ?? entry.name, depth + 1)
        } else {
          if (!KNOWN_SUBFOLDERS.test(entry.name)) flags.push(`unrecognized subfolder: ${entry.name}`)
          walk(full, datedAt, entry.name, depth + 1)
        }
      } else if (entry.isFile()) {
        let stat: fs.Stats
        try {
          stat = fs.statSync(full)
        } catch {
          continue
        }
        files.push({
          path: full,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          kind: classifyFile(full, parentLabel),
          datedAt
        })
      }
    }
  }

  walk(folderPath, null, null, 0)
  dates.sort()
  return {
    files,
    sessions,
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
    flags
  }
}

export function scanLocalCases(db: Database.Database, root = DEFAULT_CASES_ROOT): LocalScanReport {
  if (!fs.existsSync(root)) {
    throw new Error(`Infringement Cases root not found: ${root}`)
  }

  const findLicensee = db.prepare('SELECT id, name FROM licensees WHERE normalized_name = ?')
  const findCaseByFolder = db.prepare('SELECT id FROM cases WHERE local_folder_path = ?')
  const findCaseByLicensee = db.prepare(
    "SELECT id FROM cases WHERE licensee_id = ? ORDER BY status = 'Resolved', opened_at DESC LIMIT 1"
  )

  const folders: ScannedCaseFolder[] = []

  for (const bucket of BUCKETS) {
    const bucketPath = path.join(root, bucket.dir)
    if (!fs.existsSync(bucketPath)) continue
    for (const entry of fs.readdirSync(bucketPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const folderPath = path.join(bucketPath, entry.name)
      const { primaryName, relatedEntity } = parseCaseFolderName(entry.name)
      const match = findLicensee.get(normalizeCompanyName(primaryName)) as
        | { id: number; name: string }
        | undefined
      const existingCase = match
        ? ((findCaseByLicensee.get(match.id) as { id: number } | undefined) ?? null)
        : null
      const alreadyImported = findCaseByFolder.get(folderPath) !== undefined
      const walked = walkCaseFolder(folderPath)

      folders.push({
        folderPath,
        folderName: entry.name,
        bucket: bucket.dir,
        caseType: bucket.caseType,
        primaryName,
        relatedEntity,
        matchedLicenseeId: match?.id ?? null,
        matchedLicenseeName: match?.name ?? null,
        existingCaseId: existingCase?.id ?? null,
        alreadyImported,
        evidenceSessions: walked.sessions,
        files: walked.files,
        earliestEvidence: walked.earliest,
        latestEvidence: walked.latest,
        flags: walked.flags
      })
    }
  }

  folders.sort((a, b) => a.folderName.localeCompare(b.folderName))
  return {
    root,
    scannedAt: new Date().toISOString(),
    folders,
    totals: {
      folders: folders.length,
      files: folders.reduce((s, f) => s + f.files.length, 0),
      matchedExisting: folders.filter((f) => f.matchedLicenseeId !== null).length,
      newLicensees: folders.filter((f) => f.matchedLicenseeId === null).length,
      alreadyImported: folders.filter((f) => f.alreadyImported).length,
      flagged: folders.filter((f) => f.flags.length > 0).length
    }
  }
}

export interface LocalCommitResult {
  casesCreated: number
  casesLinked: number
  licenseesCreated: number
  evidenceAdded: number
  evidenceSkipped: number
  skippedFolders: number
}

/**
 * Commit a scan. Historical archive cases enter as status "Resolved" with
 * legacy_import=1 and a review event — Jonathan corrects any that are still
 * live (the four active matters already exist and are LINKED, not duplicated).
 */
export function commitLocalCases(db: Database.Database, report: LocalScanReport): LocalCommitResult {
  const result: LocalCommitResult = {
    casesCreated: 0,
    casesLinked: 0,
    licenseesCreated: 0,
    evidenceAdded: 0,
    evidenceSkipped: 0,
    skippedFolders: 0
  }

  const insertLicensee = db.prepare(
    'INSERT INTO licensees (name, normalized_name, aka_names, local_folder_path) VALUES (?, ?, ?, ?)'
  )
  const updateLicenseeFolder = db.prepare(
    'UPDATE licensees SET local_folder_path = COALESCE(local_folder_path, ?) WHERE id = ?'
  )
  const insertCase = db.prepare(
    `INSERT INTO cases (licensee_id, title, type, status, source, opened_at, local_folder_path, legacy_import)
     VALUES (?, ?, ?, 'Resolved', 'Website', ?, ?, 1)`
  )
  const linkCaseFolder = db.prepare(
    'UPDATE cases SET local_folder_path = COALESCE(local_folder_path, ?) WHERE id = ?'
  )
  const insertEvent = db.prepare(
    'INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, ?, ?)'
  )
  const insertEvidence = db.prepare(
    `INSERT OR IGNORE INTO evidence_files (case_id, path, byte_size, mtime, kind, dated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, 'local_import')`
  )

  const today = new Date().toISOString().slice(0, 10)

  const tx = db.transaction(() => {
    for (const f of report.folders) {
      if (f.alreadyImported) {
        result.skippedFolders += 1
        continue
      }

      let licenseeId = f.matchedLicenseeId
      if (licenseeId === null) {
        licenseeId = Number(
          insertLicensee.run(
            f.primaryName,
            normalizeCompanyName(f.primaryName),
            f.relatedEntity,
            f.folderPath
          ).lastInsertRowid
        )
        result.licenseesCreated += 1
      } else {
        updateLicenseeFolder.run(f.folderPath, licenseeId)
      }

      let caseId: number
      if (f.existingCaseId !== null) {
        caseId = f.existingCaseId
        linkCaseFolder.run(f.folderPath, caseId)
        insertEvent.run(
          caseId,
          today,
          'import',
          `Linked historical archive folder (${f.files.length} files, ${f.evidenceSessions} evidence sessions): ${f.folderPath}`
        )
        result.casesLinked += 1
      } else {
        const openedAt = f.earliestEvidence ?? today
        caseId = Number(
          insertCase.run(
            licenseeId,
            f.relatedEntity ? `${f.primaryName} (${f.relatedEntity})` : f.primaryName,
            f.caseType,
            openedAt,
            f.folderPath
          ).lastInsertRowid
        )
        insertEvent.run(
          caseId,
          today,
          'import',
          `Imported from archive (status defaulted to Resolved — REVIEW if still live). ` +
            `${f.files.length} files, ${f.evidenceSessions} evidence sessions, ` +
            `evidence ${f.earliestEvidence ?? '?'} → ${f.latestEvidence ?? '?'}. ` +
            (f.flags.length > 0 ? `Flags: ${f.flags.join('; ')}` : 'No flags.')
        )
        result.casesCreated += 1
      }

      for (const file of f.files) {
        const r = insertEvidence.run(caseId, file.path, file.size, file.mtime, file.kind, file.datedAt)
        if (r.changes === 1) result.evidenceAdded += 1
        else result.evidenceSkipped += 1
      }
    }
  })
  tx()
  return result
}
