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
Paleo Foundation house standard for a legal referral.

WRITE SHORT. This is a one- to two-page briefing a busy attorney reads once, not
a brief. Rules, in order of importance:
 - State each fact and each argument ONCE, in the one section it belongs to.
   Never restate a date, a contract clause, or a point you have already made in
   another section. If E.3.d is explained in Background, later sections refer to
   it in a few words, not by re-explaining it.
 - One or two sentences per point. Cut every clause that does not carry a new
   fact. No preamble, no summarising what you are about to say, no "it should be
   noted that", no closing recap.
 - Use PLAIN TEXT only. Do NOT use bold, asterisks (**), underlining, or any
   markup for emphasis anywhere in the body — not on dates, names, field labels,
   section numbers, options, contract references, or file names. The section
   headings (the "# 1." lines) are the only styled text; everything else is
   plain. Write "Legal Entity: Acme Inc.", never "**Legal Entity:** Acme Inc.".

Emit the title block exactly as these six lines, each on its own line, in plain
text with no bold, nothing else before them:

# LEGAL REFERRAL SUMMARY
Trademark Infringement Matter
Paleo Certified, Inc. dba The Paleo Foundation
v.
${c.infringer}
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
Name: Paleo Certified, Inc. dba The Paleo Foundation
Contact: Jonathan D. Pendergrass, CLO | Legal
Email: jonathand@paleofoundation.org
Website: https://paleofoundation.com/
## Respondent
[Plain "Label: value" lines, one per line, no bold: Legal Entity; Operating Name
(only if it trades under a different name); Jurisdiction; Primary Contact (name
and email); Secondary Contact (only if a second respondent-side person is on the
correspondence); Websites. Use the verified facts and the latest correspondence,
and omit a label rather than guessing at it. List ONLY the infringing party's own
people. Never list a paleofoundation.org or paleofoundation.com address, or any
Paleo Foundation staff member, as a contact — those are the complainant's own
side and do not belong in the respondent's details.]

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
the certification, packaging, retail listings, dated social posts.
BROKEN REMEDIATION PROMISE — check this every time, in one or two sentences if it
applies: scan the correspondence for any representation that the respondent would
fix the problem (remove, take down, sticker over, cover, relabel, or stop using
the mark). Compare each such promise's date against the EVIDENCE ON FILE. If any
capture session, test purchase, or order document postdates the promise, that is
evidence the promise was not kept — state it with both dates: what was promised
and when, then the later-dated evidence that contradicts it. A purchase or order
confirmation dated after a promise to remediate is exactly this contradiction and
must be surfaced, not left for the reader to find.]
## Standards Violation
[Any use that violates a specific licence provision — the mark shown beside
non-certified products, etc. Cite the section. Omit if the record has none.]

# 4. Correspondence Timeline
[A short dated list of what happened, oldest first, one line per event in plain
text with no bold, in this form:
  MM/DD/YYYY (Sender): what happened, in one sentence.
Give the sender's NAME only, never their email address. The record labels each
message "Name email:" — use just the name.
Keep it tight. Merge same-day back-and-forth into a single line. Leave out
routine or procedural messages (acknowledgements, "please send documentation",
auto-replies) — include a message only if it moves the matter: the initial
notice and the offer it made, a substantive reply or counter-offer, a
representation later contradicted, a missed deadline, the final pre-referral
message. Aim for the fewest lines that tell the story, not a transcript. Do not
add flags, tags, or gloss. Close with a single line: PDF of this correspondence
is on file.
If no correspondence has been extracted into the record, say exactly that: the
case documents have not yet been processed into dated entries — do not write that
no correspondence exists.]

# 5. Defenses Raised and Rebuttals
[Only the defenses the respondent actually raised. For each, a level-2 heading
with the defense in the respondent's own words as a short quote, then a one- or
two-sentence rebuttal grounded in the record. Do not re-explain contract clauses
already covered above — cite them in a few words. If none were raised, write the
single line: No formal defenses raised as of the referral date. Do not invent
them.]

# 6. Current Settlement Position
[Plain text, no bold. The options presented to the respondent, taken from the
settlement field and the figures already stated in correspondence — do not
recompute them. One line each:
  Option 1 — [name]: [terms].
  Option 2 — [name]: [terms, only if a second option exists].
Then one line for the respondent's stated position (accepted / rejected / silent
/ invited escalation) with its date, and at most two sentences of basis for the
figure and whether counsel should consider revising it up. No pricing tables, no
arithmetic, no re-explaining clauses.]

# 7. Evidence on File
[A short bulleted list of the evidence, no bold — the screenshots and the pages
they came from with capture dates, the correspondence chain, the agreement(s),
the key public pages. Curate it; this is an exhibit list, not a file dump. Then
list each screenshot exhibit from SCREENSHOT EXHIBITS above — exhibit letter,
platform, capture date, and in a few words what it shows — and end the section
with the following marker alone on its own line, exactly as written, nothing
after it:
${SCREENSHOT_MARKER}]

---
Prepared by: Jonathan D. Pendergrass, CLO | The Paleo Foundation | jonathand@paleofoundation.org | ${usDate(c.todayIso)}`
}
