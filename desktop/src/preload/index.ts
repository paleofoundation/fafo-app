import { contextBridge, ipcRenderer } from 'electron'
import type { ExtractionProgressEvent, FafoApi, MsAuthEvent } from '../shared/types'

const api: FafoApi = {
  listCases: () => ipcRenderer.invoke('fafo:listCases'),
  getCase: (id) => ipcRenderer.invoke('fafo:getCase', id),
  createCase: (input) => ipcRenderer.invoke('fafo:createCase', input),
  updateCase: (id, patch) => ipcRenderer.invoke('fafo:updateCase', id, patch),
  addEvent: (caseId, kind, body, at) => ipcRenderer.invoke('fafo:addEvent', caseId, kind, body, at),
  listDeadlines: () => ipcRenderer.invoke('fafo:listDeadlines'),
  addDeadline: (input) => ipcRenderer.invoke('fafo:addDeadline', input),
  satisfyDeadline: (id, satisfied) => ipcRenderer.invoke('fafo:satisfyDeadline', id, satisfied),
  dismissDeadline: (id) => ipcRenderer.invoke('fafo:dismissDeadline', id),
  listMarks: () => ipcRenderer.invoke('fafo:listMarks'),
  listLicensees: () => ipcRenderer.invoke('fafo:listLicensees'),
  msStatus: () => ipcRenderer.invoke('fafo:msStatus'),
  msSignIn: () => ipcRenderer.invoke('fafo:msSignIn'),
  msSignOut: () => ipcRenderer.invoke('fafo:msSignOut'),
  onMsAuthEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, event: MsAuthEvent): void => cb(event)
    ipcRenderer.on('fafo:msAuthEvent', listener)
    return () => ipcRenderer.removeListener('fafo:msAuthEvent', listener)
  },
  importSnapshotStatus: () => ipcRenderer.invoke('fafo:importSnapshotStatus'),
  importSignnowSnapshot: () => ipcRenderer.invoke('fafo:importSignnowSnapshot'),
  importScanLocal: () => ipcRenderer.invoke('fafo:importScanLocal'),
  importCommitLocal: () => ipcRenderer.invoke('fafo:importCommitLocal'),
  importScanSheets: () => ipcRenderer.invoke('fafo:importScanSheets'),
  importCommitSheets: () => ipcRenderer.invoke('fafo:importCommitSheets'),
  signnowStatus: () => ipcRenderer.invoke('fafo:signnowStatus'),
  signnowSetKey: (key) => ipcRenderer.invoke('fafo:signnowSetKey', key),
  signnowSyncNow: () => ipcRenderer.invoke('fafo:signnowSyncNow'),
  extractionStatus: () => ipcRenderer.invoke('fafo:extractionStatus'),
  extractionRun: (limit) => ipcRenderer.invoke('fafo:extractionRun', limit),
  onExtractionProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ExtractionProgressEvent): void => cb(p)
    ipcRenderer.on('fafo:extractionProgress', listener)
    return () => ipcRenderer.removeListener('fafo:extractionProgress', listener)
  },
  listLicenses: () => ipcRenderer.invoke('fafo:listLicenses'),
  listLetters: (caseId) => ipcRenderer.invoke('fafo:listLetters', caseId),
  generateLetter: (caseId, kind) => ipcRenderer.invoke('fafo:generateLetter', caseId, kind),
  markLetterSent: (letterId) => ipcRenderer.invoke('fafo:markLetterSent', letterId),
  exportLetterToDrive: (letterId) => ipcRenderer.invoke('fafo:exportLetterToDrive', letterId),
  scanMailNow: () => ipcRenderer.invoke('fafo:scanMailNow'),
  quoteSettlement: (caseId, observedUseThrough) =>
    ipcRenderer.invoke('fafo:quoteSettlement', caseId, observedUseThrough),
  metricsImportPlan: () => ipcRenderer.invoke('fafo:metricsImportPlan'),
  metricsImportCommit: (supersedeConflicts) =>
    ipcRenderer.invoke('fafo:metricsImportCommit', supersedeConflicts),
  metricsSummary: () => ipcRenderer.invoke('fafo:metricsSummary'),
  listLegacyPayments: () => ipcRenderer.invoke('fafo:listLegacyPayments'),
  addLegacyPayment: (input) => ipcRenderer.invoke('fafo:addLegacyPayment', input),
  removeLegacyPayment: (id) => ipcRenderer.invoke('fafo:removeLegacyPayment', id),
  unrecordedSettlements: () => ipcRenderer.invoke('fafo:unrecordedSettlements'),
  confirmSettlementPayment: (caseId, amountCents, receivedDate, resolvedBy) =>
    ipcRenderer.invoke(
      'fafo:confirmSettlementPayment',
      caseId,
      amountCents,
      receivedDate,
      resolvedBy
    ),
  exportPolicingRecord: (markCode, toDrive) =>
    ipcRenderer.invoke('fafo:exportPolicingRecord', markCode, toDrive),
  exportBrandFeed: () => ipcRenderer.invoke('fafo:exportBrandFeed')
}

contextBridge.exposeInMainWorld('fafo', api)
