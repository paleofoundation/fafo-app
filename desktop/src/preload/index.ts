import { contextBridge, ipcRenderer } from 'electron'
import type { FafoApi } from '../shared/types'

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
  listLicensees: () => ipcRenderer.invoke('fafo:listLicensees')
}

contextBridge.exposeInMainWorld('fafo', api)
