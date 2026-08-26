import { describe, expect, it } from 'vitest'
import { PRICING_BANDS, bandByNumeral, bandForRevenue } from '../pricingBands'
import { addDays, daysUntil, isOverdue, monthsOfContinuedUse, selloffEnd } from '../deadlines'
import {
  ldCompromiseRange,
  ldOpeningDemand,
  legacyAnchor,
  legacyOpeningRange,
  selloffExtensionPrice,
  settlementPosition
} from '../settlementMath'
import {
  exportFilename,
  normalizeCompanyName,
  parseAgreementTemplateName,
  parseCaseFolderName,
  parseEvidenceFolderName,
  parseSignnowGroupName,
  safeFilename
} from '../naming'
import { AMANDA_SYSTEM_PROMPT, buildAmandaUserPrompt } from '../amandaPrompts'
import { buildSummaryUserPrompt, renderEvidence } from '../summaryPrompt'

describe('sell-off deadlines (§E.3.c)', () => {
  it('sell-off = license end + 180 days', () => {
    // Healthy Crunch: license expired 2025-11-26 → sell-off ends 2026-05-25
    expect(selloffEnd('2025-11-26', '2025')).toBe('2026-05-25')
  })

  it('2020-vintage agreements have NO sell-off period', () => {
    // Love Good Foods / The Good Fat Co: 2020 agreement, expired 2023-07-30
    expect(selloffEnd('2023-07-30', '2020')).toBeNull()
  })

  it('addDays crosses year boundaries in UTC', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29') // leap year
  })

  it('months of continued use round partial months up', () => {
    expect(monthsOfContinuedUse('2025-11-26', '2025-11-26')).toBe(0)
    expect(monthsOfContinuedUse('2025-11-26', '2025-12-01')).toBe(1)
    expect(monthsOfContinuedUse('2025-11-26', '2026-02-26')).toBe(3)
    expect(monthsOfContinuedUse('2025-11-26', '2026-02-27')).toBe(4)
  })

  it('overdue and daysUntil', () => {
    expect(isOverdue('2026-05-25', '2026-07-27')).toBe(true)
    expect(daysUntil('2026-07-30', '2026-07-27')).toBe(3)
    expect(daysUntil('2026-07-24', '2026-07-27')).toBe(-3)
  })
})

describe('pricing bands (2026 guide, §5)', () => {
  it('has exactly 14 bands', () => {
    expect(PRICING_BANDS).toHaveLength(14)
  })

  it('looks up bands by revenue with correct boundaries', () => {
    expect(bandForRevenue(0).numeral).toBe('I')
    expect(bandForRevenue(99_999).numeral).toBe('I')
    expect(bandForRevenue(100_000).numeral).toBe('II')
    expect(bandForRevenue(750_000).numeral).toBe('III')
    expect(bandForRevenue(750_000).oneYear).toBe(10_000)
    expect(bandForRevenue(3_000_000).numeral).toBe('IV')
    expect(bandForRevenue(1_000_000_000).numeral).toBe('XIV')
    // above published table clamps to top band
    expect(bandForRevenue(10_000_000_000).numeral).toBe('XIV')
  })

  it('band XIV fees match the guide', () => {
    const b = bandByNumeral('xiv')!
    expect(b.oneYear).toBe(225_000)
    expect(b.twoYear).toBe(405_000)
    expect(b.threeYear).toBe(540_000)
  })
})

describe('settlement math (§9)', () => {
  it('LD opening: one year fee per month of misuse', () => {
    expect(ldOpeningDemand(10_000, 3)).toBe(30_000)
    expect(ldOpeningDemand(4_000, 6)).toBe(24_000)
  })

  it('LD compromise is 80–85% of opening', () => {
    // Rawcology position: $30,000 opening / $25,000 compromise — 83.3% sits inside the band
    const r = ldCompromiseRange(30_000)
    expect(r.low).toBe(24_000)
    expect(r.high).toBe(25_500)
    expect(25_000).toBeGreaterThanOrEqual(r.low)
    expect(25_000).toBeLessThanOrEqual(r.high)
  })

  it('legacy anchor: current 1-yr fee × years (partial years up)', () => {
    expect(legacyAnchor(10_000, 3)).toBe(30_000)
    expect(legacyAnchor(10_000, 2.2)).toBe(30_000)
  })

  it('legacy opening range is 2–3× original fee', () => {
    const r = legacyOpeningRange(7_000)
    expect(r).toEqual({ low: 14_000, high: 21_000 })
  })

  it('sell-off extension: half annual fee per 6 months', () => {
    expect(selloffExtensionPrice(10_000, 6)).toBe(5_000)
    expect(selloffExtensionPrice(10_000, 12)).toBe(10_000)
    expect(selloffExtensionPrice(10_000, 7)).toBe(10_000)
    // Yoleez precedent: $5,250 extension = half of a $10,500 annual fee for 6 months
    expect(selloffExtensionPrice(10_500, 6)).toBe(5_250)
  })

  it('settlementPosition selects formula by vintage', () => {
    const ld = settlementPosition({ vintage: '2025', annualFee: 10_000, monthsOfMisuse: 3 })
    expect(ld.formula).toBe('ld')
    expect(ld.opening).toBe(30_000)

    const legacy = settlementPosition({
      vintage: '2020',
      annualFee: 10_000,
      monthsOfMisuse: 36,
      originalLicenseFee: 7_000
    })
    expect(legacy.formula).toBe('legacy')
    expect(legacy.opening).toBe(30_000)
    expect(legacy.compromise).toEqual({ low: 14_000, high: 21_000 })
  })
})

