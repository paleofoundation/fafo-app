import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CaseDeletionPreview,
  CaseEvent,
  CaseFiles,
  CaseLicenseFacts,
  CaseMergePreview,
  CasePayment,
  CaseRow,
  CaseStatus,
  Deadline,
  DeadlineKind,
  DuplicatePaymentMatch,
  DuplicateSuggestion,
  EmailExtractionProgress,
  EmailExtractionResult,
  EmailExtractionStatus,
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
        <MergeCase caseId={id} title={c.title} onMerged={onDeleted} />
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

      <LicenseCard caseId={id} />

      <FilesCard caseId={id} onChanged={load} />

      <PaymentsCard
        caseId={id}
        caseResolvedBy={c.resolvedBy ?? null}
        onChanged={async () => {
          await load()
          await onChanged()
        }}
      />

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
 * The agreement facts a matter turns on, read from the extracted license.
 *
 * Liquidated damages appear as their BASIS rather than a figure: under
 * §E.3.d.ii the measure is one year's fee per month of continued use, so the
 * number depends on how long the misuse ran. The settlement calculator below
 * turns it into money once you give it an observed-use-through date.
 */
function LicenseCard({ caseId }: { caseId: number }): React.JSX.Element | null {
  const [facts, setFacts] = useState<CaseLicenseFacts | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    void window.fafo.caseLicenseFacts(caseId).then((f) => {
      if (live) setFacts(f)
    })
    return () => {
      live = false
    }
  }, [caseId])

  if (facts === undefined) return null
  if (facts === null) {
    return (
      <div className="card">
        <h2>License agreement</h2>
        <div className="empty">
          No agreement on file for this licensee — nothing extracted yet. Run the SignNow sync and
          agreement extraction from Import, or check that the case is linked to the right licensee.
        </div>
      </div>
    )
  }

  const rows: Array<[string, React.ReactNode]> = [
    ['Business name', facts.businessName ?? '—'],
    ['Address', facts.address ?? <span className="deadline-meta">not extracted</span>],
    [
      'Term',
      facts.termStart || facts.termEnd ? (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {facts.termStart ?? '?'} → {facts.termEnd ?? '?'}
        </span>
      ) : (
        <span className="deadline-meta">not extracted</span>
      )
    ],
    [
      'License fee',
      facts.annualFeeCents !== null ? (
        <>
          {usd(facts.annualFeeCents)}/yr
          {facts.revenueBand && <span className="deadline-meta"> · band {facts.revenueBand}</span>}
        </>
      ) : (
        <span className="deadline-meta">not extracted</span>
      )
    ],
    ['Liquidated damages', <span style={{ fontSize: 12.5 }}>{facts.liquidatedDamages.basis}</span>]
  ]

  return (
    <div className="card">
      <h2>License agreement</h2>
      {rows.map(([label, value]) => (
        <div key={label} className="field-row">
          <span className="field-label">{label}</span>
          <span style={{ flex: 1 }}>{value}</span>
        </div>
      ))}
      {facts.marks.length > 0 && (
        <div className="field-row">
          <span className="field-label">Marks licensed</span>
          <span style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {facts.marks.map((m) => (
              <span key={m.code} className="pill mark" title={`Reg. ${m.regNo} (${m.regStatus})`}>
                {m.code}
              </span>
            ))}
          </span>
        </div>
      )}
      <p className="deadline-meta" style={{ margin: '4px 0 0' }}>
        {facts.vintage ? `${facts.vintage} template` : 'vintage unknown'}
        {facts.agreementRef && ` · ${facts.agreementRef}`}
        {facts.extractionConfidence !== null &&
          ` · extraction confidence ${Math.round(facts.extractionConfidence * 100)}%`}
      </p>
    </div>
  )
}

/**
 * Reads the case's email threads into the timeline. Each message becomes one
 * dated entry, so the correspondence reads as a clock rather than a pile of
 * PDFs. Undated messages are dropped rather than guessed at — the count is
 * reported so a thread that mostly failed to parse is visible.
 */
