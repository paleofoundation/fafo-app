import { BrowserWindow, ipcMain } from 'electron'
import { openDb } from './db'
import * as q from './db/queries'
import { msSignIn, msSignOut, msStatus } from './services/msgraph'
import type { CasePatch, EventKind, NewCaseInput, NewDeadlineInput } from '../shared/types'

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
}
