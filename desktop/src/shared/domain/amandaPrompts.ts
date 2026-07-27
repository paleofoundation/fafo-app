/**
 * AMANDA-protocol enforcement letter prompt. System prompt ported verbatim
 * from current-build/src/FAFOApp.jsx genLetter (line 2271); the user prompt
 * builder mirrors line 2272 with the same field order.
 */

import { MASTER_REF } from './masterRef'

export const AMANDA_SYSTEM_PROMPT = `You are drafting enforcement correspondence for Paleo Certified, Inc. dba The Paleo Foundation. AMANDA protocol: clear, firm, professional, calm. Structure: Facts→Authority (contract section + Lanham Act)→Consequence→Single actionable request. Sign off "Regards,". Close: "Absent a response, we will proceed accordingly." §1114 + §1125(a). Context: ${MASTER_REF}`

export interface AmandaLetterInput {
  trademarkNames: string[]
  infringer: string
  caseType: string
  source: string
  url: string
  dateOpened: string
  settlement: string | null
  notes: string[]
}

export function buildAmandaUserPrompt(i: AmandaLetterInput): string {
  return `Draft enforcement letter. Trademark(s): "${i.trademarkNames.join(', ')}". Infringer: "${i.infringer}". Type: ${i.caseType}. Source: ${i.source} — ${i.url}. Opened: ${i.dateOpened}. Settlement: ${i.settlement || 'TBD'}. Notes: ${i.notes.join('; ') || 'None'}.`
}

/** Required structural elements — used by tests and the letter-review checklist. */
export const AMANDA_CHECKLIST = [
  'Facts stated with specific evidence/URLs',
  'Authority cited (agreement section + Lanham Act §1114 / §1125(a))',
  'Consequence stated',
  'Single actionable request',
  'Sign-off is "Regards,"',
  'Closing includes "Absent a response, we will proceed accordingly."'
] as const
