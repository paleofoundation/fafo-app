import { useEffect, useState } from 'react'
import type { ExportResult, Mark } from '../../../shared/types'

export function Marks(): React.JSX.Element {
  const [rows, setRows] = useState<Mark[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [exported, setExported] = useState<Record<string, ExportResult>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.fafo.listMarks().then(setRows)
  }, [])

  async function exportRecord(code: string, toDrive: boolean): Promise<void> {
    setBusy(code)
    setError(null)
    try {
      const r = await window.fafo.exportPolicingRecord(code, toDrive)
      setExported((prev) => ({ ...prev, [code]: r }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(null)
  }

  return (
    <div>
      <h1>Certification Marks</h1>
      <p className="subtitle">
        Registered portfolio — Paleo Certified, Inc. Legal caveats surface here so letters never
        overstate. Export a mark&rsquo;s policing record to evidence enforcement for validity and
        anti-abandonment purposes.
      </p>
      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Mark</th>
              <th>Program</th>
              <th>USPTO No.</th>
              <th>Status</th>
              <th>Policing record</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="pill mark">{m.code}</span>
                </td>
                <td>
                  {m.name}
                  {m.notes && <div style={{ color: 'var(--warn)', fontSize: 12, marginTop: 3 }}>⚠ {m.notes}</div>}
                </td>
                <td>{m.program}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{m.usptoRegNo}</td>
                <td>
                  <span className={`pill ${m.regStatus === 'Registered' ? 'done' : 'soon'}`}>{m.regStatus}</span>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button
                    className="subtle"
                    disabled={busy !== null}
                    onClick={() => void exportRecord(m.code, false)}
                  >
                    {busy === m.code ? 'Exporting…' : 'Export'}
                  </button>{' '}
                  <button
                    className="subtle"
                    disabled={busy !== null}
                    onClick={() => void exportRecord(m.code, true)}
                  >
                    + Drive
                  </button>
                  {exported[m.code] && (
                    <div className="deadline-meta" style={{ marginTop: 3 }}>
                      {exported[m.code]!.driveUrl ? (
                        <a href={exported[m.code]!.driveUrl!} target="_blank" rel="noreferrer">
                          Open in Drive
                        </a>
                      ) : (
                        'saved locally'
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
