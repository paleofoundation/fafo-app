import { useMemo } from 'react'
import type { Deadline } from '../../../shared/types'

/**
 * The deadline surface — the single highest-legal-value screen in the app.
 * Everything with a clock lives here, ordered by urgency. Missed deadlines
 * (sell-off windows, response clocks) are legally unrecoverable.
 */
export function Dashboard({
  deadlines,
  onChanged
}: {
  deadlines: Deadline[]
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const today = new Date().toISOString().slice(0, 10)

  const { overdue, upcoming, satisfied } = useMemo(() => {
    const open = deadlines.filter((d) => !d.satisfiedAt)
    return {
      overdue: open.filter((d) => d.dueAt < today),
      upcoming: open.filter((d) => d.dueAt >= today),
      satisfied: deadlines.filter((d) => d.satisfiedAt)
    }
  }, [deadlines, today])

  async function toggle(d: Deadline): Promise<void> {
    await window.fafo.satisfyDeadline(d.id, !d.satisfiedAt)
    await onChanged()
  }

  async function dismiss(d: Deadline): Promise<void> {
    await window.fafo.dismissDeadline(d.id)
    await onChanged()
  }

  return (
    <div>
      <h1>Deadline Surface</h1>
      <p className="subtitle">
        Sell-off windows, response clocks, and review dates — ordered by urgency. Today is {today}.
      </p>

      <div className="card">
        <h2>Overdue — action required</h2>
        {overdue.length === 0 && <div className="empty">Nothing overdue. Clear runway.</div>}
        {overdue.map((d) => (
          <DeadlineLine key={d.id} d={d} today={today} onToggle={toggle} onDismiss={dismiss} />
        ))}
      </div>

      <div className="card">
        <h2>Upcoming</h2>
        {upcoming.length === 0 && <div className="empty">No upcoming deadlines on the books.</div>}
        {upcoming.map((d) => (
          <DeadlineLine key={d.id} d={d} today={today} onToggle={toggle} onDismiss={dismiss} />
        ))}
      </div>

      {satisfied.length > 0 && (
        <div className="card">
          <h2>Satisfied</h2>
          {satisfied.map((d) => (
            <DeadlineLine key={d.id} d={d} today={today} onToggle={toggle} onDismiss={dismiss} />
          ))}
        </div>
      )}
    </div>
  )
}

function DeadlineLine({
  d,
  today,
  onToggle,
  onDismiss
}: {
  d: Deadline
  today: string
  onToggle: (d: Deadline) => Promise<void>
  onDismiss: (d: Deadline) => Promise<void>
}): React.JSX.Element {
  const days = Math.round(
    (new Date(`${d.dueAt}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000
  )
  const pill = d.satisfiedAt ? 'done' : days < 0 ? 'overdue' : days <= 14 ? 'soon' : 'later'
  const label = d.satisfiedAt
    ? `done ${d.satisfiedAt}`
    : days < 0
      ? `${-days}d overdue`
      : days === 0
        ? 'due today'
        : `in ${days}d`

  return (
    <div className="deadline-row">
      <span className="deadline-date">{d.dueAt}</span>
      <span className={`pill ${pill}`}>{label}</span>
      <span className="deadline-title">
        {d.title}
        {d.caseTitle && <span className="deadline-meta"> — {d.caseTitle}</span>}
      </span>
      <button className="subtle" onClick={() => void onToggle(d)}>
        {d.satisfiedAt ? 'Reopen' : 'Mark done'}
      </button>
      {!d.satisfiedAt && (
        <button className="subtle" onClick={() => void onDismiss(d)} title="Remove without satisfying">
          Dismiss
        </button>
      )}
    </div>
  )
}
