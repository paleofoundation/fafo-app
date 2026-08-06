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
  duplicatesSkipped: number
}

export interface SnapshotStatus {
  present: boolean
  exportedAt?: string
  total?: number
}

export interface SheetScanRowView {
  sheetTitle: string
  caseName: string
  status: string
  startDate: string | null
  endDate: string | null
  notes: string | null
  mappedStatus: 'Open' | 'In Progress' | 'Resolved'
  matchedCaseTitle: string | null
  currentCaseStatus: string | null
  action: 'attach' | 'create' | 'conflict-review'
  alreadyImported: boolean
}

export interface SheetsScanView {
  rows: SheetScanRowView[]
  totals: { rows: number; attach: number; create: number; conflicts: number; alreadyImported: number }
}

export interface SheetsCommitResult {
  eventsAttached: number
  casesCreated: number
  licenseesCreated: number
  conflictsAttached: number
  skipped: number
}

export interface SignnowStatus {
  keyPresent: boolean
  lastSyncAt: string | null
  lastSyncCursor: string | null
  lastJobStatus: string | null
}

export interface SignnowSyncNowResult {
  identityEmail: string
  apiTotal: number
  licensesCreated: number
  licensesUpdated: number
  activeLicenses: number
}

export interface ExtractionStatus {
  total: number
  extracted: number
  pending: number
  keysPresent: boolean
  lastJobStatus: string | null
}

export interface ExtractionProgressEvent {
  processed: number
  total: number
  current: string
  ok: number
  failed: number
}

export interface ExtractionRunResult {
  processed: number
  ok: number
  failed: number
  errors: string[]
  remaining: number
}

export interface LetterView {
  id: number
  caseId: number
  kind: string
  bodyText: string
  draftedAt: string
  sentAt: string | null
  docUrl: string | null
  responseDueAt: string | null
  responseReceivedAt: string | null
  status: string
}

export interface MailScanResult {
  messagesSeen: number
  matched: number
  clocksStopped: number
}

export interface SettlementQuote {
  formula: 'ld' | 'legacy'
  opening: number
  compromiseLow: number
  compromiseHigh: number
  monthsOfMisuse: number
  annualFee: number
  vintage: AgreementVintage
  selloffEnd: string | null
  notes: string
}

export interface ResolverStat {
  who: string
  totalCents: number
  payments: number
  caseCount: number
}

export interface YearRow {
  year: number
  totalCents: number
  count: number
  byType: Record<string, number>
  byResolver: Record<string, number>
}

export interface MetricsSummary {
  years: YearRow[]
  grandTotalCents: number
  resolvers: ResolverStat[]
  unassignedCents: number
  unassignedCases: number
  attributedCents: number
  openCases: number
  resolvedCases: number
}

/** A payment row attached to a case. Received rows feed the income rollups. */
export interface CasePayment {
  id: number
  amountCents: number
  dueDate: string | null
  receivedDate: string | null
  received: boolean
  /** null = inherits the case's resolution credit rather than overriding it. */
  resolvedBy: 'JP' | 'Trestle' | null
  effectiveResolvedBy: 'JP' | 'Trestle' | null
  infringementType: string | null
  year: number | null
  imported: boolean
}

export interface CasePaymentInput {
  amountCents: number
  received: boolean
  /** The received date when received, the due date when still expected. */
  date: string
  resolvedBy?: 'JP' | 'Trestle' | null
}

export interface DuplicatePaymentMatch {
  paymentId: number
  label: string
  sameCase: boolean
}

/** Agreement facts for a case, from the extracted license record. */
export interface CaseLicenseFacts {
  businessName: string | null
  address: string | null
  termStart: string | null
  termEnd: string | null
  annualFeeCents: number | null
  revenueBand: string | null
  vintage: string | null
  agreementRef: string | null
  extractionConfidence: number | null
  liquidatedDamages: { applies: boolean; basis: string }
  marks: Array<{ code: string; name: string; regNo: string; regStatus: string }>
}

/** A document attached to a case, referenced in place on disk. */
export interface CaseFile {
  id: number
  fileName: string
  path: string | null
  byteSize: number | null
  mtime: string | null
  kind: string
  datedAt: string | null
  source: string
  present: boolean
}

export interface CaseFiles {
  folderPath: string | null
  folderExists: boolean
  files: CaseFile[]
  byKind: Array<{ kind: string; count: number }>
  missing: number
}

