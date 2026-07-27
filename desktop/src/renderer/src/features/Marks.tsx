import { useEffect, useState } from 'react'
import type { Mark } from '../../../shared/types'

export function Marks(): React.JSX.Element {
  const [rows, setRows] = useState<Mark[]>([])

  useEffect(() => {
    void window.fafo.listMarks().then(setRows)
  }, [])

  return (
    <div>
      <h1>Certification Marks</h1>
      <p className="subtitle">Registered portfolio — Paleo Certified, Inc. Legal caveats surface here so letters never overstate.</p>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Mark</th>
              <th>Program</th>
              <th>USPTO No.</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="pill mark">{m.code}</span>
                </td>
                <td>
                  {m.name}
                  {m.notes && <div style={{ color: 'var(--warn)', fontSize: 12, marginTop: 3 }}>⚠ {m.notes}</div>}
                </td>
                <td>{m.program}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{m.usptoRegNo}</td>
                <td>
                  <span className={`pill ${m.regStatus === 'Registered' ? 'done' : 'soon'}`}>{m.regStatus}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
