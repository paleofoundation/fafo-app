/**
 * Picks the handful of captures that go into a referral, and encodes them for
 * the Docs service.
 *
 * The archive is organised Company / capture-date / platform / file, though
 * plenty of sessions dump images straight into the date folder with no platform
 * subfolder at all. Counsel gets more from one Website capture plus one Amazon
 * capture than from five consecutive frames of the same product page, so the
 * selection takes one from each platform before it takes a second from any.
 */

import type Database from 'better-sqlite3'
import path from 'node:path'
import { parseEvidenceFolderName } from '../../shared/domain/naming'
import type { ScreenshotExhibit } from '../../shared/domain/summaryPrompt'

export interface ShotRow {
  path: string
  datedAt: string | null
  mtime: string | null
}

/**
 * The platform a capture was filed under, or null when it sat loose in the
 * date folder. The immediate parent is the platform unless it parses as a
 * capture-session date, in which case there is no platform subfolder.
 */
export function platformOf(filePath: string): string | null {
  const parent = path.basename(path.dirname(filePath))
  if (!parent || parseEvidenceFolderName(parent)) return null
  return cleanPlatform(parent)
}

const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d/i

/**
 * Folder names carry dates the session parser did not recognise — "April 2026",
 * "Oct 23, 2023", "Amazon - 2:9:26". A date is not a platform, so a purely
 * date-like folder yields none, and a trailing date on a real label is trimmed
 * off it: counsel should read "Amazon", not "Amazon - 2:9:26".
 */
function cleanPlatform(label: string): string | null {
  const trimmed = label
    .replace(/\s+[-–—]\s*(?:[a-z]+\.?\s*)?\d[\d/:.\-\s,]*$/i, '')
    .trim()
  if (!trimmed) return null
  if (MONTH.test(trimmed)) return null
  if (/^\d/.test(trimmed)) return null
  return trimmed
}

/**
 * When the capture was taken.
 *
 * The filename wins: macOS stamps the capture instant into it, and it is the
 * only source present for the 432 captures whose folders carry no date at all.
 * The session folder is the fallback, and mtime the last resort — mtime moves
 * when a file is copied, so it is evidence of filing, not of capture.
 */
