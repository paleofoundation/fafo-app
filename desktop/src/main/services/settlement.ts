import type Database from 'better-sqlite3'
import { monthsOfContinuedUse, selloffEnd, type AgreementVintage } from '../../shared/domain/deadlines'
import { settlementPosition } from '../../shared/domain/settlementMath'
import { bandForRevenue, bandByNumeral } from '../../shared/domain/pricingBands'

/**
 * Settlement calculator (M4, improvement 17). Pulls the case's licensee's
 * most recent license, then applies the vintage-appropriate formula from
 * shared/domain/settlementMath. Damages accrue from the sell-off end when a
 * sell-off exists (2025 template), otherwise from the license end date
 * (2020 legacy: immediate cessation required).
 */

export interface SettlementQuote {
  formula: 'ld' | 'legacy'
  opening: number
  compromiseLow: number
  compromiseHigh: number
  monthsOfMisuse: number
  annualFee: number
  vintage: AgreementVintage
  selloffEnd: string | null
  notes: string
}

export function quoteSettlement(
  db: Database.Database,
  caseId: number,
  observedUseThrough?: string
): SettlementQuote {
  const row = db
    .prepare(
      `SELECT li.vintage, li.term_end AS termEnd, li.annual_fee_cents AS annualFeeCents,
              li.revenue_band AS revenueBand
       FROM cases c
       JOIN licenses li ON li.licensee_id = c.licensee_id
       WHERE c.id = ?
       ORDER BY li.term_end IS NULL, li.term_end DESC LIMIT 1`
    )
    .get(caseId) as
    | { vintage: AgreementVintage; termEnd: string | null; annualFeeCents: number | null; revenueBand: string | null }
    | undefined

  if (!row) {
    throw new Error(
      'No license on file for this case — unlicensed-use matters price from the current schedule by revenue band; set a band on the licensee first.'
    )
  }
  if (!row.termEnd) {
    throw new Error('License term end is unknown — run term extraction before quoting a settlement.')
  }

  // Fee: extracted value, else the band's published 1-year price.
  const bandFee = row.revenueBand ? bandByNumeral(row.revenueBand)?.oneYear : undefined
  const annualFee = row.annualFeeCents !== null ? row.annualFeeCents / 100 : (bandFee ?? bandForRevenue(0).oneYear)

  const sellOff = selloffEnd(row.termEnd, row.vintage)
  const accrualStart = sellOff ?? row.termEnd
  const through = observedUseThrough ?? new Date().toISOString().slice(0, 10)
  const months = monthsOfContinuedUse(accrualStart, through)

  const position = settlementPosition({
    vintage: row.vintage,
    annualFee,
    monthsOfMisuse: months,
    originalLicenseFee: row.annualFeeCents !== null ? row.annualFeeCents / 100 : undefined
  })

  const provenance =
    row.annualFeeCents !== null
      ? 'Annual fee from the executed agreement.'
      : row.revenueBand
        ? `Annual fee inferred from revenue band ${row.revenueBand} (no fee extracted).`
        : 'Annual fee defaulted to Band I — set the revenue band or extract the fee for an accurate figure.'

  return {
    formula: position.formula,
    opening: position.opening,
    compromiseLow: position.compromise.low,
    compromiseHigh: position.compromise.high,
    monthsOfMisuse: months,
    annualFee,
    vintage: row.vintage,
    selloffEnd: sellOff,
    notes: `${position.notes} Damages accrue from ${accrualStart} (${sellOff ? 'sell-off end' : 'license end — no sell-off in this agreement'}) through ${through}. ${provenance}`
  }
}
