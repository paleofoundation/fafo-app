/** Shared entity + IPC contract types. Pure types — no runtime deps. */

import type { AgreementVintage } from './domain/deadlines'

export type CaseStatus = 'Open' | 'In Progress' | 'Resolved'

export const CASE_TYPES = [
  'Expired License',
  'Unlicensed Use',
  'Unlicensed Use - Change in Ownership',
  'Unlicensed Use - Never Certified'
] as const
export type CaseType = (typeof CASE_TYPES)[number]

export const CASE_SOURCES = [
  'Website',
  'Social Media',
  'Product Packaging',
  'Amazon',
  'Third-Party Retail',
  'Other'
] as const
export type CaseSource = (typeof CASE_SOURCES)[number]

export type ResolvedBy = 'JP' | 'Trestle' | null

export interface Licensee {
  id: number
  name: string
  normalizedName: string
  akaNames: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  driveFolderId: string | null
  localFolderPath: string | null
  repeatInfringer: 0 | 1
}

export interface Mark {
  id: number
  code: string
  name: string
  program: string
  usptoRegNo: string
  regStatus: string
  notes: string | null
}

export interface License {
  id: number
  licenseeId: number
  signnowGroupId: string | null
  vintage: AgreementVintage
  termStart: string | null
  termEnd: string | null
  revenueBand: string | null
  revenueCategory: string | null
  annualFeeCents: number | null
  status: 'active' | 'expiring' | 'expired' | 'terminated' | 'renewed'
  agreementRef: string | null
  extractionConfidence: number | null
}

export interface CaseRow {
  id: number
  licenseeId: number | null
  watchItemId: number | null
  title: string
  type: CaseType
  status: CaseStatus
  source: CaseSource
  url: string | null
  openedAt: string
  resolvedAt: string | null
  resolvedBy: ResolvedBy
  settlementPosition: string | null
  driveFolderId: string | null
  localFolderPath: string | null
  legacyImport: 0 | 1
  /** joined for display */
  licenseeName?: string
  markCodes?: string[]
}

export type EventKind =
  | 'note'
  | 'letter_sent'
  | 'response'
  | 'evidence'
  | 'payment'
  | 'status_change'
  | 'import'

export interface CaseEvent {
  id: number
  caseId: number
  at: string
  kind: EventKind
  body: string
  refTable: string | null
  refId: number | null
}

export type DeadlineKind =
  | 'selloff_end'
  | 'letter_response'
  | 'payment_due'
  | 'patrol_spot_check'
  | 'review'
  | 'custom'

export interface Deadline {
  id: number
  refTable: string | null
  refId: number | null
  kind: DeadlineKind
  title: string
  dueAt: string
  satisfiedAt: string | null
  dismissed: 0 | 1
  /** joined for display */
  caseTitle?: string | null
}

export interface NewCaseInput {
  title: string
  licenseeName?: string
  type: CaseType
  status: CaseStatus
  source: CaseSource
  url?: string
  openedAt: string
  settlementPosition?: string
  markCodes?: string[]
}

export interface CasePatch {
  title?: string
  type?: CaseType
  status?: CaseStatus
  source?: CaseSource
  url?: string | null
  openedAt?: string
  resolvedAt?: string | null
  resolvedBy?: ResolvedBy
  settlementPosition?: string | null
}

export interface NewDeadlineInput {
  kind: DeadlineKind
  title: string
  dueAt: string
  refTable?: string
  refId?: number
}

export interface MsAuthStatus {
  connected: boolean
  username: string | null
  clientId: string
  tenantId: string
  cacheEncrypted: boolean
}

export interface MsDeviceCode {
  userCode: string
  verificationUri: string
  message: string
  expiresInSeconds: number
}

export type MsAuthEvent = { type: 'signedIn'; username: string } | { type: 'error'; message: string }

export interface LocalScanFolderSummary {
  folderPath: string
  folderName: string
  caseType: string
  primaryName: string
  relatedEntity: string | null
  matchedLicenseeName: string | null
  willLinkExistingCase: boolean
  alreadyImported: boolean
  fileCount: number
  evidenceSessions: number
  earliestEvidence: string | null
  latestEvidence: string | null
  flags: string[]
}

export interface LocalScanSummary {
  root: string
  scannedAt: string
  totals: {
    folders: number
    files: number
    matchedExisting: number
    newLicensees: number
    alreadyImported: number
    flagged: number
  }
  folders: LocalScanFolderSummary[]
}

export interface LocalCommitResult {
  casesCreated: number
  casesLinked: number
  licenseesCreated: number
  evidenceAdded: number
  evidenceSkipped: number
  skippedFolders: number
}

export interface SnapshotImportResult {
  groupsSeen: number
  licenseesCreated: number
  licensesCreated: number
  licensesUpdated: number
  unparsedNames: string[]
  activeLicenses: number
}

export interface SnapshotStatus {
  present: boolean
  exportedAt?: string
  total?: number
}

/** The typed surface exposed to the renderer via contextBridge as window.fafo. */
export interface FafoApi {
  listCases(): Promise<CaseRow[]>
  getCase(id: number): Promise<{ case: CaseRow; events: CaseEvent[]; deadlines: Deadline[] } | null>
  createCase(input: NewCaseInput): Promise<CaseRow>
  updateCase(id: number, patch: CasePatch): Promise<CaseRow>
  addEvent(caseId: number, kind: EventKind, body: string, at?: string): Promise<CaseEvent>
  listDeadlines(): Promise<Deadline[]>
  addDeadline(input: NewDeadlineInput): Promise<Deadline>
  satisfyDeadline(id: number, satisfied: boolean): Promise<void>
  dismissDeadline(id: number): Promise<void>
  listMarks(): Promise<Mark[]>
  listLicensees(): Promise<Licensee[]>
  msStatus(): Promise<MsAuthStatus>
  msSignIn(): Promise<MsDeviceCode>
  msSignOut(): Promise<void>
  /** Subscribe to sign-in completion/errors; returns an unsubscribe fn. */
  onMsAuthEvent(cb: (e: MsAuthEvent) => void): () => void
  importSnapshotStatus(): Promise<SnapshotStatus>
  importSignnowSnapshot(): Promise<SnapshotImportResult>
  /** Read-only scan of the local Infringement Cases archive (dry run). */
  importScanLocal(): Promise<LocalScanSummary>
  /** Commits the most recent scan — only callable after importScanLocal. */
  importCommitLocal(): Promise<LocalCommitResult>
}
