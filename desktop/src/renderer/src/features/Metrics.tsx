import { useCallback, useEffect, useState } from 'react'
import type {
  ExportResult,
  LegacyEntry,
  MetricsSummary,
  SettlementSuggestion
} from '../../../shared/types'
import { CASE_TYPES } from '../../../shared/types'

const money = (cents: number): string => `$${Math.round(cents / 100).toLocaleString()}`
const RESOLVER_COLORS: Record<string, { bg: string; border: string; fg: string; chip: string }> = {
  JP: { bg: '#EBF2FB', border: '#A8C8F0', fg: '#1255A8', chip: '#1A6FD4' },
  Trestle: { bg: '#EAF3DE', border: '#97C459', fg: '#27500A', chip: '#3B6D11' }
}

export function Metrics(): React.JSX.Element {
  const [m, setM] = useState<MetricsSummary | null>(null)
  const [legacy, setLegacy] = useState<LegacyEntry[]>([])
  const [suggestions, setSuggestions] = useState<SettlementSuggestion[]>([])
  const [feed, setFeed] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(async () => {
    const [summary, legacyRows, sugg] = await Promise.all([
      window.fafo.metricsSummary(),
      window.fafo.listLegacyPayments(),
      window.fafo.unrecordedSettlements()
    ])
    setM(summary)
    setLegacy(legacyRows)
    setSuggestions(sugg)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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
  const totalPayments = m.years.reduce((s, y) => s + y.count, 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1>Metrics</h1>
          <p className="subtitle">
            Settlement income by year and type — received payments from cases plus legacy entries.
          </p>
        </div>
        <button className="outline" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Cancel' : '+ Add legacy data'}
        </button>
      </div>

      {showAdd && (
        <LegacyForm
          onAdded={async () => {
            setShowAdd(false)
            await load()
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {(
          [
            ['Total received', money(m.grandTotalCents)],
            ['Years tracked', String(m.years.length)],
            ['Payments', String(totalPayments)],
            ['Open cases', String(m.openCases)]
          ] as const
        ).map(([label, val]) => (
          <div
            key={label}
            style={{
              flex: 1,
              minWidth: 110,
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '10px 14px'
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}
            >
              {label}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{val}</div>
          </div>
        ))}
      </div>

      {suggestions.length > 0 && <SuggestionsCard suggestions={suggestions} onChanged={load} />}

      <div className="card">
        <h2>Resolved by</h2>
        <p className="subtitle">Settlement income split by who carried the case.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {m.resolvers.map((r) => {
            const c = RESOLVER_COLORS[r.who]!
            const pct =
              m.attributedCents > 0 ? Math.round((r.totalCents / m.attributedCents) * 100) : 0
            return (
              <div
                key={r.who}
                style={{
                  flex: 1,
                  minWidth: 170,
                  borderRadius: 10,
                  padding: '12px 14px',
                  background: c.bg,
                  border: `1px solid ${c.border}`
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 5,
                      letterSpacing: '0.03em',
                      background: c.chip,
                      color: '#fff'
                    }}
                  >
                    {r.who.toUpperCase()}
                  </span>
                  {m.attributedCents > 0 && (
                    <span style={{ fontSize: 11, color: c.fg }}>{pct}% of attributed</span>
                  )}
                </div>
                <div style={{ fontSize: 20, fontWeight: 600, color: c.fg }}>
                  {money(r.totalCents)}
                </div>
                <div style={{ fontSize: 11, color: c.fg, marginTop: 2 }}>
                  {r.caseCount} case{r.caseCount === 1 ? '' : 's'} resolved · {r.payments} payment
                  {r.payments === 1 ? '' : 's'}
                </div>
              </div>
            )
          })}
        </div>
        {m.unassignedCents > 0 && (
          <div
            style={{
              fontSize: 11.5,
              color: '#92711A',
              background: '#FEF9EC',
              border: '1px solid #F5DFA0',
              borderRadius: 8,
              padding: '8px 10px',
              marginTop: 8,
              lineHeight: 1.5
            }}
          >
            {money(m.unassignedCents)}
            {m.unassignedCases > 0 &&
              ` across ${m.unassignedCases} resolved case${m.unassignedCases === 1 ? '' : 's'}`}{' '}
            has no “Resolution credit” set, so it isn’t counted in either column above. Set it on the
            case (or on a legacy entry) to include it.
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>Total</th>
              {types.map((t) => (
                <th key={t}>{t}</th>
              ))}
              <th style={{ borderLeft: '1px solid var(--line)', color: '#1255A8' }}>JP</th>
              <th style={{ color: '#27500A' }}>Trestle</th>
              <th style={{ color: '#92711A' }}>Unassg.</th>
              <th>Ct.</th>
            </tr>
          </thead>
          <tbody>
            {m.years.map((y) => (
              <tr key={y.year}>
                <td>
                  <strong>{y.year}</strong>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(y.totalCents)}</td>
                {types.map((t) => (
                  <td key={t} style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>
                    {y.byType[t] ? money(y.byType[t]!) : '—'}
                  </td>
                ))}
                <td
                  style={{
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 12.5,
                    borderLeft: '1px solid var(--line)',
                    color: '#1255A8'
                  }}
                >
                  {y.byResolver['JP'] ? money(y.byResolver['JP']!) : '—'}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: '#27500A' }}>
                  {y.byResolver['Trestle'] ? money(y.byResolver['Trestle']!) : '—'}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: '#92711A' }}>
                  {y.byResolver['Unassigned'] ? money(y.byResolver['Unassigned']!) : '—'}
                </td>
                <td style={{ fontSize: 12.5 }}>{y.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {m.years.length === 0 && (
          <div className="empty">
            No payment data yet. Mark payments received on a case, or add legacy entries above.
          </div>
        )}
      </div>

      {legacy.length > 0 && (
        <div className="card">
          <h2>Legacy entries</h2>
          {legacy.map((l) => (
            <div key={l.id} className="deadline-row">
              <span className="deadline-date">{l.year}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 80 }}>
                {money(l.amountCents)}
              </span>
              <span className="deadline-title">{l.label || '(no label)'}</span>
              {l.resolvedBy && <span className="pill later">{l.resolvedBy}</span>}
              <button
                className="subtle"
                onClick={async () => {
                  await window.fafo.removeLegacyPayment(l.id)
                  await load()
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Brand feed for paleofoundation.com</h2>
        <p className="subtitle">
          Certified-brand status as JSON (schema <code>fafo.brand-feed/v1</code>) — brand, status,
          marks, certified-through date.
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

function SuggestionsCard({
  suggestions,
  onChanged
}: {
  suggestions: SettlementSuggestion[]
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [edits, setEdits] = useState<Record<number, { amount: string; date: string; who: string }>>(
    {}
  )
  const today = new Date().toISOString().slice(0, 10)
  const received = suggestions.filter((s) => s.reading === 'received').length

  async function confirm(s: SettlementSuggestion): Promise<void> {
    const e = edits[s.caseId]
    const dollars = e?.amount ? parseFloat(e.amount) : (s.suggestedCents ?? 0) / 100
    if (!dollars) return
    const who = e?.who === 'JP' || e?.who === 'Trestle' ? e.who : null
    await window.fafo.confirmSettlementPayment(
      s.caseId,
      Math.round(dollars * 100),
      e?.date || `${s.year}-01-01`,
      who
    )
    await onChanged()
  }

  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h2>Settlement amounts not counted yet</h2>
      <p className="subtitle">
        These cases record a settlement figure in their notes but have no payment on file, so the
        totals above exclude them. {received} read as money actually received; the rest look like
        demands or offers. Nothing counts until you confirm it — check the amount and date, then
        Confirm.
      </p>
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Recorded note</th>
            <th>Reading</th>
            <th>Amount $</th>
            <th>Received</th>
            <th>Credit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {suggestions.map((s) => {
            const e = edits[s.caseId] ?? {
              amount: String((s.suggestedCents ?? 0) / 100),
              date: `${s.year}-01-01`,
              who: ''
            }
            const set = (patch: Partial<typeof e>): void =>
              setEdits((prev) => ({ ...prev, [s.caseId]: { ...e, ...patch } }))
            return (
              <tr key={s.caseId}>
                <td>
                  <strong>{s.caseTitle}</strong>
                </td>
                <td style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 240 }}>
                  {s.settlementText}
                </td>
                <td>
                  <span className={`pill ${s.reading === 'received' ? 'done' : 'soon'}`}>
                    {s.reading === 'received' ? 'paid' : 'position'}
                  </span>
                </td>
                <td>
                  <input
                    className="inline"
                    style={{ width: 90 }}
                    value={e.amount}
                    onChange={(ev) => set({ amount: ev.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="inline"
                    type="date"
                    style={{ width: 135 }}
                    value={e.date}
                    max={today}
                    onChange={(ev) => set({ date: ev.target.value })}
                  />
                </td>
                <td>
                  <select
                    className="inline"
                    style={{ width: 100 }}
                    value={e.who}
                    onChange={(ev) => set({ who: ev.target.value })}
                  >
                    <option value="">—</option>
                    <option value="JP">JP</option>
                    <option value="Trestle">Trestle</option>
                  </select>
                </td>
                <td>
                  <button className="subtle" onClick={() => void confirm(s)}>
                    Confirm
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LegacyForm({ onAdded }: { onAdded: () => Promise<void> }): React.JSX.Element {
  const [f, setF] = useState({
    label: '',
    type: CASE_TYPES[0] as string,
    amount: '',
    year: '',
    date: '',
    who: ''
  })

  async function submit(): Promise<void> {
    const dollars = parseFloat(f.amount)
    const year = parseInt(f.year, 10)
    if (!dollars || !year) return
    await window.fafo.addLegacyPayment({
      label: f.label.trim(),
      type: f.type,
      amountCents: Math.round(dollars * 100),
      year,
      receivedDate: f.date || null,
      resolvedBy: f.who === 'JP' || f.who === 'Trestle' ? f.who : null
    })
    setF({ label: '', type: CASE_TYPES[0] as string, amount: '', year: '', date: '', who: '' })
    await onAdded()
  }

  return (
    <div className="card">
      <h2>Add legacy settlement entry</h2>
      <p className="subtitle">
        Historical income that predates the case file — counted in the totals but not tied to a case.
      </p>
      <div className="add-row">
        <input
          type="text"
          placeholder="Party / description"
          value={f.label}
          onChange={(e) => setF({ ...f, label: e.target.value })}
        />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {CASE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input
          type="number"
          placeholder="Amount $"
          style={{ width: 110 }}
          value={f.amount}
          onChange={(e) => setF({ ...f, amount: e.target.value })}
        />
        <input
          type="number"
          placeholder="Year"
          style={{ width: 85 }}
          value={f.year}
          onChange={(e) => setF({ ...f, year: e.target.value })}
        />
        <select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}>
          <option value="">Credit —</option>
          <option value="JP">JP</option>
          <option value="Trestle">Trestle</option>
        </select>
        <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <button className="outline" disabled={!f.amount || !f.year} onClick={() => void submit()}>
          Add entry
        </button>
      </div>
    </div>
  )
}
