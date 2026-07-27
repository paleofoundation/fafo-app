import { useEffect, useState } from 'react'
import type {
  LocalCommitResult,
  LocalScanSummary,
  SnapshotImportResult,
  SnapshotStatus
} from '../../../shared/types'

/**
 * M2 ingest surface. Nothing writes to the database without an explicit
 * click here — the dry run is the review gate.
 */
export function Import({ onChanged }: { onChanged: () => Promise<void> }): React.JSX.Element {
  const [snapStatus, setSnapStatus] = useState<SnapshotStatus | null>(null)
  const [snapResult, setSnapResult] = useState<SnapshotImportResult | null>(null)
  const [snapBusy, setSnapBusy] = useState(false)
  const [scan, setScan] = useState<LocalScanSummary | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [commit, setCommit] = useState<LocalCommitResult | null>(null)
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
