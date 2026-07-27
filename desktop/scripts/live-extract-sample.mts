/**
 * Dev utility: validate the extraction pipeline end-to-end on a SAMPLE of
 * real agreements against a throwaway in-memory DB.
 *   SN_KEY=... AN_KEY=... npx tsx scripts/live-extract-sample.mts
 */
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrations'
import { seedIfEmpty } from '../src/main/db/seed'
import { mapRawDocument, type RawDocument } from '../src/main/services/signnowApi'
import { runExtraction } from '../src/main/services/ingest/extractionRunner'
import { parseSignnowGroupName, normalizeCompanyName } from '../src/shared/domain/naming'

const SN = process.env['SN_KEY']
const AN = process.env['AN_KEY']
if (!SN || !AN) throw new Error('SN_KEY and AN_KEY env vars required')

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
migrate(db)
seedIfEmpty(db)

// Grab the first page of real documents and stage two parseable agreements.
const res = await fetch('https://api.signnow.com/user/documentsv2?per_page=15&page=1', {
  headers: { Authorization: `Bearer ${SN}` }
})
const raw = (await res.json()) as RawDocument[]
const docs = raw
  .map(mapRawDocument)
  .filter((d): d is NonNullable<typeof d> => d !== null && parseSignnowGroupName(d.name) !== null)
  .slice(0, 2)

const insertLicensee = db.prepare('INSERT INTO licensees (name, normalized_name) VALUES (?, ?)')
const insertLicense = db.prepare(
  `INSERT INTO licenses (licensee_id, signnow_group_id, vintage, status, agreement_ref)
   VALUES (?, ?, '2025', 'active', ?)`
)
for (const d of docs) {
  const company = parseSignnowGroupName(d.name)!.company
  const lid = Number(insertLicensee.run(company, normalizeCompanyName(company)).lastInsertRowid)
  insertLicense.run(lid, d.id, `signnow:${d.name}`)
}
console.log('staged:', docs.map((d) => d.name).join(' | '))

const result = await runExtraction(db, { signnow: SN, anthropic: AN }, 2, (p) =>
  console.log(`  [${p.processed}/${p.total}] ${p.current}`)
)
console.log('result:', JSON.stringify(result))

const rows = db
  .prepare(
    `SELECT l.name, li.term_start, li.term_end, li.annual_fee_cents, li.revenue_band,
            li.vintage, li.extraction_confidence,
            (SELECT GROUP_CONCAT(m.code) FROM license_marks lm JOIN marks m ON m.id=lm.mark_id
             WHERE lm.license_id = li.id) AS marks
     FROM licenses li JOIN licensees l ON l.id = li.licensee_id
     WHERE li.signnow_group_id IS NOT NULL AND li.extracted_at IS NOT NULL`
  )
  .all()
console.log(JSON.stringify(rows, null, 1))
