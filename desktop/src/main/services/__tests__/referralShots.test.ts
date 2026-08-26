import { describe, expect, it } from 'vitest'
import { captureDateOf, pickExhibits, platformOf } from '../referralShots'

const ROOT = '/LEGAL/Infringement Cases/Certified:Expired/Awake Chocolate'

describe('screenshot exhibit selection', () => {
  it('reads the platform from the folder the capture was filed under', () => {
    expect(platformOf(`${ROOT}/August 5, 2026/Amazon/a.png`)).toBe('Amazon')
    expect(platformOf(`${ROOT}/August 5, 2026/Website/a.png`)).toBe('Website')
    // Dumped straight into the session folder — there is no platform.
    expect(platformOf(`${ROOT}/August 5, 2026/a.png`)).toBeNull()
  })

  it('prefers the filename date, which is the only one 432 captures have', () => {
    expect(
      captureDateOf({
        path: `${ROOT}/x/Screenshot 2026-08-05 at 6.53.27 PM.png`,
        datedAt: null,
        mtime: '2026-08-20T00:00:00.000Z'
      })
    ).toBe('2026-08-05')
    // Falls back to the session folder, then to mtime.
    expect(captureDateOf({ path: `${ROOT}/x/img.png`, datedAt: '2025-08-11', mtime: null })).toBe(
      '2025-08-11'
    )
    expect(
      captureDateOf({ path: `${ROOT}/x/img.png`, datedAt: null, mtime: '2024-01-02T03:04:05.000Z' })
    ).toBe('2024-01-02')
  })

  it('does not mistake a version number or a price for a date', () => {
    expect(captureDateOf({ path: `${ROOT}/x/v1999-99-99.png`, datedAt: null, mtime: null })).toBeNull()
  })

  it('treats a date folder as no platform, and trims a date off a real label', () => {
    expect(platformOf(`${ROOT}/x/April 2026/a.png`)).toBeNull()
    expect(platformOf(`${ROOT}/x/Oct 23, 2023/a.png`)).toBeNull()
    expect(platformOf(`${ROOT}/x/Amazon - 2:9:26/a.png`)).toBe('Amazon')
    expect(platformOf(`${ROOT}/x/Order - July 19, 2026/a.png`)).toBe('Order')
    // A hyphenated year that is part of the label, not a date suffix, survives.
    expect(platformOf(`${ROOT}/x/Packaging pre-2015/a.png`)).toBe('Packaging pre-2015')
  })

  it('spreads picks across capture days when every capture shares one platform', () => {
    // Yo Mama's Foods shape: 244 captures, no platform subfolders, several
    // sittings. Naive recency returns five frames of one afternoon.
    const rows = [
      ...['8.05.53', '8.06.33', '8.07.02', '8.07.09', '8.07.11'].map((t) => ({
        path: `${ROOT}/Screenshot 2024-11-04 at ${t} PM.png`, datedAt: null, mtime: null
      })),
      { path: `${ROOT}/Screenshot 2024-10-09 at 3.38.57 PM.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/Screenshot 2024-08-14 at 10.14.33 PM.png`, datedAt: null, mtime: null }
    ]
    const dates = pickExhibits(rows, 5).map((p) => p.date)
    expect(dates.slice(0, 3)).toEqual(['2024-11-04', '2024-10-09', '2024-08-14'])
    expect(new Set(dates).size).toBe(3)
  })

  it('takes one capture per platform before a second from any', () => {
    const rows = [
      { path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 2.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 3.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Amazon/Screenshot 2026-07-13 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Instagram/Screenshot 2026-06-11 at 1.png`, datedAt: null, mtime: null }
    ]
    const picked = pickExhibits(rows, 5)
    expect(picked.map((p) => p.platform)).toEqual([
      'Website',
      'Amazon',
      'Instagram',
      'Website',
      'Website'
    ])
    expect(picked.map((p) => p.label)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('takes the most recent capture within a platform', () => {
    const rows = [
      { path: `${ROOT}/A/Website/Screenshot 2024-01-01 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 1.png`, datedAt: null, mtime: null }
    ]
    expect(pickExhibits(rows, 1)[0]!.date).toBe('2026-08-05')
  })

  it('returns what exists when the case has fewer than five captures', () => {
    const rows = [{ path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 1.png`, datedAt: null, mtime: null }]
    expect(pickExhibits(rows, 5)).toHaveLength(1)
    expect(pickExhibits([], 5)).toEqual([])
  })
})
