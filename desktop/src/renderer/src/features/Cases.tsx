import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CaseDeletionPreview,
  CaseEvent,
  CaseRow,
  CaseStatus,
  Deadline,
  DeadlineKind,
  LetterView,
  NewCaseInput,
  SettlementQuote
} from '../../../shared/types'
import { CASE_SOURCES, CASE_TYPES } from '../../../shared/types'

const STATUS_PILL: Record<CaseStatus, string> = {
  Open: 'open',
  'In Progress': 'progress',
  Resolved: 'resolved'
}

/** Workflow order, not alphabetical — live matters sort above closed ones. */
const STATUS_ORDER: Record<CaseStatus, number> = {
  Open: 0,
  'In Progress': 1,
  Resolved: 2
}

type SortKey = 'title' | 'type' | 'status' | 'openedAt'
type SortDir = 'asc' | 'desc'

const COLUMNS: Array<{ key: SortKey; label: string; defaultWidth: number }> = [
  { key: 'title', label: 'Matter', defaultWidth: 260 },
  { key: 'type', label: 'Type', defaultWidth: 150 },
  { key: 'status', label: 'Status', defaultWidth: 110 },
  { key: 'openedAt', label: 'Opened', defaultWidth: 105 }
]

const WIDTHS_KEY = 'fafo.cases.columnWidths'
const SORT_KEY = 'fafo.cases.sort'
const MIN_WIDTH = 70

function loadWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function loadSort(): { key: SortKey; dir: SortDir } {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (raw) return JSON.parse(raw) as { key: SortKey; dir: SortDir }
  } catch {
    /* fall through to the default */
  }
  return { key: 'openedAt', dir: 'desc' }
}

function compareCases(a: CaseRow, b: CaseRow, key: SortKey): number {
  switch (key) {
    case 'status':
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    case 'openedAt':
      return a.openedAt.localeCompare(b.openedAt)
    case 'type':
      return a.type.localeCompare(b.type)
    case 'title':
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  }
}

