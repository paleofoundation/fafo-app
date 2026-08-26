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

  it('always pins the first and last capture, and reads chronologically', () => {
    const rows = [
      { path: `${ROOT}/A/Website/Screenshot 2024-01-15 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2025-03-02 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Amazon/Screenshot 2025-07-19 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Instagram/Screenshot 2026-02-08 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 1.png`, datedAt: null, mtime: null }
    ]
    const picked = pickExhibits(rows, 5)
    // The span is the duration argument: earliest still in the file, and the
    // most recent capture proving use had not stopped.
    expect(picked[0]!.date).toBe('2024-01-15')
    expect(picked[picked.length - 1]!.date).toBe('2026-08-05')
    expect(picked.map((p) => p.date)).toEqual([...picked.map((p) => p.date)].sort())
  })

  it('spends the middle picks on platforms not already represented', () => {
    // Eight website captures crowd the pool; Amazon and Instagram must still
    // appear, because one channel proves one channel.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({
        path: `${ROOT}/A/Website/Screenshot 2025-0${i + 1}-10 at 1.png`, datedAt: null, mtime: null
      })),
      { path: `${ROOT}/A/Amazon/Screenshot 2025-04-11 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Instagram/Screenshot 2025-05-11 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Facebook/Screenshot 2025-06-11 at 1.png`, datedAt: null, mtime: null }
    ]
    const platforms = pickExhibits(rows, 5).map((p) => p.platform)
    expect(platforms).toContain('Amazon')
    expect(platforms).toContain('Instagram')
    expect(platforms).toContain('Facebook')
  })

  it('pins both ends even when one end is the only capture on its platform', () => {
    const rows = [
      { path: `${ROOT}/A/Packaging/Screenshot 2023-05-09 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2025-01-01 at 1.png`, datedAt: null, mtime: null },
      { path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 1.png`, datedAt: null, mtime: null }
    ]
    const picked = pickExhibits(rows, 5)
    expect(picked.map((p) => p.date)).toEqual(['2023-05-09', '2025-01-01', '2026-08-05'])
  })

  it('returns what exists when the case has fewer than five captures', () => {
    const rows = [{ path: `${ROOT}/A/Website/Screenshot 2026-08-05 at 1.png`, datedAt: null, mtime: null }]
    expect(pickExhibits(rows, 5)).toHaveLength(1)
    expect(pickExhibits([], 5)).toEqual([])
  })
})
