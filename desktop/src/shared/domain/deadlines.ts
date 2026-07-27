/**
 * Deadline math. Source: docs/FAFO_App_Master_Reference.md §4, §13.
 * Dates are ISO `YYYY-MM-DD` strings computed in UTC so results never
 * shift with the machine's timezone.
 */

export type AgreementVintage = '2020' | '2025'

export const SELL_OFF_DAYS = 180

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${isoDate}`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Sell-off window end: license end + 180 days — physical inventory only,
 * never websites/social/marketing/retail listings (§E.3.c).
 * 2020-vintage agreements have NO sell-off period (immediate cessation),
 * so this returns null for them. Termination for cause also voids sell-off;
 * callers handle that upstream.
 */
export function selloffEnd(licenseEnd: string, vintage: AgreementVintage): string | null {
  if (vintage === '2020') return null
  return addDays(licenseEnd, SELL_OFF_DAYS)
}

/** Whole months of continued misuse between license end (or selloff end) and an observation date — for E.3.d.ii liquidated damages. Partial months round up: any use inside a month accrues that month. */
export function monthsOfContinuedUse(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`)
  const to = new Date(`${toIso}T00:00:00Z`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error(`Invalid date range: ${fromIso} → ${toIso}`)
  }
  if (to <= from) return 0
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  if (to.getUTCDate() > from.getUTCDate()) months += 1
  return Math.max(months, 1)
}

/**
 * Response-clock due date per the communication protocol (§15): "Respond by
 * end of day Thursday." Returns the coming Thursday when it gives the
 * recipient at least 3 days; otherwise the following Thursday.
 */
export function nextResponseThursday(sentIso: string): string {
  const d = new Date(`${sentIso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${sentIso}`)
  const THURSDAY = 4
  let days = (THURSDAY - d.getUTCDay() + 7) % 7
  if (days === 0) days = 7 // sent on a Thursday → next week's
  if (days < 3) days += 7 // too tight → following Thursday
  return addDays(sentIso, days)
}

export function isOverdue(dueIso: string, todayIso: string): boolean {
  return dueIso < todayIso
}

export function daysUntil(dueIso: string, todayIso: string): number {
  const due = new Date(`${dueIso}T00:00:00Z`).getTime()
  const today = new Date(`${todayIso}T00:00:00Z`).getTime()
  return Math.round((due - today) / 86_400_000)
}
