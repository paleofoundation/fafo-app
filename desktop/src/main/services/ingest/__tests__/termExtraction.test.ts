import { describe, expect, it } from 'vitest'
import { bandFromFee, parseFeeToCents } from '../termExtraction'

describe('term extraction helpers', () => {
  it('parses fee strings to cents', () => {
    expect(parseFeeToCents('$9,600.00')).toBe(960_000)
    expect(parseFeeToCents('$4,000')).toBe(400_000)
    expect(parseFeeToCents('10000')).toBe(1_000_000)
    expect(parseFeeToCents('$7,000.50')).toBe(700_050)
    expect(parseFeeToCents(null)).toBeNull()
    expect(parseFeeToCents('per the schedule')).toBeNull()
  })

  it('reverse-maps exact published fees to revenue bands', () => {
    expect(bandFromFee(400_000)).toBe('I') // $4,000 = Band I one-year
    expect(bandFromFee(960_000)).toBe('I') // $9,600 = Band I three-year
    expect(bandFromFee(1_000_000)).toBe('III') // $10,000 = Band III one-year
    expect(bandFromFee(2_520_000)).toBe('IV') // $25,200 = Band IV two-year
    expect(bandFromFee(123_456)).toBeNull() // not a published price
    expect(bandFromFee(null)).toBeNull()
  })
})
