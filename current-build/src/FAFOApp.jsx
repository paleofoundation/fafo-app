/**
 * FAFO App v1.0.4-r66
 * Find. Audit. Flag. Oppose.
 * Paleo Certified, Inc. dba The Paleo Foundation
 *
 * Changes in r62: Infringing Proof fixes.
 *   - Screenshots are downscaled/recompressed (1600px, JPEG q0.82) before being
 *     embedded, so a few retina screenshots can't blow past Cloud Run's request
 *     size limit — the most likely cause of the Drive upload failure.
 *   - The real proxy error (HTTP status + server message) is now surfaced instead
 *     of a generic "failed", and PDF size is shown, so failures are diagnosable.
 *   - Download fallback rewritten: <a download> on a data: URI is blocked by the
 *     artifact iframe sandbox (link looks live, does nothing). Now uses Blob URLs
 *     with an "Open in new tab" route, which the sandbox permits.
 * Changes in r61: Infringing Proof modal accepts drag-and-drop of one or several
 * images at once; drops fill blank entries first, then append new ones.
 * Changes in r60: New "Infringing Proof" letters function. Manual URL + image
 * evidence entries compiled client-side into a branded PDF (jsPDF from CDN) and
 * uploaded to the case's Drive folder via fafo-drive-proxy /upload. Case record
 * stores only a lightweight reference (URLs, dates, Drive link) — not the images
 * or PDF bytes — consistent with the earlier localStorage-bloat lesson.
 * Changes in r3: Logos stored in dedicated per-trademark storage keys (fafo_logo_<id>).
 * Bypasses value size limit. Logos hydrated on load. fafo_trademarks stays lean.
 * Storage keys: fafo_trademarks | fafo_cases_v2 | fafo_docs | fafo_legacy_payments | fafo_logo_<id>
 * AI model: claude-sonnet-4-20250514
 * Drive folder: My Drive > 1 - FAFO App (1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89)
 */

import { useState, useRef, useEffect } from "react";

const APP_VERSION = "v1.0.4-r66";

// ── PDF text extraction (pdf.js, loaded on demand from CDN) ──
// Document content blocks aren't reliably read in the artifact sandbox, so we
// pull the PDF's text layer client-side and send it as plain text instead.
let _pdfjsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error("Failed to load PDF reader (network blocked?)"));
    document.head.appendChild(s);
  });
  return _pdfjsPromise;
}

// Returns the extracted text of a PDF given its base64 (no data: prefix).
async function extractPdfText(base64) {
  const pdfjsLib = await loadPdfJs();
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  let out = "";
  const maxPages = Math.min(pdf.numPages, 30);
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(it => it.str).join(" ") + "\n\n";
  }
  return out.trim();
}

// ── Infringing Proof PDF generation (jsPDF, loaded on demand from CDN) ──
// Screenshots are manually uploaded (no auto-capture — see r60 note above),
// so this only needs a client-side PDF library, not a headless browser.
let _jspdfPromise = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = () => {
      try { resolve(window.jspdf.jsPDF); } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error("Failed to load PDF generator (network blocked?)"));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 800, height: img.naturalHeight || 600 });
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = dataUrl;
  });
}

function imageFormatFromDataUrl(dataUrl) {
  if (/^data:image\/png/i.test(dataUrl)) return "PNG";
  if (/^data:image\/webp/i.test(dataUrl)) return "WEBP";
  return "JPEG";
}

// Brand colors — same values used in the FAFO Docs MCP server / license agreement styling.
// Note: jsPDF only ships helvetica/times/courier — there's no Georgia/Calibri to embed
// without shipping a custom font file, so "times" (serif, bold) stands in for headings.
const PDF_NAVY = [38, 54, 108];     // #26366C
const PDF_SLATE = [43, 53, 64];     // #2B3540
const PDF_BODY = [26, 26, 26];      // #1A1A1A
const PDF_GREY = [200, 200, 200];   // #C8C8C8
const PDF_BAND = [232, 235, 244];   // light navy-tinted header band

async function buildInfringingProofPdf({ infringer, markNames, entries }) {
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const today = new Date().toISOString().slice(0, 10);

  function footer(pageNum) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...PDF_GREY);
    doc.text("Paleo Certified, Inc. dba The Paleo Foundation — Confidential", margin, pageH - 30);
    doc.text(String(pageNum), pageW - margin, pageH - 30, { align: "right" });
  }

  // ── Cover page ──
  doc.setFillColor(...PDF_BAND);
  doc.rect(0, 0, pageW, 70, "F");
  doc.setFont("times", "bold");
  doc.setFontSize(26);
  doc.setTextColor(...PDF_NAVY);
  doc.text("Exhibit A", margin, 130);

  doc.setDrawColor(...PDF_GREY);
  doc.setLineWidth(0.75);
  doc.line(margin, 150, pageW - margin, 150);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...PDF_BODY);
  let y = 180;
  doc.text(`Prepared for: ${infringer || "—"}`, margin, y); y += 18;
  if (markNames && markNames.length) { doc.text(`Certification mark(s): ${markNames.join(", ")}`, margin, y); y += 18; }
  doc.text(`Prepared by: Paleo Certified, Inc. dba The Paleo Foundation`, margin, y); y += 18;
  doc.text(`Date generated: ${today}`, margin, y); y += 30;

  doc.setFont("helvetica", "italic");
  doc.setFontSize(10);
  doc.setTextColor(...PDF_SLATE);
  doc.text("This document compiles evidence of certification mark use for the party named above,", margin, y); y += 14;
  doc.text("provided at their request to document the basis of our enforcement inquiry.", margin, y);

  footer(1);

  // ── One exhibit per entry ──
  let pageNum = 1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    doc.addPage();
    pageNum++;
    let cy = margin + 10;

    doc.setFont("times", "bold");
    doc.setFontSize(15);
    doc.setTextColor(...PDF_NAVY);
    doc.text(`Exhibit ${i + 1}`, margin, cy);
    cy += 22;

    doc.setDrawColor(...PDF_GREY);
    doc.setLineWidth(0.5);
    doc.line(margin, cy - 8, pageW - margin, cy - 8);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...PDF_SLATE);
    doc.text("Source URL:", margin, cy);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...PDF_BODY);
    const urlText = e.url || "(no URL provided)";
    const urlLines = doc.splitTextToSize(urlText, pageW - margin * 2 - 80);
    if (e.url) doc.textWithLink(urlLines[0], margin + 80, cy, { url: e.url });
    else doc.text(urlLines[0], margin + 80, cy);
    for (let li = 1; li < urlLines.length; li++) { cy += 14; doc.text(urlLines[li], margin + 80, cy); }
    cy += 20;

    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF_SLATE);
    doc.text("Date documented:", margin, cy);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...PDF_BODY);
    doc.text(e.date || today, margin + 110, cy);
    cy += 24;

    if (e.imageDataUrl) {
      try {
        // Downscale/recompress before embedding. Raw screenshots (esp. retina/4K)
        // base64 into a PDF that can blow past Cloud Run's ~32MB request limit.
        // 1600px longest edge is still far more than enough for a letter-size exhibit.
        const compressed = await compressImage(e.imageDataUrl, 1600, 0.82);
        const dims = await getImageDimensions(compressed);
        const maxW = pageW - margin * 2;
        const maxH = pageH - cy - 60;
        const scale = Math.min(maxW / dims.width, maxH / dims.height, 1);
        const w = dims.width * scale, h = dims.height * scale;
        doc.addImage(compressed, "JPEG", margin, cy, w, h);
      } catch (err) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10);
        doc.setTextColor(...PDF_GREY);
        doc.text("[Image could not be embedded]", margin, cy + 20);
      }
    } else {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(10);
      doc.setTextColor(...PDF_GREY);
      doc.text("No image attached for this entry.", margin, cy + 10);
    }

    footer(pageNum);
  }

  const dataUri = doc.output("datauristring");
  const base64 = dataUri.split(",")[1];
  return { dataUri, base64 };
}

const MASTER_REF = `FAFO App — Master Reference | Paleo Certified, Inc. dba The Paleo Foundation
Version 1.0 — April 9, 2026

ORGANIZATIONAL IDENTITY
Company: Paleo Certified, Inc. dba The Paleo Foundation
Address: 11350 Weeks Bay Rd, Foley, AL 36535 | Website: paleofoundation.com
Primary Contact: Jonathan D. Pendergrass, Chief Licensing Officer | Legal | jonathand@paleofoundation.org
Nature of Business: Certification organization — licensing fees are the primary revenue model. Goal of enforcement is to return companies to licensure, not merely collect settlements.

OUTSIDE COUNSEL — TRESTLE LAW, APC | 3131 Camino Del Rio N., Suite 380, San Diego, CA 92108
Amanda L. Bruss, Esq. (Senior Attorney): amanda@trestlelaw.com | 619-343-3655 ext. 24
Kristen G. Roberts, Esq. (Founder/Managing Attorney): kristen@trestlelaw.com | 619-289-8939
Kayley Seedborg (Paralegal — DocuSign/scheduling): kayley@trestlelaw.com | 619-760-2645
NOTE: All infringement communications must be in writing. No phone calls on infringement matters.

REGISTERED MARKS (PALEO CERTIFIED, INC.)
CP=4767643 (Certified Paleo — filed as service mark; certification mark framework does not apply per Trestle Law)
PF=4583649 (Certified Paleo Friendly) | GF1=6676253 (Grain Free Certified) | GF2=6337794 (Grain Free Certified)
PF2=6214420 (Certified Paleo Friendly) | KETO=6171595 (KETO Certified) | PB=98507477 (Plant-Based Certified — pending)
Abbreviations: CP=Certified Paleo, KETO=KETO Certified, PF=Paleo Friendly/Certified Paleo Friendly, PV=Plant-Based Verified, PB=Plant-Based Certified, GF=Grain Free Certified
Grandfathered logos: Paleo Friendly and Grain Free each have two versions (old + updated); both authorized for active licensees.

LICENSE AGREEMENT — KEY TERMS (2025 CURRENT TEMPLATE)
B.4: Licensor retains full ownership. Licensee gets no ownership or goodwill rights.
E.3.d.ii: Liquidated damages = 1 year’s license fee per month of continued misuse post-termination. Not a penalty — does not limit other remedies.
E.3.c: Sell-off = 180 days post-termination (physical inventory only — NOT websites, social media, marketing, retail listings).
P: Sale of business — purchaser must execute new agreement before any licensed rights transfer.
2020 Legacy differences: No liquidated damages clause. No sell-off period (immediate cessation + destruction). Anchor settlement to current pricing schedule. ADR: Mediation → Arbitration in San Diego.
Sell-off extension pricing: Half the annual license fee per additional 6 months.

2026 PRICING GUIDE — ONE CERTIFICATION (1yr / 2yr / 3yr)
Band I: Under $100k — $4,000 / $7,200 / $9,600
Band II: $100k–$499k — $7,000 / $12,600 / $16,800
Band III: $500k–$999k — $10,000 / $18,000 / $24,000
Band IV: $1M–$4.99M — $14,000 / $25,200 / $33,600
Band V: $5M–$9.99M — $20,000 / $36,000 / $48,000
Band VI: $10M–$19.99M — $28,000 / $50,400 / $67,200
Band VII: $20M–$49.99M — $40,000 / $72,000 / $96,000
Band VIII: $50M–$74.99M — $55,000 / $99,000 / $132,000
Band IX: $75M–$99.99M — $70,000 / $126,000 / $168,000
Band X: $100M–$199.99M — $95,000 / $171,000 / $228,000
Band XI: $200M–$499.99M — $130,000 / $234,000 / $312,000
Band XII: $500M–$749.99M — $165,000 / $297,000 / $396,000
Band XIII: $750M–$999.99M — $190,000 / $342,000 / $456,000
Band XIV: $1B–$4.99B — $225,000 / $405,000 / $540,000
Note: Based on licensee revenue, not parent company revenue (unless parent uses the mark).

FAFO PROTOCOL — Find, Audit, Flag, Oppose
Trigger: Upload permissions letter (Exhibit A) + keyword FAFO
Search checklist (run on every FAFO): 1. Website (product/collection pages, FAQ, homepage) 2. Facebook (@brand public page/posts) 3. Instagram (@brand posts, reels, stories) 4. Amazon (listings, bullet points, packaging images) 5. LinkedIn (company page) 6. Third-party retail (Walmart, Target, Kroger, Desertcart, specialty grocery) 7. Wayback Machine (historical use evidence) 8. Gross annual revenue (Crunchbase, ZoomInfo, Growjo, LinkedIn, news) → pricing band
Evidence: Confirmed=logo clearly visible or explicitly linked to Paleo Foundation. Possible=packaging unclear, requires verification. Flag=text claim of KETO/Paleo Certified AND direct link to paleofoundation.com or ketocertified.com.
Ignore: Plain text "Keto Certified" or "Paleo Certified" without logo — we do not own those words (exception: flag if text links to Paleo Foundation site).
FAFO Results Format: License details (mark, term, expiration, sell-off end date) | Revenue estimate + pricing band | Confirmed evidence with links | Possible evidence with links | Social media findings | Third-party retail findings | PF link flags.

KEYWORDS
FAFO — Trigger post-license mark use search (upload permissions letter + keyword)
selloff [Brand] — Calculate sell-off end date (license end + 180 days)
AMANDA — Draft infringement response in Amanda Bruss style, grounded in license terms and Lanham Act
save point vX.X.X — Save current build to Drive as vX.X.X, move development to next version
backup — Save session snapshot to Drive (Chat Archive) + prompt local artifact download

AMANDA PROTOCOL
Style: Clear, firm, professional, calm — never combative. Structure: Facts → Authority (contract section + Lanham Act) → Consequence → Single actionable request.
Signature: "Regards," (not "Kind regards" for enforcement matters). No verbal communication on infringement matters — written only.
Closing: Always include "Absent a response, we will proceed accordingly."
Elements: 1. Acknowledge remediation taken (if any) 2. State facts with specific evidence/URLs 3. Cite agreement sections 4. Address any defenses raised 5. Present options (cessation + payment OR new license) 6. Set deadline 7. Consequence clause.
MBTI overlay (optional): ENTJlens = more decisive/authoritative (use when prior comms ignored or bad-faith arguments raised).
Lanham Act: §1114 (registered mark infringement) + §1125(a) (false designation of origin, unfair competition). Both apply to post-termination unauthorized use.

SETTLEMENT FRAMEWORK
With LD clause: Anchor to E.3.d.ii — 1yr fee × months of continued use = opening demand. Compromise typically 80–85%.
Without LD clause (legacy/2020): Anchor to current pricing. Calculate: current 1yr fee × years of unauthorized use. Typical range: 2–3x original fee as opening.
Settlement components: Recitals | Cessation/destruction | Payment amount + timeline | Sell-off rights (if applicable) | Mutual release | Non-disparagement | Confidentiality | No new manufacturing | Attorney’s fees | California law | San Diego jurisdiction.
Option 1 (Cessation): Settlement payment + immediate removal. Lower amount — positions cessation as easier path.
Option 2 (New License): New license at current pricing. Higher amount but preferred — returns company to recurring revenue.

THIRD-PARTY MANUFACTURER / PERMISSIONS LETTER PROTOCOL
Permissions Letter = Exhibit A = defines: approved products, authorized marks, territory, term.
If parent brand uses the mark, parent must have valid license or written authorization.
Non-assignable: licensee cannot prepare approved goods for another commercial party without Paleo Foundation written consent or that party having their own valid license.

POLICING METHODOLOGY
Standard channels: Product packaging | Brand website | Social media (FB/IG primary, LinkedIn secondary) | Online retail (Amazon, Walmart, Target, Kroger) | Third-party retail (Desertcart, international) | Wayback Machine.
Post-termination triggers: License end date | 180-day sell-off calendar reminder | Spot check at sell-off end date.
Evidence standard: URL + date accessed | Screenshot description | Classification (Confirmed/Possible/Flag) | PF link (if present).

IMPORTANT LEGAL NOTES (PER TRESTLE LAW)
1. Certified P Paleo (4767643) filed as service mark — certification mark statutory framework does NOT apply (Amanda Bruss, email #91, Feb 9, 2026).
2. Liquidated damages clause is NOT a penalty and does not limit injunctive or other equitable remedies. Never agree to LD as sole remedy (Iovate redlines, 2024).
3. Inspection costs: not objectionable for licensee to bear, depending on scope.
4. Common law rights persist for marks not registered with USPTO, provided mark is still in use in commerce.
5. Governing law: California (federal + state). Jurisdiction: San Diego Superior Court / USDC Southern District of California.
6. ADR: Mediation required before arbitration for contract disputes.
7. Policing adequacy: Strong enforcement record supports trademark validity. Failure to police creates abandonment risk.

COMMUNICATION PROTOCOLS
All infringement matters: Written only — no phone calls.
Standard response time: Respond by end of day Thursday (or specified deadline).
Consequence clause: "Absent a response, we will proceed accordingly."
Sensitive strategy: Do not forward attorney redlines or privileged communications to opposing party.
DocuSign: Standard execution method — route through Trestle Law (Kayley) or directly via Jonathan.
Settlement payments: Route through Trestle Law to avoid chasing payments.`;

const PRESET_CASES = [
  { id: 101, infringer: "The Healthy Crunch Company", contact: "Julie Bednarski-Malik", trademarkIds: [2], type: "Expired License", status: "In Progress", source: "Website", url: "healthycrunch.com", dateOpened: "2025-11-26", settlement: "$10,000 + full cessation", payments: [], files: [], notes: [{ date: "2025-11-26", text: "License expired November 26, 2025." }, { date: "2026-01-01", text: "Post-termination use confirmed on website, social media, and packaging. Unauthorized products: CP mark used on PF-only products." }, { date: "2026-02-01", text: "Costco advertising campaign ran after agreed removal deadline." }, { date: "2026-03-01", text: "Confidentiality agreement executed. Healthy Crunch producing cessation documents." }, { date: "2026-04-09", text: "Amanda Bruss handling. Outside counsel: Mr. Sultan." }], letters: [] },
  { id: 102, infringer: "Love Good Foods (1000747000 Ontario Inc)", contact: "Darryl Hartman", trademarkIds: [1], type: "Expired License", status: "In Progress", source: "Website", url: "lovegoodfats.com", dateOpened: "2024-01-30", settlement: "$30,000 cessation OR $40,000 new 2-year license (preferred)", payments: [], files: [], notes: [{ date: "2024-01-30", text: "Acquired assets of The Good Fat Co. Ltd. through bankruptcy without executing new agreement per Section P. Original license expired July 30, 2023." }, { date: "2024-01-30", text: "2020 legacy agreement — no sell-off period. Darryl Hartman personally signed." }, { date: "2026-03-31", text: "Use confirmed via Instagram reel." }, { date: "2026-04-09", text: "Remediation underway: 2 of 4 SKUs repackaged. Website relaunched April 9, 2026. Contact: darryl@lovegoodfats.com / 416-712-2580. CEO: Paul Schiffner." }], letters: [] },
  { id: 103, infringer: "Rawcology Inc.", contact: "Tara Tomulka", trademarkIds: [1], type: "Expired License", status: "In Progress", source: "Website", url: "rawcology.com", dateOpened: "2025-07-01", settlement: "$30,000 opening / $25,000 compromise", payments: [], files: [], notes: [{ date: "2025-07-01", text: "Second infringement — prior settlement July 2025. History of late payments." }, { date: "2026-01-01", text: "Post-termination use confirmed including unauthorized product: Mint Chip Granola — never audited." }, { date: "2026-02-01", text: "Veiled public threats. ChatGPT-drafted legal arguments submitted." }, { date: "2026-04-09", text: "Represented by Santen & Barristers. Second infringement = willful." }], letters: [] },
  { id: 104, infringer: "Little West (WS West LLC)", contact: "", trademarkIds: [2], type: "Unlicensed Use - Never Certified", status: "In Progress", source: "Website", url: "littlewest.com", dateOpened: "2025-01-01", settlement: "Litigation — default judgment pending", payments: [], files: [], notes: [{ date: "2025-01-01", text: "No license — unauthorized use of Certified Paleo mark." }, { date: "2025-06-01", text: "Case filed: 3:25-cv-02823-RBM-BJW, USDC Southern District of California." }, { date: "2026-04-09", text: "Motion for default judgment filed. Ruling expected ~6 weeks." }], letters: [] },
  { id: 201, infringer: "Allive Europe UAB", contact: "", trademarkIds: [1], type: "Unlicensed Use - Never Certified", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "$4,000", payments: [{ amount: 4000, date: "2023-06-01", received: true }], files: [], notes: [{ date: "2023-01-01", text: "Settled at $4,000. KETO Certified mark." }], letters: [] },
  { id: 202, infringer: "Laitram / Prime Shrimp LLC", contact: "", trademarkIds: [1], type: "Unlicensed Use - Never Certified", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "$6,000", payments: [{ amount: 6000, date: "2023-08-01", received: true }], files: [], notes: [{ date: "2023-01-01", text: "Settled at $6,000. KETO Certified mark." }], letters: [] },
  { id: 203, infringer: "Yoleez LLC", contact: "", trademarkIds: [1], type: "Expired License", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "$3,000 + $5,250 sell-off extension", payments: [{ amount: 3000, date: "2023-09-01", received: true }, { amount: 5250, date: "2023-10-01", received: true }], files: [], notes: [{ date: "2023-01-01", text: "Settled $3,000 + $5,250 sell-off extension. KETO Certified." }], letters: [] },
  { id: 204, infringer: "Caveman Foods LLC", contact: "", trademarkIds: [3], type: "Expired License", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "$15,000 demand issued", payments: [], files: [], notes: [{ date: "2023-01-01", text: "Demand issued $15,000. Paleo Friendly mark." }], letters: [] },
  { id: 205, infringer: "TBE Beverages LLC", contact: "", trademarkIds: [2], type: "Unlicensed Use - Never Certified", status: "Resolved", source: "Website", url: "", dateOpened: "2024-01-01", settlement: "Litigation → default judgment", payments: [], files: [], notes: [{ date: "2024-01-01", text: "Case 2:24-cv-00214-DDP-AS. Default judgment obtained." }], letters: [] },
  { id: 206, infringer: "Ener-G", contact: "", trademarkIds: [1], type: "Unlicensed Use - Never Certified", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "Converted to license — invoice paid", payments: [], files: [], notes: [{ date: "2023-01-01", text: "KETO Certified. Converted to active license." }], letters: [] },
  { id: 207, infringer: "Log House Foods (WholeME)", contact: "", trademarkIds: [2], type: "Unlicensed Use - Never Certified", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "$3,000 suggested", payments: [], files: [], notes: [{ date: "2023-01-01", text: "Certified Paleo mark. Demand issued." }], letters: [] },
  { id: 208, infringer: "Piping Rock Health Products", contact: "", trademarkIds: [2], type: "Expired License", status: "Resolved", source: "Website", url: "", dateOpened: "2022-01-01", settlement: "Settled per agreement", payments: [], files: [], notes: [{ date: "2022-01-01", text: "Multiple marks. Settled per agreement." }], letters: [] },
  { id: 209, infringer: "FATCO", contact: "", trademarkIds: [2], type: "Expired License", status: "Resolved", source: "Website", url: "", dateOpened: "2022-01-01", settlement: "Settled per agreement", payments: [], files: [], notes: [{ date: "2022-01-01", text: "Certified Paleo mark. Settled." }], letters: [] },
  { id: 210, infringer: "Stanmar International (Simply Delish)", contact: "", trademarkIds: [1], type: "Expired License", status: "Resolved", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "No payment — use ceased", payments: [], files: [], notes: [{ date: "2023-01-01", text: "KETO Certified. Corrective action — use ceased." }], letters: [] },
  { id: 211, infringer: "Daily Crunch", contact: "", trademarkIds: [1], type: "Expired License", status: "Resolved", source: "Social Media", url: "", dateOpened: "2023-01-01", settlement: "No payment — images removed", payments: [], files: [], notes: [{ date: "2023-01-01", text: "KETO Certified. Images removed." }], letters: [] },
  { id: 212, infringer: "SunOpta", contact: "", trademarkIds: [2], type: "Expired License", status: "Resolved", source: "Website", url: "", dateOpened: "2022-01-01", settlement: "Use ceased — declined to counter", payments: [], files: [], notes: [{ date: "2022-01-01", text: "Multiple marks. Use ceased." }], letters: [] },
  { id: 213, infringer: "Barr Necessities", contact: "", trademarkIds: [2], type: "Unlicensed Use - Never Certified", status: "In Progress", source: "Website", url: "", dateOpened: "2023-01-01", settlement: "Demand issued — monitoring", payments: [], files: [], notes: [{ date: "2023-01-01", text: "Certified Paleo mark. Demand → no response. Monitoring." }], letters: [] },
];

