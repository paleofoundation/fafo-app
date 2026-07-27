import { useCallback, useEffect, useState } from 'react'
import type { Deadline } from '../../shared/types'
import { Dashboard } from './features/Dashboard'
import { Cases } from './features/Cases'
import { Licensees } from './features/Licensees'
import { Marks } from './features/Marks'
import { Settings } from './features/Settings'

const TABS = ['Dashboard', 'Cases', 'Licensees', 'Trademarks', 'Settings'] as const
type Tab = (typeof TABS)[number]

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('Dashboard')
  const [deadlines, setDeadlines] = useState<Deadline[]>([])

  const refreshDeadlines = useCallback(async () => {
    setDeadlines(await window.fafo.listDeadlines())
  }, [])

  useEffect(() => {
    void refreshDeadlines()
  }, [refreshDeadlines])

  const today = new Date().toISOString().slice(0, 10)
  const overdueCount = deadlines.filter((d) => !d.satisfiedAt && d.dueAt < today).length

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">FAFO</div>
        <div className="brand-sub">Find. Audit. Flag. Oppose.</div>
        {TABS.map((t) => (
          <button key={t} className={`nav-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
            {t === 'Dashboard' && overdueCount > 0 && <span className="badge">{overdueCount}</span>}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'Dashboard' && <Dashboard deadlines={deadlines} onChanged={refreshDeadlines} />}
        {tab === 'Cases' && <Cases onDeadlinesChanged={refreshDeadlines} />}
        {tab === 'Licensees' && <Licensees />}
        {tab === 'Trademarks' && <Marks />}
        {tab === 'Settings' && <Settings />}
      </main>
    </div>
  )
}
