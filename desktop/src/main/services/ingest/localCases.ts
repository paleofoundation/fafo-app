import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  normalizeCompanyName,
  parseCaseFolderName,
  parseEvidenceFolderName
} from '../../../shared/domain/naming'
import { findLicenseeByName } from './matching'
import { parseNameDate } from '../referralShots'

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
  { dir: 'Not Certified', caseType: 'Unlicensed Use - Never Certified' },
  // Everything else filed at this level is a matter too — the bucket just
  // doesn't say whether they were ever certified, so the type stays generic.
  { dir: 'Misc. Cases', caseType: 'Unlicensed Use' }
]

/** Buckets are the folders we descend INTO; anything else at the root is a case folder in its own right. */
const BUCKET_DIRS = new Set(BUCKETS.map((b) => b.dir))

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
  // A reply/forward prefix marks an email thread, even when the subject carries
  // a letter keyword: "Re Notice of Infringement …" is correspondence, not a
  // demand letter, and must reach email extraction rather than being filed away.
  if (/^(re|fwd?|fw)[\s:_-]/i.test(base) && ['.pdf', '.docx', '.doc', '.eml'].includes(ext))
    return 'email'
  if (/agreement/.test(base)) return 'agreement'
  if (/(complaint|motion|declaration|proposed order|judgment)/.test(base)) return 'court'
  if (/(c&d|cease|demand|notice of infringement|termination|settlement)/.test(base)) return 'letter'
  if (parentLabel && ['.pdf', '.docx', '.doc'].includes(ext)) {
    // The per-case dump folders: Email/ holds correspondence, Legal/ and
    // Settlement/ hold counsel traffic and settlement revisions. Filed by
    // folder rather than by filename, so the folder is what classifies them.
    if (/email/i.test(parentLabel)) return 'email'
    if (/^(legal|settlement|termination|trestle|litigation)/i.test(parentLabel)) return 'letter'
  }
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
          // Fall back to a date in the file's own name (PXL_20260719_…) or its
          // folder ("Order - July 19, 2026") when the session parser found none,
          // so a test-purchase folder is not filed as undated.
          datedAt: datedAt ?? parseNameDate(entry.name) ?? (parentLabel ? parseNameDate(parentLabel) : null)
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

/**
 * Every folder under the root that represents a matter: the contents of each
 * known bucket, plus any folder sitting loose at the root (e.g. "erewhon",
 * "Thrive Market"), which would otherwise never be seen.
 */
