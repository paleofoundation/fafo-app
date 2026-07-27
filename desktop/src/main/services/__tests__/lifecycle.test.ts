import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrations'
import { lifecycleRoll } from '../lifecycle'

describe('lifecycle roll (Licensed → Expiring → Watch)', () => {
  let db: Database.Database
  const TODAY = '2026-07-27'

  function licensee(name: string): number {
    return Number(
      db
        .prepare("INSERT INTO licensees (name, normalized_name) VALUES (?, lower(?))")
        .run(name, name).lastInsertRowid
    )
  }

  function license(
    licenseeId: number,
    termEnd: string | null,
    status: string,
    vintage: '2020' | '2025' = '2025'
  ): number {
    return Number(
      db
        .prepare(
          'INSERT INTO licenses (licensee_id, term_end, status, vintage) VALUES (?, ?, ?, ?)'
        )
        .run(licenseeId, termEnd, status, vintage).lastInsertRowid
    )
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
  })

  it('flips active licenses inside 60 days to expiring with a watch item + deadline', () => {
    const l = licensee('Chomps')
    license(l, '2026-08-15', 'active')
    const r = lifecycleRoll(db, TODAY)
    expect(r.toExpiring).toBe(1)
    expect(r.watchOpened).toBe(1)
    expect(r.deadlinesCreated).toBe(1)
    const d = db
      .prepare("SELECT due_at AS dueAt, title FROM deadlines WHERE ref_table='watch_items'")
      .get() as { dueAt: string; title: string }
    expect(d.dueAt).toBe('2026-08-15')
    expect(d.title).toContain('renewal not yet on file')
  })

  it('expires past-due licenses: 2025 vintage gets a sell-off deadline, 2020 gets an immediate check', () => {
    const a = licensee('Modern Co')
    license(a, '2026-07-01', 'active', '2025')
    const b = licensee('Legacy Co')
    license(b, '2026-07-01', 'expiring', '2020')

    const r = lifecycleRoll(db, TODAY)
    expect(r.toExpired).toBe(2)
    expect(r.watchOpened).toBe(2)

    const deadlines = db
      .prepare("SELECT kind, due_at AS dueAt, title FROM deadlines ORDER BY kind")
      .all() as Array<{ kind: string; dueAt: string; title: string }>
    const selloff = deadlines.find((d) => d.kind === 'selloff_end')!
    expect(selloff.dueAt).toBe('2026-12-28') // 2026-07-01 + 180d
    expect(selloff.title).toContain('Modern Co')
    const spotCheck = deadlines.find((d) => d.kind === 'patrol_spot_check')!
    expect(spotCheck.title).toContain('NO sell-off')
    expect(spotCheck.dueAt).toBe('2026-07-08')
  })

  it('is idempotent — re-rolling creates nothing new', () => {
    const l = licensee('Chomps')
    license(l, '2026-08-15', 'active')
    lifecycleRoll(db, TODAY)
    const r2 = lifecycleRoll(db, TODAY)
    expect(r2.toExpiring).toBe(0) // already 'expiring'
    expect(r2.watchOpened).toBe(0)
    expect(r2.deadlinesCreated).toBe(0)
  })

  it('closes the watch as renewed when a new active agreement appears, dismissing its deadlines', () => {
    const l = licensee('Chomps')
    const oldLicense = license(l, '2026-08-15', 'active')
    lifecycleRoll(db, TODAY)
    expect(oldLicense).toBeGreaterThan(0)

    // renewal lands (e.g. via SignNow sync): a new active license for the same licensee
    license(l, '2027-08-15', 'active')
    const r = lifecycleRoll(db, TODAY)
    expect(r.watchRenewed).toBe(1)

    const watch = db.prepare('SELECT status FROM watch_items').get() as { status: string }
    expect(watch.status).toBe('renewed')
    const dismissed = db
      .prepare('SELECT dismissed FROM deadlines WHERE ref_table = ?')
      .get('watch_items') as { dismissed: number }
    expect(dismissed.dismissed).toBe(1)
  })
})
