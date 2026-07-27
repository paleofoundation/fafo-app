/**
 * Dev utility: validate the SignNow live sync against a throwaway in-memory
 * DB — proves the API client + importer end-to-end without touching real data.
 *   SN_KEY=... npx tsx scripts/livesync.mts
 */
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrations'
import { syncSignnow } from '../src/main/services/signnowApi'

const key = process.env['SN_KEY']
if (!key) throw new Error('SN_KEY env var required')

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
migrate(db)

const outcome = await syncSignnow(db, key)
console.log('identity:', outcome.identity.email)
console.log('documents mapped:', outcome.apiTotal)
console.log(
  'imported:',
  JSON.stringify(outcome.imported, (k, v: unknown) =>
    k === 'unparsedNames' ? `[${(v as string[]).length} names]` : v
  )
)

const counts = db
  .prepare('SELECT li.status, COUNT(*) n FROM licenses li GROUP BY li.status ORDER BY n DESC')
  .all()
console.log('license status counts:', JSON.stringify(counts))
console.log(
  'licensees:',
  (db.prepare('SELECT COUNT(*) n FROM licensees').get() as { n: number }).n
)
const active = db
  .prepare(
    `SELECT l.name FROM licenses li JOIN licensees l ON l.id=li.licensee_id
     WHERE li.status='active' ORDER BY l.name LIMIT 6`
  )
  .all() as Array<{ name: string }>
console.log('sample active:', active.map((a) => a.name).join(' · '))
