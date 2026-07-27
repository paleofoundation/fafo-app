import { BrowserWindow, app, ipcMain } from 'electron'
import fs from 'node:fs'
import { openDb } from './db'
import * as q from './db/queries'
import { msSignIn, msSignOut, msStatus } from './services/msgraph'
import {
  commitLocalCases,
  scanLocalCases,
  type LocalScanReport
} from './services/ingest/localCases'
import {
  importSignnowSnapshot,
  readSnapshot,
  snapshotPath
} from './services/ingest/signnowSnapshot'
import {
  commitSheets,
  scanSheets,
  sheetsExportPath,
  type SheetsExport,
  type SheetsScanResult
} from './services/ingest/sheetsImport'
import { syncSignnow } from './services/signnowApi'
import { extractionCounts, runExtraction } from './services/ingest/extractionRunner'
import {
  getSecret,
  hasSecret,
  setSecret,
  SECRET_ANTHROPIC_API_KEY,
  SECRET_SIGNNOW_API_KEY
} from './secrets'
import type {
  CasePatch,
  EventKind,
  LocalScanSummary,
  NewCaseInput,
  NewDeadlineInput,
  SignnowStatus,
  SnapshotStatus
} from '../shared/types'

/** Full scan (with per-file lists) cached main-side between dry run and commit. */
let lastScan: LocalScanReport | null = null

function summarize(report: LocalScanReport): LocalScanSummary {
  return {
    root: report.root,
    scannedAt: report.scannedAt,
    totals: report.totals,
    folders: report.folders.map((f) => ({
      folderPath: f.folderPath,
      folderName: f.folderName,
      caseType: f.caseType,
      primaryName: f.primaryName,
      relatedEntity: f.relatedEntity,
      matchedLicenseeName: f.matchedLicenseeName,
      willLinkExistingCase: f.existingCaseId !== null,
      alreadyImported: f.alreadyImported,
      fileCount: f.files.length,
      evidenceSessions: f.evidenceSessions,
      earliestEvidence: f.earliestEvidence,
      latestEvidence: f.latestEvidence,
      flags: f.flags
    }))
  }
}

/**
 * IPC channel names mirror the FafoApi method names 1:1 (prefixed "fafo:").
 * All handlers are synchronous DB work behind invoke() — better-sqlite3 is
 * sync by design and these queries are small.
 */
