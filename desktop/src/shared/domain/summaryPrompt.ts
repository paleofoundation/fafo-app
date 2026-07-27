/**
 * Legal Referral Summary (SUMMARY v1.0) prompt. Ported verbatim from
 * current-build/src/FAFOApp.jsx genSummary (lines 2291–2399): same 8-section
 * structure, same system prompt, same case-data preamble.
 */

import { MASTER_REF } from './masterRef'

export const SUMMARY_SYSTEM_PROMPT = `You are drafting a Legal Referral Summary for Paleo Certified, Inc. dba The Paleo Foundation per the FAFO SUMMARY v1.0 protocol. Output must be professional, precise, and counsel-ready. Populate every required section. Use formal legal language. Do not add preamble or commentary outside the document structure. Where case data is sparse, note what is unknown rather than fabricating details.`

export interface SummaryInput {
  infringer: string
  contact: string | null
  contactEmail: string | null
  trademarkNames: string[]
  caseType: string
  source: string
  url: string | null
  dateOpened: string
  todayIso: string
  settlement: string | null
  resolvedBy: string | null
  /** chronological "[date] text" lines */
  notes: string[]
  fileNames: string[]
  /** "$amount on date — received|pending" lines */
  payments: string[]
}

export function buildSummaryUserPrompt(c: SummaryInput): string {
  const notesText = c.notes.join('\n')
  const filesText = c.fileNames.join(', ') || 'None on file'
  const paymentsText = c.payments.join('; ') || 'None'
  const resolvedBy = c.resolvedBy ? `Resolved by: ${c.resolvedBy}` : ''

  return `Generate a complete Legal Referral Summary following the FAFO Pathway protocol (SUMMARY v1.0). The document must be counsel-ready and self-contained. Follow the exact 8-section structure below.

CASE DATA:
Complainant: Paleo Certified, Inc. dba The Paleo Foundation
Complainant Contact: Jonathan D. Pendergrass, CLO | jonathand@paleofoundation.org | https://paleofoundation.com/
Respondent: ${c.infringer}
Respondent Contact: ${c.contact || 'Unknown'} | ${c.contactEmail || 'Unknown'}
Trademark(s): ${c.trademarkNames.join('; ')}
Infringement Type: ${c.caseType}
Source / Platform: ${c.source}
URL / Location: ${c.url || 'Not recorded'}
Date Case Opened: ${c.dateOpened}
Date of Referral: ${c.todayIso}
Settlement Position: ${c.settlement || 'TBD'}
${resolvedBy}

Case Notes (chronological):
${notesText || 'None recorded'}

Files on record: ${filesText}
Payments: ${paymentsText}

MASTER REFERENCE CONTEXT:
${MASTER_REF}

REQUIRED OUTPUT STRUCTURE — follow exactly, populate every section:

# LEGAL REFERRAL SUMMARY
Trademark Infringement Matter
Paleo Certified, Inc. dba The Paleo Foundation v. ${c.infringer}
Date of Referral: ${c.todayIso}

# 1. Parties
## 1a. Licensor / Complainant
[Full details]
## 1b. Respondent
[Full details from case data — infer jurisdiction and entity details from context where possible]

# 2. Background
## 2a. Original License Agreement
[Date, parties, signatory, key sections — infer from notes and type. If Expired License, detail the agreement. If Never Certified, note no agreement existed.]
## 2b. License Expiration or Termination
[Date and method — from notes]
## 2c. Asset Acquisition / Change of Ownership (if applicable)
[Include only if type is Change in Ownership — otherwise omit]

# 3. Infringement
## 3a. Nature and Duration
[Start date, most recent confirmed use, total months]
## 3b. Platforms and URLs
[All platforms from source/URL fields and notes]
## 3c. Standards Violations (if applicable)
[If noted in case notes]
## 3d. Evidence of Knowledge
[Any relevant evidence of knowledge from notes]

# 4. Correspondence Timeline
[Reconstruct from notes — one entry per note with date, sender, content summary. Flag: initial notice, first response, any broken representations, final pre-referral correspondence, any explicit invitation to escalate.]

# 5. Defenses Raised and Rebuttals
[Extract any defenses from notes. If none recorded, state "No formal defenses raised as of referral date."]

# 6. Current Settlement Position
## 6a. Options Presented
[From settlement field — parse Option 1 / Option 2 if structured, otherwise present as stated]
## 6b. Basis for Calculation
[From MASTER_REF pricing bands + duration. Calculate based on type and pricing band.]
## 6c. Respondent's Stated Position
[From notes — accepted, rejected, or open]
## 6d. Note to Counsel
[Flag duration, breadth, willfulness if second infringement. Recommend upward revision if warranted.]

# 7. Evidence on File
[List all files attached to case. Include any URLs from notes that were captured as evidence.]

# 8. Recommended Counsel Actions
## 8a. Jurisdiction
[Lanham Act §1114 + §1125(a) for U.S. If Canadian entity, note Canadian Trademarks Act RSC 1985 as applicable. Reference license jurisdiction clause.]
## 8b. Liability Assessment
[Individual vs entity. Signatory continuity if applicable.]
## 8c. Available Remedies
[Injunctive relief, damages, account of profits, delivery up, statutory damages]
## 8d. Verification Actions
[Standard checklist: full cessation across all platforms, Amazon/retail lag, cached/archived pages]

---
Prepared by: Jonathan D. Pendergrass, CLO | The Paleo Foundation | jonathand@paleofoundation.org | ${c.todayIso}
FAFO Workflow | Paleo Certified, Inc. dba The Paleo Foundation | Protocol: SUMMARY v1.0`
}