function EmailThreadExtractor({
  caseId,
  onChanged
}: {
  caseId: number
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const [status, setStatus] = useState<EmailExtractionStatus | null>(null)
  const [progress, setProgress] = useState<EmailExtractionProgress | null>(null)
  const [result, setResult] = useState<EmailExtractionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus(await window.fafo.emailExtractionStatus(caseId))
  }, [caseId])

  useEffect(() => {
    setResult(null)
    setError(null)
    void load()
  }, [load])

  useEffect(() => window.fafo.onEmailExtractionProgress(setProgress), [])

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await window.fafo.runEmailExtraction(25, caseId))
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setProgress(null)
    setBusy(false)
  }

  if (!status || status.total === 0) return null

  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="subtle"
          disabled={busy || status.pending === 0 || !status.keyPresent}
          onClick={() => void run()}
          title={
            status.keyPresent
              ? 'Read each thread into dated timeline entries'
              : 'Add an Anthropic API key in Settings first'
          }
        >
          {busy
            ? 'Reading threads…'
            : status.pending === 0
              ? 'All threads read'
              : `Read ${status.pending} email thread${status.pending === 1 ? '' : 's'}`}
        </button>
        <span className="deadline-meta">
          {status.extracted} of {status.total} read into the timeline
        </span>
      </div>

      {busy && progress && (
        <p className="deadline-meta" style={{ margin: '6px 0 0' }}>
          {progress.processed}/{progress.total} · {progress.current}
        </p>
      )}
      {!status.keyPresent && (
        <p className="deadline-meta" style={{ margin: '6px 0 0' }}>
          Needs an Anthropic API key — add one in Settings.
        </p>
      )}
      {result && (
        <p className="deadline-meta" style={{ margin: '6px 0 0' }}>
          {result.eventsWritten} timeline entr{result.eventsWritten === 1 ? 'y' : 'ies'} from{' '}
          {result.ok} thread{result.ok === 1 ? '' : 's'}
          {result.undatedDropped > 0 &&
            ` · ${result.undatedDropped} message${result.undatedDropped === 1 ? '' : 's'} had no date and were left out`}
          {result.skipped > 0 &&
            ` · ${result.skipped} screened out as bulk mail`}
          {result.failed > 0 && ` · ${result.failed} failed`}
          {result.remaining > 0 && ` · ${result.remaining} still pending`}
        </p>
      )}
      {result && result.errors.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="deadline-meta" style={{ cursor: 'pointer' }}>
            {result.errors.length} problem{result.errors.length === 1 ? '' : 's'}
          </summary>
          {result.errors.map((e, i) => (
            <p key={i} className="deadline-meta" style={{ margin: '3px 0' }}>
              {e}
            </p>
          ))}
        </details>
      )}
      {error && <p style={{ color: 'var(--danger)', margin: '6px 0 0', fontSize: 12.5 }}>{error}</p>}
    </div>
  )
}

function fileSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Drop the archive root so the folder reads as "Certified:Expired/Awake Chocolate". */
const shortFolder = (p: string): string => p.split('/').slice(-2).join('/')

const FILE_LIMIT = 12

/**
 * The documents on a case, referenced in place in the LEGAL archive — nothing
 * is copied. "Refresh from folder" re-reads the folder and picks up whatever
 * has been added since, which is the working loop for a live matter: drop the
 * new screenshots or the countersigned agreement in, then refresh.
 *
 * Files that vanished from disk are reported, never unlinked — a moved folder
 * shouldn't quietly shrink the evidence record behind a case.
 */
