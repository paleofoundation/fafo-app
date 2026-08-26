/**
 * Local PDF and standalone-HTML rendering for letters and referrals.
 *
 * The Drive path renders through Google Docs, but it needs a live Cloud Run
 * service and a Google refresh token that has now expired twice. A referral
 * going to outside counsel should not be hostage to either, so this renders the
 * same house-style markup through Chromium instead — matching the approved
 * artifact-era referral: a centered title block, two-tone blue section
 * headings, a clean sans body, and the captures inline as data URIs.
 */

import fs from 'node:fs'
import path from 'node:path'
import { letterToHtml } from './letters'
import type { EncodedExhibit } from './referralShots'

// The Paleo Foundation referral house style, taken from the approved artifact-era
// document: a two-tone blue heading scale on a clean page, no rules.
const H1BLUE = '#1F3864' // section headings (Heading 1)
const H2BLUE = '#2E5496' // subsection headings (Heading 2)
const INK = '#20242B' // body text
const MUTE = '#5A6672' // captions and the title subtitle

/** US Letter with one-inch margins, matching the Docs template. */
const PAGE_CSS = `
  @page { size: Letter; margin: 1in; }
  body {
    font-family: Calibri, "Aptos", "Avenir Next", Helvetica, Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.45; color: ${INK};
    margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* Section headings: bold blue, no rule — the reference document's look. */
  h1.fafo-h1 { font-size: 15pt; font-weight: bold; color: ${H1BLUE};
       margin: 22pt 0 6pt; break-after: avoid; }
  h2.fafo-h2 { font-size: 12.5pt; font-weight: bold; color: ${H2BLUE};
       margin: 14pt 0 3pt; break-after: avoid; }
  h3.fafo-h3 { font-size: 11pt; font-weight: bold; color: ${INK}; margin: 10pt 0 2pt; break-after: avoid; }
  /* Centered title block: title, "v." party stack, referral date. */
  .fafo-titleblock { text-align: center; margin: 0 0 8pt; }
  .fafo-titleblock h1.fafo-h1 { font-size: 17pt; margin: 0 0 2pt; }
  .fafo-titleblock p { margin: 1pt 0; color: ${MUTE}; }
  .fafo-titleblock strong { color: ${INK}; }
  p { margin: 0 0 6pt; }
  ul { margin: 0 0 6pt 0; padding-left: 18pt; }
  li { margin: 0 0 2pt; }
  hr { border: none; border-bottom: 0.5pt solid ${H2BLUE}; margin: 8pt 0; }
  /* A capture must not be split across a page boundary, and must stay with the
     caption that dates it — an undated exhibit proves nothing. Capped at 3.4in
     tall so two exhibits and their captions fit on a page: unconstrained, a
     1600px capture renders 4.2in tall and each one claimed a page of its own,
     with half of it blank. At that size a 1600px source still resolves near
     300dpi, so nothing is lost when counsel zooms in. */
  img.exhibit { display: block; max-width: 100%; max-height: 3.4in; width: auto; height: auto;
                margin: 10pt auto 2pt; break-inside: avoid; page-break-inside: avoid; }
  img.exhibit + p, p.fafo-caption { text-align: center; font-size: 9pt; color: ${MUTE};
                    break-before: avoid; page-break-before: avoid; }
`

/** A complete, self-contained HTML document — no external assets of any kind. */
export function letterToDocument(
  title: string,
  bodyText: string,
  exhibits: EncodedExhibit[] = []
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head><body>
${letterToHtml(title, bodyText, exhibits, 'inline')}
</body></html>`
}

/**
 * Render to PDF bytes.
 *
 * The document goes through a temp file rather than a data: URL because
 * Chromium caps data-URL length and an exhibit set runs to megabytes. The
 * window is destroyed and the temp file removed even when printing throws.
 */
export async function letterToPdf(
  title: string,
  bodyText: string,
  exhibits: EncodedExhibit[] = []
): Promise<Buffer> {
  // Imported here rather than at module scope so letterToDocument stays
  // loadable — and testable — outside a running Electron app.
  const { BrowserWindow, app } = await import('electron')
  const tmp = path.join(
    app.getPath('temp'),
    `fafo-print-${process.pid}-${Math.random().toString(36).slice(2)}.html`
  )
  fs.writeFileSync(tmp, letterToDocument(title, bodyText, exhibits), 'utf8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  try {
    await win.loadFile(tmp)
    // did-finish-load fires before webfont layout settles; printing early
    // reflows the document in the PDF.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
    return await win.webContents.printToPDF({
      pageSize: 'Letter',
      printBackground: true,
      margins: { top: 1, bottom: 1, left: 1, right: 1 }
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.rmSync(tmp, { force: true })
  }
}
