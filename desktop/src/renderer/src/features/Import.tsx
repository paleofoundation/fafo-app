import { useEffect, useState } from 'react'
import type {
  LocalCommitResult,
  LocalScanSummary,
  MetricsImportPlanView,
  MetricsImportResult,
  SheetsCommitResult,
  SheetsScanView,
  SnapshotImportResult,
  SnapshotStatus
} from '../../../shared/types'

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

function MetricsImportCard({
  onChanged
}: {
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [plan, setPlan] = useState<MetricsImportPlanView | null>(null)
  const [result, setResult] = useState<MetricsImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      setResult(await window.fafo.metricsImportCommit())
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
          skipped.
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
            Snapshot of {snapStatus.total} agreement groups, exported {snapStatus.exportedAt?.slice(0, 16).replace('T', ' ')}.
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
                    {r.startDate ?? '—'}
                    {r.endDate ? ` → ${r.endDate}` : ''}
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
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="outline" disabled={scanBusy} onClick={() => void runScan()}>
            {scanBusy && !scan ? 'Scanning…' : 'Scan (dry run)'}
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
                          {f.earliestEvidence} → {f.latestEvidence}
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