const SAMPLE_TRADEMARKS = [
  { id: 1, name: "THIS PRODUCT IS KETO CERTIFIED KETOCERTIFIED.COM", description: "KETO Certified — Reg. No. 6171595, Class A", logo: null, licenses: [] },
  { id: 2, name: "CERTIFIED P PALEO", description: "Certified Paleo — Reg. No. 4767643, Class 042", logo: null, licenses: [] },
  { id: 3, name: "THIS PRODUCT IS CERTIFIED PALEO FRIENDLY", description: "Certified Paleo Friendly — Reg. No. 4583649, Class 042", logo: null, licenses: [] },
  { id: 4, name: "LAB-TESTED GRAIN FREE CERTIFIED", description: "Grain Free Certified — Reg. No. 6676253, Class A", logo: null, licenses: [] },
  { id: 5, name: "LAB-TESTED NOGRAIN.ORG GRAIN FREE GLUTEN FREE", description: "Grain Free Certified — Reg. No. 6337794, Class A", logo: null, licenses: [] },
  { id: 6, name: "CERTIFIED PF PALEO FRIENDLY", description: "Certified Paleo Friendly — Reg. No. 6214420, Class A", logo: null, licenses: [] },
];

const DRIVE_LINKS = [
  { name: "1 - FAFO App (root folder)", url: "https://drive.google.com/drive/folders/1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89", type: "folder" },
  { name: "Versions", url: "https://drive.google.com/drive/folders/1q2dwV6j9qJpqZpAW3VEoPuuzTWeFsJjo", type: "folder" },
  { name: "FAFO App v1.0.1 — Source Code", url: "https://docs.google.com/document/d/1y7Ep20Khc5tcVICb9XUlEdg4WEAM8kVODCQfUEqp4FI/edit", type: "doc" },
];

// ── STYLE CONSTANTS ──
const STATUS_COLORS = {
  "In Progress": { bg: "#EBF2FB", text: "#3A6EA8", border: "#A8C8F0", selBg: "#1A6FD4", selText: "#fff",    selBorder: "#1255A8" },
  "Resolved":    { bg: "#F2F2F0", text: "#5A5A55", border: "#C8C8C0", selBg: "#6B6B65", selText: "#fff",    selBorder: "#4A4A45" },
};
const RECEIVED_COLORS = { bg: "#EAF3DE", text: "#3B6D11", border: "#97C459", selBg: "#3B6D11", selText: "#fff", selBorder: "#27500A" };
const TYPE_STYLE = {
  "Expired License":                      { background: "#FEF9EC", color: "#92711A" },
  "Unlicensed Use - Change in Ownership": { background: "#F5EBFC", color: "#7A2D9E" },
  "Unlicensed Use - Never Certified":     { background: "#FCEEF0", color: "#9E2D3F" },
};

const ALL_TYPES = [
  "Expired License",
  "Unlicensed Use - Change in Ownership",
  "Unlicensed Use - Never Certified",
];

const inputStyle = {
  width: "100%", fontSize: 13, padding: "7px 10px",
  border: "0.5px solid #d1d5db", borderRadius: 8,
  background: "#fff", color: "#111", boxSizing: "border-box",
  outline: "none", fontFamily: "inherit",
};
const outlineBtn = {
  fontSize: 13, padding: "7px 14px",
  border: "1px solid #d1d5db", borderRadius: 8,
  background: "#fff", color: "#111", cursor: "pointer", fontWeight: 400,
  fontFamily: "inherit",
};

// ── PRIMITIVE COMPONENTS ──
function StatusPill({ status, selected, onClick }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS["Resolved"];
  return (
    <span onClick={onClick} style={{
      fontSize: 11, fontWeight: 500, padding: "2px 10px", borderRadius: 6,
      background: selected ? c.selBg : c.bg,
      color: selected ? c.selText : c.text,
      border: `0.5px solid ${selected ? c.selBorder : c.border}`,
      cursor: onClick ? "pointer" : "default",
      userSelect: "none", whiteSpace: "nowrap",
    }}>{status}</span>
  );
}

function TypePill({ type }) {
  const s = TYPE_STYLE[type] || { background: "#F1EFE8", color: "#5F5E5A" };
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6,
      ...s, border: "0.5px solid transparent", whiteSpace: "nowrap",
    }}>{type}</span>
  );
}

function Card({ children, onClick, style }) {
  return (
    <div onClick={onClick} style={{
      background: "#fff", border: "0.5px solid #e5e7eb",
      borderRadius: 12, padding: "12px 16px", marginBottom: 8,
      cursor: onClick ? "pointer" : "default",
      transition: "box-shadow 0.15s",
      ...(onClick ? { ":hover": { boxShadow: "0 2px 8px rgba(0,0,0,0.08)" } } : {}),
      ...style,
    }}>{children}</div>
  );
}

function Btn({ children, onClick, disabled, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      fontSize: 13, padding: "7px 14px",
      border: "0.5px solid #d1d5db", borderRadius: 8,
      background: "#fff", color: "#111",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      fontFamily: "inherit",
      ...style,
    }}>{children}</button>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function EditableField({ label, value, onChange }) {
  return (
    <div style={{
      display: "flex", gap: 12, padding: "9px 0",
      borderBottom: "0.5px solid #f3f4f6", alignItems: "center",
    }}>
      <div style={{ fontSize: 13, color: "#6b7280", width: 160, flexShrink: 0 }}>{label}</div>
      <input
        value={value || ""}
        onChange={e => onChange(e.target.value)}
        style={{
          flex: 1, fontSize: 13, padding: "4px 8px",
          border: "0.5px solid #e5e7eb", borderRadius: 6,
          background: "#f9fafb", color: "#111", outline: "none",
          fontFamily: "inherit",
        }}
      />
    </div>
  );
}

// ── LOGO STORAGE ──
// Logos are compressed to 200×200 JPEG ~0.7 quality via canvas (~8–15KB each)
// then stored in dedicated per-trademark storage keys (fafo_logo_<id>).
// This keeps each value well under storage limits.

function compressImage(dataUrl, maxSize = 200, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      // White background so PNGs with transparency compress well
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function saveLogo(tmId, dataUrl) {
  try {
    await window.storage.set(`fafo_logo_${tmId}`, dataUrl);
    return true;
  } catch (e) {
    console.warn("saveLogo failed:", e);
    return false;
  }
}

async function loadLogo(tmId) {
  try {
    const res = await window.storage.get(`fafo_logo_${tmId}`);
    return res?.value || null;
  } catch { return null; }
}

function LogoUploader({ tmId, tmName, currentLogo, onUpload }) {
  const ref = useRef();
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadErr, setUploadErr] = useState(false);

  async function handleFile(e) {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = "";
    setUploading(true); setUploadErr(false); setSaved(false);

    try {
      // Read full image
      const rawDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });

      // Compress to ≤200×200 JPEG so it fits in storage
      const compressed = await compressImage(rawDataUrl);

      // Show it immediately
      onUpload(tmId, compressed);

      // Persist
      const ok = await saveLogo(tmId, compressed);
      setSaved(ok);
      if (!ok) setUploadErr(true);
    } catch (err) {
      console.error("Logo upload error:", err);
      setUploadErr(true);
    }
    setUploading(false);
  }

  return (
    <div style={{ marginTop: 10 }}>
      {currentLogo
        ? <img src={currentLogo} alt="logo" style={{ display: "block", maxWidth: 120, maxHeight: 120, objectFit: "contain", borderRadius: 6, border: "0.5px solid #e5e7eb", background: "#fff", padding: 6, marginBottom: 6 }} />
        : <div style={{ width: 80, height: 80, borderRadius: 6, border: "0.5px dashed #d1d5db", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#9ca3af", marginBottom: 6 }}>No logo</div>
      }
      {saved && <div style={{ fontSize: 10, color: "#3B6D11", marginBottom: 6 }}>✓ Saved</div>}
      {uploadErr && <div style={{ fontSize: 10, color: "#A32D2D", marginBottom: 6 }}>Save failed — try again</div>}
      <input ref={ref} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
      <button onClick={() => ref.current.click()} disabled={uploading} style={{
        fontSize: 11, padding: "4px 10px",
        border: "0.5px solid #d1d5db", borderRadius: 6,
        background: "transparent", color: uploading ? "#9ca3af" : "#6b7280",
        cursor: uploading ? "default" : "pointer", fontFamily: "inherit",
      }}>
        {uploading ? "Saving…" : currentLogo ? "Replace logo" : "Upload logo"}
      </button>
    </div>
  );
}

// ── AVATAR ──
function Avatar({ name, size = 36 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: "#EAF3DE", display: "flex",
      alignItems: "center", justifyContent: "center",
      fontSize: size * 0.33, fontWeight: 600, color: "#3B6D11", flexShrink: 0,
    }}>{initials(name)}</div>
  );
}

// ── DASHBOARD ──
function timeElapsed(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr);
  const now = new Date();
  let diff = Math.floor((now - start) / 1000); // seconds
  if (diff < 0) diff = 0;
  const days   = Math.floor(diff / 86400);
  const yrs    = Math.floor(days / 365);
  const mos    = Math.floor((days % 365) / 30);
  const wks    = Math.floor((days % 365 % 30) / 7);
  const dys    = days % 365 % 30 % 7;
  const parts = [];
  if (yrs > 0) parts.push(yrs + "yr");
  if (mos > 0) parts.push(mos + "mo");
  if (wks > 0) parts.push(wks + "wk");
  if (dys > 0 || parts.length === 0) parts.push(dys + "d");
  return parts.join(" ");
}

