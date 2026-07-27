import { useCallback, useEffect, useState } from 'react'
import type {
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

export function Cases({
  onDeadlinesChanged
}: {
  onDeadlinesChanged: () => Promise<void>
}): React.JSX.Element {
  const [cases, setCases] = useState<CaseRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)

  const refresh = useCallback(async () => {
    setCases(await window.fafo.listCases())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

      <div className="split">
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Matter</th>
                <th>Type</th>
                <th>Status</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr
                  key={c.id}
                  className="clickable"
                  onClick={() => setSelectedId(c.id)}
                  style={selectedId === c.id ? { outline: '2px solid var(--navy)', outlineOffset: -2 } : undefined}
                >
                  <td>
                    <strong>{c.title}</strong>
                    {c.markCodes && c.markCodes.length > 0 && (
                      <div style={{ marginTop: 3, display: 'flex', gap: 4 }}>
                        {c.markCodes.map((m) => (
                          <span key={m} className="pill mark">
                            {m}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5 }}>{c.type}</td>
                  <td>
                    <span className={`pill ${STATUS_PILL[c.status]}`}>{c.status}</span>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{c.openedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cases.length === 0 && <div className="empty">No cases yet.</div>}
        </div>

        {selectedId !== null && (
          <CaseDetail
            id={selectedId}
            onChanged={async () => {
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

function CaseDetail({ id, onChanged }: { id: number; onChanged: () => Promise<void> }): React.JSX.Element {
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
