import { useEffect, useState } from 'react'
import type {
  CaseImportColumnHelp,
  CaseImportResult,
  CaseImportScan,
  CaseRowAction,
  LocalCommitResult,
  RefreshAllResult,
  LocalScanSummary,
  MetricsImportPlanView,
  MetricsImportResult,
  SheetsCommitResult,
  SheetsScanView,
  SnapshotImportResult,
  SnapshotStatus
} from '../../../shared/types'
import { usDate } from '../../../shared/domain/deadlines'

/**
 * M2 ingest surface. Nothing writes to the database without an explicit
 * click here — the dry run is the review gate.
 */
const money = (cents: number): string => `$${Math.round(cents / 100).toLocaleString()}`

const ACTION_PILL: Record<string, string> = {
  import: 'done',
  'already-imported': 'later',
  'duplicate-of-existing': 'later',
  'no-year': 'soon'
}

const ROW_PILL: Record<CaseRowAction, string> = {
  create: 'done',
  duplicate: 'later',
  error: 'overdue'
}

/**
 * Bulk case intake. Paste is the primary path — copying rows out of Excel or
 * Sheets yields TSV, which the parser handles without a save-as step.
 */
function NewCasesImportCard({
  onChanged
}: {
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [columns, setColumns] = useState<CaseImportColumnHelp[]>([])
  const [showColumns, setShowColumns] = useState(false)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [scan, setScan] = useState<CaseImportScan | null>(null)
  const [result, setResult] = useState<CaseImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.fafo.casesImportColumns().then(setColumns)
  }, [])

  async function pick(): Promise<void> {
    setError(null)
    try {
      const picked = await window.fafo.casesImportPickFile()
      if (!picked) return
      setFileName(picked.name)
      setText(picked.text)
      setScan(null)
      setResult(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function preview(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setScan(await window.fafo.casesImportScan(text))
    } catch (e) {
      setScan(null)
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function commit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setResult(await window.fafo.casesImportCommit())
      setScan(null)
      setText('')
      setFileName(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <h2>New cases — paste a list or choose a CSV</h2>
      <p className="subtitle">
        Paste rows straight out of Excel or Google Sheets (include the header row), or pick a
        .csv/.tsv file. Column names are matched loosely, so &ldquo;Case&rdquo;,
        &ldquo;Infringer&rdquo; and &ldquo;Brand&rdquo; all mean the matter name. Only
        <strong> Matter</strong> is required. Rows matching a case already on file are flagged and
        skipped, and a row carrying a settlement amount records it as received income.{' '}
        <button
          className="subtle"
          style={{ padding: '1px 8px', fontSize: 12 }}
          onClick={() => setShowColumns(!showColumns)}
        >
          {showColumns ? 'Hide columns' : 'Accepted columns'}
        </button>
      </p>

      {showColumns && (
        <table style={{ marginBottom: 12 }}>
          <tbody>
            {columns.map((c) => (
              <tr key={c.field}>
                <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                  {c.field === 'paidOn' ? 'paid on' : c.field}
                  {c.required && <span style={{ color: 'var(--danger)' }}> *</span>}
                </td>
                <td className="deadline-meta">{c.accepts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setScan(null)
          setFileName(null)
        }}
        placeholder={'Matter\tType\tOpened\tStatus\tAmount\nAcme Foods\tExpired License\t2026-03-01\tResolved\t10,000'}
        rows={5}
        style={{
          width: '100%',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          padding: 8,
          border: '1px solid var(--line)',
          borderRadius: 8,
          resize: 'vertical'
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button className="outline" disabled={busy} onClick={() => void pick()}>
          Choose file…
        </button>
        <button className="outline" disabled={busy || !text.trim()} onClick={() => void preview()}>
          {busy && !scan ? 'Reading…' : 'Preview'}
        </button>
        {scan && scan.totals.create > 0 && (
          <button
            className="outline"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
            disabled={busy}
            onClick={() => void commit()}
          >
            Create {scan.totals.create} case{scan.totals.create === 1 ? '' : 's'}
          </button>
        )}
        {fileName && <span className="deadline-meta">{fileName}</span>}
      </div>

      {error && <p style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}

      {result && (
        <p style={{ marginTop: 10 }}>
          <span className="pill done">imported</span> {result.casesCreated} case
          {result.casesCreated === 1 ? '' : 's'} created, {result.paymentsRecorded} payment
          {result.paymentsRecorded === 1 ? '' : 's'} recorded
          {result.notesAdded > 0 && `, ${result.notesAdded} note${result.notesAdded === 1 ? '' : 's'} added`}
          {result.skipped > 0 && `, ${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped`}
          {result.paymentsSkipped > 0 && `, ${result.paymentsSkipped} duplicate payment${result.paymentsSkipped === 1 ? '' : 's'} skipped`}
          .
        </p>
      )}

      {scan && (
        <div style={{ marginTop: 12 }}>
          <p>
            <strong>{scan.totals.rows}</strong> rows · {scan.totals.create} to create ·{' '}
            {scan.totals.duplicate} already on file · {scan.totals.error} unusable
            {scan.totals.recoveredCents > 0 &&
              ` · ${money(scan.totals.recoveredCents)} of income across ${scan.totals.withPayments} payment${scan.totals.withPayments === 1 ? '' : 's'}`}
          </p>
          {scan.unrecognized.length > 0 && (
            <p className="deadline-meta">
              Ignored columns: {scan.unrecognized.join(', ')}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Matter</th>
                <th>Type</th>
                <th>Status</th>
                <th>Opened</th>
                <th>Amount</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {scan.rows.map((r) => (
                <tr key={r.line}>
                  <td>
                    {r.matter || <span className="deadline-meta">(blank, line {r.line})</span>}
                    {r.licensee !== r.matter && (
                      <div className="deadline-meta">licensee: {r.licensee}</div>
                    )}
                  </td>
                  <td className="deadline-meta">{r.type}</td>
                  <td className="deadline-meta">
                    {r.status}
                    {r.resolvedBy && ` · ${r.resolvedBy}`}
                  </td>
                  <td className="deadline-meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {usDate(r.openedAt)}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {r.amountCents !== null ? money(r.amountCents) : '—'}
                  </td>
                  <td>
                    <span className={`pill ${ROW_PILL[r.action]}`}>
                      {r.action === 'duplicate' ? 'already on file' : r.action}
                    </span>
                    {r.matchedCaseTitle && (
                      <div className="deadline-meta">matches “{r.matchedCaseTitle}”</div>
                    )}
                    {r.messages.map((m, i) => (
                      <div key={i} className="deadline-meta">
                        {m}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MetricsImportCard({
  onChanged
}: {
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [plan, setPlan] = useState<MetricsImportPlanView | null>(null)
  const [result, setResult] = useState<MetricsImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The export is the live v1 record, so replacing stale rows is the correct
  // default — but it deletes data, so it stays visible and switchable.
  const [supersede, setSupersede] = useState(true)

  async function choose(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const p = await window.fafo.metricsImportPlan()
      setPlan(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function commit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setResult(await window.fafo.metricsImportCommit(supersede))
      setPlan(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <h2>v1 metrics export — settlement income history</h2>
      <p className="subtitle">
        Imports a <code>fafo.metrics.v2</code> export from the v1 app (Metrics tab → Export for
        v2), JSON or CSV. One row per money event. Only received rows count as income; unreceived
        ones are kept as pending. Payments already here — including the seeded precedents — are
        detected and skipped, so re-importing is safe.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="outline" disabled={busy} onClick={() => void choose()}>
          {busy && !plan ? 'Reading…' : 'Choose export file…'}
        </button>
        {plan && plan.schemaOk && plan.totals.toImport > 0 && (
          <button
            className="outline"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
            disabled={busy}
            onClick={() => void commit()}
          >
            Import {plan.totals.toImport} row{plan.totals.toImport === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {error && <p style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}

      {result && (
        <p style={{ marginTop: 10 }}>
          <span className="pill done">imported</span> {result.imported} money events (
          {result.linkedToCases} linked to cases, {result.legacyRows} as legacy), {result.skipped}{' '}
          skipped
          {result.supersededPayments > 0 &&
            `, ${result.supersededPayments} superseded payment${result.supersededPayments === 1 ? '' : 's'} removed`}
          {result.statusCorrected > 0 &&
            `, ${result.statusCorrected} collection status${result.statusCorrected === 1 ? '' : 'es'} corrected`}
          .
        </p>
      )}

      {plan && (
        <div style={{ marginTop: 12 }}>
          <p className="deadline-meta">
            {plan.file}
            {plan.sourceAppVersion && ` · from ${plan.sourceAppVersion}`}
          </p>
          {!plan.schemaOk && (
            <p style={{ color: 'var(--danger)' }}>
              {plan.verification.messages.join(' ')} Nothing will be imported.
            </p>
          )}
          <p>
            <strong>{plan.totals.rows}</strong> rows · {plan.totals.toImport} to import ·{' '}
            {plan.totals.alreadyImported} already imported · {plan.totals.duplicateOfExisting}{' '}
            duplicates of existing payments
            {plan.totals.withoutYear > 0 && ` · ${plan.totals.withoutYear} with no year`}
            {plan.totals.toImport > 0 && (
              <>
                {' '}
                · adds <strong>{money(plan.totals.realizedIncomeCents)}</strong> realized income
              </>
            )}
          </p>
          {plan.conflicts.length > 0 && (
            <div
              style={{
                background: '#FEF9EC',
                border: '1px solid #F5DFA0',
                borderRadius: 8,
                padding: '10px 12px',
                margin: '10px 0'
              }}
            >
              <strong style={{ fontSize: 13 }}>
                {plan.conflicts.length} case{plan.conflicts.length === 1 ? '' : 's'} already hold
                payments this export replaces
              </strong>
              <p className="subtitle" style={{ margin: '4px 0 8px' }}>
                These were recorded before this export existed. Keeping both would count the same
                money twice.
              </p>
              {plan.conflicts.map((c) => (
                <div key={c.caseId} style={{ fontSize: 12.5, marginBottom: 5 }}>
                  <strong>{c.caseTitle}</strong> — on file{' '}
                  {c.existing
                    .map((e) => `${money(e.amountCents)}${e.date ? ` (${usDate(e.date)})` : ''}`)
                    .join(' + ')}{' '}
                  · export brings{' '}
                  {c.incoming
                    .map((i) => `${money(i.amountCents)}${i.date ? ` (${usDate(i.date)})` : ''}`)
                    .join(' + ')}
                  <div className="deadline-meta">
                    Replace → {money(c.supersedeCents)} · Keep both → {money(c.keepBothCents)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {plan.statusFixes.length > 0 && (
            <div
              style={{
                background: '#FEF9EC',
                border: '1px solid #F5DFA0',
                borderRadius: 8,
                padding: '10px 12px',
                margin: '10px 0'
              }}
            >
              <strong style={{ fontSize: 13 }}>
                {plan.statusFixes.length} payment
                {plan.statusFixes.length === 1 ? '' : 's'} disagree on whether the money was
                collected
              </strong>
              {plan.statusFixes.map((f) => (
                <div key={f.paymentId} style={{ fontSize: 12.5, marginTop: 4 }}>
                  <strong>{f.label}</strong> {money(f.amountCents)}
                  {f.date && ` (${usDate(f.date)})`} — on file as{' '}
                  {f.currentlyReceived ? 'received' : 'not received'}, export says{' '}
                  <strong>{f.exportSaysReceived ? 'received' : 'NOT received'}</strong>
                </div>
              ))}
            </div>
          )}
          {(plan.conflicts.length > 0 || plan.statusFixes.length > 0) && (
            <label
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'flex-start',
                fontSize: 12.5,
                margin: '8px 0'
              }}
            >
              <input
                type="checkbox"
                checked={supersede}
                onChange={(e) => setSupersede(e.target.checked)}
              />
              <span>
                Let this export win — replace the superseded records and correct the
                collected/not-collected flags. Recommended: the export is the live v1 ledger.
                Unchecking keeps what&rsquo;s on file, which double-counts and overstates income.
              </span>
            </label>
          )}
          <p
            className="deadline-meta"
            style={{ color: plan.verification.matches ? 'var(--ok)' : 'var(--warn)' }}
          >
            {plan.verification.matches
              ? `Verified: rows total ${money(plan.verification.recomputedRealizedIncomeCents)}, matching the file's summary${plan.verification.resolverIdentityHolds ? ' and the JP/Trestle/Unassigned split reconciles' : ''}.`
              : plan.verification.messages.join(' ')}
          </p>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Party</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Date</th>
                <th>Credit</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr
                  key={r.key}
                  style={r.action === 'import' ? undefined : { opacity: 0.55 }}
                >
                  <td>
                    <strong>{r.infringer}</strong>
                    {r.matchedCaseTitle && (
                      <div className="deadline-meta">→ {r.matchedCaseTitle}</div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.rowType === 'legacy_entry' ? 'legacy' : 'case payment'}
                    {!r.received && <span className="pill soon" style={{ marginLeft: 4 }}>pending</span>}
                    {r.infringementType && (
                      <div className="deadline-meta">{r.infringementType}</div>
                    )}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.amountCents)}</td>
                  <td style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
                    {r.paymentDate ?? (r.year ? String(r.year) : '—')}
                  </td>
                  <td style={{ fontSize: 12.5 }}>{r.resolvedBy ?? '—'}</td>
                  <td>
                    <span className={`pill ${ACTION_PILL[r.action] ?? 'later'}`}>{r.action}</span>
                    {r.note && <div className="deadline-meta">{r.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function Import({ onChanged }: { onChanged: () => Promise<void> }): React.JSX.Element {
  const [snapStatus, setSnapStatus] = useState<SnapshotStatus | null>(null)
  const [snapResult, setSnapResult] = useState<SnapshotImportResult | null>(null)
  const [snapBusy, setSnapBusy] = useState(false)
  const [scan, setScan] = useState<LocalScanSummary | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [refresh, setRefresh] = useState<RefreshAllResult | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [commit, setCommit] = useState<LocalCommitResult | null>(null)
  const [sheets, setSheets] = useState<SheetsScanView | null>(null)
  const [sheetsBusy, setSheetsBusy] = useState(false)
  const [sheetsCommit, setSheetsCommit] = useState<SheetsCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.fafo.importSnapshotStatus().then(setSnapStatus)
  }, [])

  async function runSnapshotImport(): Promise<void> {
    setSnapBusy(true)
    setError(null)
    try {
      setSnapResult(await window.fafo.importSignnowSnapshot())
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSnapBusy(false)
  }

  async function runRefresh(): Promise<void> {
    setRefreshBusy(true)
    setError(null)
    setRefresh(null)
    try {
      const r = await window.fafo.refreshAllCaseFiles()
      setRefresh(r)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setRefreshBusy(false)
  }

  async function runScan(): Promise<void> {
    setScanBusy(true)
    setError(null)
    setCommit(null)
    try {
      setScan(await window.fafo.importScanLocal())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setScanBusy(false)
  }

  async function runCommit(): Promise<void> {
    setScanBusy(true)
    setError(null)
    try {
      setCommit(await window.fafo.importCommitLocal())
      setScan(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setScanBusy(false)
  }

  async function runSheetsScan(): Promise<void> {
    setSheetsBusy(true)
    setError(null)
    setSheetsCommit(null)
    try {
      setSheets(await window.fafo.importScanSheets())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSheetsBusy(false)
  }

  async function runSheetsCommit(): Promise<void> {
    setSheetsBusy(true)
    setError(null)
    try {
      setSheetsCommit(await window.fafo.importCommitSheets())
      setSheets(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSheetsBusy(false)
  }

  return (
    <div>
      <h1>Import</h1>
      <p className="subtitle">
        One-time historical ingest. Dry run first — nothing is written until you commit.
      </p>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <NewCasesImportCard onChanged={onChanged} />

      <MetricsImportCard onChanged={onChanged} />

      <div className="card">
        <h2>SignNow ledger — licensees &amp; licenses</h2>
        {snapStatus && !snapStatus.present && (
          <p className="subtitle">
            No catalog snapshot found yet (expected at Application Support/FAFO/import/
            signnow-catalog.json). It's generated from the SignNow connector — ask Claude to
            refresh it, or wait for the live API sync.
          </p>
        )}
        {snapStatus?.present && (
          <p className="subtitle">
            Snapshot of {snapStatus.total} agreement groups, exported {snapStatus.exportedAt ? `${usDate(snapStatus.exportedAt)} ${snapStatus.exportedAt.slice(11, 16)}` : ''}.
            Importing builds the licensee ledger — company names, agreement years, signer emails.
            Term dates arrive later via PDF extraction and stay review-flagged until then.
          </p>
        )}
        <button className="outline" disabled={!snapStatus?.present || snapBusy} onClick={() => void runSnapshotImport()}>
          {snapBusy ? 'Importing…' : 'Import SignNow snapshot'}
        </button>
        {snapResult && (
          <p style={{ marginTop: 10 }}>
            <span className="pill done">done</span> {snapResult.groupsSeen} groups →{' '}
            {snapResult.licenseesCreated} new licensees, {snapResult.licensesCreated} licenses created,{' '}
            {snapResult.licensesUpdated} updated, {snapResult.activeLicenses} currently active.
            {snapResult.unparsedNames.length > 0 && (
              <span style={{ color: 'var(--warn)' }}>
                {' '}
                {snapResult.unparsedNames.length} names didn't parse:{' '}
                {snapResult.unparsedNames.slice(0, 5).join(' · ')}
                {snapResult.unparsedNames.length > 5 ? ' …' : ''}
              </span>
            )}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Drive sheets — Infringement Cases + 2025 Infringement</h2>
        <p className="subtitle">
          Statuses, Trestle submission dates, and settlement notes from your tracking sheets attach
          to case timelines. Status conflicts are flagged for review — the sheet never overwrites
          the app.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="outline" disabled={sheetsBusy} onClick={() => void runSheetsScan()}>
            {sheetsBusy && !sheets ? 'Scanning…' : 'Scan sheets (dry run)'}
          </button>
          {sheets && (
            <button
              className="outline"
              style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
              disabled={sheetsBusy}
              onClick={() => void runSheetsCommit()}
            >
              Commit {sheets.totals.rows - sheets.totals.alreadyImported} rows
            </button>
          )}
        </div>
        {sheetsCommit && (
          <p style={{ marginTop: 10 }}>
            <span className="pill done">committed</span> {sheetsCommit.eventsAttached} timeline
            events attached ({sheetsCommit.conflictsAttached} flagged as conflicts),{' '}
            {sheetsCommit.casesCreated} cases created, {sheetsCommit.licenseesCreated} licensees
            created, {sheetsCommit.skipped} already imported.
          </p>
        )}
        {sheets && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Case</th>
                <th>Sheet status</th>
                <th>Dates</th>
                <th>Action</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {sheets.rows.map((r, i) => (
                <tr key={i} style={r.alreadyImported ? { opacity: 0.45 } : undefined}>
                  <td>
                    <strong>{r.caseName}</strong>
                    {r.matchedCaseTitle && r.matchedCaseTitle !== r.caseName && (
                      <div className="deadline-meta">→ {r.matchedCaseTitle}</div>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    {r.status} <span className="deadline-meta">→ {r.mappedStatus}</span>
                  </td>
                  <td style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
                    {r.startDate ? usDate(r.startDate) : '—'}
                    {r.endDate ? ` → ${usDate(r.endDate)}` : ''}
                  </td>
                  <td>
                    {r.alreadyImported ? (
                      <span className="pill later">imported</span>
                    ) : r.action === 'attach' ? (
                      <span className="pill done">attach</span>
                    ) : r.action === 'create' ? (
                      <span className="pill later">new case</span>
                    ) : (
                      <span className="pill overdue">
                        conflict: app says {r.currentCaseStatus}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5 }}>{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Local archive — LEGAL/Infringement Cases</h2>
        <p className="subtitle">
          References the 14 GB evidence tree in place — nothing is copied or moved. Historical
          cases enter as Resolved (review any that are still live); folders matching existing
          licensees link to their current case instead of duplicating.
          <br />
          <strong>Refresh</strong> re-reads every folder already linked to a case and picks up
          whatever has been added since — new screenshots, email threads, a countersigned
          agreement. Safe to run any time; it only ever adds.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="outline"
            style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
            disabled={refreshBusy}
            onClick={() => void runRefresh()}
          >
            {refreshBusy ? 'Reading folders…' : 'Refresh from local folders'}
          </button>
          <button className="outline" disabled={scanBusy} onClick={() => void runScan()}>
            {scanBusy && !scan ? 'Scan for new cases (dry run)' : 'Scan for new cases (dry run)'}
          </button>
          {scan && (
            <button
              className="outline"
              style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
              disabled={scanBusy}
              onClick={() => void runCommit()}
            >
              Commit {scan.totals.folders - scan.totals.alreadyImported} folders
            </button>
          )}
        </div>

        {refresh && (
          <div style={{ marginTop: 10 }}>
            <p>
              <span className="pill done">refreshed</span> {refresh.totals.casesChecked} linked
              folders checked ·{' '}
              <strong>
                {refresh.totals.filesAdded} new file
                {refresh.totals.filesAdded === 1 ? '' : 's'}
              </strong>{' '}
              across {refresh.totals.casesChanged} case
              {refresh.totals.casesChanged === 1 ? '' : 's'}
              {refresh.totals.unlinkedCases > 0 &&
                ` · ${refresh.totals.unlinkedCases} case${refresh.totals.unlinkedCases === 1 ? '' : 's'} have no folder linked`}
              {refresh.totals.unreadableFolders > 0 &&
                ` · ${refresh.totals.unreadableFolders} folder${refresh.totals.unreadableFolders === 1 ? '' : 's'} unreadable`}
              {refresh.totals.missing > 0 &&
                ` · ${refresh.totals.missing} indexed file${refresh.totals.missing === 1 ? '' : 's'} no longer on disk`}
            </p>
            {refresh.cases.length === 0 && (
              <p className="deadline-meta">Everything already indexed — nothing new to pull in.</p>
            )}
            {refresh.cases.map((c) => (
              <div key={c.caseId} className="deadline-row">
                <span className="deadline-title">{c.caseTitle}</span>
                <span className="deadline-meta">
                  {c.filesAdded > 0 &&
                    `+${c.filesAdded} (${Object.entries(c.addedByKind)
                      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
                      .join(', ')})`}
                  {c.missing > 0 && `${c.filesAdded > 0 ? ' · ' : ''}${c.missing} missing`}
                </span>
              </div>
            ))}
          </div>
        )}

        {commit && (
          <p style={{ marginTop: 10 }}>
            <span className="pill done">committed</span> {commit.casesCreated} cases created,{' '}
            {commit.casesLinked} linked to existing matters, {commit.licenseesCreated} licensees
            created, {commit.evidenceAdded} evidence files referenced ({commit.evidenceSkipped}{' '}
            already known, {commit.skippedFolders} folders previously imported).
          </p>
        )}

        {scan && (
          <div style={{ marginTop: 12 }}>
            <p>
              <strong>{scan.totals.folders}</strong> folders · {scan.totals.files} files ·{' '}
              {scan.totals.matchedExisting} match existing licensees · {scan.totals.newLicensees}{' '}
              new · {scan.totals.alreadyImported} already imported ·{' '}
              <span style={{ color: scan.totals.flagged > 0 ? 'var(--warn)' : 'inherit' }}>
                {scan.totals.flagged} flagged
              </span>
            </p>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Folder</th>
                  <th>Type</th>
                  <th>Match</th>
                  <th>Evidence</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {scan.folders.map((f) => (
                  <tr key={f.folderPath} style={f.alreadyImported ? { opacity: 0.45 } : undefined}>
                    <td>
                      <strong>{f.primaryName}</strong>
                      {f.relatedEntity && <span className="deadline-meta"> : {f.relatedEntity}</span>}
                      {f.alreadyImported && <span className="pill later" style={{ marginLeft: 6 }}>imported</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>{f.caseType === 'Expired License' ? 'Expired' : 'Never certified'}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {f.willLinkExistingCase ? (
                        <span className="pill progress">links existing case</span>
                      ) : f.matchedLicenseeName ? (
                        <span className="pill done">licensee match</span>
                      ) : (
                        <span className="pill later">new</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
                      {f.fileCount} files
                      {f.evidenceSessions > 0 && `, ${f.evidenceSessions} sessions`}
                      {f.earliestEvidence && (
                        <div className="deadline-meta">
                          {usDate(f.earliestEvidence)} → {usDate(f.latestEvidence)}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--warn)' }}>{f.flags.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