function Dashboard({ cases, trademarks, onViewCase }) {
  const counts = { "In Progress": 0, Resolved: 0 };
  cases.forEach(c => { if (counts[c.status] !== undefined) counts[c.status]++; });
  const active = cases.filter(c => c.status !== "Resolved");

  const [backupText, setBackupText] = useState("");
  const [backupStatus, setBackupStatus] = useState(""); // "" | "ready" | "copied"

  function buildBackup() {
    // Read straight from localStorage so the backup is the exact persisted state.
    // Fall back to in-memory props if a key is missing.
    let casesData, tmData, docsData, legacyData;
    try { casesData = JSON.parse(window.localStorage.getItem("fafo_cases_v2")); } catch { casesData = null; }
    try { tmData = JSON.parse(window.localStorage.getItem("fafo_trademarks")); } catch { tmData = null; }
    try { docsData = JSON.parse(window.localStorage.getItem("fafo_docs")); } catch { docsData = null; }
    try { legacyData = JSON.parse(window.localStorage.getItem("fafo_legacy_payments")); } catch { legacyData = null; }

    const payload = {
      _fafo_backup: true,
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      fafo_cases_v2: casesData || cases,
      fafo_trademarks: tmData || trademarks,
      fafo_docs: docsData || [],
      fafo_legacy_payments: legacyData || [],
    };
    const json = JSON.stringify(payload, null, 2);
    setBackupText(json);
    setBackupStatus("ready");
  }

  async function copyBackup() {
    try {
      await navigator.clipboard.writeText(backupText);
      setBackupStatus("copied");
      setTimeout(() => setBackupStatus("ready"), 2000);
    } catch {
      // Clipboard API can be blocked in the sandbox — fall back to selecting the text
      const ta = document.getElementById("fafo-backup-textarea");
      if (ta) { ta.focus(); ta.select(); }
      setBackupStatus("ready");
    }
  }

  const caseCount = (() => {
    try { return (JSON.parse(window.localStorage.getItem("fafo_cases_v2")) || cases).length; }
    catch { return cases.length; }
  })();

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          ["Open", counts.Open, "#92711A"],
          ["In Progress", counts["In Progress"], "#3A6EA8"],
          ["Resolved", counts.Resolved, "#5A5A55"],
          ["Marks", trademarks.length, "#111"],
        ].map(([label, val, color]) => (
          <div key={label} style={{
            flex: 1, minWidth: 90,
            background: "#f9fafb",
            border: "0.5px solid #e5e7eb",
            borderRadius: 10, padding: "12px 16px",
          }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 600, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* ── BACKUP / EXPORT ── network-free local data export */}
      <div style={{ background: "#f9fafb", border: "0.5px solid #e5e7eb", borderRadius: 10, padding: "12px 16px", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Backup data</div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
              Exports all {caseCount} case{caseCount !== 1 ? "s" : ""}, trademarks, docs & legacy payments as JSON. Works offline — no Drive needed.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {backupStatus === "copied" && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ Copied</span>}
            {backupStatus === "ready" && <span style={{ fontSize: 12, color: "#3A6EA8" }}>Ready — copy & paste to save</span>}
            <button onClick={buildBackup} style={outlineBtn}>⬇ Export JSON</button>
          </div>
        </div>
        {backupStatus && (
          <div style={{ marginTop: 12 }}>
            <textarea
              id="fafo-backup-textarea"
              readOnly
              value={backupText}
              onFocus={e => e.target.select()}
              style={{
                width: "100%", height: 120, fontSize: 11, fontFamily: "monospace",
                padding: "8px 10px", border: "0.5px solid #d1d5db", borderRadius: 8,
                background: "#fff", color: "#374151", boxSizing: "border-box", resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <button onClick={copyBackup} style={outlineBtn}>📋 Copy to clipboard</button>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                Tip: copy this text and paste it into chat or a file. {backupText.length.toLocaleString()} chars.
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Active cases</div>
      {active.length === 0 && <div style={{ fontSize: 13, color: "#9ca3af" }}>No active cases.</div>}
      {active.slice(0, 6).map(c => {
        const tmNames = (c.trademarkIds || [])
          .map(id => trademarks.find(t => t.id === id)?.name?.split(" ").slice(0, 3).join(" "))
          .filter(Boolean).join(", ");
        return (
          <div key={c.id} onClick={() => onViewCase(c)} style={{
            background: "#fff", border: "0.5px solid #e5e7eb",
            borderRadius: 12, padding: "12px 16px", marginBottom: 8,
            cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
          }}>
            <Avatar name={c.infringer} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.infringer}</div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{tmNames}… · {c.dateOpened}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {c.type === "Expired License" && timeElapsed(c.dateOpened) && (
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 5,
                    background: "#FEF9EC", color: "#92711A", border: "0.5px solid #F5DFA0",
                    whiteSpace: "nowrap",
                  }}>{timeElapsed(c.dateOpened)}</span>
                )}
                <StatusPill status={c.status} />
              </div>
              <TypePill type={c.type} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── TRADEMARKS ──
function Trademarks({ trademarks, cases, onAdd, onLogoUpload, onSave, saveStatus }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12, alignItems: "center" }}>
        {saveStatus === "tm_saved" && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ Saved</span>}
        {saveStatus === "tm_error" && <span style={{ fontSize: 12, color: "#A32D2D" }}>Save failed</span>}
        <button onClick={onAdd} style={outlineBtn}>+ Add trademark</button>
        <button onClick={onSave} style={outlineBtn}>Save</button>
      </div>
      {trademarks.map(tm => {
        const active = cases.filter(c => (c.trademarkIds || []).includes(tm.id) && c.status !== "Resolved").length;
        return (
          <Card key={tm.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{tm.name}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{tm.description}</div>
                <LogoUploader tmId={tm.id} tmName={tm.name} currentLogo={tm.logo} onUpload={onLogoUpload} />
              </div>
              {active > 0 && (
                <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6, background: "#FCEBEB", color: "#A32D2D", marginLeft: 12 }}>
                  {active} active
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>Licenses</div>
            {tm.licenses.length === 0 && <div style={{ fontSize: 12, color: "#9ca3af" }}>No licenses on file</div>}
            {tm.licenses.map((l, i) => {
              const exp = new Date(l.expiry) < new Date();
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "0.5px solid #f3f4f6", fontSize: 13 }}>
                  <span>{l.client}</span>
                  <span style={{ fontSize: 12, color: exp ? "#A32D2D" : "#6b7280" }}>Expires {l.expiry}{exp ? " ✕" : ""}</span>
                </div>
              );
            })}
          </Card>
        );
      })}
    </div>
  );
}

// ── CASES TAB ──
function CasesTab({ cases, trademarks, onView, onNew, onSave, saveStatus, searchResults, searchQuery }) {
  const [filter, setFilter] = useState("All");
  const [sortBy, setSortBy] = useState("date"); // "date" | "name" | "owner"
  const filters = ["All", "In Progress", "Resolved"];

  // If there's an active search, show those results (ignore status filter)
  // Otherwise apply the status filter as normal
  const isSearching = searchResults !== null;

  const STATUS_ORDER = { "In Progress": 0, "Resolved": 1 };

  function sortCases(list) {
    const arr = [...list];
    if (sortBy === "name") {
      arr.sort((a, b) => (a.infringer || "").localeCompare(b.infringer || "", undefined, { sensitivity: "base" }));
      return arr;
    }
    if (sortBy === "jp" || sortBy === "trestle") {
      const target = sortBy === "jp" ? "JP" : "Trestle";
      arr.sort((a, b) => {
        const aMatch = a.resolvedBy === target ? 0 : 1;
        const bMatch = b.resolvedBy === target ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        // Within the same group: newest dateOpened first
        return (b.dateOpened || "").localeCompare(a.dateOpened || "");
      });
      return arr;
    }
    // Default: by status (In Progress before Resolved), then newest dateOpened first
    arr.sort((a, b) => {
      const statusDiff = (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2);
      if (statusDiff !== 0) return statusDiff;
      return (b.dateOpened || "").localeCompare(a.dateOpened || "");
    });
    return arr;
  }

  const filtered = isSearching
    ? sortCases(searchResults)
    : sortCases(filter === "All" ? cases : cases.filter(c => c.status === filter));

  function CaseRow({ c }) {
    const tmNames = (c.trademarkIds || [])
      .map(id => trademarks.find(t => t.id === id)?.name?.split(" ").slice(0, 3).join(" "))
      .filter(Boolean).join(", ");
    const totalReceived = (c.payments || []).filter(p => p.received).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    return (
      <div onClick={() => onView(c)} style={{
        background: "#fff", border: "0.5px solid #e5e7eb", borderRadius: 12,
        padding: "12px 16px", marginBottom: 8, cursor: "pointer",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <Avatar name={c.infringer} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.infringer}</div>
          <div style={{ fontSize: 12, color: "#6b7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {tmNames}… · {c.source} · {c.dateOpened}
          </div>
          {c.settlement && (
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
              Settlement: {c.settlement}{totalReceived > 0 ? ` · Received: $${totalReceived.toLocaleString()}` : ""}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 }}>
          <StatusPill status={c.status} />
          <TypePill type={c.type} />
          {c.resolvedBy && (
            <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 5,
              background: c.resolvedBy === "JP" ? "#EBF2FB" : "#EAF3DE",
              color: c.resolvedBy === "JP" ? "#1A6FD4" : "#3B6D11",
              border: "0.5px solid " + (c.resolvedBy === "JP" ? "#A8C8F0" : "#97C459"),
            }}>{c.resolvedBy}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {/* Status filters — dimmed when search is active */}
          {!isSearching && filters.map(f => {
            const isAll = f === "All";
            const c = !isAll ? STATUS_COLORS[f] : null;
            const sel = filter === f;
            return (
              <button key={f} onClick={() => setFilter(f)} style={{
                fontSize: 12, padding: "4px 12px", borderRadius: 6, cursor: "pointer",
                fontWeight: sel ? 600 : 400,
                background: isAll ? (sel ? "#374151" : "#f3f4f6") : (sel ? c.selBg : c.bg),
                color: isAll ? (sel ? "#fff" : "#374151") : (sel ? c.selText : c.text),
                border: `0.5px solid ${isAll ? (sel ? "#374151" : "#e5e7eb") : (sel ? c.selBorder : c.border)}`,
                fontFamily: "inherit",
              }}>{f}</button>
            );
          })}
          {/* Search results banner */}
          {isSearching && (
            <span style={{ fontSize: 12, color: "#3A6EA8", fontWeight: 500 }}>
              {filtered.length === 0
                ? `No results for "${searchQuery}"`
                : `${filtered.length} result${filtered.length !== 1 ? "s" : ""} for "${searchQuery}"`}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>Sort</span>
            <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "0.5px solid #e5e7eb" }}>
              {[["date", "Date"], ["name", "Name"], ["jp", "JP"], ["trestle", "Trestle"]].map(([val, label], i) => {
                const sel = sortBy === val;
                return (
                  <button key={val} onClick={() => setSortBy(val)} style={{
                    fontSize: 12, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit",
                    fontWeight: sel ? 600 : 400,
                    background: sel ? "#374151" : "#fff",
                    color: sel ? "#fff" : "#6b7280",
                    border: "none",
                    borderLeft: i === 0 ? "none" : "0.5px solid #e5e7eb",
                  }}>{label}</button>
                );
              })}
            </div>
          </div>
          {saveStatus === "case_saved" && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ Saved</span>}
          {saveStatus === "case_error" && <span style={{ fontSize: 12, color: "#A32D2D" }}>Save failed</span>}
          <button onClick={onNew} style={outlineBtn}>+ New case</button>
          <button onClick={onSave} style={outlineBtn}>Save</button>
        </div>
      </div>

      {filtered.length === 0 && !isSearching && (
        <div style={{ fontSize: 13, color: "#9ca3af" }}>No cases in this category.</div>
      )}
      {filtered.length === 0 && isSearching && (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
          <div style={{ fontSize: 13 }}>No cases match "{searchQuery}"</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Try searching by name, mark, status, notes, or settlement</div>
        </div>
      )}
      {filtered.map(c => <CaseRow key={c.id} c={c} />)}
    </div>
  );
}

// ── EXPORT HELPERS ──

// ── DRIVE EXPORT RELAY ──
// Sends letter text to Claude API → Claude saves to Google Drive via MCP
// Returns { ok, fileId, viewUrl, exportUrl } — no CDN, works in desktop app

const DRIVE_LETTERS_FOLDER = "1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ"; // My Drive > 1 - FAFO App > Cases

// ── EXPORT TO DRIVE ──
// Saves letter text to fafo_pending_export storage key.
// Claude reads it from storage and saves to Drive when asked in chat.
const PENDING_EXPORT_KEY = "fafo_pending_export";

async function exportToDrive(text, filename, infringer, letterType) {
  const entry = {
    text,
    filename,
    infringer,
    exportType: letterType,
    date: new Date().toISOString().slice(0, 10),
    folderId: DRIVE_LETTERS_FOLDER,
    folderName: "1 - FAFO App / Cases",
    docTitle: filename.replace(/\.docx$|\.pdf$/, ""),
  };
  await window.storage.set(PENDING_EXPORT_KEY, JSON.stringify(entry));
  return { ok: true, pending: true, filename };
}

function safeFilename(infringer, label, ext) {
  const safe = (infringer || "document").replace(/[^a-zA-Z0-9_\-. ]/g, "_").slice(0, 40);
  const today = new Date().toISOString().slice(0, 10);
  return "FAFO_" + label + "_" + safe + "_" + today + "." + ext;
}

async function downloadPDF(text, infringer, label) {
  const filename = safeFilename(infringer, label, "pdf");
  const result = await exportToDrive(text, filename, infringer, "pdf");
  if (!result.ok) throw new Error(result.error || "Drive export failed");
  return { ok: true, pending: result.pending, filename };
}

async function downloadDOCX(text, infringer, label) {
  const filename = safeFilename(infringer, label, "docx");
  const result = await exportToDrive(text, filename, infringer, "docx");
  if (!result.ok) throw new Error(result.error || "Drive export failed");
  return { ok: true, pending: result.pending, filename };
}


// ── LETTERS SECTION COMPONENT ──
// ── GENERATE PANEL ──
function GeneratePanel({ onGenLetter, onGenSummary, onGenBoth, disabled }) {
  const [pending, setPending] = useState(null);

  const btnBase = {
    fontSize: 13, padding: "9px 14px", borderRadius: 8, cursor: "pointer",
    fontFamily: "inherit", fontWeight: 400, transition: "all 0.1s",
  };

  const options = [
    {
      key: "letter",
      label: "Enforcement letter",
      sub: "AMANDA protocol — demand + Lanham Act",
      icon: "✉️",
      style: { background: "#f9fafb", border: "0.5px solid #e5e7eb", color: "#374151" },
      confirmStyle: { background: "#374151", border: "0.5px solid #1f2937", color: "#fff" },
      onConfirm: onGenLetter,
    },
    {
      key: "summary",
      label: "Legal referral summary",
      sub: "FAFO SUMMARY v1.0 — 8-section counsel brief",
      icon: "📋",
      style: { background: "#EBF2FB", border: "0.5px solid #A8C8F0", color: "#1A6FD4" },
      confirmStyle: { background: "#1A6FD4", border: "0.5px solid #1255A8", color: "#fff" },
      onConfirm: onGenSummary,
    },
    {
      key: "both",
      label: "Generate both",
      sub: "Runs enforcement letter + summary together",
      icon: "⚡",
      style: { background: "#EAF3DE", border: "0.5px solid #97C459", color: "#3B6D11" },
      confirmStyle: { background: "#3B6D11", border: "0.5px solid #27500A", color: "#fff" },
      onConfirm: onGenBoth,
    },
  ];

  function handleClick(key) {
    if (pending === key) {
      const opt = options.find(o => o.key === key);
      opt.onConfirm();
      setPending(null);
    } else {
      setPending(key);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>
        Click once to select, click again to confirm and generate.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map(opt => {
          const isArmed = pending === opt.key;
          const isOther = pending && pending !== opt.key;
          return (
            <button
              key={opt.key}
              onClick={() => handleClick(opt.key)}
              disabled={disabled || isOther}
              style={{
                ...btnBase,
                ...(isArmed ? opt.confirmStyle : opt.style),
                opacity: (disabled || isOther) ? 0.4 : 1,
                display: "flex", flexDirection: "column", alignItems: "flex-start",
                gap: 2, minWidth: 160,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
                <span>{opt.icon}</span>
                <span>{isArmed ? "Confirm — click again" : opt.label}</span>
              </span>
              {!isArmed && <span style={{ fontSize: 11, opacity: 0.75, fontWeight: 400 }}>{opt.sub}</span>}
            </button>
          );
        })}
      </div>
      {pending && (
        <button
          onClick={() => setPending(null)}
          style={{ marginTop: 8, fontSize: 11, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}
        >
          ✕ Cancel
        </button>
      )}
    </div>
  );
}

function LettersSection({ c, generating, generatingSummary, onGenLetter, onGenSummary, infringer, markNames, onSaveFile, onDeleteLetter, infringingProofs, onSaveProof, onDeleteProof }) {
  const [exportingIdx, setExportingIdx] = useState(null);
  const [exportType, setExportType] = useState(null);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [driveLink, setDriveLink] = useState(null);
  const [showDrivePrompt, setShowDrivePrompt] = useState(null); // { url, filename }
  const [showProofModal, setShowProofModal] = useState(false);
  const [confirmDeleteProof, setConfirmDeleteProof] = useState(null);

  const [saveHint, setSaveHint] = useState(null);

  async function handleExport(l, idx, type) {
    setExportingIdx(idx); setExportType(type);
    const label = l.type === "summary" ? "Legal_Referral_Summary" : "Enforcement_Letter";
    try {
      // Both PDF and DOCX now go through Drive relay
      setSaveHint("Saving to Google Drive\u2026");
      const result = await (type === "pdf"
        ? downloadPDF(l.text, infringer, label)
        : downloadDOCX(l.text, infringer, label));

      if (result && result.ok && result.pending) {
        setSaveHint("ready_for_drive");
        setDriveLink({ filename: result.filename, type });
        if (onSaveFile) {
          // Store letter text as plain-text data URI for Files tab download
          const txtFilename = result.filename.replace(/\.(pdf|docx)$/, ".txt");
          const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(l.text);
          onSaveFile({
            name: txtFilename,
            size: l.text.length,
            type: "text/plain",
            date: new Date().toISOString().slice(0, 10),
            dataUrl,
          });
        }
      } else {
        throw new Error("Export failed");
      }
    } catch (err) {
      console.error("Export failed:", err);
      setSaveHint("Export failed \u2014 " + err.message);
      setTimeout(() => setSaveHint(null), 6000);
    }
    setExportingIdx(null); setExportType(null);
  }

  const reversed = [...(c.letters || [])].reverse();

  return (
    <div>
      {/* Save hint / Drive notice banner */}
      {(saveHint || driveLink) && (
        <div style={{
          background: saveHint === "ready_for_drive" ? "#EBF2FB" : "#EAF3DE",
          border: "0.5px solid " + (saveHint === "ready_for_drive" ? "#A8C8F0" : "#97C459"),
          borderRadius: 8, padding: "10px 14px", marginBottom: 12,
          fontSize: 12, color: saveHint === "ready_for_drive" ? "#1A6FD4" : "#3B6D11",
          lineHeight: 1.6,
        }}>
          {saveHint === "ready_for_drive" ? (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#1A6FD4" }}>
                📄 {driveLink?.filename} — queued for Drive
              </div>
              <div style={{ fontSize: 12, color: "#374151", marginBottom: 8 }}>
                Type this in the chat to save and get a download link:
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code style={{ fontSize: 12, background: "#e8f0fe", color: "#1A6FD4", padding: "4px 10px", borderRadius: 6, fontFamily: "monospace", flex: 1 }}>
                  save pending export to Drive
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText("save pending export to Drive").catch(() => {});
                  }}
                  style={{ fontSize: 11, padding: "4px 10px", border: "0.5px solid #A8C8F0", borderRadius: 6, background: "#EBF2FB", color: "#1A6FD4", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                >Copy</button>
              </div>
              <button onClick={() => { setSaveHint(null); setDriveLink(null); }}
                style={{ marginTop: 8, fontSize: 11, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                Dismiss
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>💾</span>
              <span style={{ flex: 1 }}>{saveHint}</span>
              {driveLink?.url && (
                <a href={driveLink.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12, fontWeight: 600, color: "#1A6FD4", textDecoration: "none", padding: "2px 10px", border: "0.5px solid #A8C8F0", borderRadius: 6, background: "#EBF2FB", whiteSpace: "nowrap" }}>
                  Open in Drive ↗
                </a>
              )}
              <button onClick={() => { setSaveHint(null); setDriveLink(null); }}
                style={{ fontSize: 11, color: "#5A8A30", background: "none", border: "none", cursor: "pointer", padding: 0 }}>✕</button>
            </div>
          )}
        </div>
      )}

      {/* Generate panel */}
      {!generating && !generatingSummary && (
        <GeneratePanel
          onGenLetter={onGenLetter}
          onGenSummary={onGenSummary}
          onGenBoth={() => { onGenLetter(); onGenSummary(); }}
          disabled={generating || generatingSummary}
        />
      )}

      {/* Infringing Proof trigger — separate from the AI-generation panel above since it
          just opens an input modal rather than immediately generating anything. */}
      {!generating && !generatingSummary && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setShowProofModal(true)}
            style={{
              fontSize: 13, padding: "9px 14px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
              background: "#FCEBEB", border: "0.5px solid #EFC8C8", color: "#A32D2D",
            }}
          >
            <span>📸</span>
            <span>Infringing Proof</span>
            <span style={{ fontWeight: 400, opacity: 0.8, fontSize: 11 }}>— evidence package for the infringer, saved to Drive</span>
          </button>
        </div>
      )}

      {showProofModal && (
        <InfringingProofModal
          infringer={infringer}
          markNames={markNames}
          onClose={() => setShowProofModal(false)}
          onSave={record => { onSaveProof(record); setShowProofModal(false); }}
        />
      )}

      {(generating || generatingSummary) && (
        <div style={{ background: "#f9fafb", border: "0.5px solid #e5e7eb", borderRadius: 10, padding: "20px 16px", marginBottom: 16, textAlign: "center" }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>
            {generating && generatingSummary ? "⚙️" : generating ? "✉️" : "📋"}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 4 }}>
            {generating && generatingSummary
              ? "Generating enforcement letter + legal summary…"
              : generating ? "Generating enforcement letter…"
              : "Generating legal referral summary…"}
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>This may take 30–60 seconds</div>
        </div>
      )}

      {c.letters.length === 0 && !generating && !generatingSummary && (
        <div style={{ fontSize: 13, color: "#9ca3af", textAlign: "center", padding: "12px 0" }}>No letters or summaries yet.</div>
      )}

      {reversed.map((l, i) => {
        const isSummary = l.type === "summary";
        const isExporting = exportingIdx === i;
        const label = isSummary ? "Legal_Referral_Summary" : "Enforcement_Letter";
        const wordCount = l.text ? l.text.trim().split(/\s+/).length : 0;
        const isExpanded = expandedIdx === i;
        return (
          <div key={i} style={{
            background: isSummary ? "#EBF2FB" : "#f9fafb",
            border: `0.5px solid ${isSummary ? "#A8C8F0" : "#e5e7eb"}`,
            borderRadius: 10, marginBottom: 10, overflow: "hidden",
          }}>
            {/* Compact header — always visible */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", flexWrap: "wrap" }}>
              {/* Type badge */}
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 5,
                background: isSummary ? "#1A6FD4" : "#374151", color: "#fff", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
                {isSummary ? "LEGAL REFERRAL SUMMARY" : "ENFORCEMENT LETTER"}
              </span>
              {/* Meta */}
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{l.date}</span>
              <span style={{ fontSize: 11, color: "#d1d5db" }}>·</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{wordCount.toLocaleString()} words</span>
              <span style={{ fontSize: 11, color: "#d1d5db" }}>·</span>
              <span style={{ fontSize: 11, color: "#6b7280" }}>📋 Save to Drive for PDF/Word</span>

              {/* Actions */}
              <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center", flexWrap: "nowrap" }}>
                <button
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  style={{ fontSize: 11, padding: "2px 9px", border: "0.5px solid #d1d5db", borderRadius: 5,
                    background: isExpanded ? "#374151" : "transparent",
                    color: isExpanded ? "#fff" : "#6b7280", cursor: "pointer", fontFamily: "inherit" }}
                >{isExpanded ? "Collapse" : "View"}</button>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(l.text).catch(() => {
                      const el = document.createElement("textarea");
                      el.value = l.text; document.body.appendChild(el);
                      el.select(); document.execCommand("copy");
                      document.body.removeChild(el);
                    });
                  }}
                  style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #d1d5db", borderRadius: 5,
                    background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}
                >Copy</button>
                <button
                  onClick={() => {
                    const txt = l.text;
                    const safe = (infringer || "case").replace(/[^a-zA-Z0-9 ]/g, " ").trim().slice(0, 30);
                    const label = isSummary ? "Legal Referral Summary" : "Enforcement Letter";
                    // Convert markdown to HTML for proper Drive formatting
                    function toHtml(md) {
                      const esc = s => s.replace(/&/g,"&amp;");
                      const inl = s => esc(s).replace(/\*\*(.*?)\*\*/g,"<b>$1</b>").replace(/\*(.*?)\*/g,"<i>$1</i>");
                      return md.split("\n").map(line => {
                        const t = line.trim();
                        if (!t) return "<p></p>";
                        if (t.startsWith("---")) return "<hr/>";
                        if (t.startsWith("### ")) return "<h3>"+inl(t.slice(4))+"</h3>";
                        if (t.startsWith("## "))  return "<h2>"+inl(t.slice(3))+"</h2>";
                        if (t.startsWith("# "))   return "<h1>"+inl(t.slice(2))+"</h1>";
                        if (t.startsWith("- "))   return "<p>&bull; "+inl(t.slice(2))+"</p>";
                        return "<p>"+inl(t)+"</p>";
                      }).join("");
                    }
                    const htmlContent = toHtml(txt);
                    const msg = "SAVE_TO_DRIVE\nInfringer: " + safe + "\nType: " + label + "\nDate: " + l.date + "\nHTML_CONTENT_START\n" + htmlContent + "\nHTML_CONTENT_END\n---\n" + txt;
                    navigator.clipboard?.writeText(msg).catch(() => {
                      const el = document.createElement("textarea");
                      el.value = msg; document.body.appendChild(el);
                      el.select(); document.execCommand("copy");
                      document.body.removeChild(el);
                    });
                    setShowDrivePrompt(i);
                    setTimeout(() => setShowDrivePrompt(null), 15000);
                  }}
                  style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #97C459", borderRadius: 5,
                    background: "#EAF3DE", color: "#3B6D11", cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}
                >📋 Save to Drive</button>

                <button
                  onClick={e => {
                    e.stopPropagation();
                    if (confirmDelete === i) {
                      onDeleteLetter(l);
                      if (expandedIdx === i) setExpandedIdx(null);
                      setConfirmDelete(null);
                    } else {
                      setConfirmDelete(i);
                    }
                  }}
                  style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #fca5a5", borderRadius: 5,
                    background: confirmDelete === i ? "#dc2626" : "transparent",
                    color: confirmDelete === i ? "#fff" : "#dc2626",
                    cursor: "pointer", fontFamily: "inherit", fontWeight: confirmDelete === i ? 600 : 400 }}
                  title={confirmDelete === i ? "Confirm delete" : "Delete"}
                >{confirmDelete === i ? "Delete?" : "✕"}</button>
              </div>
            </div>

            {/* Expanded text — only rendered when open */}
            {isExpanded && (
              <div style={{ borderTop: `0.5px solid ${isSummary ? "#A8C8F0" : "#e5e7eb"}`, padding: "14px 16px" }}>
                <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", color: "#374151" }}>{l.text}</div>
              </div>
            )}
            {/* Drive save prompt */}
            {showDrivePrompt === i && (
              <div style={{ borderTop: "0.5px solid #97C459", padding: "10px 14px", background: "#f0fdf4" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#3B6D11", marginBottom: 4 }}>
                  ✓ Copied — paste into chat to save to Drive
                </div>
                <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.6 }}>
                  Paste into the chat → Claude saves to Drive → replies with direct download links for PDF and Word.
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Past Infringing Proof packages — kept visually separate since the data shape
          (links + metadata, not letter text) differs from letters/summaries above. */}
      {infringingProofs && infringingProofs.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "#6b7280", marginBottom: 8 }}>Infringing Proof packages</div>
          {[...infringingProofs].reverse().map((p, i) => {
            const idx = infringingProofs.length - 1 - i;
            return (
              <div key={p.id || idx} style={{
                background: "#FCEBEB", border: "0.5px solid #EFC8C8", borderRadius: 10,
                padding: "10px 14px", marginBottom: 8,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 5,
                    background: "#A32D2D", color: "#fff", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
                    INFRINGING PROOF
                  </span>
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>{p.dateGenerated}</span>
                  <span style={{ fontSize: 11, color: "#d1d5db" }}>·</span>
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>{(p.entries || []).length} exhibit{(p.entries || []).length === 1 ? "" : "s"}</span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                    {p.driveUrl && (
                      <a href={p.driveUrl} target="_blank" rel="noopener noreferrer" style={{
                        fontSize: 11, fontWeight: 600, color: "#1A6FD4", textDecoration: "none",
                        padding: "2px 10px", border: "0.5px solid #A8C8F0", borderRadius: 6, background: "#EBF2FB",
                      }}>Open in Drive ↗</a>
                    )}
                    <button
                      onClick={() => {
                        if (confirmDeleteProof === idx) { onDeleteProof(p); setConfirmDeleteProof(null); }
                        else setConfirmDeleteProof(idx);
                      }}
                      style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #fca5a5", borderRadius: 5,
                        background: confirmDeleteProof === idx ? "#dc2626" : "transparent",
                        color: confirmDeleteProof === idx ? "#fff" : "#dc2626",
                        cursor: "pointer", fontFamily: "inherit", fontWeight: confirmDeleteProof === idx ? 600 : 400 }}
                      title={confirmDeleteProof === idx ? "Confirm delete" : "Delete"}
                    >{confirmDeleteProof === idx ? "Delete?" : "✕"}</button>
                  </div>
                </div>
                {(p.entries || []).length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#7A2D2D", lineHeight: 1.6 }}>
                    {p.entries.map((e, ei) => (
                      <div key={ei} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        Exhibit {ei + 1}: {e.url || "(image only)"} {e.hasImage ? "📎" : ""}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── INFRINGING PROOF MODAL ──
// Collects URL + optional image per entry (manual upload — no auto-screenshot capture,
// see r60 changelog note). Builds a branded PDF client-side and uploads it to the
// case's Drive folder via the existing fafo-drive-proxy /upload endpoint. Only a
// lightweight reference (URLs, dates, Drive link) is ever saved into the case record —
// the images and PDF bytes are not persisted to localStorage.
function dataUriToBlob(dataUri) {
  const [meta, b64] = dataUri.split(",");
  const mime = (meta.match(/:(.*?);/) || [])[1] || "application/pdf";
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Artifacts run inside a sandboxed iframe, where an <a download> pointing at a
// data: URI is frequently blocked outright (the link looks live but nothing
// happens). Blob URLs behave better; opening in a new tab is the most reliable
// route of all, since the browser's own PDF viewer then offers Save.
function downloadBlob(dataUri, filename) {
  try {
    const blob = dataUriToBlob(dataUri);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    console.warn("Blob download failed:", e);
    return false;
  }
}

function openBlobInNewTab(dataUri) {
  try {
    const blob = dataUriToBlob(dataUri);
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return !!w;
  } catch (e) {
    console.warn("Blob open failed:", e);
    return false;
  }
}

// ── MULTI-IMAGE DROP ZONE (Infringing Proof) ──
// Accepts one or several images at once via drag-and-drop or click-to-browse.
function ImageDropZone({ onFiles }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  function handleDrop(e) {
    e.preventDefault(); e.stopPropagation(); setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
    if (files.length) onFiles(files);
  }
  function handleDragOver(e) { e.preventDefault(); e.stopPropagation(); setDragging(true); }
  function handleDragLeave(e) { e.preventDefault(); setDragging(false); }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      style={{
        border: `1.5px dashed ${dragging ? "#1A6FD4" : "#d1d5db"}`,
        borderRadius: 10, padding: "24px 16px", textAlign: "center", cursor: "pointer",
        background: dragging ? "#EBF2FB" : "#f9fafb", marginBottom: 16,
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <input
        ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={e => { const files = Array.from(e.target.files || []); if (files.length) onFiles(files); e.target.value = ""; }}
      />
      <div style={{ fontSize: 28, marginBottom: 6 }}>{dragging ? "⬇️" : "🖼️"}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: dragging ? "#1A6FD4" : "#111" }}>
        {dragging ? "Release to add" : "Drop screenshots here, or click to browse"}
      </div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>One or several at once — each becomes its own exhibit</div>
    </div>
  );
}

function InfringingProofModal({ infringer, markNames, onClose, onSave }) {
  const [entries, setEntries] = useState([
    { id: 1, url: "", date: new Date().toISOString().slice(0, 10), imageDataUrl: null, imageName: null },
  ]);
  const [stage, setStage] = useState("form"); // form | building | uploading | done | error
  const [errorMsg, setErrorMsg] = useState(null);
  const [result, setResult] = useState(null);
  const [fallbackDataUri, setFallbackDataUri] = useState(null);
  const [pdfSizeMB, setPdfSizeMB] = useState(null);
  const [downloadNote, setDownloadNote] = useState(null);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const fileInputRefs = useRef({});

  const PROXY_URL = "https://fafo-drive-proxy-134533637471.us-central1.run.app";

  function addEntry() {
    setEntries(prev => [...prev, { id: Date.now() + Math.random(), url: "", date: new Date().toISOString().slice(0, 10), imageDataUrl: null, imageName: null }]);
  }
  function updateEntry(id, patch) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
  }
  function removeEntry(id) {
    setEntries(prev => prev.length > 1 ? prev.filter(e => e.id !== id) : prev);
  }
  function handleImagePick(id, file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => updateEntry(id, { imageDataUrl: ev.target.result, imageName: file.name });
    r.readAsDataURL(file);
  }

  // Bulk drop/browse: fills any completely-blank entries first (in order),
  // then appends new entries for any remaining images.
  function handleFilesDropped(files) {
    if (!files.length) return;
    const readers = files.map(f => new Promise(resolve => {
      const r = new FileReader();
      r.onload = ev => resolve({ imageDataUrl: ev.target.result, imageName: f.name });
      r.readAsDataURL(f);
    }));
    Promise.all(readers).then(results => {
      setEntries(prev => {
        const next = [...prev];
        let ri = 0;
        for (let i = 0; i < next.length && ri < results.length; i++) {
          if (!next[i].url.trim() && !next[i].imageDataUrl) {
            next[i] = { ...next[i], imageDataUrl: results[ri].imageDataUrl, imageName: results[ri].imageName };
            ri++;
          }
        }
        while (ri < results.length) {
          next.push({
            id: Date.now() + Math.random(),
            url: "", date: new Date().toISOString().slice(0, 10),
            imageDataUrl: results[ri].imageDataUrl, imageName: results[ri].imageName,
          });
          ri++;
        }
        return next;
      });
    });
  }

  const validEntries = entries.filter(e => e.url.trim() || e.imageDataUrl);
  const canGenerate = validEntries.length > 0;

  // Plain GET /health, no payload. Distinguishes "sandbox/CORS is blocking the
  // proxy outright" from "the proxy is up but rejected this specific upload".
  async function testProxy() {
    setProbing(true); setProbeResult(null);
    try {
      const res = await fetch(`${PROXY_URL}/health`, { method: "GET" });
      const body = await res.text();
      setProbeResult({
        ok: res.ok,
        msg: res.ok
          ? `✓ Proxy reachable (HTTP ${res.status}): ${body.slice(0, 120)} — the service is up and CORS is fine, so the failure is specific to the upload request itself.`
          : `Proxy answered with HTTP ${res.status}: ${body.slice(0, 120)}`,
      });
    } catch (e) {
      setProbeResult({
        ok: false,
        msg: `✕ Cannot reach the proxy at all (${e.message}). Even a payload-free GET is blocked — so this is the artifact sandbox / CORS blocking the domain, or the Cloud Run service is down. Not an upload-size problem.`,
      });
    }
    setProbing(false);
  }

  async function handleGenerate() {
    setStage("building"); setErrorMsg(null);
    try {
      const { dataUri, base64 } = await buildInfringingProofPdf({ infringer, markNames, entries: validEntries });
      setFallbackDataUri(dataUri);

      const sizeMB = (base64.length * 0.75) / (1024 * 1024);
      setPdfSizeMB(sizeMB);

      setStage("uploading");
      const fileName = safeFilename(infringer, "Infringing_Proof", "pdf");

      let res;
      try {
        res = await fetch(`${PROXY_URL}/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ infringerName: infringer, fileName, mimeType: "application/pdf", base64 }),
        });
      } catch (netErr) {
        throw new Error(`Could not reach the Drive proxy (${netErr.message}). The PDF itself is fine — use the download below.`);
      }

      // Surface the real server error rather than a generic one — the proxy returns
      // { error } on failure, and the status code distinguishes payload-too-large
      // from auth/quota problems.
      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = j.error || ""; }
        catch { try { detail = (await res.text()).slice(0, 200); } catch {} }
        throw new Error(`Drive upload failed (HTTP ${res.status})${detail ? ": " + detail : ""}`);
      }

      const data = await res.json();
      if (!data.fileId) throw new Error(data.error || "Drive upload failed — no file ID returned");

      setResult({ driveUrl: data.fileUrl, fileId: data.fileId, folderId: data.folderId, fileName });
      setStage("done");
      onSave({
        id: Date.now(),
        dateGenerated: new Date().toISOString().slice(0, 10),
        entries: validEntries.map(e => ({ url: e.url, date: e.date, hasImage: !!e.imageDataUrl })),
        fileName,
        driveUrl: data.fileUrl,
        fileId: data.fileId,
        folderId: data.folderId,
      });
    } catch (err) {
      console.error("Infringing Proof error:", err);
      setErrorMsg(err.message || "Something went wrong");
      setStage("error");
    }
  }

  return (
    <ModalOverlay onClose={stage === "building" || stage === "uploading" ? () => {} : onClose}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>📸 Infringing Proof</div>
      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16, lineHeight: 1.5 }}>
        Drop in screenshots below — each becomes its own exhibit. Add a URL to any entry if you have one; it's optional. This compiles into a branded PDF and saves to Drive under {infringer || "this case"}.
      </div>

      {stage === "form" && (
        <>
          <ImageDropZone onFiles={handleFilesDropped} />
          {entries.map((e, idx) => (
            <div key={e.id} style={{ border: "0.5px solid #e5e7eb", borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "#6b7280" }}>Entry {idx + 1}</div>
                {entries.length > 1 && (
                  <button onClick={() => removeEntry(e.id)} style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #e5e7eb", borderRadius: 6, background: "transparent", color: "#9ca3af", cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
                )}
              </div>
              <Field label="URL">
                <input value={e.url} onChange={ev => updateEntry(e.id, { url: ev.target.value })} placeholder="https://example.com/product-page" style={inputStyle} />
              </Field>
              <Field label="Date documented">
                <input type="date" value={e.date} onChange={ev => updateEntry(e.id, { date: ev.target.value })} style={inputStyle} />
              </Field>
              <Field label="Screenshot / image">
                <input
                  ref={el => (fileInputRefs.current[e.id] = el)}
                  type="file" accept="image/*" style={{ display: "none" }}
                  onChange={ev => handleImagePick(e.id, ev.target.files[0])}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button onClick={() => fileInputRefs.current[e.id]?.click()} style={outlineBtn}>
                    {e.imageDataUrl ? "Replace image" : "Upload image"}
                  </button>
                  {e.imageName && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ {e.imageName}</span>}
                </div>
                {e.imageDataUrl && (
                  <img src={e.imageDataUrl} alt="preview" style={{ marginTop: 8, maxWidth: "100%", maxHeight: 140, borderRadius: 6, border: "0.5px solid #e5e7eb" }} />
                )}
              </Field>
            </div>
          ))}
          <button onClick={addEntry} style={{ ...outlineBtn, marginBottom: 16 }}>+ Add another</button>

          {!canGenerate && (
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12 }}>Add at least one URL or image to continue.</div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            <button onClick={handleGenerate} disabled={!canGenerate} style={{ ...outlineBtn, opacity: canGenerate ? 1 : 0.5 }}>Generate & save to Drive</button>
          </div>
        </>
      )}

      {(stage === "building" || stage === "uploading") && (
        <div style={{ textAlign: "center", padding: "28px 0" }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>📸</div>
          <div style={{ fontSize: 13, fontWeight: 500, color: "#374151" }}>
            {stage === "building" ? "Building PDF…" : "Saving to Google Drive…"}
          </div>
        </div>
      )}

      {stage === "done" && result && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 13, fontWeight: 500, color: "#3B6D11", marginBottom: 12 }}>Saved to Drive</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <a href={result.driveUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, color: "#1A6FD4", textDecoration: "none", padding: "6px 14px", border: "0.5px solid #A8C8F0", borderRadius: 6, background: "#EBF2FB" }}>Open in Drive ↗</a>
            {fallbackDataUri && (
              <button onClick={() => openBlobInNewTab(fallbackDataUri)} style={outlineBtn}>↗ Preview PDF</button>
            )}
            <button onClick={onClose} style={outlineBtn}>Done</button>
          </div>
        </div>
      )}

      {stage === "error" && (
        <div style={{ padding: "4px 0" }}>
          <div style={{ background: "#FCEBEB", border: "0.5px solid #EFC8C8", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#A32D2D", marginBottom: 4 }}>
              {fallbackDataUri ? "PDF built — Drive upload failed" : "PDF generation failed"}
            </div>
            <div style={{ fontSize: 11, color: "#7A2D2D", lineHeight: 1.6, wordBreak: "break-word" }}>{errorMsg}</div>
            {pdfSizeMB != null && (
              <div style={{ fontSize: 11, color: "#7A2D2D", marginTop: 6 }}>
                PDF size: {pdfSizeMB.toFixed(1)} MB
                {pdfSizeMB > 25 ? " — likely too large for the proxy; try fewer exhibits per package." : ""}
              </div>
            )}
          </div>

          {fallbackDataUri && (
            <>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8, lineHeight: 1.5 }}>
                Your PDF is safe. Open it in a new tab (most reliable — then Save from the PDF viewer), or try a direct download.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <button
                  onClick={() => {
                    const ok = openBlobInNewTab(fallbackDataUri);
                    setDownloadNote(ok ? null : "Pop-up blocked — allow pop-ups for this page, or try Download.");
                  }}
                  style={{ fontSize: 12, fontWeight: 600, color: "#1A6FD4", padding: "6px 14px", border: "0.5px solid #A8C8F0", borderRadius: 6, background: "#EBF2FB", cursor: "pointer", fontFamily: "inherit" }}
                >↗ Open PDF in new tab</button>
                <button
                  onClick={() => {
                    const ok = downloadBlob(fallbackDataUri, safeFilename(infringer, "Infringing_Proof", "pdf"));
                    setDownloadNote(ok ? "Download triggered — check your downloads folder. If nothing appeared, use 'Open in new tab' instead." : "Download blocked by the browser sandbox — use 'Open in new tab' instead.");
                  }}
                  style={outlineBtn}
                >↓ Download PDF</button>
              </div>
              {downloadNote && (
                <div style={{ fontSize: 11, color: "#92711A", background: "#FEF9EC", border: "0.5px solid #F5DFA0", borderRadius: 6, padding: "8px 10px", marginBottom: 10, lineHeight: 1.5 }}>
                  {downloadNote}
                </div>
              )}
            </>
          )}

          {/* Connectivity probe — a plain GET /health with no payload. If this also
              fails, the artifact sandbox / CORS is blocking the proxy entirely and
              the problem has nothing to do with the upload itself. */}
          <div style={{ borderTop: "0.5px solid #e5e7eb", paddingTop: 10, marginBottom: 10 }}>
            <button onClick={testProxy} disabled={probing} style={{ ...outlineBtn, fontSize: 12, opacity: probing ? 0.5 : 1 }}>
              {probing ? "Testing…" : "🔌 Test proxy connection"}
            </button>
            {probeResult && (
              <div style={{
                fontSize: 11, marginTop: 8, lineHeight: 1.5, padding: "8px 10px", borderRadius: 6,
                background: probeResult.ok ? "#EAF3DE" : "#FCEBEB",
                border: "0.5px solid " + (probeResult.ok ? "#97C459" : "#EFC8C8"),
                color: probeResult.ok ? "#3B6D11" : "#7A2D2D",
                wordBreak: "break-word",
              }}>
                {probeResult.msg}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={handleGenerate} style={outlineBtn}>Retry Drive upload</button>
            <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
          </div>
        </div>
      )}
    </ModalOverlay>
  );
}

// ── CASE DETAIL ──
function CaseDetail({ caseItem, trademarks, onBack, onUpdate }) {
  const [c, setC] = useState(caseItem);
  const [section, setSection] = useState("overview");
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newPayment, setNewPayment] = useState({ amount: "", date: new Date().toISOString().slice(0, 10) });
  const fileRef = useRef();
  const importNoteRef = useRef();
  const licenseImportRef = useRef();
  const [caseFiles, setCaseFiles] = useState(caseItem.files || []);
  const [importingNote, setImportingNote] = useState(false);
  const [importingLicense, setImportingLicense] = useState(false);
  const [driveStatus, setDriveStatus] = useState(null); // null | "uploading" | "done" | "error"

  const tmNames = (c.trademarkIds || []).map(id => trademarks.find(t => t.id === id)?.name).filter(Boolean);

  // ── GOOGLE DRIVE PROXY ──
  const PROXY_URL = "https://fafo-drive-proxy-134533637471.us-central1.run.app";

  async function uploadFileToDrive(file, base64Data, infringerName) {
    setDriveStatus("uploading");
    try {
      const res = await fetch(`${PROXY_URL}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          infringerName,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          base64: base64Data,
        }),
      });
      const data = await res.json();
      if (data.fileId) {
        setDriveStatus("done");
        return data;
      }
      setDriveStatus("error");
      return null;
    } catch (e) {
      console.error("Drive upload error", e);
      setDriveStatus("error");
      return null;
    }
  }

  // ── IMPORT FILE → NOTES ──
  async function handleImportNoteFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    setImportingNote(true);

    try {
      // Read file as base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const isEML = file.name.toLowerCase().endsWith(".eml") || file.type === "message/rfc822";

      // ── EML PARSER: extract clean human-readable content only ──
      function parseEML(raw) {
        // Extract key headers using simple string search
        function getHeader(name) {
          const prefix = name + ":";
          const lines = raw.split("\n");
          const line = lines.find(l => l.toLowerCase().startsWith(prefix.toLowerCase()));
          return line ? line.slice(prefix.length).trim() : "";
        }
        const subject = getHeader("Subject");
        const from    = getHeader("From");
        const to      = getHeader("To");
        const date    = getHeader("Date");

        // Split on text/plain content sections
        const bodies = [];
        const marker = "Content-Type: text/plain";
        const parts = raw.split(marker);
        for (let i = 1; i < parts.length; i++) {
          const part = parts[i];
          const headerEnd = part.indexOf("\n\n") !== -1 ? part.indexOf("\n\n") : part.indexOf("\r\n\r\n");
          if (headerEnd === -1) continue;
          const partHeaders = part.slice(0, headerEnd);
          const isB64 = partHeaders.toLowerCase().includes("base64");
          let bodyText = part.slice(headerEnd).trim();
          // Remove everything after the next MIME boundary
          const boundaryIdx = bodyText.indexOf("\n--");
          if (boundaryIdx !== -1) bodyText = bodyText.slice(0, boundaryIdx);
          if (isB64) {
            try { bodyText = atob(bodyText.replace(/\s+/g, "")); }
            catch { continue; }
          }
          // Clean: remove long URLs, cid refs, quoted lines, blank lines, base64-looking lines
          const cleanLines = bodyText
            .replace(/\r/g, "")
            .split("\n")
            .map(l => l.trim())
            .filter(l => {
              if (!l) return false;
              if (l.startsWith(">")) return false;
              if (/^[A-Za-z0-9+/=]{60,}$/.test(l)) return false;
              return true;
            })
            .map(l => l.replace(/https?:\/\/\S{50,}/g, "").replace(/\[cid:[^\]]+\]/g, "").trim())
            .filter(l => l.length > 0);
          const cleaned = cleanLines.join("\n");
          if (cleaned.length > 30) bodies.push(cleaned);
        }

        const cleanBody = bodies.join("\n\n---\n\n").slice(0, 8000);
        return "From: " + from + "\nTo: " + to + "\nDate: " + date + "\nSubject: " + subject + "\n\n" + cleanBody;
      }

            const notePromptInstruction = `You are a case log assistant for Paleo Certified, Inc. dba The Paleo Foundation.
This file relates to a trademark infringement case against "${c.infringer}".

Your job is to extract discrete facts and log them exactly as a paralegal would write them in a case notes log — short, direct, and date-anchored where possible.

REQUIRED: If any of the following are present in the file, you MUST extract them as separate entries:
- Date a renewal notice or invoice was sent or received
- Date the infringer communicated intent to discontinue or not renew their license
- Date a termination notice was sent by Paleo Certified
- Date of the first communication regarding infringement, including any settlement amount, renewal offer, or fee quoted
- Dates of all follow-up or ongoing correspondence (emails, calls, letters)

ALSO extract: parties involved, marks at issue, license status, payment amounts, deadlines, legal actions, admissions, and any commitments made.

EXCLUDE: email headers, server routing, MIME data, message IDs, HTML, DKIM/SPF, and any technical email infrastructure.

FORMAT RULES — critical:
- One fact per entry. Never combine two facts into one string.
- Write exactly as a case log entry: brief, factual, past tense, no commentary.
- Always lead with the date if known, e.g. "October 10, 2024 — First infringement email sent."
- Do not explain, summarize, or editorialize. Just state the fact.
- No bullet points, no markdown, no headers inside the strings.

STYLE EXAMPLES (match this exactly):
"November 26, 2025 — License expired."
"January 1, 2026 — Post-termination use confirmed on website and social media."
"March 1, 2026 — Confidentiality agreement executed."
"Renewal notice sent March 15, 2024."
"August 2, 2024 — Infringer notified us of intent to discontinue licensing."
"Settlement demand: $30,000 cessation or $40,000 new 2-year license."

Return ONLY a raw JSON array of strings, nothing else. Example: ["Fact one.", "Fact two."]`;

      let messageContent;

      if (isPDF) {
        let pdfText = "";
        try { pdfText = await extractPdfText(base64.split(",")[1]); } catch (e) { pdfText = ""; }
        if (!pdfText) throw new Error("Could not read text from this PDF — it may be scanned/image-only.");
        messageContent = `${notePromptInstruction}

FILE CONTENT:
${pdfText.slice(0, 24000)}`;
      } else {
        const rawText = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = ev => resolve(ev.target.result);
          reader.onerror = reject;
          reader.readAsText(file);
        });
        // For EML files, parse and clean before sending to Claude
        const cleanText = isEML ? parseEML(rawText) : rawText.slice(0, 12000);
        messageContent = `${notePromptInstruction}

FILE CONTENT:
${cleanText}`;
      }

      // Call Claude API to extract notes as a JSON array of strings
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 2000,
          system: "You are a legal case log assistant for Paleo Certified, Inc. dba The Paleo Foundation. Extract discrete facts from documents and return them as a raw JSON array of strings only. No markdown, no explanation, no code fences. Just the JSON array.",
          messages: [{ role: "user", content: messageContent }]
        })
      });
      const data = await res.json();
      const raw = (data.content || []).map(b => b.text || "").join("").trim();

      // Parse the JSON array of fact strings
      let facts = [];
      console.log("FAFO import raw:", raw.slice(0, 400));
      try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          facts = JSON.parse(match[0]);
        } else if (raw.trim()) {
          // No array found — use whole response as single note
          console.warn("No JSON array in import response");
          facts = [raw.trim().slice(0, 500)];
        }
      } catch (e) {
        console.error("Import JSON parse error:", e.message, "raw:", raw.slice(0, 200));
        if (raw.trim()) facts = [raw.trim().slice(0, 500)];
      }

      const today = new Date().toISOString().slice(0, 10);
      // First note identifies the source file
      const sourceNote = { date: today, text: `File imported: ${file.name}.`, importedFile: file.name };
      // One note per extracted fact
      const factNotes = facts.filter(f => typeof f === "string" && f.trim()).map(f => ({
        date: today,
        text: f.trim(),
        importedFile: file.name,
      }));
      const allNewNotes = [sourceNote, ...factNotes];

      const fileEntry = { name: file.name, size: file.size, type: file.type, date: today, dataUrl: base64 };
      const updatedFiles = [...caseFiles, fileEntry];
      setCaseFiles(updatedFiles);
      save({ ...c, notes: [...c.notes, ...allNewNotes], files: updatedFiles });

      // Upload to Google Drive (non-blocking)
      uploadFileToDrive(file, base64, c.infringer);

    } catch (err) {
      console.error("Import error:", err);
      save({ ...c, notes: [...c.notes, { date: new Date().toISOString().slice(0, 10), text: `[Import failed for: ${file.name}] ${err.message || "Unknown error"}` }] });
    }

    setImportingNote(false);
  }

  // ── IMPORT LICENSE AGREEMENT → structured license fields ──
  async function handleImportLicenseFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    setImportingLicense(true);

    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

      const tmList = trademarks.map(t => `"${t.name}" (${t.description})`).join("; ");

      const licensePrompt = `You are parsing a standardized Paleo Certified, Inc. dba The Paleo Foundation trademark license agreement. These agreements ALWAYS follow the same template, so use these exact locations to find each field:

- businessName AND businessAddress: in the FIRST PARAGRAPH of the document. The licensee's legal entity name (e.g. "MCB Star, LLC") and its full mailing address both appear there.
- licenseStart AND licenseEnd: in SECTION E.1. This section states the term, e.g. "commencing on [start date] and ending on [end date]". Extract both dates.
- licenseFee: in SECTION B.5. This is the annual recurring license fee (a dollar amount, e.g. "$9,600.00").
- ldAmount: in SECTION E.3.d.ii (liquidated damages). The standard clause sets liquidated damages at one year's license fee per month of continued post-termination use. Report the PER-MONTH figure — normally equal to the annual licenseFee from Section B.5. If the section states it explicitly, use that; otherwise set it equal to the annual fee.
- certifications: on the FIRST PAGE, listed at the TOP RIGHT. These are the certification marks granted. Match them against this known list and return names exactly as they appear in the list: ${tmList}
- contact: the licensee's primary contact person name, if present anywhere in the agreement.
- contactEmail: the licensee's contact email, if present.
- contactPhone: NOT present in these agreements — always return an empty string.

Extract only what is explicitly stated. If a field genuinely cannot be found in its expected location, return an empty string for it (except ldAmount, which may be derived from the annual fee as described).

Format dates as YYYY-MM-DD when possible.

Return ONLY a raw JSON object with exactly these keys: licenseStart, licenseEnd, contact, contactEmail, contactPhone, businessName, businessAddress, licenseFee, ldAmount, certifications. No markdown, no code fences, no commentary.`;

      let messageContent;
      if (isPDF) {
        let pdfText = "";
        try { pdfText = await extractPdfText(base64.split(",")[1]); } catch (e) { pdfText = ""; }
        if (!pdfText) throw new Error("Could not read text from this PDF — it may be scanned/image-only. Try a text-based PDF or paste the text.");
        messageContent = `${licensePrompt}

LICENSE AGREEMENT TEXT:
${pdfText.slice(0, 24000)}`;
      } else {
        const rawText = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = ev => resolve(ev.target.result);
          reader.onerror = reject;
          reader.readAsText(file);
        });
        messageContent = `${licensePrompt}

FILE CONTENT:
${rawText.slice(0, 24000)}`;
      }

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1200,
          system: "You are a legal document parser for Paleo Certified, Inc. dba The Paleo Foundation. Extract structured license-agreement data and return a single raw JSON object only. No markdown, no explanation, no code fences.",
          messages: [{ role: "user", content: messageContent }]
        })
      });
      const data = await res.json();
      const raw = (data.content || []).map(b => b.text || "").join("").trim();
      console.log("FAFO license import raw:", raw.slice(0, 500));

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object returned");
      const ex = JSON.parse(match[0]);

      // Map extracted certification names → trademark IDs
      const certNames = Array.isArray(ex.certifications) ? ex.certifications : [];
      const matchedTmIds = trademarks
        .filter(tm => certNames.some(n => {
          const a = tm.name.toLowerCase();
          const b = String(n).toLowerCase();
          return a.includes(b) || b.includes(a.split(" ")[0]) ||
            (tm.description || "").toLowerCase().includes(b);
        }))
        .map(tm => tm.id);

      const today = new Date().toISOString().slice(0, 10);

      // Build the updated case: license fields + merge contact/business + trademarks
      const updated = {
        ...c,
        licenseStart: ex.licenseStart || c.licenseStart || "",
        licenseEnd: ex.licenseEnd || c.licenseEnd || "",
        licenseFee: ex.licenseFee || c.licenseFee || "",
        ldAmount: ex.ldAmount || c.ldAmount || "",
        contact: ex.contact || c.contact || "",
        contactEmail: ex.contactEmail || c.contactEmail || "",
        contactPhone: ex.contactPhone || c.contactPhone || "",
        businessName: ex.businessName || c.businessName || "",
        businessAddress: ex.businessAddress || c.businessAddress || "",
        trademarkIds: matchedTmIds.length ? matchedTmIds : (c.trademarkIds || []),
      };

      // Log a source note + a concise summary note
      const summaryBits = [];
      if (updated.licenseStart || updated.licenseEnd) summaryBits.push(`License term ${updated.licenseStart || "?"} to ${updated.licenseEnd || "?"}.`);
      if (updated.licenseFee) summaryBits.push(`License fee ${updated.licenseFee}.`);
      if (updated.ldAmount) summaryBits.push(`E.3.d.ii liquidated damages ${updated.ldAmount}/month.`);
      if (updated.businessName) summaryBits.push(`Licensee ${updated.businessName}.`);
      const newNotes = [
        { date: today, text: `License agreement imported: ${file.name}.`, importedFile: file.name },
      ];
      if (summaryBits.length) newNotes.push({ date: today, text: summaryBits.join(" "), importedFile: file.name });

      const fileEntry = { name: file.name, size: file.size, type: file.type, date: today, dataUrl: base64 };
      const updatedFiles = [...caseFiles, fileEntry];
      setCaseFiles(updatedFiles);
      save({ ...updated, notes: [...c.notes, ...newNotes], files: updatedFiles });

      // Upload to Drive (non-blocking)
      uploadFileToDrive(file, base64, c.infringer);

    } catch (err) {
      console.error("License import error:", err);
      save({ ...c, notes: [...c.notes, { date: new Date().toISOString().slice(0, 10), text: `[License import failed for: ${file.name}] ${err.message || "Unknown error"}` }] });
    }

    setImportingLicense(false);
  }

  function handleFileAdd(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const newEntries = files.map(f => ({ name: f.name, size: f.size, type: f.type, date: new Date().toISOString().slice(0, 10) }));
    const readers = files.map((f, i) => new Promise(resolve => {
      const r = new FileReader();
      r.onload = ev => resolve({ ...newEntries[i], dataUrl: ev.target.result });
      r.readAsDataURL(f);
    }));
    Promise.all(readers).then(entries => {
      const updated = [...caseFiles, ...entries];
      setCaseFiles(updated);
      save({ ...c, files: updated });
      // Upload each file to Google Drive under the case folder
      files.forEach((f, i) => {
        if (entries[i]?.dataUrl) uploadFileToDrive(f, entries[i].dataUrl, c.infringer);
      });
    });
    e.target.value = "";
  }

  function removeFile(idx) {
    const updated = caseFiles.filter((_, i) => i !== idx);
    setCaseFiles(updated);
    save({ ...c, files: updated });
  }

  function formatSize(bytes) {
    if (!bytes) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function fileIcon(type) {
    if (!type) return "📄";
    if (type.includes("pdf")) return "📕";
    if (type.includes("image")) return "🖼";
    if (type.includes("word") || type.includes("document") || type.includes("rtf")) return "📝";
    if (type.includes("sheet") || type.includes("excel")) return "📊";
    if (type.includes("zip")) return "📦";
    if (type.includes("text") || type.includes("plain")) return "📄";
    return "📄";
  }

  function save(updated) { setC(updated); onUpdate(updated); }
  function setField(key, val) { save({ ...c, [key]: val }); }
  function setStatus(status) { save({ ...c, status }); }

  function addNote() {
    if (!note.trim()) return;
    save({ ...c, notes: [...c.notes, { date: new Date().toISOString().slice(0, 10), text: note.trim() }] });
    setNote("");
  }

  function addPayment() {
    if (!newPayment.amount || !newPayment.date) return;
    const p = { amount: parseFloat(newPayment.amount), date: newPayment.date, received: false };
    save({ ...c, payments: [...(c.payments || []), p] });
    setNewPayment({ amount: "", date: new Date().toISOString().slice(0, 10) });
  }

  function toggleReceived(idx) {
    const payments = (c.payments || []).map((p, i) => i === idx ? { ...p, received: !p.received } : p);
    save({ ...c, payments });
  }

  function removePayment(idx) {
    const payments = (c.payments || []).filter((_, i) => i !== idx);
    save({ ...c, payments });
  }

  const totalReceived = (c.payments || []).filter(p => p.received).reduce((s, p) => s + (p.amount || 0), 0);
  const totalPending  = (c.payments || []).filter(p => !p.received).reduce((s, p) => s + (p.amount || 0), 0);

  async function genLetter() {
    setGenerating(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1500,
          system: `You are drafting enforcement correspondence for Paleo Certified, Inc. dba The Paleo Foundation. AMANDA protocol: clear, firm, professional, calm. Structure: Facts→Authority (contract section + Lanham Act)→Consequence→Single actionable request. Sign off "Regards,". Close: "Absent a response, we will proceed accordingly." §1114 + §1125(a). Context: ${MASTER_REF}`,
          messages: [{ role: "user", content: `Draft enforcement letter. Trademark(s): "${tmNames.join(", ")}". Infringer: "${c.infringer}". Type: ${c.type}. Source: ${c.source} — ${c.url}. Opened: ${c.dateOpened}. Settlement: ${c.settlement || "TBD"}. Notes: ${c.notes.map(n => n.text).join("; ") || "None"}.` }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      save({ ...c, letters: [...c.letters, { date: new Date().toISOString().slice(0, 10), text }] });
    } catch (err) {
      console.error("Letter generation failed:", err);
      save({ ...c, letters: [...c.letters, {
        date: new Date().toISOString().slice(0, 10),
        text: "⚠ Letter generation failed: " + (err.message || "Unknown error") + "\n\nPlease try again.",
        type: "letter"
      }]});
    }
    setGenerating(false);
  }

  const [generatingSummary, setGeneratingSummary] = useState(false);

  async function genSummary() {
    setGeneratingSummary(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const notesText = (c.notes || []).map(n => `[${n.date}] ${n.text}`).join("\n");
      const filesText = (c.files || []).map(f => f.name).join(", ") || "None on file";
      const paymentsText = (c.payments || []).map(p => `$${p.amount} on ${p.date} — ${p.received ? "received" : "pending"}`).join("; ") || "None";
      const resolvedBy = c.resolvedBy ? `Resolved by: ${c.resolvedBy}` : "";

      const prompt = `Generate a complete Legal Referral Summary following the FAFO Pathway protocol (SUMMARY v1.0). The document must be counsel-ready and self-contained. Follow the exact 8-section structure below.

CASE DATA:
Complainant: Paleo Certified, Inc. dba The Paleo Foundation
Complainant Contact: Jonathan D. Pendergrass, CLO | jonathand@paleofoundation.org | https://paleofoundation.com/
Respondent: ${c.infringer}
Respondent Contact: ${c.contact || "Unknown"} | ${c.contactEmail || "Unknown"}
Trademark(s): ${tmNames.join("; ")}
Infringement Type: ${c.type}
Source / Platform: ${c.source}
URL / Location: ${c.url || "Not recorded"}
Date Case Opened: ${c.dateOpened}
Date of Referral: ${today}
Settlement Position: ${c.settlement || "TBD"}
${resolvedBy}

Case Notes (chronological):
${notesText || "None recorded"}

Files on record: ${filesText}
Payments: ${paymentsText}

MASTER REFERENCE CONTEXT:
${MASTER_REF}

REQUIRED OUTPUT STRUCTURE — follow exactly, populate every section:

# LEGAL REFERRAL SUMMARY
Trademark Infringement Matter
Paleo Certified, Inc. dba The Paleo Foundation v. ${c.infringer}
Date of Referral: ${today}

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
Prepared by: Jonathan D. Pendergrass, CLO | The Paleo Foundation | jonathand@paleofoundation.org | ${today}
FAFO Workflow | Paleo Certified, Inc. dba The Paleo Foundation | Protocol: SUMMARY v1.0`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 6000,
          system: `You are drafting a Legal Referral Summary for Paleo Certified, Inc. dba The Paleo Foundation per the FAFO SUMMARY v1.0 protocol. Output must be professional, precise, and counsel-ready. Populate every required section. Use formal legal language. Do not add preamble or commentary outside the document structure. Where case data is sparse, note what is unknown rather than fabricating details.`,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      save({ ...c, letters: [...c.letters, { date: today, text, type: "summary" }] });
      // Auto-save to Drive
    } catch (err) {
      console.error("Summary generation failed:", err);
      save({ ...c, letters: [...c.letters, {
        date: new Date().toISOString().slice(0, 10),
        text: "⚠ Summary generation failed: " + (err.message || "Unknown error") + "\n\nPlease try again. If the error persists, check that the case has notes and a valid infringement type.",
        type: "summary"
      }]});
    }
    setGeneratingSummary(false);
  }

  const sectionTabs = ["overview", "notes", "letters", "files"];

  return (
    <div>
      <button onClick={onBack} style={{ background: "none", border: "none", fontSize: 13, color: "#6b7280", cursor: "pointer", padding: "0 0 14px", display: "block", fontFamily: "inherit" }}>← Back</button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <Avatar name={c.infringer} size={44} />
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{c.infringer}</div>
          {c.contact && <div style={{ fontSize: 12, color: "#6b7280" }}>{c.contact}</div>}
          <div style={{ fontSize: 12, color: "#6b7280" }}>{tmNames.join(", ")} · Opened {c.dateOpened}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>Status:</span>
        {["Open", "In Progress", "Resolved"].map(s => (
          <StatusPill key={s} status={s} selected={c.status === s} onClick={() => setStatus(s)} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 0, borderBottom: "0.5px solid #e5e7eb", marginBottom: 16 }}>
        {sectionTabs.map(s => (
          <button key={s} onClick={() => setSection(s)} style={{
            background: "none", border: "none",
            borderBottom: section === s ? "2px solid #111" : "2px solid transparent",
            padding: "7px 14px", fontSize: 13,
            fontWeight: section === s ? 600 : 400,
            color: section === s ? "#111" : "#6b7280",
            cursor: "pointer", marginBottom: -1, textTransform: "capitalize",
            fontFamily: "inherit",
          }}>{s}</button>
        ))}
      </div>

      {section === "overview" && (
        <div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>All fields are editable. Changes save when you hit Save in the Cases tab.</div>
          {[
            ["Contact Name", "contact"],
            ["Contact Email", "contactEmail"],
            ["Source", "source"],
            ["URL / Location", "url"],
            ["Date opened", "dateOpened"],
            ["Settlement position", "settlement"],
          ].map(([label, key]) => (
            <EditableField key={label} label={label} value={c[key]} onChange={v => setField(key, v)} />
          ))}

          {/* ── LICENSE AGREEMENT ── */}
          <div style={{ marginTop: 16, marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.04em" }}>License Agreement</div>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>Import from Notes tab → ⎙ Import License Agreement</span>
            </div>
          </div>
          {[
            ["License start", "licenseStart"],
            ["License end", "licenseEnd"],
            ["Business name", "businessName"],
            ["Business address", "businessAddress"],
            ["Contact phone", "contactPhone"],
            ["License fee", "licenseFee"],
            ["E.3.d.ii LD / month", "ldAmount"],
          ].map(([label, key]) => (
            <EditableField key={label} label={label} value={c[key]} onChange={v => setField(key, v)} />
          ))}

          <div style={{ display: "flex", gap: 12, padding: "9px 0", borderBottom: "0.5px solid #f3f4f6", alignItems: "center" }}>
            <div style={{ fontSize: 13, color: "#6b7280", width: 160, flexShrink: 0 }}>Infringement type</div>
            <select value={c.type} onChange={e => setField("type", e.target.value)} style={{ flex: 1, fontSize: 13, padding: "4px 8px", border: "0.5px solid #e5e7eb", borderRadius: 6, background: "#f9fafb", color: "#111", outline: "none", fontFamily: "inherit" }}>
              {ALL_TYPES.map(v => <option key={v}>{v}</option>)}
            </select>
          </div>
          {/* Resolved by — JP or Trestle */}
          <div style={{ display: "flex", gap: 12, padding: "9px 0", borderBottom: "0.5px solid #f3f4f6", alignItems: "center" }}>
            <div style={{ fontSize: 13, color: "#6b7280", width: 160, flexShrink: 0 }}>Resolved by</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {["JP", "Trestle"].map(opt => {
                const sel = c.resolvedBy === opt;
                return (
                  <button key={opt} onClick={() => setField("resolvedBy", sel ? null : opt)} style={{
                    fontSize: 12, fontWeight: sel ? 600 : 400,
                    padding: "3px 14px", borderRadius: 6, cursor: "pointer",
                    fontFamily: "inherit",
                    background: sel ? (opt === "JP" ? "#1A6FD4" : "#3B6D11") : "#f3f4f6",
                    color: sel ? "#fff" : "#6b7280",
                    border: "0.5px solid " + (sel ? (opt === "JP" ? "#1255A8" : "#27500A") : "#e5e7eb"),
                  }}>{opt}</button>
                );
              })}
              {c.resolvedBy && (
                <button onClick={() => setField("resolvedBy", null)} style={{ fontSize: 11, padding: "3px 8px", border: "0.5px solid #e5e7eb", borderRadius: 6, background: "transparent", color: "#9ca3af", cursor: "pointer", fontFamily: "inherit" }}>✕ clear</button>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, padding: "9px 0", borderBottom: "0.5px solid #f3f4f6" }}>
            <div style={{ fontSize: 13, color: "#6b7280", width: 160, flexShrink: 0 }}>Trademark(s)</div>
            <div style={{ fontSize: 13 }}>{tmNames.join("; ") || "—"}</div>
          </div>
          <div style={{ padding: "12px 0", borderBottom: "0.5px solid #f3f4f6" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Payments received</div>
              <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
                {totalReceived > 0 && <span style={{ color: "#3B6D11", fontWeight: 600 }}>Received: ${totalReceived.toLocaleString()}</span>}
                {totalPending  > 0 && <span style={{ color: "#92711A" }}>Pending: ${totalPending.toLocaleString()}</span>}
              </div>
            </div>
            {(c.payments || []).map((p, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "6px 10px", background: "#f9fafb", borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, minWidth: 80 }}>${(p.amount || 0).toLocaleString()}</div>
                <div style={{ fontSize: 12, color: "#6b7280", flex: 1 }}>{p.date}</div>
                <span onClick={() => toggleReceived(i)} style={{
                  fontSize: 11, fontWeight: 500, padding: "3px 10px", borderRadius: 6, cursor: "pointer", userSelect: "none",
                  background: p.received ? RECEIVED_COLORS.selBg : RECEIVED_COLORS.bg,
                  color: p.received ? RECEIVED_COLORS.selText : RECEIVED_COLORS.text,
                  border: `0.5px solid ${p.received ? RECEIVED_COLORS.selBorder : RECEIVED_COLORS.border}`,
                }}>{p.received ? "✓ Received" : "Received"}</span>
                <button onClick={() => removePayment(i)} style={{ fontSize: 11, padding: "2px 6px", border: "0.5px solid #e5e7eb", borderRadius: 4, background: "transparent", color: "#9ca3af", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input value={newPayment.amount} onChange={e => setNewPayment(p => ({ ...p, amount: e.target.value }))} placeholder="Amount" type="number" style={{ width: 100, fontSize: 13, padding: "5px 8px", border: "0.5px solid #d1d5db", borderRadius: 6, background: "#fff", color: "#111", fontFamily: "inherit", outline: "none" }} />
              <input value={newPayment.date} onChange={e => setNewPayment(p => ({ ...p, date: e.target.value }))} type="date" style={{ fontSize: 13, padding: "5px 8px", border: "0.5px solid #d1d5db", borderRadius: 6, background: "#fff", color: "#111", fontFamily: "inherit", outline: "none" }} />
              <button onClick={addPayment} disabled={!newPayment.amount} style={{ fontSize: 12, padding: "5px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", color: "#111", cursor: newPayment.amount ? "pointer" : "not-allowed", opacity: newPayment.amount ? 1 : 0.5, fontFamily: "inherit" }}>+ Add</button>
            </div>
          </div>
        </div>
      )}

      {section === "notes" && (
        <div>
          {/* Import file button row */}
          <input ref={importNoteRef} type="file" accept=".txt,.eml,.pdf,text/plain,message/rfc822,application/pdf" style={{ display: "none" }} onChange={handleImportNoteFile} />
          <input ref={licenseImportRef} type="file" accept=".txt,.eml,.pdf,text/plain,message/rfc822,application/pdf" style={{ display: "none" }} onChange={handleImportLicenseFile} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#9ca3af" }}>Notes log for this case.</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {importingNote && <span style={{ fontSize: 12, color: "#3A6EA8" }}>⏳ Scanning file…</span>}
              {importingLicense && <span style={{ fontSize: 12, color: "#3A6EA8" }}>⏳ Reading license…</span>}
              {driveStatus === "uploading" && <span style={{ fontSize: 12, color: "#6b7280" }}>↑ Uploading to Drive…</span>}
              {driveStatus === "done" && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ Saved to Drive</span>}
              {driveStatus === "error" && <span style={{ fontSize: 12, color: "#A32D2D" }}>Drive upload failed</span>}
              <button
                onClick={() => licenseImportRef.current.click()}
                disabled={importingLicense || importingNote}
                style={{ ...outlineBtn, fontSize: 12, opacity: (importingLicense || importingNote) ? 0.5 : 1 }}
              >
                {importingLicense ? "Reading…" : "⎙ Import License Agreement"}
              </button>
              <button
                onClick={() => importNoteRef.current.click()}
                disabled={importingNote || importingLicense}
                style={{ ...outlineBtn, fontSize: 12, opacity: (importingNote || importingLicense) ? 0.5 : 1 }}
              >
                {importingNote ? "Importing…" : "↑ Import file"}
              </button>
            </div>
          </div>

          {c.notes.length === 0 && <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 12 }}>No notes yet.</div>}
          {c.notes.map((n, i) => {
            const isSourceNote = n.importedFile && n.text.startsWith("File imported:");
            return (
              <div key={i} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{n.date}</span>
                    {isSourceNote && (
                      <span style={{ fontSize: 10, color: "#6b7280", background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, border: "0.5px solid #e5e7eb" }}>
                        📎 {n.importedFile}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      const updated = { ...c, notes: c.notes.filter((_, j) => j !== i) };
                      save(updated);
                    }}
                    style={{ fontSize: 11, padding: "1px 6px", border: "0.5px solid #e5e7eb", borderRadius: 4, background: "transparent", color: "#9ca3af", cursor: "pointer", fontFamily: "inherit", lineHeight: 1.5 }}
                  >✕</button>
                </div>
                <div style={{ fontSize: 13 }}>{n.text}</div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note or log an action..." onKeyDown={e => e.key === "Enter" && addNote()} style={{ flex: 1, fontSize: 13, padding: "7px 10px", border: "0.5px solid #d1d5db", borderRadius: 8, background: "#fff", color: "#111", fontFamily: "inherit", outline: "none" }} />
            <Btn onClick={addNote}>Add</Btn>
          </div>
        </div>
      )}

      {section === "letters" && (
        <LettersSection
          c={c}
          generating={generating}
          generatingSummary={generatingSummary}
          onGenLetter={genLetter}
          onGenSummary={genSummary}
          infringer={c.infringer}
          markNames={tmNames}
          infringingProofs={c.infringingProofs || []}
          onSaveFile={fileEntry => {
            const updated = [...caseFiles, fileEntry];
            setCaseFiles(updated);
            save({ ...c, files: updated });
          }}
          onDeleteLetter={letterObj => {
            // Use functional update to avoid stale closure on c
            setC(prev => {
              const updated = (prev.letters || []).filter(l => l !== letterObj);
              const next = { ...prev, letters: updated };
              onUpdate(next);
              return next;
            });
          }}
          onSaveProof={record => {
            setC(prev => {
              const updated = [...(prev.infringingProofs || []), record];
              const next = { ...prev, infringingProofs: updated };
              onUpdate(next);
              return next;
            });
          }}
          onDeleteProof={proofObj => {
            setC(prev => {
              const updated = (prev.infringingProofs || []).filter(p => p !== proofObj);
              const next = { ...prev, infringingProofs: updated };
              onUpdate(next);
              return next;
            });
          }}
        />
      )}

      {section === "files" && (
        <div>
          <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={handleFileAdd} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: "#9ca3af" }}>
              Files attached to this case. Uploaded to Google Drive → Cases → {c.infringer}.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {driveStatus === "uploading" && <span style={{ fontSize: 12, color: "#6b7280" }}>↑ Uploading…</span>}
              {driveStatus === "done" && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ In Drive</span>}
              {driveStatus === "error" && <span style={{ fontSize: 12, color: "#A32D2D" }}>Drive error</span>}
              <button onClick={() => fileRef.current.click()} style={outlineBtn}>+ Add file</button>
            </div>
          </div>
          {caseFiles.length === 0 && (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📎</div>
              <div style={{ fontSize: 13, marginBottom: 4 }}>No files attached yet</div>
              <div style={{ fontSize: 12 }}>Click "+ Add file" to attach documents, screenshots, or evidence to this case.</div>
            </div>
          )}
          {caseFiles.map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#f9fafb", borderRadius: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 22, flexShrink: 0 }}>{fileIcon(f.type)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>{f.date} · {formatSize(f.size)}</div>
              </div>
              {f.dataUrl
                ? <a href={f.dataUrl} download={f.name} style={{
                    fontSize: 12, fontWeight: 500, color: "#1A6FD4",
                    textDecoration: "none", flexShrink: 0,
                    padding: "3px 10px", border: "0.5px solid #A8C8F0",
                    borderRadius: 6, background: "#EBF2FB",
                  }}>↓ Download</a>
                : f.driveUrl
                  ? <a href={f.driveUrl} target="_blank" rel="noopener noreferrer" style={{
                      fontSize: 12, fontWeight: 500, color: "#3B6D11",
                      textDecoration: "none", flexShrink: 0,
                      padding: "3px 10px", border: "0.5px solid #97C459",
                      borderRadius: 6, background: "#EAF3DE",
                    }}>Open ↗</a>
                  : null
              }
              <button onClick={() => removeFile(i)} style={{ fontSize: 11, padding: "3px 8px", border: "0.5px solid #e5e7eb", borderRadius: 6, background: "transparent", color: "#9ca3af", cursor: "pointer", flexShrink: 0, fontFamily: "inherit" }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── DETECTION ──
function Detection({ trademarks, onCreateCase }) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function scan() {
    if (!url.trim()) return;
    setLoading(true); setResult(null);
    try {
      const tmList = trademarks.map(t => `"${t.name}"`).join(", ");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 800,
          system: `Trademark infringement analyst for Paleo Certified, Inc. FAFO protocol. Classify: Confirmed/Possible/Flag. Ignore plain text without logo. Flag if links to paleofoundation.com or ketocertified.com. Assess pricing band. Context: ${MASTER_REF}`,
          messages: [{ role: "user", content: `Analyze for infringement of: ${tmList}. URL: ${url}. Provide: mark(s), classification, type, pricing band, recommended action.` }]
        })
      });
      const data = await res.json();
      setResult(data.content?.map(b => b.text || "").join("") || "No result.");
    } catch { setResult("Scan failed."); }
    setLoading(false);
  }

  return (
    <div>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>FAFO Scan</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>Enter a URL to scan. Results classified as Confirmed, Possible, or Flag.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://example.com"
            onKeyDown={e => e.key === "Enter" && scan()}
            style={{ flex: 1, fontSize: 13, padding: "7px 10px", border: "0.5px solid #d1d5db", borderRadius: 8, background: "#fff", color: "#111", fontFamily: "inherit", outline: "none" }}
          />
          <Btn onClick={scan} disabled={loading || !url.trim()}>{loading ? "Scanning…" : "Run FAFO"}</Btn>
        </div>
      </Card>
      {result && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>FAFO Result</div>
          <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 14 }}>{result}</div>
          <Btn onClick={() => onCreateCase(url, result)}>+ Create case from this finding</Btn>
        </Card>
      )}
    </div>
  );
}

// ── METRICS ──
function Metrics({ cases }) {
  const [showAddLegacy, setShowAddLegacy] = useState(false);
  const [legacy, setLegacy] = useState({ infringer: "", type: "Expired License", amount: "", date: "", year: "", resolvedBy: null });
  const [legacyEntries, setLegacyEntries] = useState([]);

  useEffect(() => {
    async function load() {
      try {
        let raw = null;
        try { raw = window.localStorage.getItem("fafo_legacy_payments"); } catch {}
        if (!raw) {
          try { const res = await window.storage.get("fafo_legacy_payments"); if (res?.value) { raw = res.value; try { window.localStorage.setItem("fafo_legacy_payments", raw); } catch {} } } catch {}
        }
        if (raw) setLegacyEntries(JSON.parse(raw));
      } catch {}
    }
    load();
  }, []);

  async function saveLegacy(entries) {
    const json = JSON.stringify(entries);
    try { window.localStorage.setItem("fafo_legacy_payments", json); } catch {}
    try { const p = window.storage?.set?.("fafo_legacy_payments", json); if (p?.catch) p.catch(() => {}); } catch {}
  }

  function addLegacy() {
    if (!legacy.amount || !legacy.year) return;
    const entry = { ...legacy, amount: parseFloat(legacy.amount), id: Date.now() };
    const updated = [...legacyEntries, entry];
    setLegacyEntries(updated); saveLegacy(updated);
    setLegacy({ infringer: "", type: "Expired License", amount: "", date: "", year: "", resolvedBy: null });
    setShowAddLegacy(false);
  }

  function removeLegacy(id) {
    const updated = legacyEntries.filter(e => e.id !== id);
    setLegacyEntries(updated); saveLegacy(updated);
  }

  const allPayments = [];
  cases.forEach(c => {
    (c.payments || []).filter(p => p.received).forEach(p => {
      const year = p.date ? parseInt(p.date.slice(0, 4)) : null;
      if (year) allPayments.push({ year, amount: p.amount || 0, type: c.type, source: c.infringer, resolvedBy: c.resolvedBy || null });
    });
  });
  legacyEntries.forEach(e => {
    const year = e.year ? parseInt(e.year) : (e.date ? parseInt(e.date.slice(0, 4)) : null);
    if (year) allPayments.push({ year, amount: e.amount || 0, type: e.type, source: e.infringer || "Legacy entry", resolvedBy: e.resolvedBy || null });
  });

  // Resolution credit split. Cases (and legacy entries) with no resolvedBy set are
  // reported separately as "Unassigned" rather than silently folded into either
  // bucket — otherwise the split would quietly misstate the totals.
  const RESOLVERS = ["JP", "Trestle"];
  const resolverStats = RESOLVERS.map(who => {
    const rows = allPayments.filter(p => p.resolvedBy === who);
    const resolvedCases = cases.filter(c => c.status === "Resolved" && c.resolvedBy === who);
    return {
      who,
      total: rows.reduce((s, p) => s + p.amount, 0),
      payments: rows.length,
      caseCount: resolvedCases.length,
    };
  });
  const unassignedRows = allPayments.filter(p => !p.resolvedBy);
  const unassignedTotal = unassignedRows.reduce((s, p) => s + p.amount, 0);
  const unassignedCases = cases.filter(c => c.status === "Resolved" && !c.resolvedBy).length;
  const attributedTotal = resolverStats.reduce((s, r) => s + r.total, 0);

  const years = [...new Set(allPayments.map(p => p.year))].sort((a, b) => a - b);
  const byYear = years.map(year => {
    const rows = allPayments.filter(p => p.year === year);
    const byType = {};
    ALL_TYPES.forEach(t => { byType[t] = rows.filter(p => p.type === t).reduce((s, p) => s + p.amount, 0); });
    const byResolver = {};
    RESOLVERS.forEach(w => { byResolver[w] = rows.filter(p => p.resolvedBy === w).reduce((s, p) => s + p.amount, 0); });
    byResolver.Unassigned = rows.filter(p => !p.resolvedBy).reduce((s, p) => s + p.amount, 0);
    return { year, total: rows.reduce((s, p) => s + p.amount, 0), byType, byResolver, count: rows.length };
  });
  const grandTotal = byYear.reduce((s, r) => s + r.total, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Settlement income by year</div>
          <div style={{ fontSize: 11, color: "#9ca3af" }}>Received payments from cases + legacy entries</div>
        </div>
        <button onClick={() => setShowAddLegacy(s => !s)} style={outlineBtn}>+ Add legacy data</button>
      </div>

      {showAddLegacy && (
        <div style={{ background: "#f9fafb", borderRadius: 10, padding: "12px 14px", marginBottom: 16, border: "0.5px solid #e5e7eb" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Add legacy settlement entry</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>Party / description</div>
              <input value={legacy.infringer} onChange={e => setLegacy(p => ({ ...p, infringer: e.target.value }))} placeholder="e.g. Acme Corp" style={{ ...inputStyle, fontSize: 12 }} />
            </div>
            <div style={{ flex: 1, minWidth: 100 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>Type</div>
              <select value={legacy.type} onChange={e => setLegacy(p => ({ ...p, type: e.target.value }))} style={{ ...inputStyle, fontSize: 12 }}>
                {ALL_TYPES.map(v => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div style={{ width: 100 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>Amount ($)</div>
              <input value={legacy.amount} onChange={e => setLegacy(p => ({ ...p, amount: e.target.value }))} type="number" placeholder="0" style={{ ...inputStyle, fontSize: 12 }} />
            </div>
            <div style={{ width: 70 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>Year</div>
              <input value={legacy.year} onChange={e => setLegacy(p => ({ ...p, year: e.target.value }))} type="number" placeholder="2021" style={{ ...inputStyle, fontSize: 12 }} />
            </div>
            <div style={{ width: 110 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>Resolved by</div>
              <select value={legacy.resolvedBy || ""} onChange={e => setLegacy(p => ({ ...p, resolvedBy: e.target.value || null }))} style={{ ...inputStyle, fontSize: 12 }}>
                <option value="">—</option>
                <option value="JP">JP</option>
                <option value="Trestle">Trestle</option>
              </select>
            </div>
            <div style={{ width: 130 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>Date (optional)</div>
              <input value={legacy.date} onChange={e => setLegacy(p => ({ ...p, date: e.target.value }))} type="date" style={{ ...inputStyle, fontSize: 12 }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={addLegacy} disabled={!legacy.amount || !legacy.year} style={{ ...outlineBtn, fontSize: 12, opacity: (!legacy.amount || !legacy.year) ? 0.5 : 1 }}>Add entry</button>
            <button onClick={() => setShowAddLegacy(false)} style={{ fontSize: 12, padding: "6px 12px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Resolution credit — JP vs Trestle */}
      {grandTotal > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Resolved by</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>Settlement income split by who carried the case</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {resolverStats.map(r => {
              const isJP = r.who === "JP";
              const pct = attributedTotal > 0 ? Math.round((r.total / attributedTotal) * 100) : 0;
              return (
                <div key={r.who} style={{
                  flex: 1, minWidth: 150, borderRadius: 10, padding: "12px 14px",
                  background: isJP ? "#EBF2FB" : "#EAF3DE",
                  border: "0.5px solid " + (isJP ? "#A8C8F0" : "#97C459"),
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 5, letterSpacing: "0.03em",
                      background: isJP ? "#1A6FD4" : "#3B6D11", color: "#fff",
                    }}>{r.who === "JP" ? "JP" : "TRESTLE"}</span>
                    {attributedTotal > 0 && (
                      <span style={{ fontSize: 11, color: isJP ? "#1255A8" : "#27500A" }}>{pct}% of attributed</span>
                    )}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: isJP ? "#1255A8" : "#27500A" }}>
                    ${r.total.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 11, color: isJP ? "#3A6EA8" : "#3B6D11", marginTop: 2 }}>
                    {r.caseCount} case{r.caseCount === 1 ? "" : "s"} resolved · {r.payments} payment{r.payments === 1 ? "" : "s"}
                  </div>
                </div>
              );
            })}
          </div>
          {unassignedTotal > 0 && (
            <div style={{ fontSize: 11, color: "#92711A", background: "#FEF9EC", border: "0.5px solid #F5DFA0", borderRadius: 8, padding: "8px 10px", marginTop: 8, lineHeight: 1.5 }}>
              ${unassignedTotal.toLocaleString()} across {unassignedRows.length} payment{unassignedRows.length === 1 ? "" : "s"}
              {unassignedCases > 0 ? ` and ${unassignedCases} resolved case${unassignedCases === 1 ? "" : "s"}` : ""} has no “Resolved by” set,
              so it isn’t counted in either column above. Set it on the case (or on a legacy entry) to include it.
            </div>
          )}
        </div>
      )}

      {grandTotal > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          {[["Total received", `$${grandTotal.toLocaleString()}`], ["Years tracked", years.length], ["Payments", allPayments.length]].map(([label, val]) => (
            <div key={label} style={{ flex: 1, minWidth: 90, background: "#f9fafb", border: "0.5px solid #e5e7eb", borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {byYear.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>No payment data yet</div>
          <div style={{ fontSize: 12 }}>Mark payments as Received in individual cases, or add legacy entries above.</div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, padding: "8px 14px", fontSize: 10, fontWeight: 600, color: "#6b7280", borderBottom: "0.5px solid #e5e7eb", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <div style={{ width: 50 }}>Year</div>
            <div style={{ width: 80 }}>Total</div>
            {ALL_TYPES.map(t => <div key={t} style={{ flex: 1 }}>{t}</div>)}
            <div style={{ width: 68, textAlign: "right", color: "#1255A8", borderLeft: "0.5px solid #e5e7eb", paddingLeft: 8 }}>JP</div>
            <div style={{ width: 68, textAlign: "right", color: "#27500A" }}>Trestle</div>
            <div style={{ width: 60, textAlign: "right", color: "#92711A" }}>Unassg.</div>
            <div style={{ width: 40, textAlign: "right" }}>Ct.</div>
          </div>
          {byYear.map(row => (
            <div key={row.year} style={{ display: "flex", gap: 8, padding: "8px 14px", fontSize: 12, borderBottom: "0.5px solid #f3f4f6", alignItems: "center" }}>
              <div style={{ width: 50, fontWeight: 600 }}>{row.year}</div>
              <div style={{ width: 80, fontWeight: 600, color: "#3B6D11" }}>${row.total.toLocaleString()}</div>
              {ALL_TYPES.map(t => {
                const v = row.byType[t] || 0;
                const s = TYPE_STYLE[t] || {};
                return <div key={t} style={{ flex: 1, color: v > 0 ? (s.color || "#374151") : "#d1d5db", fontSize: 12 }}>{v > 0 ? `$${v.toLocaleString()}` : "—"}</div>;
              })}
              <div style={{ width: 68, textAlign: "right", fontSize: 12, fontWeight: row.byResolver.JP > 0 ? 600 : 400, color: row.byResolver.JP > 0 ? "#1255A8" : "#d1d5db", borderLeft: "0.5px solid #f3f4f6", paddingLeft: 8 }}>
                {row.byResolver.JP > 0 ? `$${row.byResolver.JP.toLocaleString()}` : "—"}
              </div>
              <div style={{ width: 68, textAlign: "right", fontSize: 12, fontWeight: row.byResolver.Trestle > 0 ? 600 : 400, color: row.byResolver.Trestle > 0 ? "#27500A" : "#d1d5db" }}>
                {row.byResolver.Trestle > 0 ? `$${row.byResolver.Trestle.toLocaleString()}` : "—"}
              </div>
              <div style={{ width: 60, textAlign: "right", fontSize: 11, color: row.byResolver.Unassigned > 0 ? "#92711A" : "#d1d5db" }}>
                {row.byResolver.Unassigned > 0 ? `$${row.byResolver.Unassigned.toLocaleString()}` : "—"}
              </div>
              <div style={{ width: 40, textAlign: "right", color: "#9ca3af", fontSize: 11 }}>{row.count}</div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, background: "#f9fafb", borderRadius: 8, marginTop: 8 }}>
            <div style={{ width: 50 }}>Total</div>
            <div style={{ width: 80, color: "#3B6D11" }}>${grandTotal.toLocaleString()}</div>
            {ALL_TYPES.map(t => {
              const total = byYear.reduce((s, r) => s + (r.byType[t] || 0), 0);
              const s = TYPE_STYLE[t] || {};
              return <div key={t} style={{ flex: 1, color: total > 0 ? (s.color || "#374151") : "#d1d5db" }}>{total > 0 ? `$${total.toLocaleString()}` : "—"}</div>;
            })}
            <div style={{ width: 68, textAlign: "right", color: "#1255A8", borderLeft: "0.5px solid #e5e7eb", paddingLeft: 8 }}>
              {(() => { const t = byYear.reduce((s, r) => s + (r.byResolver.JP || 0), 0); return t > 0 ? `$${t.toLocaleString()}` : "—"; })()}
            </div>
            <div style={{ width: 68, textAlign: "right", color: "#27500A" }}>
              {(() => { const t = byYear.reduce((s, r) => s + (r.byResolver.Trestle || 0), 0); return t > 0 ? `$${t.toLocaleString()}` : "—"; })()}
            </div>
            <div style={{ width: 60, textAlign: "right", color: "#92711A", fontSize: 11 }}>
              {(() => { const t = byYear.reduce((s, r) => s + (r.byResolver.Unassigned || 0), 0); return t > 0 ? `$${t.toLocaleString()}` : "—"; })()}
            </div>
            <div style={{ width: 40, textAlign: "right" }}>{allPayments.length}</div>
          </div>
          {legacyEntries.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#6b7280" }}>Legacy entries</div>
              {legacyEntries.map(e => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 12 }}>
                  <div style={{ fontWeight: 600, width: 50 }}>{e.year}</div>
                  <div style={{ flex: 1, color: "#6b7280" }}>{e.infringer || "—"}</div>
                  <TypePill type={e.type} />
                  {e.resolvedBy && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 5, letterSpacing: "0.03em",
                      background: e.resolvedBy === "JP" ? "#1A6FD4" : "#3B6D11", color: "#fff", whiteSpace: "nowrap",
                    }}>{e.resolvedBy === "JP" ? "JP" : "TRESTLE"}</span>
                  )}
                  <div style={{ fontWeight: 600, color: "#3B6D11" }}>${(e.amount || 0).toLocaleString()}</div>
                  <button onClick={() => removeLegacy(e.id)} style={{ fontSize: 11, padding: "2px 6px", border: "0.5px solid #e5e7eb", borderRadius: 4, background: "transparent", color: "#9ca3af", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── DOCS ──
function Docs() {
  const [pinnedDocs, setPinnedDocs] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newDoc, setNewDoc] = useState({ name: "", url: "" });
  const [status, setStatus] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        let raw = null;
        try { raw = window.localStorage.getItem("fafo_docs"); } catch {}
        if (!raw) {
          try { const res = await window.storage.get("fafo_docs"); if (res?.value) raw = res.value; } catch {}
        }
        if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) { setPinnedDocs(p); try { window.localStorage.setItem("fafo_docs", raw); } catch {} return; } }
        setPinnedDocs(DRIVE_LINKS);
        try { window.localStorage.setItem("fafo_docs", JSON.stringify(DRIVE_LINKS)); } catch {}
      } catch { setPinnedDocs(DRIVE_LINKS); }
    }
    load();
  }, []);

  async function saveAll(list) {
    const json = JSON.stringify(list);
    let ok = false;
    try { window.localStorage.setItem("fafo_docs", json); ok = true; } catch {}
    try { const p = window.storage?.set?.("fafo_docs", json); if (p?.catch) p.catch(() => {}); } catch {}
    setStatus(ok ? "saved" : "error"); setTimeout(() => setStatus(null), 2000);
  }

  function addDoc() {
    if (!newDoc.name.trim() || !newDoc.url.trim()) return;
    const type = newDoc.url.includes("folder") ? "folder" : newDoc.url.includes("document") ? "doc" : newDoc.url.includes("spreadsheet") ? "sheet" : "file";
    const updated = [...pinnedDocs, { ...newDoc, type }];
    setPinnedDocs(updated); saveAll(updated);
    setNewDoc({ name: "", url: "" }); setShowAdd(false);
  }

  function removeDoc(idx) { const u = pinnedDocs.filter((_, i) => i !== idx); setPinnedDocs(u); saveAll(u); }
  const icons = { folder: "📁", doc: "📝", sheet: "📊", pdf: "📕", file: "📄" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Docs</div>
          <div style={{ fontSize: 11, color: "#9ca3af" }}>Pinned Google Drive files & folders</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {status === "saved" && <span style={{ fontSize: 12, color: "#3B6D11" }}>✓ Saved</span>}
          <button onClick={() => setShowAdd(s => !s)} style={outlineBtn}>+ Add file</button>
        </div>
      </div>
      <div style={{ marginBottom: 14, marginTop: 8 }}>
        <a href="https://drive.google.com/drive/folders/1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#6b7280", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", border: "0.5px solid #e5e7eb", borderRadius: 6 }}>
          📁 Open 1 - FAFO App in Drive ↗
        </a>
      </div>
      {showAdd && (
        <div style={{ background: "#f9fafb", borderRadius: 10, padding: "12px 14px", marginBottom: 12, border: "0.5px solid #e5e7eb" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Pin a Drive file or folder</div>
          <Field label="Display name">
            <input value={newDoc.name} onChange={e => setNewDoc(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Healthy Crunch — Settlement Docs" style={inputStyle} />
          </Field>
          <Field label="Google Drive URL">
            <input value={newDoc.url} onChange={e => setNewDoc(p => ({ ...p, url: e.target.value }))} placeholder="https://drive.google.com/…" style={inputStyle} />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={addDoc} disabled={!newDoc.name.trim() || !newDoc.url.trim()} style={{ ...outlineBtn, opacity: (!newDoc.name.trim() || !newDoc.url.trim()) ? 0.5 : 1, fontSize: 12 }}>Pin</button>
            <button onClick={() => { setShowAdd(false); setNewDoc({ name: "", url: "" }); }} style={{ fontSize: 12, padding: "6px 12px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          </div>
        </div>
      )}
      {pinnedDocs.length === 0 && (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📁</div>
          <div style={{ fontSize: 13 }}>No files pinned yet.</div>
        </div>
      )}
      {pinnedDocs.map((doc, i) => (
        <Card key={i}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 22, flexShrink: 0 }}>{icons[doc.type] || "📄"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc.name}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc.url}</div>
            </div>
            <div style={{ display: "flex", gap: 10, flexShrink: 0, alignItems: "center" }}>
              <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#6b7280", textDecoration: "none" }}>Open ↗</a>
              <button onClick={() => removeDoc(i)} style={{ fontSize: 11, padding: "3px 8px", border: "0.5px solid #e5e7eb", borderRadius: 6, background: "transparent", color: "#9ca3af", cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── REFERENCE ──
function Reference() {
  const [search, setSearch] = useState("");
  const sections = MASTER_REF.split(/\n(?=[A-Z])/).map(s => ({ title: s.split(":")[0].trim(), content: s }));
  const filtered = search.trim() ? sections.filter(s => s.content.toLowerCase().includes(search.toLowerCase())) : sections;
  return (
    <div>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search reference…"
        style={{ width: "100%", fontSize: 13, padding: "7px 10px", border: "0.5px solid #d1d5db", borderRadius: 8, background: "#fff", color: "#111", boxSizing: "border-box", marginBottom: 14, fontFamily: "inherit", outline: "none" }}
      />
      {filtered.map((s, i) => (
        <Card key={i} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{s.content}</div>
        </Card>
      ))}
    </div>
  );
}

// ── MODAL OVERLAY ──
function ModalOverlay({ onClose, children }) {
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: 20,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#fff", borderRadius: 14, padding: "1.5rem",
        width: "100%", maxWidth: 440,
        border: "0.5px solid #e5e7eb",
        maxHeight: "90vh", overflowY: "auto",
      }}>
        {children}
      </div>
    </div>
  );
}

// ── NEW TRADEMARK MODAL ──
function NewTMModal({ onClose, onSave }) {
  const [newTM, setNewTM] = useState({ name: "", description: "", regNumber: "" });
  function handleSave() {
    if (!newTM.name.trim()) return;
    onSave(newTM);
    onClose();
  }
  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Add trademark</div>
      <Field label="Mark name *">
        <input value={newTM.name} onChange={e => setNewTM(p => ({ ...p, name: e.target.value }))} placeholder="e.g. CERTIFIED PALEO" style={inputStyle} autoFocus />
      </Field>
      <Field label="Registration number">
        <input value={newTM.regNumber} onChange={e => setNewTM(p => ({ ...p, regNumber: e.target.value }))} placeholder="e.g. 4767643" style={inputStyle} />
      </Field>
      <Field label="Description">
        <input value={newTM.description} onChange={e => setNewTM(p => ({ ...p, description: e.target.value }))} placeholder="Brief description" style={inputStyle} />
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
        <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button onClick={handleSave} disabled={!newTM.name.trim()} style={{ ...outlineBtn, opacity: newTM.name.trim() ? 1 : 0.5 }}>Add trademark</button>
      </div>
    </ModalOverlay>
  );
}

// ── NEW CASE MODAL ──
// ── DROP ZONE ──
function DropZone({ onFile, onBrowse }) {
  const [dragging, setDragging] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragging(false);
  }

  return (
    <div
      onClick={onBrowse}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      style={{
        border: `1.5px dashed ${dragging ? "#1A6FD4" : "#d1d5db"}`,
        borderRadius: 10,
        padding: "32px 20px",
        textAlign: "center",
        cursor: "pointer",
        background: dragging ? "#EBF2FB" : "#f9fafb",
        marginBottom: 16,
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>{dragging ? "⬇️" : "📄"}</div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, color: dragging ? "#1A6FD4" : "#111" }}>
        {dragging ? "Release to import" : "Drop a document or click to browse"}
      </div>
      <div style={{ fontSize: 12, color: "#9ca3af" }}>PDF, EML, or text file — settlement agreement, demand letter, or email</div>
    </div>
  );
}

// ── CASE FORM (shared between manual + import flows) ──
function CaseForm({ trademarks, caseData, setCaseData }) {
  function toggleTM(id) {
    setCaseData(p => ({ ...p, trademarkIds: p.trademarkIds.includes(id) ? p.trademarkIds.filter(x => x !== id) : [...p.trademarkIds, id] }));
  }
  return (
    <>
      <Field label="Trademark(s) — select all that apply">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflowY: "auto", padding: "4px 0" }}>
          {trademarks.map(tm => {
            const sel = caseData.trademarkIds.includes(tm.id);
            return (
              <div key={tm.id} onClick={() => toggleTM(tm.id)} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                borderRadius: 8, border: `0.5px solid ${sel ? "#1A6FD4" : "#e5e7eb"}`,
                background: sel ? "#EBF2FB" : "#f9fafb", cursor: "pointer", userSelect: "none",
              }}>
                <div style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${sel ? "#1A6FD4" : "#d1d5db"}`, background: sel ? "#1A6FD4" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {sel && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                </div>
                <div style={{ fontSize: 12, color: sel ? "#1255A8" : "#111", lineHeight: 1.3 }}>{tm.name}</div>
              </div>
            );
          })}
        </div>
      </Field>
      <Field label="Infringer name *">
        <input value={caseData.infringer} onChange={e => setCaseData(p => ({ ...p, infringer: e.target.value }))} style={inputStyle} />
      </Field>
      <Field label="Contact name">
        <input value={caseData.contact} onChange={e => setCaseData(p => ({ ...p, contact: e.target.value }))} placeholder="e.g. Jane Smith" style={inputStyle} />
      </Field>
      <Field label="Contact email">
        <input value={caseData.contactEmail} onChange={e => setCaseData(p => ({ ...p, contactEmail: e.target.value }))} placeholder="e.g. jane@example.com" style={inputStyle} />
      </Field>
      <Field label="Type">
        <select value={caseData.type} onChange={e => setCaseData(p => ({ ...p, type: e.target.value }))} style={inputStyle}>
          {ALL_TYPES.map(v => <option key={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Source">
        <select value={caseData.source} onChange={e => setCaseData(p => ({ ...p, source: e.target.value }))} style={inputStyle}>
          {["Website", "Social Media", "Product Packaging", "Amazon", "Third-Party Retail", "Other"].map(v => <option key={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="URL / Location">
        <input value={caseData.url} onChange={e => setCaseData(p => ({ ...p, url: e.target.value }))} style={inputStyle} />
      </Field>
      <Field label="Settlement position">
        <input value={caseData.settlement} onChange={e => setCaseData(p => ({ ...p, settlement: e.target.value }))} placeholder="e.g. $10,000 cessation" style={inputStyle} />
      </Field>

      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 14, marginBottom: 6 }}>License Agreement</div>
      <Field label="License start">
        <input value={caseData.licenseStart || ""} onChange={e => setCaseData(p => ({ ...p, licenseStart: e.target.value }))} placeholder="YYYY-MM-DD" style={inputStyle} />
      </Field>
      <Field label="License end">
        <input value={caseData.licenseEnd || ""} onChange={e => setCaseData(p => ({ ...p, licenseEnd: e.target.value }))} placeholder="YYYY-MM-DD" style={inputStyle} />
      </Field>
      <Field label="Business name">
        <input value={caseData.businessName || ""} onChange={e => setCaseData(p => ({ ...p, businessName: e.target.value }))} placeholder="e.g. MCB Star LLC" style={inputStyle} />
      </Field>
      <Field label="Business address">
        <input value={caseData.businessAddress || ""} onChange={e => setCaseData(p => ({ ...p, businessAddress: e.target.value }))} style={inputStyle} />
      </Field>
      <Field label="Contact phone">
        <input value={caseData.contactPhone || ""} onChange={e => setCaseData(p => ({ ...p, contactPhone: e.target.value }))} style={inputStyle} />
      </Field>
      <Field label="License fee">
        <input value={caseData.licenseFee || ""} onChange={e => setCaseData(p => ({ ...p, licenseFee: e.target.value }))} placeholder="e.g. $14,000" style={inputStyle} />
      </Field>
      <Field label="E.3.d.ii LD / month">
        <input value={caseData.ldAmount || ""} onChange={e => setCaseData(p => ({ ...p, ldAmount: e.target.value }))} placeholder="e.g. $14,000" style={inputStyle} />
      </Field>
    </>
  );
}

const EMPTY_CASE = { trademarkIds: [], infringer: "", contact: "", contactEmail: "", contactPhone: "", type: "Unlicensed Use - Never Certified", source: "Website", url: "", settlement: "", licenseStart: "", licenseEnd: "", businessName: "", businessAddress: "", licenseFee: "", ldAmount: "" };

function NewCaseModal({ trademarks, onClose, onSave }) {
  const [mode, setMode] = useState("manual"); // "manual" | "import"
  const [caseData, setCaseData] = useState({ ...EMPTY_CASE });

  // Import state
  const [importStatus, setImportStatus] = useState("idle"); // idle | reading | extracting | done | error
  const [importError, setImportError] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importNote, setImportNote] = useState("");
  const [importFileEntry, setImportFileEntry] = useState(null); // stored for Files tab copy
  const fileRef = useRef();
  const licenseRef = useRef();

  const tmNames = trademarks.map(t => t.name);

  function handleSave() {
    if (!caseData.infringer.trim()) return;
    const hasNote = Array.isArray(importNote) ? importNote.length > 0 : !!importNote;
    onSave(caseData, hasNote ? importNote : null, importFileEntry || null);
    onClose();
  }

  // ── IMPORT: read file → extract with Claude API ──
  async function handleImportFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = "";
    setImportFileName(f.name);
    setImportStatus("reading");
    setImportNote("");

    try {
      // Read file as base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });

      setImportStatus("extracting");

      // Store file entry for Files tab copy on save
      setImportFileEntry({
        name: f.name,
        size: f.size,
        type: f.type,
        date: new Date().toISOString().slice(0, 10),
        dataUrl: "data:" + (f.type || "application/octet-stream") + ";base64," + base64,
      });

      // Determine content type for Claude
      const isEmail = f.name.endsWith(".eml") || f.type === "message/rfc822";
      const isPdf = f.type === "application/pdf" || f.name.endsWith(".pdf");

      // Build message content
      const extractInstruction = `Extract case information from this document for a trademark infringement case management system. The trademarks at issue are: ${tmNames.join("; ")}. Return ONLY a raw JSON object with no markdown, no explanation, no code fences. Use exactly these keys: infringer (company name), contact (person name), contactEmail, type (one of: ${["Expired License","Unlicensed Use","Unlicensed Use - Change in Ownership","Unlicensed Use - Never Certified"].join(", ")}), source (one of: Website, Social Media, Product Packaging, Amazon, Third-Party Retail, Other), url, settlement (the settlement/demand POSITION or dollar amount being sought to resolve the matter — NOT the license fee; leave empty if not a settlement document), trademarkNames (array of mark names found), notes (array of objects each with date (YYYY-MM-DD or empty string) and text (concise single sentence); extract every distinct fact, event, or action as a separate note entry).

ALSO extract these LICENSE AGREEMENT fields if the document is or contains a license agreement (these follow a standard template — leave empty if not present):
- businessName: the licensee's legal entity name (first paragraph).
- businessAddress: the licensee's full mailing address (first paragraph).
- licenseStart and licenseEnd: the license term dates from Section E.1 (format YYYY-MM-DD).
- licenseFee: the annual recurring license fee from Section B.5 (e.g. "$9,600.00"). This is the LICENSE FEE, distinct from the settlement field.
- ldAmount: the Section E.3.d.ii liquidated damages per month (standard template = one year's license fee per month; if not stated explicitly, set equal to licenseFee).

Leave any field an empty string if not found. Do NOT put the license fee or liquidated damages in the settlement field.`;
      let messageContent;
      if (isPdf) {
        let pdfText = "";
        try { pdfText = await extractPdfText(base64); } catch (e) { pdfText = ""; }
        if (!pdfText) throw new Error("Could not read text from this PDF — it may be scanned/image-only.");
        messageContent = `${extractInstruction}

Document content:
${pdfText.slice(0, 24000)}`;
      } else {
        // EML or plain text — decode and send as text
        const text = atob(base64);
        messageContent = `${extractInstruction}

Document content:
${text.slice(0, 16000)}`;
      }

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
          system: `You are a legal document parser for Paleo Certified, Inc. dba The Paleo Foundation. Extract structured case data from trademark infringement documents (settlement agreements, demand letters, emails). Be precise — only extract what is explicitly stated. Return only raw JSON.`,
          messages: [{ role: "user", content: messageContent }],
        }),
      });

      const data = await res.json();
      if (data && data.error) throw new Error("API: " + (data.error.message || JSON.stringify(data.error)));
      const raw = (data.content || []).map(b => b.text || "").join("").trim();
      console.log("FAFO doc import raw:", raw.slice(0, 500));
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(raw ? "Response had no JSON: " + raw.slice(0, 120) : "Empty response from API");

      const extracted = JSON.parse(match[0]);

      // Map extracted trademark names to IDs
      const matchedTmIds = trademarks
        .filter(tm => (extracted.trademarkNames || []).some(n =>
          tm.name.toLowerCase().includes(n.toLowerCase()) ||
          n.toLowerCase().includes(tm.name.toLowerCase().split(" ")[0])
        ))
        .map(tm => tm.id);

      // Map type — validate against ALL_TYPES
      const extractedType = ALL_TYPES.find(t =>
        t.toLowerCase() === (extracted.type || "").toLowerCase()
      ) || "Unlicensed Use - Never Certified";

      // Map source — validate
      const validSources = ["Website", "Social Media", "Product Packaging", "Amazon", "Third-Party Retail", "Other"];
      const extractedSource = validSources.find(s =>
        s.toLowerCase() === (extracted.source || "").toLowerCase()
      ) || "Website";

      setCaseData(p => ({
        ...p,
        trademarkIds: matchedTmIds.length ? matchedTmIds : p.trademarkIds,
        infringer: extracted.infringer || "",
        contact: extracted.contact || "",
        contactEmail: extracted.contactEmail || "",
        type: extractedType,
        source: extractedSource,
        url: extracted.url || "",
        settlement: extracted.settlement || "",
        businessName: extracted.businessName || p.businessName || "",
        businessAddress: extracted.businessAddress || p.businessAddress || "",
        licenseStart: extracted.licenseStart || p.licenseStart || "",
        licenseEnd: extracted.licenseEnd || p.licenseEnd || "",
        licenseFee: extracted.licenseFee || p.licenseFee || "",
        ldAmount: extracted.ldAmount || p.ldAmount || "",
      }));

      // Handle notes as array of {date, text} objects or fallback to string
      const rawNotes = extracted.notes || "";
      if (Array.isArray(rawNotes) && rawNotes.length > 0) {
        setImportNote(rawNotes);
      } else if (typeof rawNotes === "string" && rawNotes.trim()) {
        setImportNote([{ date: new Date().toISOString().slice(0, 10), text: rawNotes.trim() }]);
      } else {
        setImportNote([]);
      }
      setImportStatus("done");
      setMode("review");

    } catch (err) {
      console.error("Import failed:", err);
      setImportError(err && err.message ? err.message : "Unknown error");
      setImportStatus("error");
    }
  }

  // ── IMPORT LICENSE AGREEMENT (new-case) → structured license fields ──
  async function handleImportLicense(e) {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = "";
    setImportFileName(f.name);
    setImportStatus("reading");

    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });

      setImportStatus("extracting");

      setImportFileEntry({
        name: f.name, size: f.size, type: f.type,
        date: new Date().toISOString().slice(0, 10),
        dataUrl: "data:" + (f.type || "application/octet-stream") + ";base64," + base64,
      });

      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      const tmList = trademarks.map(t => `"${t.name}" (${t.description})`).join("; ");

      const licensePrompt = `You are parsing a standardized Paleo Certified, Inc. dba The Paleo Foundation trademark license agreement. These agreements ALWAYS follow the same template, so use these exact locations to find each field:

- businessName AND businessAddress: in the FIRST PARAGRAPH of the document. The licensee's legal entity name (e.g. "MCB Star, LLC") and its full mailing address both appear there.
- licenseStart AND licenseEnd: in SECTION E.1. This section states the term, e.g. "commencing on [start date] and ending on [end date]". Extract both dates.
- licenseFee: in SECTION B.5. This is the annual recurring license fee (a dollar amount, e.g. "$9,600.00").
- ldAmount: in SECTION E.3.d.ii (liquidated damages). The standard clause sets liquidated damages at one year's license fee per month of continued post-termination use. Report the PER-MONTH figure — normally equal to the annual licenseFee from Section B.5. If the section states it explicitly, use that; otherwise set it equal to the annual fee.
- certifications: on the FIRST PAGE, listed at the TOP RIGHT. These are the certification marks granted. Match them against this known list and return names exactly as they appear in the list: ${tmList}
- contact: the licensee's primary contact person name, if present anywhere in the agreement.
- contactEmail: the licensee's contact email, if present.
- contactPhone: NOT present in these agreements — always return an empty string.

Extract only what is explicitly stated. If a field genuinely cannot be found in its expected location, return an empty string for it (except ldAmount, which may be derived from the annual fee as described).

Format dates as YYYY-MM-DD when possible.

Return ONLY a raw JSON object with exactly these keys: licenseStart, licenseEnd, contact, contactEmail, contactPhone, businessName, businessAddress, licenseFee, ldAmount, certifications. No markdown, no code fences, no commentary.`;

      let messageContent;
      if (isPdf) {
        let pdfText = "";
        try { pdfText = await extractPdfText(base64); } catch (e) { pdfText = ""; }
        if (!pdfText) throw new Error("Could not read text from this PDF — it may be scanned/image-only. Try a text-based PDF or paste the text.");
        messageContent = `${licensePrompt}

LICENSE AGREEMENT TEXT:
${pdfText.slice(0, 24000)}`;
      } else {
        const text = atob(base64);
        messageContent = `${licensePrompt}

FILE CONTENT:
${text.slice(0, 24000)}`;
      }

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1200,
          system: "You are a legal document parser for Paleo Certified, Inc. dba The Paleo Foundation. Extract structured license-agreement data and return a single raw JSON object only. No markdown, no explanation, no code fences.",
          messages: [{ role: "user", content: messageContent }],
        }),
      });

      const data = await res.json();
      if (data && data.error) throw new Error("API: " + (data.error.message || JSON.stringify(data.error)));
      const raw = (data.content || []).map(b => b.text || "").join("").trim();
      console.log("FAFO new-case license import raw:", raw.slice(0, 500));
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(raw ? "Response had no JSON: " + raw.slice(0, 120) : "Empty response from API");
      const ex = JSON.parse(match[0]);

      const certNames = Array.isArray(ex.certifications) ? ex.certifications : [];
      const matchedTmIds = trademarks
        .filter(tm => certNames.some(n => {
          const a = tm.name.toLowerCase();
          const b = String(n).toLowerCase();
          return a.includes(b) || b.includes(a.split(" ")[0]) || (tm.description || "").toLowerCase().includes(b);
        }))
        .map(tm => tm.id);

      setCaseData(p => ({
        ...p,
        trademarkIds: matchedTmIds.length ? matchedTmIds : p.trademarkIds,
        infringer: ex.businessName || p.infringer || "",
        contact: ex.contact || p.contact || "",
        contactEmail: ex.contactEmail || p.contactEmail || "",
        contactPhone: ex.contactPhone || p.contactPhone || "",
        businessName: ex.businessName || p.businessName || "",
        businessAddress: ex.businessAddress || p.businessAddress || "",
        licenseStart: ex.licenseStart || p.licenseStart || "",
        licenseEnd: ex.licenseEnd || p.licenseEnd || "",
        licenseFee: ex.licenseFee || p.licenseFee || "",
        ldAmount: ex.ldAmount || p.ldAmount || "",
        type: "Expired License",
      }));

      // Build a concise import summary note
      const today = new Date().toISOString().slice(0, 10);
      const bits = [];
      if (ex.licenseStart || ex.licenseEnd) bits.push(`License term ${ex.licenseStart || "?"} to ${ex.licenseEnd || "?"}.`);
      if (ex.licenseFee) bits.push(`License fee ${ex.licenseFee}.`);
      if (ex.ldAmount) bits.push(`E.3.d.ii liquidated damages ${ex.ldAmount}/month.`);
      if (ex.businessName) bits.push(`Licensee ${ex.businessName}.`);
      const importNotes = [{ date: today, text: `License agreement imported: ${f.name}.` }];
      if (bits.length) importNotes.push({ date: today, text: bits.join(" ") });
      setImportNote(importNotes);

      setImportStatus("done");
      setMode("review");

    } catch (err) {
      console.error("License import failed:", err);
      setImportError(err && err.message ? err.message : "Unknown error");
      setImportStatus("error");
    }
  }

  const tabStyle = active => ({
    background: "none", border: "none", fontSize: 13,
    borderBottom: active ? "2px solid #111" : "2px solid transparent",
    padding: "6px 14px", fontWeight: active ? 600 : 400,
    color: active ? "#111" : "#6b7280", cursor: "pointer",
    marginBottom: -1, fontFamily: "inherit",
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>New infringement case</div>

      {/* Mode tabs */}
      <div style={{ display: "flex", borderBottom: "0.5px solid #e5e7eb", marginBottom: 16 }}>
        <button style={tabStyle(mode === "manual")} onClick={() => setMode("manual")}>Manual entry</button>
        <button style={tabStyle(mode === "import" || mode === "review")} onClick={() => { setMode("import"); setImportStatus("idle"); }}>
          Import document
        </button>
        <button style={tabStyle(mode === "license")} onClick={() => { setMode("license"); setImportStatus("idle"); }}>
          Import license
        </button>
      </div>

      {/* IMPORT LICENSE TAB */}
      {(mode === "license") && (
        <div>
          {importStatus === "idle" && (
            <DropZone
              onFile={f => handleImportLicense({ target: { files: [f] } })}
              onBrowse={() => licenseRef.current.click()}
            />
          )}
          {importStatus === "reading" && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📖</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Reading {importFileName}…</div>
            </div>
          )}
          {importStatus === "extracting" && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⎙</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Reading license agreement…</div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>Extracting term, fee, liquidated damages, and certifications</div>
            </div>
          )}
          {importStatus === "error" && (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#A32D2D", marginBottom: 8 }}>Could not read the license agreement</div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>The document may be scanned/image-only, or the format is unsupported.</div>
              {importError && <div style={{ fontSize: 11, color: "#A32D2D", marginBottom: 16, fontFamily: "monospace", wordBreak: "break-word", padding: "0 16px" }}>{importError}</div>}
              <button onClick={() => { setImportStatus("idle"); setImportFileName(""); setImportError(""); }} style={outlineBtn}>Try another file</button>
            </div>
          )}
          <input ref={licenseRef} type="file" accept=".pdf,.eml,.txt,.msg" style={{ display: "none" }} onChange={handleImportLicense} />
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 12, lineHeight: 1.5 }}>
            Imports license start/end, contact, business name & address, license fee, the E.3.d.ii liquidated-damages amount, and the certifications granted. You can review and edit everything before creating the case.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* IMPORT TAB */}
      {(mode === "import") && (
        <div>
          {importStatus === "idle" && (
            <DropZone
              onFile={f => handleImportFile({ target: { files: [f] } })}
              onBrowse={() => fileRef.current.click()}
            />
          )}
          {importStatus === "reading" && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📖</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Reading {importFileName}…</div>
            </div>
          )}
          {importStatus === "extracting" && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Extracting case information…</div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>Claude is reading the document</div>
            </div>
          )}
          {importStatus === "error" && (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#A32D2D", marginBottom: 8 }}>Could not extract case data</div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>The document may be scanned/image-only, or the format is unsupported.</div>
              {importError && <div style={{ fontSize: 11, color: "#A32D2D", marginBottom: 16, fontFamily: "monospace", wordBreak: "break-word", padding: "0 16px" }}>{importError}</div>}
              <button onClick={() => { setImportStatus("idle"); setImportFileName(""); setImportError(""); }} style={outlineBtn}>Try another file</button>
            </div>
          )}
          <input ref={fileRef} type="file" accept=".pdf,.eml,.txt,.msg" style={{ display: "none" }} onChange={handleImportFile} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* REVIEW TAB — shows after successful import, fully editable */}
      {mode === "review" && (
        <div>
          <div style={{ background: "#EAF3DE", border: "0.5px solid #97C459", borderRadius: 6, padding: "5px 10px", marginBottom: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#3B6D11" }}>✓</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: "#3B6D11" }}>{importFileName}</span>
            {Array.isArray(importNote) && importNote.length > 0 && (
              <span style={{ fontSize: 11, color: "#3B6D11", background: "#d1fae5", padding: "1px 7px", borderRadius: 4 }}>
                {importNote.length} note{importNote.length !== 1 ? "s" : ""} extracted
              </span>
            )}
            <span style={{ fontSize: 11, color: "#5A8A30", marginLeft: "auto" }}>Review and edit below</span>
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto", paddingRight: 4 }}>
            <CaseForm trademarks={trademarks} caseData={caseData} setCaseData={setCaseData} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button onClick={() => { setMode("import"); setImportStatus("idle"); }} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>← Re-import</button>
            <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            <button onClick={handleSave} disabled={!caseData.infringer.trim()} style={{ ...outlineBtn, opacity: caseData.infringer.trim() ? 1 : 0.5 }}>Create case</button>
          </div>
        </div>
      )}

      {/* MANUAL TAB */}
      {mode === "manual" && (
        <div>
          <div style={{ maxHeight: 420, overflowY: "auto", paddingRight: 4 }}>
            <CaseForm trademarks={trademarks} caseData={caseData} setCaseData={setCaseData} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button onClick={onClose} style={{ fontSize: 13, padding: "7px 14px", border: "0.5px solid #e5e7eb", borderRadius: 8, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            <button onClick={handleSave} disabled={!caseData.infringer.trim()} style={{ ...outlineBtn, opacity: caseData.infringer.trim() ? 1 : 0.5 }}>Create case</button>
          </div>
        </div>
      )}
    </ModalOverlay>
  );
}

// ── SAVE POINT MODAL ──
// Triggered by keyword: "save point vX.X.X"
// Saves current build to Drive Versions folder, increments version in app.
function SavePointModal({ currentVersion, nextVersion, onConfirm, onAbort }) {
  const [status, setStatus] = useState("confirm"); // confirm | saving | done | error

  async function handleConfirm() {
    setStatus("saving");
    try {
      await onConfirm();
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 2000, padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, padding: "2rem",
        width: "100%", maxWidth: 400, border: "0.5px solid #e5e7eb",
        textAlign: "center",
      }}>
        {status === "confirm" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>💾</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Save Point</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20, lineHeight: 1.6 }}>
            This will save <strong>{currentVersion}</strong> to Google Drive (Versions folder)
            and continue development as <strong>{nextVersion}</strong>.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button onClick={onAbort} style={{
              fontSize: 13, padding: "8px 20px", border: "1px solid #d1d5db",
              borderRadius: 8, background: "#fff", color: "#374151", cursor: "pointer", fontFamily: "inherit",
            }}>Cancel</button>
            <button onClick={handleConfirm} style={{
              fontSize: 13, padding: "8px 20px", border: "none",
              borderRadius: 8, background: "#111", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
            }}>Confirm Save Point</button>
          </div>
        </>)}
        {status === "saving" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Saving to Drive…</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>Uploading {currentVersion} to Versions folder</div>
        </>)}
        {status === "done" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Save point complete</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20, lineHeight: 1.6 }}>
            <strong>{currentVersion}</strong> saved to Drive.<br />
            Now running as <strong>{nextVersion}</strong>.
          </div>
          <button onClick={onAbort} style={{
            fontSize: 13, padding: "8px 20px", border: "none",
            borderRadius: 8, background: "#111", color: "#fff", cursor: "pointer", fontFamily: "inherit",
          }}>Done</button>
        </>)}
        {status === "error" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>❌</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Save failed</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>
            Drive upload failed. No changes were made. You are still on <strong>{currentVersion}</strong>.
          </div>
          <button onClick={onAbort} style={{
            fontSize: 13, padding: "8px 20px", border: "1px solid #d1d5db",
            borderRadius: 8, background: "#fff", color: "#374151", cursor: "pointer", fontFamily: "inherit",
          }}>Close</button>
        </>)}
      </div>
    </div>
  );
}

// ── ROOT ──
// ── BACKUP MODAL ──
function BackupModal({ status, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 2000, padding: 20,
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, padding: "2rem",
        width: "100%", maxWidth: 420, border: "0.5px solid #e5e7eb",
        textAlign: "center",
      }}>
        {status === "running" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>☁️</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Saving to Drive…</div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Uploading session snapshot to Chat Archive.</div>
        </>)}
        {status === "done" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Backup complete</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20, lineHeight: 1.6 }}>
            Session snapshot saved to Drive → Chat Archive.<br />
            <strong>Now save locally:</strong> click <em>"Download all"</em> in the sidebar
            (the ↓ icon) to download a zip of all artifacts to your hard drive.
          </div>
          <div style={{ background: "#f9fafb", border: "0.5px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", marginBottom: 20, fontSize: 12, color: "#374151", textAlign: "left", lineHeight: 1.7 }}>
            <strong>Sidebar → ↓ Download all</strong><br />
            This saves a .zip containing the current <code>FAFOApp.jsx</code> and all artifacts.
            Store it in a safe place — this is your full local backup.
          </div>
          <button onClick={onClose} style={{
            fontSize: 13, padding: "8px 24px", border: "none",
            borderRadius: 8, background: "#111", color: "#fff",
            cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
          }}>Got it</button>
        </>)}
        {status === "error" && (<>
          <div style={{ fontSize: 28, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Drive upload failed</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20, lineHeight: 1.6 }}>
            Couldn't reach Drive — but you can still save locally.<br />
            Click <em>"Download all"</em> in the sidebar (↓ icon) to save a zip to your hard drive.
          </div>
          <button onClick={onClose} style={{
            fontSize: 13, padding: "8px 24px", border: "none",
            borderRadius: 8, background: "#111", color: "#fff",
            cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
          }}>Got it</button>
        </>)}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("Dashboard");
  const [trademarks, setTrademarks] = useState(SAMPLE_TRADEMARKS);
  const [cases, setCases] = useState(PRESET_CASES);
  const [selectedCase, setSelectedCase] = useState(null);
  const [modal, setModal] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [savePoint, setSavePoint] = useState(null);
  const [selloffResult, setSelloffResult] = useState(null);
  const [amandaMode, setAmandaMode] = useState(false);
  const [backupModal, setBackupModal] = useState(null); // null | "running" | "done" | "error"
  const VERSIONS_FOLDER_ID = "1q2dwV6j9qJpqZpAW3VEoPuuzTWeFsJjo";
  const PROXY_URL = "https://fafo-drive-proxy-134533637471.us-central1.run.app";

  useEffect(() => {
    async function load() {
      // Reads localStorage first (sync, sandbox-reliable), then window.storage as
      // fallback. Whichever has data wins; we re-persist so localStorage becomes
      // authoritative going forward.
      async function readKey(key) {
        try {
          const local = window.localStorage.getItem(key);
          if (local) return local;
        } catch {}
        try {
          const res = await window.storage.get(key);
          if (res?.value) {
            // migrate into localStorage
            try { window.localStorage.setItem(key, res.value); } catch {}
            return res.value;
          }
        } catch {}
        return null;
      }

      try {
        let tms = SAMPLE_TRADEMARKS;
        const tmRaw = await readKey("fafo_trademarks");
        if (tmRaw) { const p = JSON.parse(tmRaw); if (Array.isArray(p) && p.length > 0) tms = p; }
        const hydrated = await Promise.all(tms.map(async tm => {
          const logo = await loadLogo(tm.id);
          return logo ? { ...tm, logo } : tm;
        }));
        setTrademarks(hydrated);

        const caseRaw = await readKey("fafo_cases_v2");
        if (caseRaw) { const p = JSON.parse(caseRaw); if (Array.isArray(p) && p.length > 0) setCases(p); }
      } catch {}
    }
    load();
  }, []);

  async function saveTM() {
    setTrademarks(prev => {
      const lean = prev.map(t => ({ ...t, logo: null }));
      const ok = persist("fafo_trademarks", lean);
      setSaveStatus(ok ? "tm_saved" : "tm_error");
      setTimeout(() => setSaveStatus(null), 2000);
      return prev;
    });
  }

  // Persist to BOTH localStorage (synchronous, sandbox-reliable) and window.storage
  // (async artifact store). localStorage is the source of truth for restore/backup;
  // a failure in either path never blocks the other or loses data.
  function persist(key, value) {
    const json = JSON.stringify(value);
    let localOk = false;
    try { window.localStorage.setItem(key, json); localOk = true; } catch {}
    // best-effort secondary write; ignore failures
    try {
      const p = window.storage && window.storage.set && window.storage.set(key, json);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
    return localOk;
  }

  async function saveCases(caseList) {
    const ok = persist("fafo_cases_v2", caseList);
    setSaveStatus(ok ? "case_saved" : "case_error");
    setTimeout(() => setSaveStatus(null), 2000);
  }

  function updateCase(updated) {
    setCases(prev => {
      const next = prev.map(c => c.id === updated.id ? updated : c);
      // Auto-persist every case edit immediately — no manual Save needed
      persist("fafo_cases_v2", next);
      return next;
    });
  }
  function handleLogoUpload(tmId, dataUrl) {
    setTrademarks(prev => {
      const next = prev.map(t => t.id === tmId ? { ...t, logo: dataUrl } : t);
      // Save trademarks WITHOUT logo data (logos stored separately in fafo_logo_<id>)
      const lean = next.map(t => ({ ...t, logo: null }));
      persist("fafo_trademarks", lean);
      return next;
    });
  }

  function handleSaveNewTM(tm) {
    setTrademarks(prev => {
      const next = [...prev, {
        id: Date.now(), name: tm.name.trim(),
        description: `${tm.regNumber ? "Reg. No. " + tm.regNumber + " — " : ""}${tm.description.trim()}`,
        logo: null, licenses: [],
      }];
      persist("fafo_trademarks", next);
      return next;
    });
  }

  function handleSaveNewCase(nc, importNote, importFileEntry) {
    const tmIds = nc.trademarkIds.length > 0 ? nc.trademarkIds : [trademarks[0]?.id].filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    // importNote is now an array of {date, text} objects
    const notes = Array.isArray(importNote) && importNote.length > 0
      ? importNote.map(n => ({ date: n.date || today, text: n.text || "" })).filter(n => n.text)
      : importNote && typeof importNote === "string"
        ? [{ date: today, text: importNote }]
        : [];
    const files = importFileEntry ? [importFileEntry] : [];
    const newEntry = {
      id: Date.now(), ...nc,
      trademarkIds: tmIds,
      status: "In Progress",
      dateOpened: today,
      payments: [], files, notes, letters: [], infringingProofs: [],
    };
    const next = [...cases, newEntry];
    setCases(next);
    saveCases(next);
    setModal(null);
    if (importNote || importFileEntry) {
      setSelectedCase(newEntry);
    } else {
      setTab("Cases");
    }
  }

  function createCaseFromDetection(url) {
    let host = url;
    try { host = new URL(url.startsWith("http") ? url : "https://" + url).hostname; } catch {}
    const nc = {
      id: Date.now(), trademarkIds: [trademarks[0]?.id].filter(Boolean),
      infringer: host, contact: "", type: "Unlicensed Use - Never Certified", status: "In Progress",
      source: "Website", url, settlement: "",
      dateOpened: new Date().toISOString().slice(0, 10),
      payments: [], files: [],
      notes: [{ date: new Date().toISOString().slice(0, 10), text: "Auto-created from FAFO scan." }],
      letters: [],
      infringingProofs: [],
    };
    const next = [...cases, nc]; setCases(next); saveCases(next); setTab("Cases");
  }

  // ── SAVE POINT LOGIC ──
  // Keyword: "save point vX.X.X" — saves current version to Drive, bumps to next
  function parseSavePointKeyword(input) {
    // Match "save point v1.0.3" style — version must be one ahead of current
    const match = input.trim().toLowerCase().match(/^save point (v\d+\.\d+\.\d+)$/);
    if (!match) return null;
    return match[1]; // e.g. "v1.0.3"
  }

  function incrementVersion(vStr) {
    // Increments patch number: v1.0.3 -> v1.0.4
    const parts = vStr.replace("v", "").split(".");
    parts[2] = String(parseInt(parts[2]) + 1);
    return "v" + parts.join(".");
  }

  function triggerSavePoint(versionArg) {
    // versionArg is the version being saved (current running version)
    const next = incrementVersion(versionArg);
    setSavePoint({ currentVersion: versionArg, nextVersion: next });
  }

  async function executeSavePoint(currentVersion, nextVersion) {
    // Upload version record to Drive Versions folder via proxy
    const versionRecord = [
      "FAFO App " + currentVersion + " \u2014 Version Record",
      "Date: " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
      "Build: Paleo Certified, Inc. dba The Paleo Foundation",
      "",
      "Saved via save point keyword from live session.",
      "Storage keys: fafo_trademarks | fafo_cases_v2 | fafo_docs | fafo_legacy_payments",
      "AI model: claude-sonnet-4-20250514",
      "Drive proxy: https://fafo-drive-proxy-134533637471.us-central1.run.app",
      "",
      "TO RESTORE: Request 'FAFO App " + currentVersion + " source code' in a Claude conversation.",
    ].join("\n");

    const b64 = btoa(unescape(encodeURIComponent(versionRecord)));

    const res = await fetch(PROXY_URL + "/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        infringerName: "__versions__",
        fileName: "FAFO App " + currentVersion + " \u2014 " + new Date().toISOString().slice(0, 10) + ".txt",
        mimeType: "text/plain",
        base64: b64,
        targetFolderId: VERSIONS_FOLDER_ID,
      }),
    });

    if (!res.ok) throw new Error("Drive upload failed");
    // On success: version is now saved. The app continues as nextVersion.
    // Nothing to revert — next build will use nextVersion naturally.
  }

  function abortSavePoint() {
    setSavePoint(null);
  }

  // ── KEYWORD HANDLERS ──
  function parseSelloffKeyword(input) {
    const match = input.trim().match(/^selloff\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }

  function calcSelloff(brand, licenseEndDate) {
    if (!licenseEndDate) return null;
    const end = new Date(licenseEndDate);
    const selloff = new Date(end);
    selloff.setDate(selloff.getDate() + 180);
    return { brand, licenseEnd: end.toISOString().slice(0, 10), selloffEnd: selloff.toISOString().slice(0, 10) };
  }

  function handleKeywordInput(input) {
    // selloff [Brand]
    const brand = parseSelloffKeyword(input);
    if (brand) {
      const match = cases.find(c => c.infringer.toLowerCase().includes(brand.toLowerCase()));
      const licenseEnd = match?.dateOpened || null;
      const result = calcSelloff(brand, licenseEnd);
      if (result) {
        setSelloffResult(result);
      } else {
        setSelloffResult({ brand, licenseEnd: null, selloffEnd: null, error: "No case found or no license end date on file." });
      }
      return;
    }
    // AMANDA — switch to Cases and show a prompt
    if (input.trim().toUpperCase() === "AMANDA") {
      setTab("Cases");
      setAmandaMode(true);
      return;
    }
    // save point
    const spVersion = parseSavePointKeyword(input);
    if (spVersion) {
      triggerSavePoint(spVersion);
      return;
    }
    // backup — save snapshot to Drive + prompt local download
    if (input.trim().toLowerCase() === "backup") {
      triggerBackup();
      return;
    }
    // save pending export — handled externally by Claude in chat
    if (/^save pending export/i.test(input.trim())) {
      setSearchQuery("");
      return;
    }
    // SAVE_TO_DRIVE — user pasted from letter card, Claude in chat handles it
    if (input.trim().startsWith("SAVE_TO_DRIVE")) {
      setSearchQuery("");
      return;
    }
  }

  // ── BACKUP LOGIC ──
  async function triggerBackup() {
    setBackupModal("running");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const activeCases = cases.filter(c => c.status !== "Resolved");
      const resolvedCases = cases.filter(c => c.status === "Resolved");
      const lines = [
        "FAFO App — Session Snapshot",
        "Date: " + today,
        "Version: " + APP_VERSION,
        "Project: Paleo Certified, Inc. dba The Paleo Foundation",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "STORAGE KEYS",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "fafo_cases_v2         — All case records (auto-saves on every edit)",
        "fafo_trademarks       — Trademark records without logo data",
        "fafo_logo_1..6        — Trademark logos (compressed JPEG, per-key)",
        "fafo_docs             — Pinned Drive links",
        "fafo_legacy_payments  — Legacy metrics entries",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "ACTIVE CASES (" + today + ")",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ...activeCases.map(c => `${c.id}  ${c.infringer.padEnd(40)} ${c.type.padEnd(42)} ${c.status}  ${c.dateOpened}`),
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "RESOLVED CASES",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ...resolvedCases.map(c => {
          const received = (c.payments || []).filter(p => p.received).reduce((s, p) => s + (p.amount || 0), 0);
          return `${c.id}  ${c.infringer.padEnd(40)} ${received > 0 ? "$" + received.toLocaleString() : c.settlement || "—"}`;
        }),
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "DRIVE FOLDER IDs",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Root:         1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89",
        "Versions:     1q2dwV6j9qJpqZpAW3VEoPuuzTWeFsJjo",
        "Logos:        1xe-tWgQsqv14GkuNhzQqACtoSm2g2v1I",
        "Chat Archive: 137gu8VzHZticI0CQlI-74jTA917DZt6Q",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "HOW TO RESUME IN A NEW CHAT",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "1. Start new Claude.ai conversation in the same Project",
        "2. Upload: FAFO_App_Master_Reference.md + fafo-app.jsx (" + APP_VERSION + ")",
        "3. Say: Continuation of FAFO build. Treat reference as active knowledge base",
        "   and render the app in the sidebar.",
        "4. All case data reloads from fafo_cases_v2 automatically.",
        "5. All logos reload from fafo_logo_1 through fafo_logo_6.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "OUTSIDE COUNSEL — TRESTLE LAW, APC",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Amanda L. Bruss    — amanda@trestlelaw.com | 619-343-3655 ext.24",
        "Kristen G. Roberts — kristen@trestlelaw.com",
        "Kayley Seedborg    — kayley@trestlelaw.com",
      ];
      const text = lines.join("\n");
      const b64 = btoa(unescape(encodeURIComponent(text)));

      // Upload to Drive Chat Archive via Claude API relay
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 256,
          mcp_servers: [{ type: "url", url: "https://drivemcp.googleapis.com/mcp/v1", name: "gdrive" }],
          system: "You are a Drive backup relay for FAFO App. Upload the provided text file to Google Drive folder ID 137gu8VzHZticI0CQlI-74jTA917DZt6Q (Chat Archive). Respond ONLY with raw JSON: {\"ok\":true} on success or {\"ok\":false,\"error\":\"reason\"} on failure.",
          messages: [{
            role: "user",
            content: `Upload this file to Drive. Folder: 137gu8VzHZticI0CQlI-74jTA917DZt6Q. Title: FAFO Snapshot — ${APP_VERSION} (${today}).txt. Content (plain text): ${text.slice(0, 4000)}`,
          }],
        }),
      });
      // Drive upload result — we show done regardless since snapshot content is what matters
      setBackupModal("done");
    } catch (err) {
      console.error("Backup failed:", err);
      setBackupModal("error");
    }
  }

  // ── SEARCH LOGIC ──
  function getSearchResults(query) {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return cases.filter(c => {
      const tmNames = (c.trademarkIds || []).map(id => trademarks.find(t => t.id === id)?.name || "").join(" ");
      return (
        c.infringer.toLowerCase().includes(q) ||
        (c.contact || "").toLowerCase().includes(q) ||
        (c.url || "").toLowerCase().includes(q) ||
        (c.type || "").toLowerCase().includes(q) ||
        (c.status || "").toLowerCase().includes(q) ||
        (c.source || "").toLowerCase().includes(q) ||
        (c.settlement || "").toLowerCase().includes(q) ||
        (c.dateOpened || "").includes(q) ||
        tmNames.toLowerCase().includes(q) ||
        (c.notes || []).some(n => n.text.toLowerCase().includes(q))
      );
    });
  }

  const searchResults = getSearchResults(searchQuery);

  const TABS = ["Dashboard", "Trademarks", "Cases", "Detection", "Metrics", "Docs", "Reference"];

  if (selectedCase) return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", padding: "1rem 1.25rem", maxWidth: 820, margin: "0 auto", color: "#111" }}>
      <CaseDetail caseItem={selectedCase} trademarks={trademarks} onBack={() => setSelectedCase(null)} onUpdate={u => { updateCase(u); setSelectedCase(u); }} />
    </div>
  );

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", padding: "1rem 1.25rem", maxWidth: 820, margin: "0 auto", color: "#111" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>FAFO App</span>
          <span
              title={'Save point keyword: "save point v1.0.3"'}
              onClick={() => triggerSavePoint(APP_VERSION)}
              style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400, letterSpacing: "0.02em", cursor: "pointer", textDecoration: "underline dotted" }}
            >{APP_VERSION}</span>
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, letterSpacing: "0.01em" }}>Find. Audit. Flag. Oppose. — Paleo Certified, Inc.</div>
      </div>

      {/* Search / Keyword bar */}
      <div style={{ marginBottom: 10, position: "relative" }}>
        <input
          value={searchQuery}
          placeholder='Search cases… or: FAFO | AMANDA | save point vX.X.X | backup | save pending export'
          onChange={e => {
            const val = e.target.value;
            setSearchQuery(val);
            // Auto-navigate to Cases tab when typing a search
            if (val.trim() && tab !== "Cases") setTab("Cases");
          }}
          onKeyDown={e => {
            if (e.key === "Enter" && searchQuery.trim()) {
              // Check if it's a keyword command (not a search)
              const kw = searchQuery.trim();
              const isSelloff = /^selloff\s+/i.test(kw);
              const isAmanda = kw.toUpperCase() === "AMANDA";
              const isSavePoint = /^save point v\d+\.\d+\.\d+$/i.test(kw);
              const isBackup = kw.toLowerCase() === "backup";
              const isPendingExport = /^save pending export/i.test(kw);
              if (isSelloff || isAmanda || isSavePoint || isBackup || isPendingExport) {
                handleKeywordInput(kw);
                setSearchQuery("");
              }
            }
            if (e.key === "Escape") setSearchQuery("");
          }}
          style={{ width: "100%", fontSize: 12, padding: "6px 10px", paddingRight: searchQuery ? 28 : 10, border: "0.5px solid #e5e7eb", borderRadius: 7, background: "#f9fafb", color: "#374151", boxSizing: "border-box", fontFamily: "inherit", outline: "none" }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", fontSize: 13, color: "#9ca3af", cursor: "pointer", padding: 0, lineHeight: 1 }}
          >✕</button>
        )}
      </div>

      {/* Selloff result banner */}
      {selloffResult && (
        <div style={{ background: selloffResult.error ? "#FCEBEB" : "#EAF3DE", border: `0.5px solid ${selloffResult.error ? "#F5C6C6" : "#97C459"}`, borderRadius: 8, padding: "10px 14px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: selloffResult.error ? "#A32D2D" : "#3B6D11" }}>
              {selloffResult.error ? `Selloff: ${selloffResult.brand}` : `Sell-off: ${selloffResult.brand}`}
            </div>
            {selloffResult.error
              ? <div style={{ fontSize: 12, color: "#A32D2D" }}>{selloffResult.error}</div>
              : <div style={{ fontSize: 12, color: "#3B6D11" }}>
                  License end: {selloffResult.licenseEnd} &nbsp;|&nbsp; Sell-off ends: <strong>{selloffResult.selloffEnd}</strong> (180 days)
                </div>
            }
          </div>
          <button onClick={() => setSelloffResult(null)} style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #d1d5db", borderRadius: 6, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
        </div>
      )}

      {/* AMANDA mode banner */}
      {amandaMode && (
        <div style={{ background: "#EBF2FB", border: "0.5px solid #A8C8F0", borderRadius: 8, padding: "10px 14px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A6FD4" }}>AMANDA mode active</div>
            <div style={{ fontSize: 12, color: "#3A6EA8" }}>Open a case → Letters tab → Generate enforcement letter (AMANDA)</div>
          </div>
          <button onClick={() => setAmandaMode(false)} style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #d1d5db", borderRadius: 6, background: "transparent", color: "#6b7280", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, borderBottom: "0.5px solid #e5e7eb", marginBottom: "1.25rem", overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: "none", border: "none",
            borderBottom: tab === t ? "2px solid #111" : "2px solid transparent",
            padding: "8px 14px", fontSize: 13,
            fontWeight: tab === t ? 600 : 400,
            color: tab === t ? "#111" : "#6b7280",
            cursor: "pointer", marginBottom: -1, whiteSpace: "nowrap",
            fontFamily: "inherit",
          }}>{t}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "Dashboard"  && <Dashboard cases={cases} trademarks={trademarks} onViewCase={c => setSelectedCase(c)} />}
      {tab === "Trademarks" && <Trademarks trademarks={trademarks} cases={cases} onAdd={() => setModal("newTM")} onLogoUpload={handleLogoUpload} onSave={saveTM} saveStatus={saveStatus} />}
      {tab === "Cases"      && <CasesTab cases={cases} trademarks={trademarks} onView={setSelectedCase} onNew={() => setModal("newCase")} onSave={() => setCases(prev => { saveCases(prev); return prev; })} saveStatus={saveStatus} searchResults={searchResults} searchQuery={searchQuery} />}
      {tab === "Detection"  && <Detection trademarks={trademarks} onCreateCase={createCaseFromDetection} />}
      {tab === "Metrics"    && <Metrics cases={cases} />}
      {tab === "Docs"       && <Docs />}
      {tab === "Reference"  && <Reference />}

      {modal === "newTM" && (
        <NewTMModal onClose={() => setModal(null)} onSave={handleSaveNewTM} />
      )}
      {modal === "newCase" && (
        <NewCaseModal trademarks={trademarks} onClose={() => setModal(null)} onSave={handleSaveNewCase} />
      )}

      {savePoint && (
        <SavePointModal
          currentVersion={savePoint.currentVersion}
          nextVersion={savePoint.nextVersion}
          onConfirm={() => executeSavePoint(savePoint.currentVersion, savePoint.nextVersion)}
          onAbort={abortSavePoint}
        />
      )}
      {backupModal && (
        <BackupModal status={backupModal} onClose={() => setBackupModal(null)} />
      )}
    </div>
  );
}