function FilesCard({
  caseId,
  onChanged
}: {
  caseId: number
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [data, setData] = useState<CaseFiles | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setData(await window.fafo.listCaseFiles(caseId))
  }, [caseId])

  useEffect(() => {
    setShowAll(false)
    setNote(null)
    setError(null)
    void load()
  }, [load])

  async function refresh(): Promise<void> {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const r = await window.fafo.refreshCaseFiles(caseId)
      const kinds = Object.entries(r.addedByKind)
        .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
        .join(', ')
      setNote(
        r.filesAdded === 0
          ? `Nothing new — ${r.filesSeen} file${r.filesSeen === 1 ? '' : 's'} in the folder, all already indexed.`
          : `Added ${r.filesAdded} new file${r.filesAdded === 1 ? '' : 's'} (${kinds}).`
      )
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function link(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const dir = await window.fafo.pickCaseFolder(caseId)
      if (dir) {
        await load()
        await onChanged()
        await refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function act(kind: 'reveal' | 'open', id: number): Promise<void> {
    setError(null)
    try {
      if (kind === 'reveal') await window.fafo.revealFile(id)
      else await window.fafo.openFile(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!data) return <div className="card empty">Loading files…</div>

  const shown = showAll ? data.files : data.files.slice(0, FILE_LIMIT)

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Files</h2>
        {data.folderPath ? (
          <button className="subtle" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Reading…' : 'Refresh from folder'}
          </button>
        ) : (
          <button className="subtle" disabled={busy} onClick={() => void link()}>
            Link folder…
          </button>
        )}
      </div>

      {data.folderPath && (
        <p className="deadline-meta" style={{ margin: '6px 0 0', wordBreak: 'break-all' }}>
          {shortFolder(data.folderPath)}
          {!data.folderExists && (
            <span style={{ color: 'var(--danger)' }}> — folder not found on disk</span>
          )}
        </p>
      )}
      {!data.folderPath && (
        <p className="subtitle" style={{ margin: '6px 0 0' }}>
          No folder linked yet, so nothing can be pulled in automatically. Link the case&rsquo;s
          folder under LEGAL/Infringement Cases.
        </p>
      )}

      <EmailThreadExtractor caseId={caseId} onChanged={onChanged} />

      {data.byKind.length > 0 && (
        <p style={{ margin: '8px 0 4px', fontSize: 13 }}>
          {data.byKind.map((k, i) => (
            <span key={k.kind}>
              {i > 0 && ' · '}
              <strong>{k.count}</strong> {k.kind}
              {k.count === 1 ? '' : 's'}
            </span>
          ))}
        </p>
      )}

      {note && <p className="deadline-meta" style={{ margin: '6px 0' }}>{note}</p>}
      {error && <p style={{ color: 'var(--danger)', margin: '6px 0', fontSize: 12.5 }}>{error}</p>}

      {data.files.length === 0 && (
        <div className="empty">No files indexed for this case yet.</div>
      )}

      {shown.map((f) => (
        <div key={f.id} className="deadline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="deadline-date" style={{ minWidth: 84, fontSize: 12.5 }}>
            {f.datedAt ?? f.mtime?.slice(0, 10) ?? '—'}
          </span>
          <span
            style={{ flex: 1, minWidth: 140, wordBreak: 'break-word' }}
            title={f.path ?? undefined}
          >
            {f.fileName}
          </span>
          <span className="deadline-meta" style={{ whiteSpace: 'nowrap' }}>
            {f.kind} · {fileSize(f.byteSize)}
          </span>
          {f.present ? (
            <>
              <button className="subtle" onClick={() => void act('open', f.id)}>
                Open
              </button>
              <button className="subtle" onClick={() => void act('reveal', f.id)}>
                Reveal
              </button>
            </>
          ) : (
            <span className="pill overdue">missing</span>
          )}
        </div>
      ))}

      {data.files.length > FILE_LIMIT && (
        <button
          className="subtle"
          style={{ marginTop: 10 }}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? `Show fewer` : `Show all ${data.files.length}`}
        </button>
      )}

      {data.missing > 0 && (
        <p className="subtitle" style={{ margin: '10px 0 0' }}>
          {data.missing} indexed file{data.missing === 1 ? '' : 's'} no longer on disk. The
          reference is kept rather than deleted — usually the folder moved.
        </p>
      )}
    </div>
  )
}

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "1,250" / "$1,250.00" / " 1250 " → 125000 cents; NaN when unparseable. */
function parseAmountCents(raw: string): number {
  const n = parseFloat(raw.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : NaN
}

/**
 * The money ledger for a case — the entry point for settlement income.
 *
 * Only received rows reach the metrics. Expected rows are recorded so an
 * installment schedule is visible on the case without booking revenue that
 * hasn't arrived. Resolution credit defaults to the case's, because the
 * rollups fall back to it and copying the value here would fossilize it.
 */
function PaymentsCard({
  caseId,
  caseResolvedBy,
  onChanged
}: {
  caseId: number
  caseResolvedBy: 'JP' | 'Trestle' | null
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const blank = { amount: '', date: '', received: true, credit: 'case' as 'case' | 'JP' | 'Trestle' }
  const [rows, setRows] = useState<CasePayment[] | null>(null)
  const [form, setForm] = useState(blank)
  const [dup, setDup] = useState<DuplicatePaymentMatch | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const [collecting, setCollecting] = useState<{ id: number; date: string } | null>(null)
  const [editing, setEditing] = useState<{
    id: number
    amount: string
    date: string
    received: boolean
    credit: 'case' | 'JP' | 'Trestle'
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setRows(await window.fafo.listCasePayments(caseId))
  }, [caseId])

  useEffect(() => {
    setForm(blank)
    setDup(null)
    setConfirmRemove(null)
    setCollecting(null)
    setEditing(null)
    setError(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const cents = parseAmountCents(form.amount)
  const valid = Number.isFinite(cents) && cents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(form.date)

  async function add(force: boolean): Promise<void> {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      // Amount + date is the same duplicate key the metrics importer uses, so a
      // settlement already booked under another case name gets caught here
      // rather than showing up as inflated income later.
      if (!force) {
        const match = await window.fafo.findDuplicatePayment(caseId, cents, form.date)
        if (match) {
          setDup(match)
          setBusy(false)
          return
        }
      }
      await window.fafo.addCasePayment(caseId, {
        amountCents: cents,
        received: form.received,
        date: form.date,
        resolvedBy: form.credit === 'case' ? null : form.credit
      })
      setForm(blank)
      setDup(null)
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function remove(id: number): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.fafo.removeCasePayment(id)
      setConfirmRemove(null)
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const editCents = editing ? parseAmountCents(editing.amount) : NaN
  const editValid =
    editing !== null &&
    Number.isFinite(editCents) &&
    editCents > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(editing.date)

  async function saveEdit(): Promise<void> {
    if (!editing || !editValid) return
    setBusy(true)
    setError(null)
    try {
      await window.fafo.updateCasePayment(editing.id, {
        amountCents: editCents,
        received: editing.received,
        date: editing.date,
        resolvedBy: editing.credit === 'case' ? null : editing.credit
      })
      setEditing(null)
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function collect(): Promise<void> {
    if (!collecting) return
    setBusy(true)
    setError(null)
    try {
      await window.fafo.markPaymentReceived(collecting.id, collecting.date)
      setCollecting(null)
      await load()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const receivedCents = (rows ?? []).filter((p) => p.received).reduce((s, p) => s + p.amountCents, 0)
  const expectedCents = (rows ?? [])
    .filter((p) => !p.received)
    .reduce((s, p) => s + p.amountCents, 0)

  return (
    <div className="card">
      <h2>Payments</h2>
      {rows === null && <div className="empty">Loading…</div>}
      {rows !== null && rows.length === 0 && (
        <div className="empty">No payments recorded. Received payments feed the metrics.</div>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 14 }}>
            <strong>{usd(receivedCents)}</strong> received
            {expectedCents > 0 && (
              <span className="deadline-meta"> · {usd(expectedCents)} still expected</span>
            )}
          </p>
          {rows.map((p) =>
            editing?.id === p.id ? (
              <div key={p.id} className="deadline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  type="text"
                  value={editing.amount}
                  aria-label="Amount"
                  onChange={(e) => setEditing({ ...editing, amount: e.target.value })}
                  style={{ flex: '1 1 110px', minWidth: 90, padding: '5px 8px' }}
                />
                <input
                  type="date"
                  value={editing.date}
                  aria-label={editing.received ? 'Date received' : 'Date due'}
                  onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                  style={{ padding: '4px 6px', fontSize: 12.5 }}
                />
                <select
                  value={editing.received ? 'received' : 'expected'}
                  aria-label="Received or expected"
                  onChange={(e) => setEditing({ ...editing, received: e.target.value === 'received' })}
                  style={{ padding: '4px 6px', fontSize: 12.5 }}
                >
                  <option value="received">Received</option>
                  <option value="expected">Expected</option>
                </select>
                <select
                  value={editing.credit}
                  aria-label="Resolution credit"
                  onChange={(e) =>
                    setEditing({ ...editing, credit: e.target.value as 'case' | 'JP' | 'Trestle' })
                  }
                  style={{ padding: '4px 6px', fontSize: 12.5 }}
                >
                  <option value="case">Case credit ({caseResolvedBy ?? 'Unassigned'})</option>
                  <option value="JP">JP</option>
                  <option value="Trestle">Trestle</option>
                </select>
                <button
                  className="outline"
                  disabled={busy || !editValid}
                  onClick={() => void saveEdit()}
                >
                  Save
                </button>
                <button className="subtle" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              // The detail pane is narrow, so let a row wrap onto a second line
              // rather than pushing its buttons outside the card.
              <div key={p.id} className="deadline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="deadline-date">{p.receivedDate ?? p.dueDate ?? '—'}</span>
                <button
                  className="linklike"
                  title="Edit this payment"
                  onClick={() => {
                    setConfirmRemove(null)
                    setCollecting(null)
                    setEditing({
                      id: p.id,
                      amount: (p.amountCents / 100).toFixed(2),
                      date: p.receivedDate ?? p.dueDate ?? '',
                      received: p.received,
                      credit: p.resolvedBy ?? 'case'
                    })
                  }}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    fontVariantNumeric: 'tabular-nums',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textDecorationStyle: 'dotted',
                    textUnderlineOffset: 3
                  }}
                >
                  {usd(p.amountCents)}
                </button>
              <span className={`pill ${p.received ? 'done' : 'open'}`}>
                {p.received ? 'received' : 'expected'}
              </span>
              <span
                className="deadline-meta"
                style={{ whiteSpace: 'nowrap' }}
                title={
                  p.resolvedBy
                    ? 'Credited to this person regardless of the case'
                    : "Follows the case's resolution credit"
                }
              >
                {p.effectiveResolvedBy ?? 'Unassigned'}
                {p.resolvedBy === null && ' (case)'}
              </span>
              {p.imported && (
                <span
                  className="deadline-meta"
                  style={{ whiteSpace: 'nowrap' }}
                  title="Came from the metrics export"
                >
                  imported
                </span>
              )}
              {confirmRemove === p.id ? (
                <>
                  <button
                    className="subtle"
                    style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                    disabled={busy}
                    onClick={() => void remove(p.id)}
                  >
                    Remove
                  </button>
                  <button className="subtle" onClick={() => setConfirmRemove(null)}>
                    Cancel
                  </button>
                </>
              ) : collecting?.id === p.id ? (
                <>
                  <input
                    type="date"
                    value={collecting.date}
                    title="Date the payment actually arrived"
                    onChange={(e) => setCollecting({ id: p.id, date: e.target.value })}
                    style={{ padding: '4px 6px', fontSize: 12.5 }}
                  />
                  <button className="outline" disabled={busy} onClick={() => void collect()}>
                    Save
                  </button>
                  <button className="subtle" onClick={() => setCollecting(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {!p.received && (
                    <button
                      className="subtle"
                      style={{ whiteSpace: 'nowrap' }}
                      title="Record the date this payment arrived"
                      onClick={() =>
                        setCollecting({ id: p.id, date: new Date().toISOString().slice(0, 10) })
                      }
                    >
                      Mark received
                    </button>
                  )}
                  <button
                    className="subtle"
                    title="Remove this payment"
                    onClick={() => setConfirmRemove(p.id)}
                  >
                    ×
                  </button>
                </>
              )}
              </div>
            )
          )}
        </>
      )}

      <div className="add-row" style={{ flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Amount, e.g. 10,000"
          value={form.amount}
          onChange={(e) => {
            setForm({ ...form, amount: e.target.value })
            setDup(null)
          }}
          style={{ flex: '1 1 130px', minWidth: 110 }}
        />
        <input
          type="date"
          value={form.date}
          title={form.received ? 'Date received' : 'Date due'}
          onChange={(e) => {
            setForm({ ...form, date: e.target.value })
            setDup(null)
          }}
        />
        <select
          value={form.received ? 'received' : 'expected'}
          onChange={(e) => setForm({ ...form, received: e.target.value === 'received' })}
        >
          <option value="received">Received</option>
          <option value="expected">Expected</option>
        </select>
        <select
          value={form.credit}
          title="Resolution credit for this payment"
          onChange={(e) => setForm({ ...form, credit: e.target.value as 'case' | 'JP' | 'Trestle' })}
        >
          <option value="case">Case credit ({caseResolvedBy ?? 'Unassigned'})</option>
          <option value="JP">JP</option>
          <option value="Trestle">Trestle</option>
        </select>
        <button className="outline" disabled={!valid || busy} onClick={() => void add(false)}>
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>

      {dup && (
        <div
          style={{
            marginTop: 10,
            border: '1px solid var(--warn)',
            borderRadius: 8,
            padding: '8px 12px',
            background: 'var(--warn-bg)'
          }}
        >
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{usd(cents)}</strong> on {form.date} is already on the ledger
            {dup.sameCase ? ' for this case' : ` under “${dup.label}”`}. Adding it again would
            double-count the income.
          </p>
          <div className="add-row">
            <button className="outline" disabled={busy} onClick={() => void add(true)}>
              Add anyway
            </button>
            <button className="subtle" onClick={() => setDup(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12.5 }}>{error}</p>}
      {rows !== null && expectedCents > 0 && (
        <p className="subtitle" style={{ margin: '10px 0 0' }}>
          Expected payments are recorded here but excluded from the metrics until you mark them
          received.
        </p>
      )}
    </div>
  )
}

/**
 * Merging duplicate matters — the same company that arrived twice, once from
 * SignNow ("OTTO'S NATURALS LLC") and once from the folder on disk ("Ottos
 * Naturals"), each with its own licensee and its own case.
 *
 * The open case is the survivor; the one picked here is absorbed and deleted.
 * Nothing is discarded — every child row moves across — so this is the safe
 * way to collapse a duplicate, as opposed to deleting one and losing whatever
 * evidence or payments were filed against it.
 */
function MergeCase({
  caseId,
  title,
  onMerged
}: {
  caseId: number
  title: string
  onMerged: () => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<DuplicateSuggestion[]>([])
  const [all, setAll] = useState<CaseRow[]>([])
  const [search, setSearch] = useState('')
  const [pickedId, setPickedId] = useState<number | null>(null)
  // Which case survives. Defaults to the one that is open, but a duplicate is
  // often the RICHER record (the folder import has the files), so the
  // direction has to be switchable before committing — merges don't undo.
  const [keepId, setKeepId] = useState<number | null>(null)
  const [preview, setPreview] = useState<CaseMergePreview | null>(null)
  const [mergeLicensee, setMergeLicensee] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOpen(false)
    setPickedId(null)
    setKeepId(null)
    setPreview(null)
    setSearch('')
    setError(null)
  }, [caseId])

  async function start(): Promise<void> {
    setOpen(true)
    setError(null)
    try {
      const [s, cases] = await Promise.all([
        window.fafo.duplicateCaseSuggestions(),
        window.fafo.listCases()
      ])
      setSuggestions(s.filter((x) => x.a.id === caseId || x.b.id === caseId))
      setAll(cases.filter((c) => c.id !== caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function pick(id: number, keep = caseId): Promise<void> {
    setPickedId(id)
    setKeepId(keep)
    setError(null)
    setPreview(null)
    try {
      const absorb = keep === caseId ? id : caseId
      const p = await window.fafo.previewCaseMerge(keep, absorb)
      setPreview(p)
      setMergeLicensee(p.licenseesDiffer)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function swap(): Promise<void> {
    if (pickedId === null) return
    await pick(pickedId, keepId === caseId ? pickedId : caseId)
  }

  async function confirm(): Promise<void> {
    if (pickedId === null || keepId === null) return
    setBusy(true)
    setError(null)
    try {
      const absorb = keepId === caseId ? pickedId : caseId
      await window.fafo.mergeCases(keepId, absorb, mergeLicensee)
      setOpen(false)
      setPickedId(null)
      setPreview(null)
      await onMerged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <button className="subtle" onClick={() => void start()}>
          Merge duplicate…
        </button>
      </div>
    )
  }

  const matches = search.trim()
    ? all
        .filter((c) =>
          `${c.title} ${c.licenseeName ?? ''}`.toLowerCase().includes(search.toLowerCase())
        )
        .slice(0, 8)
    : []

  const other = (s: DuplicateSuggestion): DuplicateSuggestion['a'] =>
    s.a.id === caseId ? s.b : s.a

  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '10px 12px'
      }}
    >
      {/* The heading has to track the direction — after a swap it would
          otherwise name the case that is about to be absorbed. */}
      <strong style={{ fontSize: 13 }}>
        Merge into “{preview ? preview.primary.title : title}”
      </strong>
      <p className="subtitle" style={{ margin: '4px 0 8px' }}>
        {preview
          ? 'That case survives; the other is absorbed and removed. Every timeline entry, file, payment and deadline moves across first.'
          : 'This case survives. The one you pick is absorbed and removed — all of its timeline, files, payments and deadlines move here first.'}
      </p>

      {suggestions.length > 0 && !preview && (
        <>
          <p className="deadline-meta" style={{ margin: '8px 0 4px' }}>
            Likely duplicates
          </p>
          {suggestions.map((s) => {
            const o = other(s)
            return (
              <div key={o.id} className="deadline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 140 }}>
                  {o.title}
                  <div className="deadline-meta">
                    {s.reason} · {o.status} · {o.files} file{o.files === 1 ? '' : 's'}
                    {o.licenseeName && ` · ${o.licenseeName}`}
                  </div>
                </span>
                <button className="subtle" onClick={() => void pick(o.id)}>
                  Preview merge
                </button>
              </div>
            )
          })}
        </>
      )}

      {!preview && (
        <div className="add-row">
          <input
            type="text"
            placeholder="…or search for any case"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      {!preview &&
        matches.map((c) => (
          <div key={c.id} className="deadline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 140 }}>
              {c.title}
              <div className="deadline-meta">
                {c.status} · opened {c.openedAt}
                {c.licenseeName && ` · ${c.licenseeName}`}
              </div>
            </span>
            <button className="subtle" onClick={() => void pick(c.id)}>
              Preview merge
            </button>
          </div>
        ))}

      {preview && (
        <div style={{ marginTop: 8 }}>
          <p style={{ margin: '0 0 6px', fontSize: 13 }}>
            Absorbing <strong>“{preview.duplicate.title}”</strong> ({preview.duplicate.status})
          </p>
          <p className="deadline-meta" style={{ margin: '0 0 8px' }}>
            Moves:{' '}
            {(
              [
                ['timeline entries', preview.moves.events],
                ['deadlines', preview.moves.deadlines],
                ['letters', preview.moves.letters],
                ['payments', preview.moves.payments],
                ['files', preview.moves.evidenceFiles],
                ['tracked URLs', preview.moves.trackedUrls],
                ['settlements', preview.moves.settlements]
              ] as Array<[string, number]>
            )
              .filter(([, n]) => n > 0)
              .map(([l, n]) => `${n} ${l}`)
              .join(', ') || 'nothing — it has no attached records'}
            {preview.moves.paymentsCents > 0 && ` · ${usd(preview.moves.paymentsCents)} of income`}
            {preview.duplicateEvidence > 0 &&
              ` · ${preview.duplicateEvidence} file reference${preview.duplicateEvidence === 1 ? '' : 's'} already here, so dropped`}
          </p>

          {preview.resolved.some((r) => r.changed) && (
            <>
              <p className="deadline-meta" style={{ margin: '8px 0 2px' }}>
                Fields that change on this case
              </p>
              {preview.resolved
                .filter((r) => r.changed)
                .map((r) => (
                  <div key={r.field} className="field-row" style={{ marginBottom: 4 }}>
                    <span className="field-label">{r.field}</span>
                    <span style={{ flex: 1, fontSize: 12.5 }}>
                      <span className="deadline-meta">{r.from}</span> → <strong>{r.to}</strong>
                    </span>
                  </div>
                ))}
            </>
          )}

          {preview.licenseeMerge && (
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                margin: '10px 0',
                fontSize: 12.5
              }}
            >
              <input
                type="checkbox"
                checked={mergeLicensee}
                onChange={(e) => setMergeLicensee(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                Also merge the licensee <strong>“{preview.licenseeMerge.absorb}”</strong> into{' '}
                <strong>“{preview.licenseeMerge.keep}”</strong>
                {preview.licenseeMerge.licensesMoved > 0 &&
                  `, moving ${preview.licenseeMerge.licensesMoved} license${preview.licenseeMerge.licensesMoved === 1 ? '' : 's'}`}
                {preview.licenseeMerge.otherCases > 0 &&
                  ` and ${preview.licenseeMerge.otherCases} other case${preview.licenseeMerge.otherCases === 1 ? '' : 's'}`}
                . The old name is kept as an alias, so a future import matches here instead of
                splitting again.{' '}
                {!mergeLicensee && (
                  <span style={{ color: 'var(--warn)' }}>
                    Leaving it unmerged means the agreement facts may still read from the other
                    record.
                  </span>
                )}
              </span>
            </label>
          )}

          <p className="deadline-meta" style={{ margin: '8px 0 4px' }}>
            Keeps the name, type and source of <strong>“{preview.primary.title}”</strong>. A merge
            cannot be undone.
          </p>
          <div className="add-row" style={{ flexWrap: 'wrap' }}>
            <button
              className="outline"
              style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'Merging…' : `Merge into “${preview.primary.title}”`}
            </button>
            <button
              className="subtle"
              disabled={busy}
              title="Swap which case survives"
              onClick={() => void swap()}
            >
              Keep “{preview.duplicate.title}” instead
            </button>
            <button className="subtle" onClick={() => setPreview(null)}>
              Pick a different case
            </button>
          </div>
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12.5 }}>{error}</p>}
      {!preview && (
        <button className="subtle" style={{ marginTop: 8 }} onClick={() => setOpen(false)}>
          Cancel
        </button>
      )}
    </div>
  )
}

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
            {/* Drive depends on a Cloud Run token that expires every ~7 days.
                A referral summary counsel is waiting on must not be stuck
                behind that, so saving locally is always available. */}
            <button
              className="subtle"
              disabled={busy !== null}
              title="Save the branded document to a file — no Drive required"
              onClick={() => void act(`file-${l.id}`, () => window.fafo.saveLetterToFile(l.id))}
            >
              {busy === `file-${l.id}` ? 'Saving…' : 'Save as file'}
            </button>
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
