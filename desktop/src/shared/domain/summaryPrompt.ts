/**
 * Legal Referral Summary (SUMMARY v2.0) prompt.
 *
 * v1.0 carried eight sections inherited from the Claude.ai artifact. v2.0 cuts
 * it to the four counsel actually reads: who they are and what they signed, what
 * was said and when, what proves it, and what we are asking for. Background,
 * Infringement, Defenses and Recommended Counsel Actions are gone — the first
 * two restated facts already carried by §1 and §2, the third invited the model
 * to invent defenses nobody had raised, and the fourth had FAFO recommending
 * legal strategy to the lawyers it is briefing.
 */

import { MASTER_REF } from './masterRef'
import { usDate } from './deadlines'

export const SUMMARY_SYSTEM_PROMPT = `You are drafting a Legal Referral Summary for Paleo Certified, Inc. dba The Paleo Foundation per the FAFO SUMMARY v2.0 protocol. Output must be professional, precise, and counsel-ready. Populate every required section. Use formal legal language. Do not add preamble or commentary outside the document structure. Where case data is sparse, note what is unknown rather than fabricating details.`

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
  /** Up to five dated captures embedded in §3 as exhibits. */
  screenshots: ScreenshotExhibit[]
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

/** One capture reproduced in the referral, with the facts that make it evidence. */
export interface ScreenshotExhibit {
  /** "A", "B", … — how counsel cites it. */
  label: string
  path: string
  fileName: string
  /** Website / Amazon / Instagram / … from the folder it was filed under. */
  platform: string | null
  /** Capture date, from the session folder or the filename. */
  date: string | null
}

/**
 * Marker the export replaces with the actual images. The model is told to emit
 * it so the captures land where its prose expects them; if it drops the line,
 * the exporter inserts the block before §4 anyway.
 */
export const SCREENSHOT_MARKER = '[[FAFO:SCREENSHOTS]]'

export function renderEvidence(e: EvidenceManifest): string {
  if (e.total === 0) {
    return 'NO evidence files are indexed for this case in FAFO.'
  }
  const lines = [
    `${e.total} files indexed` +
      (e.earliest && e.latest ? `, dated ${usDate(e.earliest)} to ${usDate(e.latest)}` : ''),
    'By kind: ' + e.byKind.map((k) => `${k.count} ${k.kind}`).join(', '),
  ]
  if (e.captureSessions.length) {
    lines.push(
      'Capture sessions (dated screenshot sets evidencing use): ' +
        e.captureSessions.map((c) => `${usDate(c.date)} (${c.count})`).join(', ')
    )
  }
  if (e.documents.length) {
    lines.push('Documents on file:')
    for (const d of e.documents) {
      lines.push(`  - [${d.kind}] ${d.name}${d.date ? ` (${usDate(d.date)})` : ''}`)
    }
  }
  return lines.join('\n')
}

export function renderScreenshots(shots: ScreenshotExhibit[]): string {
  if (shots.length === 0) {
    return 'No screenshot captures are indexed for this case.'
  }
  return shots
    .map(
      (s) =>
        `Exhibit ${s.label} — ${s.platform ?? 'capture'}, ${s.date ? usDate(s.date) : 'date not recorded'} (${s.fileName})`
    )
    .join('\n')
}

/** Only the change-of-ownership matters carry an acquisition narrative. */
export function isChangeOfOwnership(caseType: string): boolean {
  return /change\s+(in|of)\s+ownership/i.test(caseType)
}