export function captureDateOf(row: ShotRow): string | null {
  const name = path.basename(row.path)
  const dashed = name.match(/(20\d{2})-(\d{2})-(\d{2})/)
  const packed = name.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/)
  const m = dashed ?? packed
  if (m) {
    const [, y, mo, d] = m
    const month = Number(mo)
    const day = Number(d)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${y}-${mo}-${d}`
  }
  return row.datedAt ?? (row.mtime ? row.mtime.slice(0, 10) : null)
}

/** Website and Amazon lead: they are where the certified goods are actually sold. */
function platformRank(platform: string | null): number {
  if (!platform) return 3
  const p = platform.toLowerCase()
  if (p.includes('website') || p.includes('site')) return 0
  if (p.includes('amazon')) return 1
  return 2
}

/**
 * Round-robin across platforms, most recent capture first within each.
 *
 * Recency matters because the most recent capture is what proves use is still
 * live at the date of referral; breadth matters because one platform proves one
 * channel. Taking a round at a time gives both.
 */
/**
 * Order one platform's captures so that consecutive picks land on different
 * days. Without this, a case whose captures were all taken in one sitting
 * yields five frames of the same page seconds apart — Yo Mama's Foods has 244
 * screenshots and would otherwise have offered 20:05:53 through 20:07:11 of the
 * same afternoon. Newest day first, then the next day, then back round.
 */
function rotateByDate<T extends { date: string | null; row: ShotRow }>(items: T[]): T[] {
  const byDate = new Map<string, T[]>()
  for (const item of items) {
    const key = item.date ?? ''
    const bucket = byDate.get(key)
    if (bucket) bucket.push(item)
    else byDate.set(key, [item])
  }
  const days = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  for (const [, bucket] of days) bucket.sort((a, b) => a.row.path.localeCompare(b.row.path))

  const out: T[] = []
  for (let round = 0; out.length < items.length; round += 1) {
    let took = false
    for (const [, bucket] of days) {
      const item = bucket[round]
      if (!item) continue
      out.push(item)
      took = true
    }
    if (!took) break
  }
  return out
}

/**
 * Round-robin across platforms, and within a platform across capture days.
 *
 * Breadth first: one Website capture plus one Amazon capture proves two
 * channels, where two Website captures prove one. Recency second: the newest
 * capture is what shows the use is still live at the date of referral.
 */
export function pickExhibits(rows: ShotRow[], limit = 5): ScreenshotExhibit[] {
  const withMeta = rows.map((r) => ({
    row: r,
    platform: platformOf(r.path),
    date: captureDateOf(r)
  }))

  const groups = new Map<string, typeof withMeta>()
  for (const item of withMeta) {
    const key = item.platform?.toLowerCase() ?? ''
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }

  const ordered = [...groups.values()]
    .sort(
      (a, b) =>
        platformRank(a[0]!.platform) - platformRank(b[0]!.platform) ||
        (a[0]!.platform ?? '').localeCompare(b[0]!.platform ?? '')
    )
    .map(rotateByDate)

  const picked: typeof withMeta = []
  for (let round = 0; picked.length < limit; round += 1) {
    let tookAny = false
    for (const bucket of ordered) {
      const item = bucket[round]
      if (!item) continue
      picked.push(item)
      tookAny = true
      if (picked.length >= limit) break
    }
    if (!tookAny) break
  }

  return picked.map((item, i) => ({
    label: String.fromCharCode(65 + i),
    path: item.row.path,
    fileName: path.basename(item.row.path),
    platform: item.platform,
    date: item.date
  }))
}

export function selectReferralScreenshots(
  db: Database.Database,
  caseId: number,
  limit = 5
): ScreenshotExhibit[] {
  const rows = db
    .prepare(
      `SELECT path, dated_at AS datedAt, mtime FROM evidence_files
       WHERE case_id = ? AND kind = 'screenshot' AND path IS NOT NULL`
    )
    .all(caseId) as ShotRow[]
  return pickExhibits(rows, limit)
}

export interface EncodedExhibit extends ScreenshotExhibit {
  /** JPEG bytes, base64, ready for the Docs service. */
  dataBase64: string
  mimeType: 'image/jpeg'
  /** Display size in points, pre-fitted to the text column. */
  widthPt: number
  heightPt: number
}

/** US Letter minus one-inch margins, and a height that leaves room for a caption. */
const COLUMN_PT = 468
const MAX_IMAGE_PT = 520

/**
 * Downscale to 1600px on the long edge and re-encode as JPEG.
 *
 * Raw retina PNGs are several megabytes each and five of them overrun the
 * Cloud Run request cap — the same limit that forced downscaling in v1's PDF
 * path. `electron` is imported lazily so the selection logic above stays
 * testable outside a running app.
 */
export async function encodeExhibits(shots: ScreenshotExhibit[]): Promise<EncodedExhibit[]> {
  const { nativeImage } = await import('electron')
  const out: EncodedExhibit[] = []
  for (const s of shots) {
    let img = nativeImage.createFromPath(s.path)
    if (img.isEmpty()) continue
    const { width, height } = img.getSize()
    const longest = Math.max(width, height)
    if (longest > 1600) {
      img = width >= height ? img.resize({ width: 1600 }) : img.resize({ height: 1600 })
    }
    const size = img.getSize()
    const scale = Math.min(COLUMN_PT / size.width, MAX_IMAGE_PT / size.height, 1)
    out.push({
      ...s,
      dataBase64: img.toJPEG(82).toString('base64'),
      mimeType: 'image/jpeg',
      widthPt: Math.round(size.width * scale),
      heightPt: Math.round(size.height * scale)
    })
  }
  // Labels are NOT reassigned. They were fixed when the letter was drafted and
  // the prose cites them; renumbering around an unreadable file would silently
  // point counsel at the wrong capture.
  return out
}