describe('naming parsers (LEGAL archive conventions)', () => {
  it('parses mark-bundle template names', () => {
    const p = parseAgreementTemplateName('CP:K:PF:GF:PV License Agreement 2025.pages')!
    expect(p.markCodes).toEqual(['CP', 'KETO', 'PF', 'GF', 'PV'])
    expect(p.year).toBe(2025)
    expect(p.category).toBeNull()
  })

  it('parses category-coded template names', () => {
    const p = parseAgreementTemplateName('GF License Agreement 2025 - Cat B.pages')!
    expect(p.markCodes).toEqual(['GF'])
    expect(p.category).toBe('B')
  })

  it('parses SignNow group names', () => {
    expect(parseSignnowGroupName('RAWCOLOGY INC. License Agreement 2025')).toEqual({
      company: 'RAWCOLOGY INC.',
      year: 2025
    })
    expect(
      parseSignnowGroupName('REDLANDS FARM HOLDING CORP. DBA FRESH PRESS FARMS License Agreement 2026')!
        .company
    ).toBe('REDLANDS FARM HOLDING CORP. DBA FRESH PRESS FARMS')
  })

  it('parses dated evidence folders incl. label + x-prefix variants', () => {
    expect(parseEvidenceFolderName('August 15, 2022')).toEqual({ isoDate: '2022-08-15', label: null })
    expect(parseEvidenceFolderName('March 5, 2024 - Purchased Packaging')).toEqual({
      isoDate: '2024-03-05',
      label: 'Purchased Packaging'
    })
    expect(parseEvidenceFolderName('xJanuary 24, 2024')?.isoDate).toBe('2024-01-24')
    expect(parseEvidenceFolderName('Emails')).toBeNull()
  })

  it('parses brand/parent case folder names', () => {
    expect(parseCaseFolderName('4505 Meats : Evans Food Group')).toEqual({
      primaryName: '4505 Meats',
      relatedEntity: 'Evans Food Group'
    })
    expect(parseCaseFolderName('Terrafertil:Nestle')).toEqual({
      primaryName: 'Terrafertil',
      relatedEntity: 'Nestle'
    })
    expect(parseCaseFolderName('Rawcology')).toEqual({ primaryName: 'Rawcology', relatedEntity: null })
  })

  it('normalizes company names for cross-source matching', () => {
    expect(normalizeCompanyName('RAWCOLOGY INC.')).toBe(normalizeCompanyName('Rawcology'))
    expect(normalizeCompanyName('The Healthy Crunch Company')).toBe(
      normalizeCompanyName('Healthy Crunch Co.')
    )
  })

  it('safe export filenames never contain path separators', () => {
    expect(safeFilename('Ayoba/Stromberg: Ltd.')).toBe('Ayoba_Stromberg_Ltd')
    expect(exportFilename('Referral Summary', 'MCB Star LLC (Zint)', '2026-06-15', 'docx')).toBe(
      'FAFO_Referral_Summary_MCB_Star_LLC_Zint_2026-06-15.docx'
    )
  })
})