export function registerIpc(): void {
  const db = openDb()

  ipcMain.handle('fafo:listCases', () => q.listCases(db))
  ipcMain.handle('fafo:getCase', (_e, id: number) => q.getCase(db, id))
  ipcMain.handle('fafo:createCase', (_e, input: NewCaseInput) => q.createCase(db, input))
  ipcMain.handle('fafo:updateCase', (_e, id: number, patch: CasePatch) => q.updateCase(db, id, patch))
  ipcMain.handle('fafo:addEvent', (_e, caseId: number, kind: EventKind, body: string, at?: string) =>
    q.addEvent(db, caseId, kind, body, at)
  )
  ipcMain.handle('fafo:listDeadlines', () => q.listDeadlines(db))
  ipcMain.handle('fafo:addDeadline', (_e, input: NewDeadlineInput) => q.addDeadline(db, input))
  ipcMain.handle('fafo:satisfyDeadline', (_e, id: number, satisfied: boolean) =>
    q.satisfyDeadline(db, id, satisfied)
  )
  ipcMain.handle('fafo:dismissDeadline', (_e, id: number) => q.dismissDeadline(db, id))
  ipcMain.handle('fafo:listMarks', () => q.listMarks(db))
  ipcMain.handle('fafo:listLicensees', () => q.listLicensees(db))

  ipcMain.handle('fafo:msStatus', () => msStatus(db))
  ipcMain.handle('fafo:msSignIn', () =>
    msSignIn(db, (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('fafo:msAuthEvent', event)
      }
    })
  )
  ipcMain.handle('fafo:msSignOut', () => msSignOut(db))

  ipcMain.handle('fafo:importSnapshotStatus', (): SnapshotStatus => {
    const file = snapshotPath(app.getPath('userData'))
    if (!fs.existsSync(file)) return { present: false }
    try {
      const snap = readSnapshot(file)
      return { present: true, exportedAt: snap.exportedAt, total: snap.total }
    } catch {
      return { present: false }
    }
  })
  ipcMain.handle('fafo:importSignnowSnapshot', () =>
    importSignnowSnapshot(db, readSnapshot(snapshotPath(app.getPath('userData'))))
  )
  ipcMain.handle('fafo:importScanLocal', () => {
    lastScan = scanLocalCases(db)
    return summarize(lastScan)
  })
  ipcMain.handle('fafo:importCommitLocal', () => {
    if (!lastScan) throw new Error('Run the dry-run scan first — nothing staged to commit')
    const result = commitLocalCases(db, lastScan)
    lastScan = null
    return result
  })

  let lastSheetsScan: SheetsScanResult | null = null
  ipcMain.handle('fafo:importScanSheets', () => {
    const file = sheetsExportPath(app.getPath('userData'))
    if (!fs.existsSync(file)) throw new Error(`Sheets export not found at ${file}`)
    const exp = JSON.parse(fs.readFileSync(file, 'utf8')) as SheetsExport
    lastSheetsScan = scanSheets(db, exp)
    return {
      rows: lastSheetsScan.rows.map(({ matchedCaseId: _m, ...view }) => view),
      totals: lastSheetsScan.totals
    }
  })
  ipcMain.handle('fafo:importCommitSheets', () => {
    if (!lastSheetsScan) throw new Error('Run the sheets dry-run first — nothing staged to commit')
    const result = commitSheets(db, lastSheetsScan)
    lastSheetsScan = null
    return result
  })

  function signnowStatus(): SignnowStatus {
    const sync = db
      .prepare("SELECT cursor, last_full_sync_at AS at FROM sync_state WHERE source = 'signnow'")
      .get() as { cursor: string | null; at: string | null } | undefined
    const job = db
      .prepare("SELECT last_status FROM jobs WHERE kind = 'signnow_sync'")
      .get() as { last_status: string | null } | undefined
    return {
      keyPresent: hasSecret(SECRET_SIGNNOW_API_KEY),
      lastSyncAt: sync?.at ?? null,
      lastSyncCursor: sync?.cursor ?? null,
      lastJobStatus: job?.last_status ?? null
    }
  }

  ipcMain.handle('fafo:signnowStatus', () => signnowStatus())
  ipcMain.handle('fafo:signnowSetKey', (_e, key: string) => {
    setSecret(SECRET_SIGNNOW_API_KEY, key.trim())
    return signnowStatus()
  })
  ipcMain.handle('fafo:extractionStatus', () => {
    const counts = extractionCounts(db)
    const job = db
      .prepare("SELECT last_status FROM jobs WHERE kind = 'license_extraction'")
      .get() as { last_status: string | null } | undefined
    return {
      ...counts,
      keysPresent: hasSecret(SECRET_SIGNNOW_API_KEY) && hasSecret(SECRET_ANTHROPIC_API_KEY),
      lastJobStatus: job?.last_status ?? null
    }
  })
  ipcMain.handle('fafo:extractionRun', async (_e, limit?: number) => {
    const signnow = getSecret(SECRET_SIGNNOW_API_KEY)
    const anthropic = getSecret(SECRET_ANTHROPIC_API_KEY)
    if (!signnow || !anthropic) {
      throw new Error('SignNow and Anthropic API keys are both required — add them in Settings')
    }
    return runExtraction(db, { signnow, anthropic }, limit ?? 40, (p) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('fafo:extractionProgress', p)
      }
    })
  })
  ipcMain.handle('fafo:listLicenses', () =>
    (
      db
        .prepare(
          `SELECT li.id, l.name AS licenseeName, li.agreement_ref AS agreementRef,
                  li.vintage, li.term_start AS termStart, li.term_end AS termEnd,
                  li.annual_fee_cents AS annualFeeCents, li.revenue_band AS revenueBand,
                  li.status, li.extraction_confidence AS extractionConfidence
           FROM licenses li JOIN licensees l ON l.id = li.licensee_id
           ORDER BY li.status = 'active' DESC, li.term_end IS NULL, li.term_end DESC`
        )
        .all() as Array<Record<string, unknown> & { id: number }>
    ).map((row) => ({
      ...row,
      markCodes: (
        db
          .prepare(
            `SELECT m.code FROM license_marks lm JOIN marks m ON m.id = lm.mark_id
             WHERE lm.license_id = ?`
          )
          .all(row.id) as Array<{ code: string }>
      ).map((r) => r.code)
    }))
  )

  ipcMain.handle('fafo:signnowSyncNow', async () => {
    const key = getSecret(SECRET_SIGNNOW_API_KEY)
    if (!key) throw new Error('No SignNow API key stored — add one below first')
    const r = await syncSignnow(db, key)
    return {
      identityEmail: r.identity.email,
      apiTotal: r.apiTotal,
      licensesCreated: r.imported.licensesCreated,
      licensesUpdated: r.imported.licensesUpdated,
      activeLicenses: r.imported.activeLicenses
    }
  })
}