export function buildSummaryUserPrompt(c: SummaryInput): string {
  const notesText = c.notes.join('\n')
  const evidenceText = renderEvidence(c.evidence)
  const screenshotText = renderScreenshots(c.screenshots)
  const correspondenceText = c.correspondence.length
    ? c.correspondence.join('\n')
    : 'No inter-party correspondence has been extracted into the case record.'
  const deadlinesText = c.deadlines.length ? c.deadlines.join('\n') : 'None recorded'
  const paymentsText = c.payments.join('; ') || 'None'
  const resolvedBy = c.resolvedBy ? `Resolved by: ${c.resolvedBy}` : ''
  const acquisition = isChangeOfOwnership(c.caseType)

  // The licence block and the acquisition block are mutually exclusive: an
  // acquirer never held the licence, so reciting a term and fee it was not
  // party to would misstate the relationship counsel has to plead.
  const section1b = acquisition
    ? `## 1b. Asset Acquisition / Change of Ownership
[The acquisition that produced the unauthorised use: what was acquired, from whom, when, and what the acquirer did with the certified goods or marks afterwards. Draw only on the case data and correspondence above. Do NOT include licence term, licence fee, or licensed marks in this matter — the respondent never held the licence.]`
    : `## 1b. License
**Term:** [start and end dates, verbatim from the verified licence facts]
**License Fee:** [annual fee, verbatim]
**Marks Licensed:** [the marks under that licence, with USPTO numbers where supplied]
[If no licence exists on record — an unlicensed party that was never certified — state that plainly and omit the three fields above rather than emitting blanks.]`

  return `Generate a complete Legal Referral Summary following the FAFO Pathway protocol (SUMMARY v2.0). The document must be counsel-ready and self-contained. Follow the exact four-section structure below.

CASE DATA:
Complainant: Paleo Certified, Inc. dba The Paleo Foundation
Complainant Contact: Jonathan D. Pendergrass, CLO | jonathand@paleofoundation.org | https://paleofoundation.com/
Infringing Party: ${c.infringer}
Infringing Party Contact: ${c.contact || 'Unknown'} | ${c.contactEmail || 'Unknown'}
Trademark(s): ${c.trademarkNames.join('; ')}
Infringement Type: ${c.caseType}
Source / Platform: ${c.source}
URL / Location: ${c.url || 'Not recorded'}
Date Case Opened: ${usDate(c.dateOpened)}
Date of Referral: ${usDate(c.todayIso)}
Settlement Position: ${c.settlement || 'TBD'}
${resolvedBy}

Case Notes (chronological):
${notesText || 'None recorded'}

EVIDENCE ON FILE:
${evidenceText}

SCREENSHOT EXHIBITS REPRODUCED IN THIS REFERRAL:
${screenshotText}

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
Date of Referral: ${usDate(c.todayIso)}

DO NOT emit a protocol line, an internal case-opened date, a case-handler line,
a referral-status line, or a classification line. The four header lines above are
the entire header. Do not add sections, appendices or a table of contents beyond
the four numbered sections specified below.

EVIDENTIARY RULE — this document is relied on by outside counsel:
Distinguish "not in the record provided" from "does not exist". Where a fact is
absent from the case data above, write that it is not in the record and should be
confirmed — never assert that a thing did not happen, was never sent, or is
missing from the file. Do not characterise the record as deficient on the basis of
data you were not given. Facts supplied above (licensee name, address, term dates,
fee, evidence counts and dates) are extracted from source documents: reproduce them
verbatim rather than inferring or restating them approximately.

# 1. Contact and License
## 1a. Infringing Party
**Entity Name:** [legal entity name]
**Address:** [full address from the verified licence facts, verbatim]
**Contact:** [named individual]
**Email:** [email address]
[These four fields only. Do not add jurisdiction, entity form, website, business
description, or officers to this subsection.]
${section1b}

# 2. Correspondence Timeline
[A dated list of what happened, drawn from CORRESPONDENCE ON RECORD and the case
notes. One line per event, in exactly this form — date, hyphen, what happened:

  01/27/2022 - Sent renewal request as license expired on 02/23/2022. (agreement has license expiring on 02/11/2022).
  03/29/2022 - Sent followup email for renewal
  09/27/2022 - Found TBE Beverage products in an Erewhon in Venice, CA
  09/28/2022 - Sent email to TBE Beverages notifying them of the infringement
  09/28/2022 - Reply from TBE Beverages to renew certification
  10/31/2022 - Jordan leaves TBE Beverages and hands process over to Brenton Blanchard
  12/01/2022 - Followup with no response

Every date in this document is MM/DD/YYYY — zero-padded, four-digit year — in
the timeline and everywhere else, including licence terms and capture dates. The
case data above is already in that format; reproduce it as given. No commentary, no analysis, no significance, no labels, no
flags, no bold, no table, no grouping headings, and no closing paragraph. When
and what happened, nothing else — counsel draws the inferences.

Include: renewal correspondence and expiry notices; the termination date and the
date it was sent; any stated intention to discontinue, and the date given; every
reply from the respondent, so response times and gaps are visible; anything after
the licence ended bearing on liquidated damages or settlement, including offers,
counter-offers and silence following a demand. A change of contact person is
worth a line. Leave out routine or administrative traffic.

Never include FAFO's own internal housekeeping — imports, status changes,
re-indexing, or file counts. That is not correspondence.

If no correspondence has been extracted into the record, say exactly that: state
that the case documents have not yet been processed into dated entries, not that
no correspondence exists.]

# 3. Evidence
[One short line per exhibit listed in SCREENSHOT EXHIBITS above, in that order,
giving the exhibit letter, the platform, the capture date, and what the capture
shows — which mark appears, on what page or listing. Then end the section with
the following marker alone on its own line, exactly as written, with nothing
after it:
${SCREENSHOT_MARKER}

Do NOT reproduce the EVIDENCE ON FILE block, a file count, a breakdown by kind,
a capture-session list, or a document inventory. That block is context for you,
not content for counsel — the exhibits are what this section supplies.]

# 4. Settlement Position
## 4a. Options Presented
[From settlement field — parse Option 1 / Option 2 if structured, otherwise present as stated]
## 4b. Basis for Calculation
[Three sentences at most. The figures were already stated to the respondent in
the initial infringement correspondence — take them from the record rather than
recomputing, and where a second option was offered, give that too. Do not
reproduce the pricing bands, do not show the arithmetic, and do not add a
schedule or table.]
## 4c. Respondent's Stated Position
[From the most recent correspondence on record: whether they have accepted,
rejected, gone silent, or stated an intention to keep using the mark. Give the
position as they put it, with the date they put it, in a sentence or two.]
## 4d. Note to Counsel
[Flag duration, breadth, willfulness if second infringement. Recommend upward revision if warranted.]

---
Prepared by: Jonathan D. Pendergrass, CLO | The Paleo Foundation | jonathand@paleofoundation.org | ${usDate(c.todayIso)}
FAFO Workflow | Paleo Certified, Inc. dba The Paleo Foundation`
}