function caseFolderCandidates(
  root: string
): Array<{ folderPath: string; folderName: string; bucket: string; caseType: string }> {
  const out: Array<{ folderPath: string; folderName: string; bucket: string; caseType: string }> = []

  for (const bucket of BUCKETS) {
    const bucketPath = path.join(root, bucket.dir)
    if (!fs.existsSync(bucketPath)) continue
    for (const entry of fs.readdirSync(bucketPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      out.push({
        folderPath: path.join(bucketPath, entry.name),
        folderName: entry.name,
        bucket: bucket.dir,
        caseType: bucket.caseType
      })
    }
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (BUCKET_DIRS.has(entry.name)) continue
    out.push({
      folderPath: path.join(root, entry.name),
      folderName: entry.name,
      bucket: '(root)',
      caseType: 'Unlicensed Use'
    })
  }

  return out
}

export function scanLocalCases(db: Database.Database, root = DEFAULT_CASES_ROOT): LocalScanReport {
  if (!fs.existsSync(root)) {
    throw new Error(`Infringement Cases root not found: ${root}`)
  }

  const findCaseByFolder = db.prepare('SELECT id FROM cases WHERE local_folder_path = ?')
  const findCaseByLicensee = db.prepare(
    "SELECT id FROM cases WHERE licensee_id = ? ORDER BY status = 'Resolved', opened_at DESC LIMIT 1"
  )

  const folders: ScannedCaseFolder[] = []

  for (const bucket of caseFolderCandidates(root)) {
    {
      const folderPath = bucket.folderPath
      const { primaryName, relatedEntity } = parseCaseFolderName(bucket.folderName)
      const match = findLicenseeByName(db, primaryName)
      const existingCase = match
        ? ((findCaseByLicensee.get(match.id) as { id: number } | undefined) ?? null)
        : null
      const alreadyImported = findCaseByFolder.get(folderPath) !== undefined
      const walked = walkCaseFolder(folderPath)
      if (match && !match.exact) {
        walked.flags.push(`fuzzy licensee match: "${primaryName}" → "${match.name}" — verify`)
      }

      folders.push({
        folderPath,
        folderName: bucket.folderName,
        bucket: bucket.bucket,
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

/**
 * Re-read a case's folder and pick up anything new.
 *
 * The original import deliberately skips folders it has already seen, which
 * makes it useless once a matter is live: dropping a new screenshot, email
 * thread or countersigned agreement into the folder produced nothing. This is
 * the repeatable path — safe to run any number of times, because
 * evidence_files.path is uniquely indexed and inserts are OR IGNORE.
 *
 * Files that have disappeared are REPORTED, never deleted. A missing file is
 * usually a folder someone moved, and silently dropping the reference would
 * quietly shrink the evidence record behind a case.
 */
export interface FolderRefresh {
  caseId: number
  caseTitle: string
  folderPath: string
  filesSeen: number
  filesAdded: number
  /** Indexed files whose path no longer resolves on disk. */
  missing: number
  newestFileAt: string | null
  addedByKind: Record<string, number>
  flags: string[]
}

export function refreshCaseFiles(db: Database.Database, caseId: number): FolderRefresh {
  const row = db
    .prepare('SELECT id, title, local_folder_path AS folderPath FROM cases WHERE id = ?')
    .get(caseId) as { id: number; title: string; folderPath: string | null } | undefined
  if (!row) throw new Error(`Case ${caseId} not found`)
  if (!row.folderPath)
    throw new Error(
      `"${row.title}" has no local folder linked yet. Link one first, then refresh.`
    )
  if (!fs.existsSync(row.folderPath))
    throw new Error(`Folder no longer exists: ${row.folderPath}`)

  const walked = walkCaseFolder(row.folderPath)
  const insertEvidence = db.prepare(
    `INSERT OR IGNORE INTO evidence_files (case_id, path, byte_size, mtime, kind, dated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, 'local_refresh')`
  )

  const addedByKind: Record<string, number> = {}
  let filesAdded = 0
  let newestFileAt: string | null = null

  db.transaction(() => {
    for (const file of walked.files) {
      const r = insertEvidence.run(
        caseId,
        file.path,
        file.size,
        file.mtime,
        file.kind,
        file.datedAt
      )
      if (r.changes === 1) {
        filesAdded += 1
        addedByKind[file.kind] = (addedByKind[file.kind] ?? 0) + 1
        if (!newestFileAt || file.mtime > newestFileAt) newestFileAt = file.mtime
      }
    }
    if (filesAdded > 0) {
      const summary = Object.entries(addedByKind)
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
        .join(', ')
      db.prepare(
        "INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'evidence', ?)"
      ).run(
        caseId,
        new Date().toISOString().slice(0, 10),
        `Picked up ${filesAdded} new file${filesAdded === 1 ? '' : 's'} from the case folder (${summary}).`
      )
    }
  })()

  const onDisk = new Set(walked.files.map((f) => f.path))
  const indexed = db
    .prepare('SELECT path FROM evidence_files WHERE case_id = ? AND path IS NOT NULL')
    .all(caseId) as Array<{ path: string }>
  const missing = indexed.filter((e) => !onDisk.has(e.path)).length

  return {
    caseId,
    caseTitle: row.title,
    folderPath: row.folderPath,
    filesSeen: walked.files.length,
    filesAdded,
    missing,
    newestFileAt,
    addedByKind,
    flags: walked.flags
  }
}

export interface RefreshAllResult {
  cases: FolderRefresh[]
  totals: {
    casesChecked: number
    casesChanged: number
    filesAdded: number
    missing: number
    unlinkedCases: number
    unreadableFolders: number
  }
}

/** Refresh every case that has a folder linked. Only changed cases are returned. */
export function refreshAllCaseFiles(db: Database.Database): RefreshAllResult {
  const linked = db
    .prepare(
      'SELECT id FROM cases WHERE local_folder_path IS NOT NULL ORDER BY status != \'Resolved\' DESC, title'
    )
    .all() as Array<{ id: number }>
  const unlinked = (
    db.prepare('SELECT COUNT(*) AS n FROM cases WHERE local_folder_path IS NULL').get() as {
      n: number
    }
  ).n

  const cases: FolderRefresh[] = []
  let filesAdded = 0
  let missing = 0
  let unreadable = 0

  for (const { id } of linked) {
    try {
      const r = refreshCaseFiles(db, id)
      filesAdded += r.filesAdded
      missing += r.missing
      if (r.filesAdded > 0 || r.missing > 0) cases.push(r)
    } catch {
      // A folder that has moved shouldn't abort the sweep over the other 160.
      unreadable += 1
    }
  }

  return {
    cases,
    totals: {
      casesChecked: linked.length,
      casesChanged: cases.filter((c) => c.filesAdded > 0).length,
      filesAdded,
      missing,
      unlinkedCases: unlinked,
      unreadableFolders: unreadable
    }
  }
}

/** Point a case at a folder so it can be refreshed. Used for matters the archive scan never matched. */
export function setCaseFolder(db: Database.Database, caseId: number, folderPath: string): void {
  if (!fs.existsSync(folderPath)) throw new Error(`Folder not found: ${folderPath}`)
  const taken = db
    .prepare('SELECT title FROM cases WHERE local_folder_path = ? AND id != ?')
    .get(folderPath, caseId) as { title: string } | undefined
  if (taken) throw new Error(`That folder is already linked to "${taken.title}".`)
  const r = db.prepare('UPDATE cases SET local_folder_path = ? WHERE id = ?').run(folderPath, caseId)
  if (r.changes === 0) throw new Error(`Case ${caseId} not found`)
  db.prepare("INSERT INTO case_events (case_id, at, kind, body) VALUES (?, ?, 'import', ?)").run(
    caseId,
    new Date().toISOString().slice(0, 10),
    `Linked local folder: ${folderPath}`
  )
}

export interface CaseFile {
  id: number
  fileName: string
  path: string | null
  byteSize: number | null
  mtime: string | null
  kind: string
  datedAt: string | null
  source: string
  /** False when the row points at a file that is no longer on disk. */
  present: boolean
}

export interface CaseFiles {
  folderPath: string | null
  folderExists: boolean
  files: CaseFile[]
  byKind: Array<{ kind: string; count: number }>
  missing: number
}

/** The documents attached to a case, newest first, with on-disk presence resolved. */
export function listCaseFiles(db: Database.Database, caseId: number): CaseFiles {
  const c = db.prepare('SELECT local_folder_path AS folderPath FROM cases WHERE id = ?').get(caseId) as
    | { folderPath: string | null }
    | undefined
  if (!c) throw new Error(`Case ${caseId} not found`)

  const rows = db
    .prepare(
      `SELECT id, path, byte_size AS byteSize, mtime, kind, dated_at AS datedAt, source
       FROM evidence_files WHERE case_id = ?
       ORDER BY COALESCE(dated_at, mtime) DESC, id DESC`
    )
    .all(caseId) as Array<Omit<CaseFile, 'fileName' | 'present'>>

  const files: CaseFile[] = rows.map((r) => ({
    ...r,
    fileName: r.path ? path.basename(r.path) : '(no path)',
    present: r.path ? fs.existsSync(r.path) : false
  }))

  const counts = new Map<string, number>()
  for (const f of files) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)

  return {
    folderPath: c.folderPath,
    folderExists: c.folderPath ? fs.existsSync(c.folderPath) : false,
    files,
    byKind: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    missing: files.filter((f) => !f.present).length
  }
}

/** Resolve an evidence row to its path. The renderer never passes a raw path to the shell. */
export function evidencePath(db: Database.Database, evidenceId: number): string {
  const row = db.prepare('SELECT path FROM evidence_files WHERE id = ?').get(evidenceId) as
    | { path: string | null }
    | undefined
  if (!row?.path) throw new Error(`Evidence ${evidenceId} has no local path`)
  if (!fs.existsSync(row.path)) throw new Error(`File no longer exists: ${row.path}`)
  return row.path
}
