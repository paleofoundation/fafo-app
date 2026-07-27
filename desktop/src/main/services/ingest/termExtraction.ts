import Anthropic from '@anthropic-ai/sdk'
import { PRICING_BANDS } from '../../../shared/domain/pricingBands'

/**
 * License-term extraction: agreement PDF text → structured terms via the
 * Anthropic API. Electron-free (key injected). Accuracy-first design:
 *  - vintage is decided by CLAUSE PRESENCE (E.3.d.ii liquidated damages /
 *    E.3.c sell-off), not by agreement year
 *  - the model reports per-field confidence; anything below threshold stays
 *    review-flagged rather than silently trusted
 * Prompt lineage: current-build/src/FAFOApp.jsx lines 3383-3417.
 */

export interface ExtractedTerms {
  licenseeLegalName: string | null
  licenseeAddress: string | null
  termStart: string | null
  termEnd: string | null
  /** e.g. "$9,600.00" parsed to cents */
  annualFeeCents: number | null
  markCodes: string[]
  hasLiquidatedDamages: boolean | null
  hasSelloff: boolean | null
  confidence: number
  notes: string | null
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    licensee_legal_name: { type: ['string', 'null'], description: 'Licensee legal entity name from the first paragraph' },
    licensee_address: { type: ['string', 'null'], description: 'Licensee full mailing address from the first paragraph' },
    term_start: { type: ['string', 'null'], description: 'License term start date from Section E.1, format YYYY-MM-DD' },
    term_end: { type: ['string', 'null'], description: 'License term end date from Section E.1, format YYYY-MM-DD' },
    annual_fee: { type: ['string', 'null'], description: 'Annual recurring license fee from Section B.5, e.g. "$9,600.00" — the LICENSE FEE, never a settlement amount' },
    mark_codes: {
      type: 'array',
      items: { type: 'string', enum: ['CP', 'KETO', 'PF', 'GF', 'PB', 'PV'] },
      description: 'Certification programs this agreement licenses: CP=Certified Paleo, KETO=KETO Certified, PF=Paleo Friendly, GF=Grain Free Certified, PB=Plant-Based Certified, PV=Plant-Based/Paleo Vegan Verified'
    },
    has_liquidated_damages: { type: ['boolean', 'null'], description: 'True if the agreement contains a liquidated damages clause for post-termination use (Section E.3.d.ii in the current template: one year’s license fee per month of continued misuse)' },
    has_selloff: { type: ['boolean', 'null'], description: 'True if the agreement grants a post-termination sell-off period for existing inventory (Section E.3.c in the current template: 180 days)' },
    confidence: { type: 'number', description: 'Your overall confidence 0-1 that the extracted term dates and fee are correct' },
    notes: { type: ['string', 'null'], description: 'One short sentence on anything ambiguous (scanned pages, missing sections, amended terms)' }
  },
  required: [
    'licensee_legal_name', 'licensee_address', 'term_start', 'term_end', 'annual_fee',
    'mark_codes', 'has_liquidated_damages', 'has_selloff', 'confidence', 'notes'
  ],
  additionalProperties: false
} as const

const SYSTEM = `You are a legal document parser for Paleo Certified, Inc. dba The Paleo Foundation, a certification-mark licensor. You extract structured license terms from executed certification license agreements. Be precise — extract only what is explicitly stated in the document; use null when a field is absent or illegible. Dates must be exact; if the term is expressed as "one year from the Effective Date", compute the end date only when the effective date is explicit.`

export function parseFeeToCents(fee: string | null): number | null {
  if (!fee) return null
  const m = fee.replace(/[,\s]/g, '').match(/\$?(\d+(?:\.\d{1,2})?)/)
  if (!m) return null
  return Math.round(parseFloat(m[1]!) * 100)
}

/** Reverse band lookup: an annual fee that exactly matches a published 1/2/3-year price identifies the revenue band. */
export function bandFromFee(annualFeeCents: number | null): string | null {
  if (annualFeeCents === null) return null
  const dollars = annualFeeCents / 100
  for (const b of PRICING_BANDS) {
    if (dollars === b.oneYear || dollars === b.twoYear || dollars === b.threeYear) return b.numeral
  }
  return null
}

export async function extractTermsFromText(
  apiKey: string,
  documentName: string,
  pdfText: string
): Promise<ExtractedTerms> {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2000,
    system: SYSTEM,
    output_config: {
      format: { type: 'json_schema', schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown> }
    },
    messages: [
      {
        role: 'user',
        content: `Extract the license terms from this agreement.\n\nDocument name: ${documentName}\n\nDocument text (may be truncated):\n${pdfText.slice(0, 60000)}`
      }
    ]
  })

  if (response.stop_reason === 'refusal') {
    throw new Error('Extraction request was declined by the model')
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  if (!text) throw new Error('Extraction returned no text content')
  const raw = JSON.parse(text) as {
    licensee_legal_name: string | null
    licensee_address: string | null
    term_start: string | null
    term_end: string | null
    annual_fee: string | null
    mark_codes: string[]
    has_liquidated_damages: boolean | null
    has_selloff: boolean | null
    confidence: number
    notes: string | null
  }

  const iso = (d: string | null): string | null =>
    d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null

  return {
    licenseeLegalName: raw.licensee_legal_name,
    licenseeAddress: raw.licensee_address,
    termStart: iso(raw.term_start),
    termEnd: iso(raw.term_end),
    annualFeeCents: parseFeeToCents(raw.annual_fee),
    markCodes: [...new Set(raw.mark_codes)],
    hasLiquidatedDamages: raw.has_liquidated_damages,
    hasSelloff: raw.has_selloff,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    notes: raw.notes
  }
}
