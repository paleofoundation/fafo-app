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

REQUIRED OUTPUT STRUCTURE — follow this seven-section format exactly. It is the
Paleo Foundation house standard for a legal referral. Populate every section from
the case data above. Be economical: every sentence must carry a fact or an
argument — no throat-clearing, no restating the obvious, no filler. Aim for the
density of a good memo, not the length of a brief.

Emit the title block exactly as these six lines, each on its own line, nothing
else before them:

# LEGAL REFERRAL SUMMARY
Trademark Infringement Matter
**Paleo Certified, Inc. dba The Paleo Foundation**
v.
**${c.infringer}**
Date of Referral: ${usDate(c.todayIso)}

DO NOT emit a protocol line, an internal case-opened date, a case-handler line, a
referral-status line, or a classification line.

EVIDENTIARY RULE — this document is relied on by outside counsel:
Distinguish "not in the record provided" from "does not exist". Where a fact is
absent from the case data above, write that it is not in the record and should be
confirmed — never assert that a thing did not happen, was never sent, or is
missing from the file. Facts supplied above (entity name, address, term dates,
fee, correspondence, evidence counts and dates) are extracted from source
documents: reproduce them verbatim rather than inferring or restating them
approximately. Every date is MM/DD/YYYY.

# 1. Parties
## Licensor / Complainant
**Name:** Paleo Certified, Inc. dba The Paleo Foundation
**Contact:** Jonathan D. Pendergrass, CLO | Legal
**Email:** jonathand@paleofoundation.org
**Website:** https://paleofoundation.com/
## Respondent
[Bold-labelled lines, one per line, drawn from the case data: **Legal Entity**,
**Operating Name** (if it trades under a different name), **Jurisdiction**,
**Primary Contact** (name and email), **Secondary Contact** (if a second person
is on the correspondence), **Websites**. Use the verified facts and the latest
correspondence; omit a label rather than guessing at it.]

# 2. Background
## Original License Agreement
[Who signed the agreement, on what date, in what capacity, for which mark. Name
the signatory personally where the record gives it — signatory continuity is a
liability argument. Then the key provisions relevant to THIS matter as a short
bulleted list, each citing its section (e.g. sell-off / effect of termination /
sale-of-business clauses).]
## License Expiration or Termination
[The expiry or termination date and how it happened. Any dated confirmation from
the respondent's side of intent to discontinue.]
## Asset Acquisition / Change of Ownership
[Include this subsection ONLY for a change-of-ownership matter. What was acquired,
from whom, when, and whether a new agreement was executed as the sale-of-business
clause required. Draw the knowledge/continuity argument the record supports —
a signatory of the original agreement now at the acquirer, a public "our story"
page acknowledging the brand's certified heritage. Omit entirely otherwise.]

# 3. Infringement
## Nature and Duration of Unauthorized Use
[The window of unauthorized use with both endpoints as dates and the span in
months, then the platforms and URLs where the mark was used, as a bulleted list.]
## Evidence of Knowledge and Commercial Benefit
[What in the record shows the respondent knew of the mark and its obligations,
and that the mark was doing commercial work — a customer-facing FAQ addressing
the certification, packaging, retail listings, dated social posts.]
## Standards Violation
[Any use that violates a specific licence provision — the mark shown beside
non-certified products, etc. Cite the section. Omit if the record has none.]

# 4. Correspondence Timeline
[The exchange between the parties, drawn from CORRESPONDENCE ON RECORD, most
important points first to last. One paragraph per message, in this form —
**MM/DD/YYYY (Sender):** what was sent and what it said, in one to three
sentences. Include the initial notice and the options it presented; every reply,
so counsel sees timing and responsiveness; any representation later contradicted
by the evidence; the final pre-referral message. Do not add flags, tags or an
editorial gloss — state what happened; counsel draws the inferences. Close the
section with a single line: PDF of this correspondence is on file.
If no correspondence has been extracted into the record, say exactly that: the
case documents have not yet been processed into dated entries — do not write that
no correspondence exists.]

# 5. Defenses Raised and Rebuttals
[Only the defenses the respondent actually raised in the correspondence above.
For each, a level-2 heading giving the defense in the respondent's own words as a
short quote, then a tight rebuttal grounded in the record. If none were raised,
state "No formal defenses raised as of the referral date." — do not invent them.]

# 6. Current Settlement Position
[The options presented to the respondent, taken from the settlement field and the
initial infringement correspondence where the figures were first stated — do not
recompute them:
**Option 1 — [name]:** [terms].
**Option 2 — [name]:** [terms, if a second option exists].
Then the respondent's stated position (accepted / rejected / silent / invited
escalation) with its date, and one short paragraph of basis: how the figure was
arrived at, and whether counsel should consider revising it upward given duration,
breadth, and any evidence of willfulness. Keep the basis to a few sentences — no
pricing tables, no arithmetic.]

# 7. Evidence on File
[A bulleted inventory of the evidence supporting the matter — the specific
screenshots and the pages they were captured from with capture dates, the
correspondence chain, the agreement(s), the public pages relied on. Curate it;
this is the exhibit list counsel will work from, not a raw file dump. Then, on the
lines that follow, list each screenshot exhibit from SCREENSHOT EXHIBITS above —
exhibit letter, platform, capture date, and what it shows — and end the section
with the following marker alone on its own line, exactly as written, nothing after
it:
${SCREENSHOT_MARKER}]

---
Prepared by: Jonathan D. Pendergrass, CLO | The Paleo Foundation | jonathand@paleofoundation.org | ${usDate(c.todayIso)}`
}
