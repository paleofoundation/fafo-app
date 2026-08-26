import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrations'
import { seedIfEmpty } from '../../db/seed'
import { letterToHtml, licenseFactsBlock } from '../letters'

describe('letterToHtml (branded Drive export)', () => {
  it('renders SUMMARY markdown headings as real headings, not literal #', () => {
    const html = letterToHtml('Referral', '# 1. Parties\n## 1a. Licensor\nBody text here.')
    expect(html).toContain('<h1')
    expect(html).toContain('>1. Parties<')
    expect(html).toContain('<h2')
    expect(html).toContain('>1a. Licensor<')
    expect(html).toContain('<p>Body text here.</p>')
    // The literal markdown marker must not survive into the document.
    expect(html).not.toMatch(/<p>#/)
  })

  it('handles rules, bullets, bold, and escapes HTML', () => {
    const html = letterToHtml('T', '---\n- first item\n**bold** text\n<script>x</script>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<li>first item</li>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('keeps a plain AMANDA letter as paragraphs with line breaks', () => {
    const html = letterToHtml('Letter', 'Dear Counsel,\nLine two.\n\nRegards,')
    expect(html).toContain('<p>Dear Counsel,<br/>Line two.</p>')
    expect(html).toContain('<p>Regards,</p>')
  })
})

describe('screenshot exhibits in the exported document', () => {
  const shots = [
    { label: 'A', path: '/c/Amazon/s.png', fileName: 's.png', platform: 'Amazon', date: '2026-08-05' },
    { label: 'B', path: '/c/Website/t.png', fileName: 't.png', platform: 'Website', date: null }
  ]

  it('replaces the drafter marker with one image per exhibit, captioned', () => {
    const html = letterToHtml('R', '# 3. Evidence\n[[FAFO:SCREENSHOTS]]\n# 4. Settlement Position', shots)
    expect(html).toContain('<img data-fafo-image="A">')
    expect(html).toContain('<img data-fafo-image="B">')
    expect(html).toContain('Exhibit A — Amazon, captured 2026-08-05')
    // A capture with no recoverable date says so rather than inventing one.
    expect(html).toContain('Exhibit B — Website, capture date not recorded')
    expect(html).not.toContain('FAFO:SCREENSHOTS')
  })

  it('still places the captures ahead of §4 when the drafter dropped the marker', () => {
    const html = letterToHtml('R', '# 3. Evidence\nText.\n# 4. Settlement Position\nTerms.', shots)
    expect(html.indexOf('data-fafo-image="A"')).toBeGreaterThan(html.indexOf('3. Evidence'))
    expect(html.indexOf('data-fafo-image="A"')).toBeLessThan(html.indexOf('4. Settlement Position'))
  })

  it('leaves no marker text in the document when there are no captures', () => {
    const html = letterToHtml('R', '# 3. Evidence\n[[FAFO:SCREENSHOTS]]\nText.', [])
    expect(html).not.toContain('FAFO:SCREENSHOTS')
    expect(html).not.toContain('<img')
  })
})

describe('licenseFactsBlock', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedIfEmpty(db)
  })

  const caseIdFor = (title: string): number =>
    (db.prepare('SELECT id FROM cases WHERE title = ?').get(title) as { id: number }).id

  it('supplies current-template clause facts including the sell-off end date', () => {
    // Healthy Crunch: 2025 vintage, term ended 2025-11-26, CP + PF marks.
    const facts = licenseFactsBlock(db, caseIdFor('The Healthy Crunch Company'))
    expect(facts).toContain('VERIFIED LICENSE FACTS')
    expect(facts).toContain('§E.3.d.ii')
    expect(facts).toContain('2026-05-25') // sell-off end = term end + 180d
    expect(facts).toContain('4767643') // CP USPTO number
    expect(facts).toContain('CAVEAT') // CP is a service mark
  })

  it('states the 2020-legacy position: no LD clause, no sell-off', () => {
    const facts = licenseFactsBlock(db, caseIdFor('Love Good Foods'))
    expect(facts).toContain('2020 legacy')
    expect(facts).toContain('NO liquidated damages')
    expect(facts).toContain('NO sell-off')
    expect(facts).not.toContain('§E.3.c 180-day')
  })

  it('tells the model not to invent terms when no license is on file', () => {
    const facts = licenseFactsBlock(db, caseIdFor('Little West'))
    expect(facts).toContain('none on file')
    expect(facts).toContain('do not assert license terms')
  })
})
