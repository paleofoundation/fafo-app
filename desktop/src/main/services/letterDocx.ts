/**
 * Local Word (.docx) rendering for letters and referrals.
 *
 * Same house style as the PDF and Drive paths — centered title block, two-tone
 * blue headings, plain body, exhibits inline — but as a real editable document,
 * so a small wording change does not mean regenerating from scratch. Built with
 * the `docx` library (pure JS, no native deps), imported lazily so this module
 * stays loadable and testable outside a packaged app.
 */

import { SCREENSHOT_MARKER } from '../../shared/domain/summaryPrompt'
import type { EncodedExhibit } from './referralShots'

const H1BLUE = '1F3864'
const H2BLUE = '2E5496'
const INK = '20242B'
const MUTE = '5A6672'
const PT_TO_PX = 96 / 72 // docx image transformation is pixels at 96dpi

/** Split a line into runs, honouring **bold** and *italic* (letters still use them). */
function inlineRuns(
  text: string,
  TextRun: typeof import('docx').TextRun,
  base: { color?: string; bold?: boolean; size?: number } = {}
): InstanceType<typeof import('docx').TextRun>[] {
  const runs: InstanceType<typeof import('docx').TextRun>[] = []
  const re = /\*\*(.+?)\*\*|\*(?!\s)(.+?)(?<!\s)\*/g
  let last = 0
  let m: RegExpExecArray | null
  const push = (t: string, extra: { bold?: boolean; italics?: boolean }): void => {
    if (t) runs.push(new TextRun({ text: t, color: base.color, bold: base.bold, size: base.size, ...extra }))
  }
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index), {})
    if (m[1] !== undefined) push(m[1], { bold: true })
    else push(m[2]!, { italics: true })
    last = m.index + m[0].length
  }
  push(text.slice(last), {})
  return runs.length ? runs : [new TextRun({ text: '', ...base })]
}

export async function letterToDocx(
  title: string,
  bodyText: string,
  exhibits: EncodedExhibit[] = []
): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, BorderStyle } = await import(
    'docx'
  )
  const children: InstanceType<typeof import('docx').Paragraph>[] = []
  let titleOpen = false
  let started = false

  const emitExhibits = (): void => {
    for (const ex of exhibits) {
      const buf = Buffer.from(ex.dataBase64, 'base64')
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 40 },
          children: [
            new ImageRun({
              data: buf,
              type: 'jpg',
              transformation: {
                width: Math.round(ex.widthPt * PT_TO_PX),
                height: Math.round(ex.heightPt * PT_TO_PX)
              }
            })
          ]
        })
      )
      const where = ex.platform ? `${ex.platform}, ` : ''
      const when = ex.date ? `captured ${usDateLocal(ex.date)}` : 'capture date not recorded'
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 120 },
          children: [
            new TextRun({ text: `Exhibit ${ex.label} — ${where}${when}`, italics: true, color: MUTE, size: 18 })
          ]
        })
      )
    }
  }

  for (const raw of bodyText.split('\n')) {
    const t = raw.trim()
    if (t === SCREENSHOT_MARKER) {
      emitExhibits()
      continue
    }
    if (t === '') continue
    if (t === '---' || t === '***') {
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 120 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: H2BLUE, space: 1 } },
          children: []
        })
      )
      continue
    }
    const heading = t.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      const level = heading[1]!.length
      const body = heading[2]!
      const numbered = /^\d+\.\s/.test(body.trim())
      if (level === 1 && !numbered && !titleOpen && !started) titleOpen = true
      else if (titleOpen && (numbered || level >= 2)) titleOpen = false
      started = true
      if (titleOpen) {
        // The document title line.
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: inlineRuns(body, TextRun, { color: H1BLUE, bold: true, size: 34 })
          })
        )
      } else if (level === 1) {
        children.push(
          new Paragraph({
            spacing: { before: 320, after: 100 },
            children: inlineRuns(body, TextRun, { color: H1BLUE, bold: true, size: 28 })
          })
        )
      } else if (level === 2) {
        children.push(
          new Paragraph({
            spacing: { before: 220, after: 60 },
            children: inlineRuns(body, TextRun, { color: H2BLUE, bold: true, size: 24 })
          })
        )
      } else {
        children.push(
          new Paragraph({
            spacing: { before: 160, after: 40 },
            children: inlineRuns(body, TextRun, { color: INK, bold: true, size: 22 })
          })
        )
      }
      continue
    }
    const bullet = t.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 40 },
          children: inlineRuns(bullet[1]!, TextRun, { color: INK, size: 21 })
        })
      )
      continue
    }
    // A title-block subtitle line (centered, muted) vs an ordinary paragraph.
    if (titleOpen) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 20 },
          children: inlineRuns(t, TextRun, { color: MUTE, size: 21 })
        })
      )
    } else {
      children.push(
        new Paragraph({
          spacing: { after: 100 },
          children: inlineRuns(t, TextRun, { color: INK, size: 21 })
        })
      )
    }
  }

  // Marker missing but exhibits present — never drop the captures.
  if (exhibits.length && !bodyText.includes(SCREENSHOT_MARKER)) emitExhibits()

  const doc = new Document({
    creator: 'FAFO — The Paleo Foundation',
    title,
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 21, color: INK } }
      }
    },
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children
      }
    ]
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

/** MM/DD/YYYY — a tiny local copy so this module needs no cross-import. */
function usDateLocal(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}