describe('prompt builders (verbatim protocol carry-over)', () => {
  it('AMANDA system prompt keeps the protocol invariants', () => {
    expect(AMANDA_SYSTEM_PROMPT).toContain('Facts→Authority')
    expect(AMANDA_SYSTEM_PROMPT).toContain('Sign off "Regards,"')
    expect(AMANDA_SYSTEM_PROMPT).toContain('Absent a response, we will proceed accordingly.')
    expect(AMANDA_SYSTEM_PROMPT).toContain('§1114 + §1125(a)')
  })

  it('AMANDA user prompt carries case facts', () => {
    const p = buildAmandaUserPrompt({
      trademarkNames: ['THIS PRODUCT IS KETO CERTIFIED KETOCERTIFIED.COM'],
      infringer: 'Rawcology Inc.',
      caseType: 'Expired License',
      source: 'Website',
      url: 'rawcology.com',
      dateOpened: '2025-07-01',
      settlement: '$30,000 opening / $25,000 compromise',
      notes: ['Second infringement — prior settlement July 2025.']
    })
    expect(p).toContain('Rawcology Inc.')
    expect(p).toContain('Second infringement')
  })

  it('SUMMARY prompt contains all 8 required sections', () => {
    const p = buildSummaryUserPrompt({
      infringer: 'Little West (WS West LLC)',
      contact: null,
      contactEmail: null,
      trademarkNames: ['CERTIFIED P PALEO'],
      caseType: 'Unlicensed Use - Never Certified',
      source: 'Website',
      url: 'littlewest.com',
      dateOpened: '2025-01-01',
      todayIso: '2026-07-27',
      settlement: 'Litigation — default judgment pending',
      resolvedBy: null,
      notes: ['[2025-06-01] Case filed: 3:25-cv-02823-RBM-BJW'],
      evidence: {
        total: 0,
        byKind: [],
        documents: [],
        captureSessions: [],
        earliest: null,
        latest: null
      },
      correspondence: [],
      deadlines: [],
      payments: []
    })
    for (const section of [
      '# 1. Parties',
      '# 2. Background',
      '# 3. Infringement',
      '# 4. Correspondence Timeline',
      '# 5. Defenses Raised and Rebuttals',
      '# 6. Current Settlement Position',
      '# 7. Evidence on File',
      '# 8. Recommended Counsel Actions'
    ]) {
      expect(p).toContain(section)
    }
    expect(p).toContain('Protocol: SUMMARY v1.0')
  })
})

describe('referral evidence manifest', () => {
  const manifest = {
    total: 43,
    byKind: [
      { kind: 'screenshot', count: 38 },
      { kind: 'letter', count: 2 },
      { kind: 'agreement', count: 1 },
      { kind: 'email', count: 1 },
      { kind: 'other', count: 1 }
    ],
    documents: [
      { name: 'Awake Chocolate License Agreement 2025.pdf', kind: 'agreement', date: '2025-04-22' },
      { name: 'Re Upcoming Certification Renewal.pdf', kind: 'email', date: '2026-04-15' }
    ],
    captureSessions: [
      { date: '2026-06-02', count: 12 },
      { date: '2026-08-05', count: 26 }
    ],
    earliest: '2025-04-22',
    latest: '2026-08-05'
  }

  it('collapses screenshots to capture sessions but names each document', () => {
    const out = renderEvidence(manifest)
    expect(out).toContain('43 files indexed')
    expect(out).toContain('2026-06-02 (12)')
    expect(out).toContain('Awake Chocolate License Agreement 2025.pdf')
    // The point of sessions: dates, not 38 PNG filenames.
    expect(out).not.toContain('.png')
  })

  it('says only that nothing is INDEXED, never that no evidence exists', () => {
    const out = renderEvidence({
      total: 0, byKind: [], documents: [], captureSessions: [], earliest: null, latest: null
    })
    expect(out).toContain('indexed')
    expect(out.toLowerCase()).not.toContain('no evidence exists')
  })

  it('puts the evidence, correspondence and deadlines into the prompt', () => {
    const p = buildSummaryUserPrompt({
      infringer: 'Awake Chocolate',
      contact: null, contactEmail: null,
      trademarkNames: ['CERTIFIED P PALEO'],
      caseType: 'Expired License', source: 'Website', url: null,
      dateOpened: '2026-04-22', todayIso: '2026-08-26',
      settlement: null, resolvedBy: null, notes: [],
      evidence: manifest,
      correspondence: ['[2026-04-15] (email) Kennedy Velikonja: renewal under internal review.'],
      deadlines: ['[due 2026-10-18] (selloff end) Awake Chocolate — sell-off window closes'],
      payments: []
    })
    expect(p).toContain('43 files indexed')
    expect(p).toContain('Kennedy Velikonja')
    expect(p).toContain('sell-off window closes')
    // The rule that keeps counsel from being told a gap exists that does not.
    expect(p).toContain('not in the record provided')
  })
})
