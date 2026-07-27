import { useEffect, useState } from 'react'
import type { Licensee } from '../../../shared/types'

export function Licensees(): React.JSX.Element {
  const [rows, setRows] = useState<Licensee[]>([])

  useEffect(() => {
    void window.fafo.listLicensees().then(setRows)
  }, [])

  return (
    <div>
      <h1>Licensees</h1>
      <p className="subtitle">
        Populated fully by the SignNow backfill in M2 — for now, entities referenced by open cases.
      </p>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Contact</th>
              <th>Email</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>
                  <strong>{l.name}</strong>
                  {l.repeatInfringer === 1 && <span className="pill overdue" style={{ marginLeft: 8 }}>repeat</span>}
                </td>
                <td>{l.contactName ?? '—'}</td>
                <td>{l.contactEmail ?? '—'}</td>
                <td>{l.contactPhone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No licensees yet.</div>}
      </div>
    </div>
  )
}
