/**
 * Settlement formulas. Source: docs/FAFO_App_Master_Reference.md §9,
 * ported from current-build/src/FAFOApp.jsx MASTER_REF settlement framework.
 *
 * Two regimes, selected by agreement vintage:
 *  - 2025-template agreements have the E.3.d.ii liquidated-damages clause:
 *    opening demand = one year's license fee per month of continued misuse.
 *  - 2020 legacy agreements have no LD clause: anchor to the CURRENT pricing
 *    schedule (current 1-yr fee × years of unauthorized use), with a typical
 *    opening range of 2–3× the original license fee.
 */

import type { AgreementVintage } from './deadlines'

export interface DemandRange {
  low: number
  high: number
}

/** E.3.d.ii: one year's license fee per month of continued misuse. */
export function ldOpeningDemand(annualFee: number, monthsOfMisuse: number): number {
  assertPositive(annualFee, 'annualFee')
  if (monthsOfMisuse < 0) throw new Error('monthsOfMisuse must be >= 0')
  return annualFee * monthsOfMisuse
}

/** Compromise offer, typically 80–85% of the opening demand. */
export function ldCompromiseRange(openingDemand: number): DemandRange {
  assertPositive(openingDemand, 'openingDemand')
  return { low: Math.round(openingDemand * 0.8), high: Math.round(openingDemand * 0.85) }
}

/** Legacy (no LD clause): current 1-yr fee × whole years of unauthorized use (partial years round up — use accrued in a year anchors that year). */
export function legacyAnchor(currentOneYearFee: number, yearsOfUse: number): number {
  assertPositive(currentOneYearFee, 'currentOneYearFee')
  if (yearsOfUse <= 0) throw new Error('yearsOfUse must be > 0')
  return currentOneYearFee * Math.ceil(yearsOfUse)
}

/** Legacy typical opening range: 2–3× the original license fee. */
export function legacyOpeningRange(originalLicenseFee: number): DemandRange {
  assertPositive(originalLicenseFee, 'originalLicenseFee')
  return { low: originalLicenseFee * 2, high: originalLicenseFee * 3 }
}

/** Sell-off extension pricing: half the annual license fee per additional 6 months (§4). */
export function selloffExtensionPrice(annualFee: number, extensionMonths: number): number {
  assertPositive(annualFee, 'annualFee')
  if (extensionMonths <= 0) throw new Error('extensionMonths must be > 0')
  return (annualFee / 2) * Math.ceil(extensionMonths / 6)
}

export interface SettlementInput {
  vintage: AgreementVintage
  annualFee: number
  monthsOfMisuse: number
  originalLicenseFee?: number
}

export interface SettlementPosition {
  formula: 'ld' | 'legacy'
  opening: number
  compromise: DemandRange
  notes: string
}

export function settlementPosition(input: SettlementInput): SettlementPosition {
  if (input.vintage === '2025') {
    const opening = ldOpeningDemand(input.annualFee, input.monthsOfMisuse)
    return {
      formula: 'ld',
      opening,
      compromise: ldCompromiseRange(opening),
      notes:
        'Anchored to §E.3.d.ii liquidated damages: one year’s license fee per month of continued misuse. Not a penalty; does not limit other remedies (never agree to LD as sole remedy).'
    }
  }
  const years = Math.max(input.monthsOfMisuse / 12, 1 / 12)
  const opening = legacyAnchor(input.annualFee, years)
  const range = input.originalLicenseFee
    ? legacyOpeningRange(input.originalLicenseFee)
    : ldCompromiseRange(opening)
  return {
    formula: 'legacy',
    opening,
    compromise: range,
    notes:
      '2020 legacy agreement — no liquidated damages clause. Anchored to current pricing schedule (current 1-yr fee × years of unauthorized use); typical opening 2–3× original fee.'
  }
}

function assertPositive(n: number, name: string): void {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
}