export function Cases({
  onDeadlinesChanged
}: {
  onDeadlinesChanged: () => Promise<void>
}): React.JSX.Element {
  const [cases, setCases] = useState<CaseRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [sort, setSort] = useState(loadSort)
  const [widths, setWidths] = useState<Record<string, number>>(loadWidths)
  const [filter, setFilter] = useState('')
  const tableRef = useRef<HTMLTableElement>(null)
  const [panelWidth, setPanelWidth] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setCases(await window.fafo.listCases())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort))
  }, [sort])

  function widthOf(key: string): number {
    return widths[key] ?? COLUMNS.find((c) => c.key === key)!.defaultWidth
  }

  // The list sits in a grid track, so widening a column would otherwise just
  // scroll inside a fixed-width panel. Measure what the table actually needs
  // and size the track to it, so the panel grows as columns are dragged.
  useLayoutEffect(() => {
    const el = tableRef.current
    if (el) setPanelWidth(Math.ceil(el.scrollWidth))
  }, [widths, filter, cases.length])

  function toggleSort(key: SortKey): void {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : // Dates start newest-first; text starts A–Z.
          { key, dir: key === 'openedAt' ? 'desc' : 'asc' }
    )
  }

  /** Drag a header edge to resize; persisted so it survives restarts. */
  function startResize(key: string, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = widthOf(key)
    const onMove = (ev: MouseEvent): void => {
      const next = Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX))
      setWidths((w) => ({ ...w, [key]: next }))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setWidths((w) => {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(w))
        return w
      })
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function resetLayout(): void {
    setWidths({})
    localStorage.removeItem(WIDTHS_KEY)
  }

  const visible = cases
    .filter((c) =>
      filter
        ? `${c.title} ${c.licenseeName ?? ''} ${c.type}`.toLowerCase().includes(filter.toLowerCase())
        : true
    )
    .slice()
    .sort((a, b) => {
      const cmp = compareCases(a, b, sort.key)
      // Stable, predictable tiebreak so equal keys don't shuffle between renders.
      return (sort.dir === 'asc' ? cmp : -cmp) || a.title.localeCompare(b.title)
    })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1>Cases</h1>
          <p className="subtitle">Enforcement matters — watch items escalate here when use is confirmed.</p>
        </div>
        <button className="outline" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Cancel' : 'New case'}
        </button>
      </div>

      {showNew && (
        <NewCaseForm
          onCreated={async (c) => {
            setShowNew(false)
            await refresh()
            setSelectedId(c.id)
          }}
        />
      )}

      <div className="add-row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Filter cases…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label
          className="deadline-meta"
          style={{ alignSelf: 'center', display: 'flex', gap: 6, alignItems: 'center' }}
        >
          Sort by
          <select
            value={sort.key}
            onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as SortKey }))}
          >
            {COLUMNS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key === 'title' ? 'Name' : c.key === 'openedAt' ? 'Date opened' : c.label}
              </option>
            ))}
          </select>
        </label>
        <select
          value={sort.dir}
          onChange={(e) => setSort((s) => ({ ...s, dir: e.target.value as SortDir }))}
          title="Sort direction"
        >
          <option value="asc">
            {sort.key === 'openedAt'
              ? 'Oldest first'
              : sort.key === 'status'
                ? 'Open first'
                : 'A → Z'}
          </option>
          <option value="desc">
            {sort.key === 'openedAt'
              ? 'Newest first'
              : sort.key === 'status'
                ? 'Resolved first'
                : 'Z → A'}
          </option>
        </select>
        <span className="deadline-meta" style={{ alignSelf: 'center' }}>
          {visible.length} of {cases.length}
        </span>
        <button className="subtle" onClick={resetLayout} title="Reset column widths">
          Reset columns
        </button>
      </div>

      <div
        className="split"
        style={
          panelWidth
            ? {
                // With no case selected there is no detail pane, so don't
                // reserve a track for it — that would strand empty space and
                // force a scrollbar the moment a column is widened.
                gridTemplateColumns:
                  selectedId === null ? `${panelWidth}px` : `${panelWidth}px minmax(340px, 1fr)`,
                overflowX: 'auto'
              }
            : undefined
        }
      >
        <div className="card" style={{ padding: 0 }}>
          <table ref={tableRef} style={{ tableLayout: 'fixed', width: 'max-content' }}>
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    style={{ width: widthOf(col.key), position: 'relative', userSelect: 'none' }}
                  >
                    <span
                      onClick={() => toggleSort(col.key)}
                      style={{ cursor: 'pointer', display: 'inline-flex', gap: 4 }}
                      title={`Sort by ${col.label.toLowerCase()}`}
                    >
                      {col.label}
                      <span style={{ opacity: sort.key === col.key ? 1 : 0.25 }}>
                        {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : '▲'}
                      </span>
                    </span>
                    <span
                      onMouseDown={(e) => startResize(col.key, e)}
                      title="Drag to resize"
                      style={{
                        position: 'absolute',
                        top: 0,
                        right: -3,
                        width: 7,
                        height: '100%',
                        cursor: 'col-resize'
                      }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr
                  key={c.id}
                  className="clickable"
                  onClick={() => setSelectedId(c.id)}
                  style={selectedId === c.id ? { outline: '2px solid var(--navy)', outlineOffset: -2 } : undefined}
                >
                  <td style={{ overflow: 'hidden' }}>
                    <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{c.title}</strong>
                    {c.markCodes && c.markCodes.length > 0 && (
                      <div style={{ marginTop: 3, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {c.markCodes.map((m) => (
                          <span key={m} className="pill mark">
                            {m}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5, overflow: 'hidden', overflowWrap: 'anywhere' }}>
                    {c.type}
                  </td>
                  <td style={{ overflow: 'hidden' }}>
                    <span className={`pill ${STATUS_PILL[c.status]}`}>{c.status}</span>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', overflow: 'hidden' }}>
                    {c.openedAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cases.length === 0 && <div className="empty">No cases yet.</div>}
          {cases.length > 0 && visible.length === 0 && (
            <div className="empty">No cases match “{filter}”.</div>
          )}
        </div>

        {selectedId !== null && (
          <CaseDetail
            id={selectedId}
            onChanged={async () => {
              await refresh()
              await onDeadlinesChanged()
            }}
            onDeleted={async () => {
              setSelectedId(null)
              await refresh()
              await onDeadlinesChanged()
            }}
          />
        )}
      </div>
    </div>
  )
}

/** Inline-editable field — saves on blur, no separate edit mode (v1 design language). */
function InlineField({
  label,
  value,
  onSave,
  options
}: {
  label: string
  value: string
  onSave: (v: string) => Promise<void>
  options?: readonly string[]
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = async (): Promise<void> => {
    if (draft !== value) await onSave(draft)
  }

  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {options ? (
        <select
          className="inline"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            void onSave(e.target.value)
          }}
        >
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input className="inline" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()} />
      )}
    </div>
  )
}

function CaseDetail({
  id,
  onChanged,
  onDeleted
}: {
  id: number
  onChanged: () => Promise<void>
  onDeleted: () => Promise<void>
}): React.JSX.Element {
  const [data, setData] = useState<{ case: CaseRow; events: CaseEvent[]; deadlines: Deadline[] } | null>(null)
  const [note, setNote] = useState('')
  const [dl, setDl] = useState<{ title: string; dueAt: string; kind: DeadlineKind }>({
    title: '',
    dueAt: '',
    kind: 'custom'
  })

  const load = useCallback(async () => {
    setData(await window.fafo.getCase(id))
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (!data) return <div className="card empty">Loading…</div>
  const c = data.case

  const patch = async (p: Parameters<typeof window.fafo.updateCase>[1]): Promise<void> => {
    await window.fafo.updateCase(id, p)
    await load()
    await onChanged()
  }

  async function addNote(): Promise<void> {
    if (!note.trim()) return
    await window.fafo.addEvent(id, 'note', note.trim())
    setNote('')
    await load()
  }

  async function addDeadline(): Promise<void> {
    if (!dl.title.trim() || !dl.dueAt) return
    await window.fafo.addDeadline({ kind: dl.kind, title: dl.title.trim(), dueAt: dl.dueAt, refTable: 'cases', refId: id })
    setDl({ title: '', dueAt: '', kind: 'custom' })
    await load()
    await onChanged()
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>{c.title}</strong>
          <span className={`pill ${STATUS_PILL[c.status]}`}>{c.status}</span>
        </div>
        <InlineField label="Status" value={c.status} options={['Open', 'In Progress', 'Resolved']} onSave={(v) => patch({ status: v as CaseStatus })} />
        <InlineField label="Type" value={c.type} options={CASE_TYPES} onSave={(v) => patch({ type: v as CaseRow['type'] })} />
        <InlineField label="Source" value={c.source} options={CASE_SOURCES} onSave={(v) => patch({ source: v as CaseRow['source'] })} />
        <InlineField label="URL" value={c.url ?? ''} onSave={(v) => patch({ url: v || null })} />
        <InlineField label="Opened" value={c.openedAt} onSave={(v) => patch({ openedAt: v })} />
        <InlineField label="Settlement position" value={c.settlementPosition ?? ''} onSave={(v) => patch({ settlementPosition: v || null })} />
        <InlineField
          label="Resolution credit"
          value={c.resolvedBy ?? 'Unassigned'}
          options={['Unassigned', 'JP', 'Trestle']}
          onSave={(v) => patch({ resolvedBy: v === 'Unassigned' ? null : (v as 'JP' | 'Trestle') })}
        />
        <DeleteCase caseId={id} title={c.title} onDeleted={onDeleted} />
      </div>

      <div className="card">
        <h2>Deadlines</h2>
        {data.deadlines.length === 0 && <div className="empty">No deadlines attached to this case.</div>}
        {data.deadlines.map((d) => (
          <div key={d.id} className="deadline-row">
            <span className="deadline-date">{d.dueAt}</span>
            <span className="deadline-title">{d.title}</span>
            {d.satisfiedAt && <span className="pill done">done</span>}
          </div>
        ))}
        <div className="add-row">
          <input type="text" placeholder="New deadline…" value={dl.title} onChange={(e) => setDl({ ...dl, title: e.target.value })} />
          <input type="date" value={dl.dueAt} onChange={(e) => setDl({ ...dl, dueAt: e.target.value })} />
          <select value={dl.kind} onChange={(e) => setDl({ ...dl, kind: e.target.value as DeadlineKind })}>
            <option value="custom">custom</option>
            <option value="selloff_end">sell-off end</option>
            <option value="letter_response">letter response</option>
            <option value="patrol_spot_check">spot check</option>
            <option value="review">review</option>
          </select>
          <button className="outline" onClick={() => void addDeadline()}>
            Add
          </button>
        </div>
      </div>

      <SettlementCard caseId={id} />

      <LettersCard caseId={id} onChanged={onChanged} />

      <div className="card">
        <h2>Timeline</h2>
        {data.events.map((e) => (
          <div key={e.id} className="timeline-item">
            <span className="timeline-date">{e.at}</span>
            <span className="timeline-kind">{e.kind.replace('_', ' ')}</span>
            <span style={{ flex: 1 }}>{e.body}</span>
          </div>
        ))}
        <div className="add-row">
          <input
            type="text"
            placeholder="Add note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addNote()
            }}
          />
          <button className="outline" onClick={() => void addNote()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

const money = (n: number): string => `$${Math.round(n).toLocaleString()}`

/**
 * Deleting a case is for duplicates, but the same button on a real matter
 * would take its payments and letters with it — so the confirmation names
 * exactly what goes, and typing the case title is required to proceed.
 */
function DeleteCase({
  caseId,
  title,
  onDeleted
}: {
  caseId: number
  title: string
  onDeleted: () => Promise<void>
}): React.JSX.Element {
  const [preview, setPreview] = useState<CaseDeletionPreview | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open(): Promise<void> {
    setError(null)
    setTyped('')
    try {
      setPreview(await window.fafo.previewCaseDeletion(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true)
    try {
      await window.fafo.deleteCase(caseId)
      setPreview(null)
      await onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (!preview) {
    return (
      <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <button
          className="subtle"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
          onClick={() => void open()}
        >
          Delete case…
        </button>
        {error && <span style={{ color: 'var(--danger)', marginLeft: 8 }}>{error}</span>}
      </div>
    )
  }

  const items = (
    [
      ['timeline entries', preview.events],
      ['deadlines', preview.deadlines],
      ['letters/referrals', preview.letters],
      ['payments', preview.payments],
      ['evidence references', preview.evidenceFiles],
      ['tracked URLs', preview.trackedUrls],
      ['settlement records', preview.settlements]
    ] as Array<[string, number]>
  ).filter((entry) => entry[1] > 0)

  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--danger)',
        borderRadius: 8,
        padding: '10px 12px',
        background: 'var(--danger-bg)'
      }}
    >
      <strong style={{ fontSize: 13, color: 'var(--danger)' }}>
        Permanently delete “{preview.title}”?
      </strong>
      <p className="subtitle" style={{ margin: '5px 0' }}>
        {items.length === 0
          ? 'This case has no attached records.'
          : `This also deletes ${items.map(([l, n]) => `${n} ${l}`).join(', ')}.`}
        {preview.payments > 0 && (
          <>
            {' '}
            <strong>
              {money(preview.paymentsCents / 100)} of recorded payments will leave your metrics.
            </strong>
          </>
        )}{' '}
        Evidence files in the archive are not touched — only the app&rsquo;s references to them.
        This cannot be undone.
      </p>
      <div className="add-row">
        <input
          type="text"
          placeholder={`Type the case name to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button
          className="outline"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
          disabled={busy || typed.trim() !== preview.title.trim()}
          onClick={() => void confirm()}
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button className="subtle" onClick={() => setPreview(null)}>
          Cancel
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
    </div>
  )
}

function SettlementCard({ caseId }: { caseId: number }): React.JSX.Element {
  const [quote, setQuote] = useState<SettlementQuote | null>(null)
  const [through, setThrough] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setQuote(null)
    setError(null)
  }, [caseId])

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setQuote(await window.fafo.quoteSettlement(caseId, through || undefined))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <h2>Settlement calculator</h2>
      <div className="add-row">
        <input
          type="date"
          value={through}
          onChange={(e) => setThrough(e.target.value)}
          title="Last confirmed date of use (defaults to today)"
        />
        <button className="outline" disabled={busy} onClick={() => void run()}>
          {busy ? 'Calculating…' : 'Calculate'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--warn)', marginTop: 10, fontSize: 12.5 }}>{error}</p>}
      {quote && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 15 }}>
            <strong>{money(quote.opening)}</strong> opening ·{' '}
            {money(quote.compromiseLow)}–{money(quote.compromiseHigh)} compromise
          </p>
          <p className="deadline-meta">
            {quote.formula === 'ld'
              ? `§E.3.d.ii liquidated damages: ${money(quote.annualFee)}/yr × ${quote.monthsOfMisuse} months`
              : `Legacy (${quote.vintage}): current schedule × years of use`}
          </p>
          <p className="subtitle" style={{ marginTop: 6, marginBottom: 0 }}>{quote.notes}</p>
        </div>
      )}
    </div>
  )
}

function LettersCard({
  caseId,
  onChanged
}: {
  caseId: number
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [letters, setLetters] = useState<LetterView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLetters(await window.fafo.listLetters(caseId))
  }, [caseId])

  useEffect(() => {
    void load()
  }, [load])

  async function act(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(null)
  }

  return (
    <div className="card">
      <h2>Letters &amp; referrals</h2>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="outline"
          disabled={busy !== null}
          onClick={() =>
            void act('amanda', () => window.fafo.generateLetter(caseId, 'enforcement'))
          }
        >
          {busy === 'amanda' ? 'Drafting…' : 'Draft AMANDA letter'}
        </button>
        <button
          className="outline"
          disabled={busy !== null}
          onClick={() =>
            void act('summary', () => window.fafo.generateLetter(caseId, 'referral_summary'))
          }
        >
          {busy === 'summary' ? 'Drafting…' : 'Draft Trestle referral'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)', marginTop: 10, fontSize: 12.5 }}>{error}</p>}
      {letters.length === 0 && <div className="empty">No drafts yet.</div>}
      {letters.map((l) => (
        <div key={l.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 9, marginTop: 9 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>
              {l.kind === 'enforcement' ? 'AMANDA enforcement letter' : 'Legal referral summary'}
            </strong>
            <span className={`pill ${l.status === 'responded' ? 'done' : l.status === 'sent' ? 'progress' : 'later'}`}>
              {l.status}
            </span>
            <span className="deadline-meta">drafted {l.draftedAt}</span>
            {l.responseDueAt && !l.responseReceivedAt && (
              <span className="deadline-meta">· response due {l.responseDueAt}</span>
            )}
            {l.responseReceivedAt && (
              <span className="deadline-meta">· replied {l.responseReceivedAt}</span>
            )}
            <span style={{ flex: 1 }} />
            <button className="subtle" onClick={() => setOpen(open === l.id ? null : l.id)}>
              {open === l.id ? 'Hide' : 'Read'}
            </button>
            {!l.sentAt && (
              <button
                className="subtle"
                disabled={busy !== null}
                onClick={() => void act(`sent-${l.id}`, () => window.fafo.markLetterSent(l.id))}
              >
                Mark sent
              </button>
            )}
            {l.docUrl ? (
              <a href={l.docUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Open in Drive
              </a>
            ) : (
              <button
                className="subtle"
                disabled={busy !== null}
                onClick={() =>
                  void act(`drive-${l.id}`, () => window.fafo.exportLetterToDrive(l.id))
                }
              >
                {busy === `drive-${l.id}` ? 'Exporting…' : 'Export to Drive'}
              </button>
            )}
          </div>
          {open === l.id && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'Georgia, serif',
                fontSize: 13,
                lineHeight: 1.5,
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: 12,
                marginTop: 8,
                maxHeight: 460,
                overflowY: 'auto'
              }}
            >
              {l.bodyText}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function NewCaseForm({ onCreated }: { onCreated: (c: CaseRow) => Promise<void> }): React.JSX.Element {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<NewCaseInput>({
    title: '',
    licenseeName: '',
    type: 'Expired License',
    status: 'Open',
    source: 'Website',
    url: '',
    openedAt: today,
    settlementPosition: ''
  })

  async function submit(): Promise<void> {
    if (!form.title.trim()) return
    const created = await window.fafo.createCase({
      ...form,
      title: form.title.trim(),
      licenseeName: form.licenseeName?.trim() || form.title.trim()
    })
    await onCreated(created)
  }

  return (
    <div className="card">
      <h2>New case</h2>
      <div className="add-row">
        <input type="text" placeholder="Company / matter title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as NewCaseInput['type'] })}>
          {CASE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as NewCaseInput['source'] })}>
          {CASE_SOURCES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="add-row">
        <input type="text" placeholder="URL (optional)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input type="date" value={form.openedAt} onChange={(e) => setForm({ ...form, openedAt: e.target.value })} />
        <button className="outline" onClick={() => void submit()}>
          Create
        </button>
      </div>
    </div>
  )
}
