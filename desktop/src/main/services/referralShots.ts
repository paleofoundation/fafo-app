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
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}
const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Pull a date out of a file or folder name.
 *
 * Three shapes appear in the archive: ISO (2026-07-19), packed
 * (PXL_20260719_…, the phone-camera and screenshot convention), and long form
 * ("Order - July 19, 2026", "Sept 14 2021"). The long form is why the July 19
 * test-purchase folder read as undated — the scanner only knew the first two.
 */
export function parseNameDate(s: string): string | null {
  const named = s.match(
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/i
  )
  if (named) {
    const mo = MONTHS[named[1]!.toLowerCase().slice(0, 3)]!
    const day = Number(named[2])
    if (day >= 1 && day <= 31) return `${named[3]}-${pad(mo)}-${pad(day)}`
  }
  const dashed = s.match(/(20\d{2})-(\d{2})-(\d{2})/)
  const packed = s.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/)
  const m = dashed ?? packed
  if (m) {
    const [, y, mo, d] = m
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31)
      return `${y}-${mo}-${d}`
  }
  return null
}

/**
 * The date to file a piece of evidence under, best source first: a date parsed
 * from the scan (folder), then the file's own name, then its parent folder's
 * name, then the filesystem mtime as a last resort (mtime moves when a file is
 * copied, so it evidences filing, not capture).
 */
export function evidenceDate(
  fullPath: string,
  datedAt: string | null,
  mtime: string | null
): string | null {
  return (
    datedAt ??
    parseNameDate(path.basename(fullPath)) ??
    parseNameDate(path.basename(path.dirname(fullPath))) ??
    (mtime ? mtime.slice(0, 10) : null)
  )
}

export function captureDateOf(row: ShotRow): string | null {
  // Filename first here (not folder), because for exhibit selection the capture
  // instant in the filename is what orders shots by recency within a session.
  return (
    parseNameDate(path.basename(row.path)) ??
    row.datedAt ??
    parseNameDate(path.basename(path.dirname(row.path))) ??
    (row.mtime ? row.mtime.slice(0, 10) : null)
  )
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
 * Choose the captures a referral reproduces.
 *
 * The first and last captures are pinned: together they are the duration
 * argument, showing the mark in use on the earliest date the file records and
 * still in use on the most recent. The middle three go to breadth — each pick
 * takes the platform least represented so far, so a case with website, Amazon
 * and Instagram evidence shows all three rather than three views of a store
 * page. Output is chronological, so the section reads as a span of time.
 */
export function pickExhibits(rows: ShotRow[], limit = 5): ScreenshotExhibit[] {
  type Item = { row: ShotRow; platform: string | null; date: string | null }
  const items: Item[] = rows.map((r) => ({
    row: r,
    platform: platformOf(r.path),
    date: captureDateOf(r)
  }))
  if (items.length === 0) return []

  const byDate = (a: Item, b: Item): number =>
    (a.date ?? '').localeCompare(b.date ?? '') || a.row.path.localeCompare(b.row.path)
  const chronological = [...items].sort(byDate)

  // An undated capture cannot anchor either end of the span.
  const earliest = chronological.find((i) => i.date) ?? chronological[0]!
  const latest =
    [...chronological].reverse().find((i) => i.date && i !== earliest) ??
    chronological[chronological.length - 1]!

  const picked: Item[] = [earliest]
  if (latest !== earliest && picked.length < limit) picked.push(latest)

  const pool = items.filter((i) => !picked.includes(i))
  while (picked.length < limit && pool.length > 0) {
    const seen = new Map<string, number>()
    for (const p of picked) seen.set(p.platform?.toLowerCase() ?? '', (seen.get(p.platform?.toLowerCase() ?? '') ?? 0) + 1)
    const dates = new Set(picked.map((p) => p.date))

    let best = 0
    for (let i = 1; i < pool.length; i += 1) {
      const a = pool[i]!
      const b = pool[best]!
      // Rank by how much a pick ADDS: a capture on a new channel and a new day
      // adds most, one that repeats both adds nothing. Ranking by channel alone
      // failed on Buddha Brands, whose only two channels are single-session —
      // once both were covered it spent the last slot on a second frame of the
      // same minute while six unused capture dates sat in the pool.
      const key = (x: Item): [number, number, number, string] => {
        const channelSeen = (seen.get(x.platform?.toLowerCase() ?? '') ?? 0) > 0 ? 1 : 0
        const daySeen = dates.has(x.date) ? 1 : 0
        return [
          channelSeen + daySeen,
          channelSeen, // a new channel beats a new day when both add one thing
          platformRank(x.platform),
          // Most recent within all that: the newest capture on a channel is the
          // one that shows the channel is still live.
          x.date ? String(9999 - Number(x.date.slice(0, 4))) + x.date.slice(5) : 'zzzz'
        ]
      }
      const [ka, kb] = [key(a), key(b)]
      for (let k = 0; k < ka.length; k += 1) {
        if (ka[k] === kb[k]) continue
        if (ka[k]! < kb[k]!) best = i
        break
      }
    }
    picked.push(pool.splice(best, 1)[0]!)
  }

  return picked.sort(byDate).map((item, i) => ({
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
