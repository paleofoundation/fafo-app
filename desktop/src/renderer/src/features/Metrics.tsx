import { useEffect, useState } from 'react'
import type { ExportResult, MetricsSummary } from '../../../shared/types'

const money = (cents: number): string => `$${(cents / 100).toLocaleString()}`

export function Metrics(): React.JSX.Element {
  const [m, setM] = useState<MetricsSummary | null>(null)
  const [feed, setFeed] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.fafo.metricsSummary().then(setM)
  }, [])

  async function exportFeed(): Promise<void> {
    setError(null)
    try {
      setFeed(await window.fafo.exportBrandFeed())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!m) return <div className="empty">Loading…</div>

  const types = [...new Set(m.years.flatMap((y) => Object.keys(y.byType)))].sort()

  return (
    <div>
      <h1>Metrics</h1>
      <p className="subtitle">
        Settlement income by year and infringement type, and who carried each matter. Unassigned is
        shown separately so the attributed totals never quietly misstate the whole.
      </p>

      <div className="card">
        <h2>Totals</h2>
        <p style={{ fontSize: 20, margin: '0 0 6px' }}>
          <strong>{money(m.grandTotalCents)}</strong> recovered across {m.years.length} year
          {m.years.length === 1 ? '' : 's'}
        </p>
        <p className="deadline-meta">
          {m.openCases} open · {m.resolvedCases} resolved
        </p>
      </div>

      <div className="card">
        <h2>Resolution credit</h2>
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Recovered</th>
              <th>Payments</th>
              <th>Resolved cases</th>
            </tr>
          </thead>
          <tbody>
            {m.resolvers.map((r) => (
              <tr key={r.who}>
                <td>
                  <strong>{r.who}</strong>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.totalCents)}</td>
                <td>{r.payments}</td>
                <td>{r.caseCount}</td>
              </tr>
            ))}
            <tr>
              <td>
                <span className="pill later">Unassigned</span>
              </td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(m.unassignedCents)}</td>
              <td>—</td>
              <td>{m.unassignedCases}</td>
            </tr>
          </tbody>
        </table>
        {m.unassignedCents > 0 && (
          <p className="subtitle" style={{ marginTop: 8, marginBottom: 0 }}>
            {money(m.attributedCents)} attributed + {money(m.unassignedCents)} unassigned ={' '}
            {money(m.grandTotalCents)}. Set “Resolution credit” on a case to move it out of
            Unassigned.
          </p>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>Total</th>
              <th>Payments</th>
              {types.map((t) => (
                <th key={t}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.years.map((y) => (
              <tr key={y.year}>
                <td>
                  <strong>{y.year}</strong>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(y.totalCents)}</td>
                <td>{y.count}</td>
                {types.map((t) => (
                  <td key={t} style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>
                    {y.byType[t] ? money(y.byType[t]!) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {m.years.length === 0 && (
          <div className="empty">No received payments recorded yet.</div>
        )}
      </div>

      <div className="card">
        <h2>Brand feed for paleofoundation.com</h2>
        <p className="subtitle">
          Certified-brand status as JSON (schema <code>fafo.brand-feed/v1</code>) — brand, status,
          marks, certified-through date. Wire it into the site repo when access is available.
        </p>
        <button className="outline" onClick={() => void exportFeed()}>
          Export brand feed
        </button>
        {feed && (
          <p style={{ marginTop: 10, fontSize: 12.5 }}>
            <span className="pill done">exported</span> {feed.path}
          </p>
        )}
        {error && <p style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  )
}
