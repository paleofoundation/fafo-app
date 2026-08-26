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
  /** What is actually on the case, not a filename dump — see EvidenceManifest. */
  evidence: EvidenceManifest
  /** Dated inter-party messages, extracted from correspondence on file. */
  correspondence: string[]
  /** Open clocks counsel inherits: sell-off end, response deadlines. */
  deadlines: string[]
  /** "$amount on date — received|pending" lines */
  payments: string[]
}

/**
 * The evidence actually held for a case.
 *
 * Screenshots collapse into dated capture sessions rather than listing 160
 * filenames: counsel needs to know that use was captured on eleven dates
 * spanning fourteen months, not to read every PNG name. Documents — the
 * agreement, letters, emails, court filings — are named individually, because
 * each is a distinct exhibit.
 */
export interface EvidenceManifest {
  total: number
  byKind: Array<{ kind: string; count: number }>
  documents: Array<{ name: string; kind: string; date: string | null }>
  captureSessions: Array<{ date: string; count: number }>
  earliest: string | null
  latest: string | null
}

export function renderEvidence(e: EvidenceManifest): string {
  if (e.total === 0) {
    return 'NO evidence files are indexed for this case in FAFO.'
  }
  const lines = [
    `${e.total} files indexed` +
      (e.earliest && e.latest ? `, dated ${e.earliest} to ${e.latest}` : ''),
    'By kind: ' + e.byKind.map((k) => `${k.count} ${k.kind}`).join(', '),
  ]
  if (e.captureSessions.length) {
    lines.push(
      'Capture sessions (dated screenshot sets evidencing use): ' +
        e.captureSessions.map((c) => `${c.date} (${c.count})`).join(', ')
    )
  }
  if (e.documents.length) {
    lines.push('Documents on file:')
    for (const d of e.documents) {
      lines.push(`  - [${d.kind}] ${d.name}${d.date ? ` (${d.date})` : ''}`)
    }
  }
  return lines.join('\n')
}

export function buildSummaryUserPrompt(c: SummaryInput): string {
  const notesText = c.notes.join('\n')
  const evidenceText = renderEvidence(c.evidence)
  const correspondenceText = c.correspondence.length
    ? c.correspondence.join('\n')
    : 'No inter-party correspondence has been extracted into the case record.'
  const deadlinesText = c.deadlines.length ? c.deadlines.join('\n') : 'None recorded'
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

EVIDENCE ON FILE:
${evidenceText}

CORRESPONDENCE ON RECORD (dated, extracted from the documents above):
${correspondenceText}

OPEN DEADLINES (clocks counsel inherits):
${deadlinesText}

Payments: ${paymentsText}

MASTER REFERENCE CONTEXT:
${MASTER_REF}

REQUIRED OUTPUT STRUCTURE — follow exactly, populate every section:

# LEGAL REFERRAL SUMMARY
Trademark Infringement Matter
Paleo Certified, Inc. dba The Paleo Foundation v. ${c.infringer}
Date of Referral: ${c.todayIso}

EVIDENTIARY RULE — this document is relied on by outside counsel:
Distinguish "not in the record provided" from "does not exist". Where a fact is
absent from the case data above, write that it is not in the record and should be
confirmed — never assert that a thing did not happen, was never sent, or is
missing from the file. Do not characterise the record as deficient on the basis of
data you were not given. Facts supplied above (licensee name, address, term dates,
fee, evidence counts and dates) are extracted from source documents: reproduce them
verbatim rather than inferring or restating them approximately.

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
[Reproduce the EVIDENCE ON FILE block above: total, breakdown by kind, capture-session dates, and each named document. Add any URLs from notes that were captured as evidence. Never omit this section. If the block states no files are indexed, say exactly that — do not infer that no evidence exists in the world.]

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
