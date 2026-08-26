import { useEffect, useState } from 'react'
import type { LicenseView } from '../../../shared/types'
import { usDate } from '../../../shared/domain/deadlines'

const STATUS_PILL: Record<string, string> = {
  active: 'done',
  expiring: 'soon',
  expired: 'overdue',
  terminated: 'overdue',
  renewed: 'later'
}

export function Licensees(): React.JSX.Element {
  const [rows, setRows] = useState<LicenseView[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void window.fafo.listLicenses().then(setRows)
  }, [])

  const shown = filter
    ? rows.filter((r) => r.licenseeName.toLowerCase().includes(filter.toLowerCase()))
    : rows

  return (
    <div>
      <h1>Licenses</h1>
      <p className="subtitle">
        The ledger from SignNow — one row per agreement. Term dates and fees appear as extraction
        runs (Settings → License term extraction); the lifecycle engine turns real end dates into
        watch items and sell-off deadlines automatically.
      </p>
      <div className="add-row" style={{ marginBottom: 10 }}>
        <input
          type="text"
          placeholder="Filter by company…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="deadline-meta" style={{ alignSelf: 'center' }}>
          {shown.length} of {rows.length}
        </span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Licensee</th>
              <th>Marks</th>
              <th>Term</th>
              <th>Fee</th>
              <th>Vintage</th>
              <th>Status</th>
              <th>Conf.</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.licenseeName}</strong>
                  {r.agreementRef && (
                    <div className="deadline-meta">{r.agreementRef.replace('signnow:', '')}</div>
                  )}
                </td>
                <td>
                  {r.markCodes.map((m) => (
                    <span key={m} className="pill mark" style={{ marginRight: 3 }}>
                      {m}
                    </span>
                  ))}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>
                  {r.termStart || r.termEnd ? `${r.termStart ? usDate(r.termStart) : '?'} → ${r.termEnd ? usDate(r.termEnd) : '?'}` : '—'}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>
                  {r.annualFeeCents !== null
                    ? `$${(r.annualFeeCents / 100).toLocaleString()}`
                    : '—'}
                  {r.revenueBand && <span className="deadline-meta"> ({r.revenueBand})</span>}
                </td>
                <td style={{ fontSize: 12.5 }}>{r.vintage}</td>
                <td>
                  <span className={`pill ${STATUS_PILL[r.status] ?? 'later'}`}>{r.status}</span>
                </td>
                <td style={{ fontSize: 12.5 }}>
                  {r.extractionConfidence === null ? (
                    <span className="pill later">pending</span>
                  ) : r.extractionConfidence >= 0.7 ? (
                    `${Math.round(r.extractionConfidence * 100)}%`
                  ) : (
                    <span className="pill overdue">{Math.round(r.extractionConfidence * 100)}% review</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No licenses yet — run the SignNow sync.</div>}
      </div>
    </div>
  )
}
