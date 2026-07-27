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
import type {
  CasePatch,
  EventKind,
  LocalScanSummary,
  NewCaseInput,
  NewDeadlineInput,
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
}
