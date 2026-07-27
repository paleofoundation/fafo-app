/**
 * 2026 Pricing Guide — one certification.
 * Source: docs/FAFO_App_Master_Reference.md §5 (authoritative).
 * Bands are keyed to LICENSEE revenue, not parent-company revenue,
 * unless the parent company uses the mark.
 */

export interface PricingBand {
  numeral: string
  /** inclusive lower bound of annual revenue in USD */
  minRevenue: number
  /** exclusive upper bound; Infinity for the top band's practical purposes */
  maxRevenue: number
  label: string
  oneYear: number
  twoYear: number
  threeYear: number
}

export const PRICING_BANDS: readonly PricingBand[] = [
  { numeral: 'I',    minRevenue: 0,             maxRevenue: 100_000,       label: 'Under $100k',    oneYear: 4_000,   twoYear: 7_200,   threeYear: 9_600 },
  { numeral: 'II',   minRevenue: 100_000,       maxRevenue: 500_000,       label: '$100k–$499k',    oneYear: 7_000,   twoYear: 12_600,  threeYear: 16_800 },
  { numeral: 'III',  minRevenue: 500_000,       maxRevenue: 1_000_000,     label: '$500k–$999k',    oneYear: 10_000,  twoYear: 18_000,  threeYear: 24_000 },
  { numeral: 'IV',   minRevenue: 1_000_000,     maxRevenue: 5_000_000,     label: '$1M–$4.99M',     oneYear: 14_000,  twoYear: 25_200,  threeYear: 33_600 },
  { numeral: 'V',    minRevenue: 5_000_000,     maxRevenue: 10_000_000,    label: '$5M–$9.99M',     oneYear: 20_000,  twoYear: 36_000,  threeYear: 48_000 },
  { numeral: 'VI',   minRevenue: 10_000_000,    maxRevenue: 20_000_000,    label: '$10M–$19.99M',   oneYear: 28_000,  twoYear: 50_400,  threeYear: 67_200 },
  { numeral: 'VII',  minRevenue: 20_000_000,    maxRevenue: 50_000_000,    label: '$20M–$49.99M',   oneYear: 40_000,  twoYear: 72_000,  threeYear: 96_000 },
  { numeral: 'VIII', minRevenue: 50_000_000,    maxRevenue: 75_000_000,    label: '$50M–$74.99M',   oneYear: 55_000,  twoYear: 99_000,  threeYear: 132_000 },
  { numeral: 'IX',   minRevenue: 75_000_000,    maxRevenue: 100_000_000,   label: '$75M–$99.99M',   oneYear: 70_000,  twoYear: 126_000, threeYear: 168_000 },
  { numeral: 'X',    minRevenue: 100_000_000,   maxRevenue: 200_000_000,   label: '$100M–$199.99M', oneYear: 95_000,  twoYear: 171_000, threeYear: 228_000 },
  { numeral: 'XI',   minRevenue: 200_000_000,   maxRevenue: 500_000_000,   label: '$200M–$499.99M', oneYear: 130_000, twoYear: 234_000, threeYear: 312_000 },
  { numeral: 'XII',  minRevenue: 500_000_000,   maxRevenue: 750_000_000,   label: '$500M–$749.99M', oneYear: 165_000, twoYear: 297_000, threeYear: 396_000 },
  { numeral: 'XIII', minRevenue: 750_000_000,   maxRevenue: 1_000_000_000, label: '$750M–$999.99M', oneYear: 190_000, twoYear: 342_000, threeYear: 456_000 },
  { numeral: 'XIV',  minRevenue: 1_000_000_000, maxRevenue: 5_000_000_000, label: '$1B–$4.99B',     oneYear: 225_000, twoYear: 405_000, threeYear: 540_000 }
] as const

export function bandForRevenue(annualRevenueUsd: number): PricingBand {
  if (annualRevenueUsd < 0 || !Number.isFinite(annualRevenueUsd)) {
    throw new Error(`Invalid revenue: ${annualRevenueUsd}`)
  }
  const band = PRICING_BANDS.find(
    (b) => annualRevenueUsd >= b.minRevenue && annualRevenueUsd < b.maxRevenue
  )
  // Revenue above the published table clamps to the top band.
  return band ?? PRICING_BANDS[PRICING_BANDS.length - 1]!
}

export function bandByNumeral(numeral: string): PricingBand | undefined {
  return PRICING_BANDS.find((b) => b.numeral === numeral.toUpperCase())
}