export interface FolderRefresh {
  caseId: number
  caseTitle: string
  folderPath: string
  filesSeen: number
  filesAdded: number
  missing: number
  newestFileAt: string | null
  addedByKind: Record<string, number>
  flags: string[]
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

/** Bulk case intake from a pasted spreadsheet or CSV/TSV file. */
export type CaseImportField =
  | 'matter'
  | 'licensee'
  | 'type'
  | 'status'
  | 'opened'
  | 'source'
  | 'url'
  | 'settlement'
  | 'credit'
  | 'resolved'
  | 'amount'
  | 'paidOn'
  | 'notes'

export type CaseRowAction = 'create' | 'duplicate' | 'error'

export interface CaseImportRow {
  line: number
  matter: string
  licensee: string
  type: CaseType
  status: CaseStatus
  source: CaseSource
  openedAt: string
  url: string | null
  settlement: string | null
  resolvedAt: string | null
  resolvedBy: 'JP' | 'Trestle' | null
  amountCents: number | null
  paidOn: string | null
  notes: string | null
  action: CaseRowAction
  matchedCaseTitle: string | null
  messages: string[]
  paymentDuplicate: boolean
}

export interface CaseImportScan {
  recognized: CaseImportField[]
  unrecognized: string[]
  rows: CaseImportRow[]
  totals: {
    rows: number
    create: number
    duplicate: number
    error: number
    withPayments: number
    paymentDuplicates: number
    recoveredCents: number
  }
}

export interface CaseImportResult {
  casesCreated: number
  paymentsRecorded: number
  paymentsSkipped: number
  notesAdded: number
  skipped: number
}

export interface CaseImportColumnHelp {
  field: CaseImportField
  required: boolean
  accepts: string
}

export interface LegacyEntry {
  id: number
  label: string
  type: string
  amountCents: number
  year: number
  receivedDate?: string | null
  resolvedBy?: 'JP' | 'Trestle' | null
}

export interface LegacyEntryInput {
  label: string
  type: string
  amountCents: number
  year: number
  receivedDate?: string | null
  resolvedBy?: 'JP' | 'Trestle' | null
}

export interface SettlementSuggestion {
  caseId: number
  caseTitle: string
  settlementText: string
  suggestedCents: number | null
  reading: 'received' | 'position'
  year: number
}

export interface MetricsPlanRow {
  key: string
  rowType: 'case_payment' | 'legacy_entry'
  infringer: string
  infringementType: string | null
  amountCents: number
  year: number | null
  paymentDate: string | null
  received: boolean
  resolvedBy: 'JP' | 'Trestle' | null
  matchedCaseTitle: string | null
  action: 'import' | 'already-imported' | 'duplicate-of-existing' | 'no-year'
  note: string | null
}

export interface MetricsCaseConflict {
  caseId: number
  caseTitle: string
  existing: Array<{ paymentId: number; amountCents: number; date: string | null }>
  incoming: Array<{ amountCents: number; date: string | null }>
  keepBothCents: number
  supersedeCents: number
}

export interface MetricsImportPlanView {
  file: string
  schemaOk: boolean
  sourceAppVersion: string | null
  exportedAt: string | null
  rows: MetricsPlanRow[]
  conflicts: MetricsCaseConflict[]
  statusFixes: MetricsStatusFix[]
  totals: {
    rows: number
    toImport: number
    alreadyImported: number
    duplicateOfExisting: number
    withoutYear: number
    realizedIncomeCents: number
  }
  verification: {
    fileRealizedIncomeCents: number | null
    recomputedRealizedIncomeCents: number
    matches: boolean
    resolverIdentityHolds: boolean
    messages: string[]
  }
}

export interface MetricsStatusFix {
  paymentId: number
  label: string
  amountCents: number
  date: string | null
  currentlyReceived: boolean
  exportSaysReceived: boolean
  currentResolvedBy: 'JP' | 'Trestle' | null
  exportResolvedBy: 'JP' | 'Trestle' | null
}

export interface MetricsImportResult {
  imported: number
  skipped: number
  linkedToCases: number
  legacyRows: number
  supersededPayments: number
  statusCorrected: number
}

export interface CaseDeletionPreview {
  caseId: number
  title: string
  events: number
  deadlines: number
  letters: number
  payments: number
  paymentsCents: number
  evidenceFiles: number
  trackedUrls: number
  settlements: number
}

export interface ExportResult {
  path: string
  driveUrl: string | null
}

export interface LicenseView {
  id: number
  licenseeName: string
  agreementRef: string | null
  vintage: AgreementVintage
  termStart: string | null
  termEnd: string | null
  annualFeeCents: number | null
  revenueBand: string | null
  status: string
  extractionConfidence: number | null
  markCodes: string[]
}

/** The typed surface exposed to the renderer via contextBridge as window.fafo. */
export interface FafoApi {
  listCases(): Promise<CaseRow[]>
  getCase(id: number): Promise<{ case: CaseRow; events: CaseEvent[]; deadlines: Deadline[] } | null>
  createCase(input: NewCaseInput): Promise<CaseRow>
  updateCase(id: number, patch: CasePatch): Promise<CaseRow>
  addEvent(caseId: number, kind: EventKind, body: string, at?: string): Promise<CaseEvent>
  /** Read-only: what deleting this case would take with it. */
  previewCaseDeletion(id: number): Promise<CaseDeletionPreview>
  deleteCase(id: number): Promise<CaseDeletionPreview>
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
  /** Dry-run of the Drive infringement sheets snapshot. */
  importScanSheets(): Promise<SheetsScanView>
  /** Commits the most recent sheets scan. */
  importCommitSheets(): Promise<SheetsCommitResult>
  signnowStatus(): Promise<SignnowStatus>
  /** Store/replace the SignNow API key (empty string clears it). */
  signnowSetKey(key: string): Promise<SignnowStatus>
  signnowSyncNow(): Promise<SignnowSyncNowResult>
  extractionStatus(): Promise<ExtractionStatus>
  /** Runs one extraction batch (chunked); progress arrives via onExtractionProgress. */
  extractionRun(limit?: number): Promise<ExtractionRunResult>
  onExtractionProgress(cb: (p: ExtractionProgressEvent) => void): () => void
  listLicenses(): Promise<LicenseView[]>
  listLetters(caseId: number): Promise<LetterView[]>
  generateLetter(caseId: number, kind: 'enforcement' | 'referral_summary'): Promise<LetterView>
  markLetterSent(letterId: number): Promise<LetterView>
  exportLetterToDrive(letterId: number): Promise<LetterView>
  scanMailNow(): Promise<MailScanResult>
  quoteSettlement(caseId: number, observedUseThrough?: string): Promise<SettlementQuote>
  /** Opens a file picker; returns null if cancelled. Read-only dry run. */
  metricsImportPlan(): Promise<MetricsImportPlanView | null>
  metricsImportCommit(supersedeConflicts: boolean): Promise<MetricsImportResult>
  metricsSummary(): Promise<MetricsSummary>
  listCasePayments(caseId: number): Promise<CasePayment[]>
  addCasePayment(caseId: number, input: CasePaymentInput): Promise<CasePayment>
  updateCasePayment(id: number, input: CasePaymentInput): Promise<CasePayment>
  markPaymentReceived(id: number, receivedDate: string): Promise<void>
  removeCasePayment(id: number): Promise<void>
  findDuplicatePayment(
    caseId: number,
    amountCents: number,
    date: string
  ): Promise<DuplicatePaymentMatch | null>
  caseLicenseFacts(caseId: number): Promise<CaseLicenseFacts | null>
  listCaseFiles(caseId: number): Promise<CaseFiles>
  refreshCaseFiles(caseId: number): Promise<FolderRefresh>
  refreshAllCaseFiles(): Promise<RefreshAllResult>
  pickCaseFolder(caseId: number): Promise<string | null>
  revealFile(evidenceId: number): Promise<void>
  openFile(evidenceId: number): Promise<void>
  casesImportColumns(): Promise<CaseImportColumnHelp[]>
  casesImportPickFile(): Promise<{ name: string; text: string } | null>
  casesImportScan(text: string): Promise<CaseImportScan>
  casesImportCommit(): Promise<CaseImportResult>
  listLegacyPayments(): Promise<LegacyEntry[]>
  addLegacyPayment(input: LegacyEntryInput): Promise<LegacyEntry>
  removeLegacyPayment(id: number): Promise<void>
  unrecordedSettlements(): Promise<SettlementSuggestion[]>
  confirmSettlementPayment(
    caseId: number,
    amountCents: number,
    receivedDate: string,
    resolvedBy: 'JP' | 'Trestle' | null
  ): Promise<void>
  exportPolicingRecord(markCode: string, toDrive: boolean): Promise<ExportResult>
  exportBrandFeed(): Promise<ExportResult>
}
