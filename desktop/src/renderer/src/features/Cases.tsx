import { useCallback, useEffect, useState } from 'react'
import type {
  CaseEvent,
  CaseRow,
  CaseStatus,
  Deadline,
  DeadlineKind,
  NewCaseInput
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
