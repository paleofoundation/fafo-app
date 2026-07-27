import type Database from 'better-sqlite3'
import { PDFParse } from 'pdf-parse'
import { downloadDocumentPdf } from '../signnowApi'
import { bandFromFee, extractTermsFromText } from './termExtraction'
import { normalizeCompanyName } from '../../../shared/domain/naming'

/**
 * Orchestrates the term-extraction backfill: for each license synced from
 * SignNow that still lacks trustworthy term dates, download the executed PDF,
 * extract text, run the model, and update the ledger.
 *
 * Idempotent and resumable: a license is "done" once extracted_at is set with
 * confidence >= MIN_TRUSTED_CONFIDENCE, or after MAX_ATTEMPTS failures
 * (tracked in-memory per run; persistent failures simply stay pending and
 * surface in the UI counts). Vintage is set from clause presence, overriding
 * the year-based guess. Licensee address/legal-name fill in when empty.
 */

export const MIN_TRUSTED_CONFIDENCE = 0.7

export interface ExtractionCandidate {
  licenseId: number
  signnowGroupId: string
  agreementRef: string | null
  licenseeId: number
}

export interface ExtractionProgress {
  processed: number
  total: number
  current: string
  ok: number
  failed: number
}

export interface ExtractionRunResult {
  processed: number
  ok: number
  failed: number
  errors: string[]
  remaining: number
}

export function extractionCounts(db: Database.Database): {
  total: number
  extracted: number
  pending: number
} {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN extracted_at IS NOT NULL AND extraction_confidence >= ? THEN 1 ELSE 0 END) AS extracted
       FROM licenses WHERE signnow_group_id IS NOT NULL`
    )
    .get(MIN_TRUSTED_CONFIDENCE) as { total: number; extracted: number | null }
  const extracted = row.extracted ?? 0
  return { total: row.total, extracted, pending: row.total - extracted }
}

function candidates(db: Database.Database, limit: number): ExtractionCandidate[] {
  return db
    .prepare(
      `SELECT id AS licenseId, signnow_group_id AS signnowGroupId,
              agreement_ref AS agreementRef, licensee_id AS licenseeId
       FROM licenses
       WHERE signnow_group_id IS NOT NULL
         AND (extracted_at IS NULL OR extraction_confidence < ?)
       ORDER BY status = 'active' DESC, id
       LIMIT ?`
    )
    .all(MIN_TRUSTED_CONFIDENCE, limit) as ExtractionCandidate[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runExtraction(
  db: Database.Database,
  keys: { signnow: string; anthropic: string },
  limit: number,
  onProgress?: (p: ExtractionProgress) => void
): Promise<ExtractionRunResult> {
  const batch = candidates(db, limit)
  const result: ExtractionRunResult = {
    processed: 0,
    ok: 0,
    failed: 0,
    errors: [],
    remaining: 0
  }

  const updateLicense = db.prepare(
    `UPDATE licenses SET term_start = ?, term_end = ?, annual_fee_cents = ?,
       revenue_band = COALESCE(?, revenue_band), vintage = ?,
       extraction_confidence = ?, extracted_at = ?
     WHERE id = ?`
  )
  const markConfidenceOnly = db.prepare(
    'UPDATE licenses SET extraction_confidence = ?, extracted_at = ? WHERE id = ?'
  )
  const fillLicensee = db.prepare(
    `UPDATE licensees SET address = COALESCE(address, ?),
       aka_names = CASE WHEN aka_names IS NULL AND ? IS NOT NULL AND normalized_name != ? THEN ? ELSE aka_names END
     WHERE id = ?`
  )
  const markId = db.prepare('SELECT id FROM marks WHERE code = ?')
  const insertLicenseMark = db.prepare(
    'INSERT OR IGNORE INTO license_marks (license_id, mark_id) VALUES (?, ?)'
  )

  for (const c of batch) {
    const label = c.agreementRef ?? c.signnowGroupId
    onProgress?.({
      processed: result.processed,
      total: batch.length,
      current: label,
      ok: result.ok,
      failed: result.failed
    })
    try {
      const pdf = await downloadDocumentPdf(keys.signnow, c.signnowGroupId)
      const parser = new PDFParse({ data: new Uint8Array(pdf) })
      let text: string
      try {
        text = ((await parser.getText()).text ?? '').trim()
      } finally {
        await parser.destroy()
      }
      if (text.length < 200) {
        throw new Error('PDF has no extractable text (likely scanned)')
      }
      const terms = await extractTermsFromText(keys.anthropic, label, text)

      const now = new Date().toISOString()
      if (terms.termEnd || terms.termStart || terms.annualFeeCents !== null) {
        // Clause presence beats the year heuristic; when the model couldn't
        // tell (null), keep whatever vintage the row already has.
        const vintage =
          terms.hasLiquidatedDamages === true || terms.hasSelloff === true
            ? '2025'
            : terms.hasLiquidatedDamages === false && terms.hasSelloff === false
              ? '2020'
              : (db.prepare('SELECT vintage FROM licenses WHERE id = ?').get(c.licenseId) as {
                  vintage: string
                }).vintage
        updateLicense.run(
          terms.termStart,
          terms.termEnd,
          terms.annualFeeCents,
          bandFromFee(terms.annualFeeCents),
          vintage,
          terms.confidence,
          now,
          c.licenseId
        )
      } else {
        markConfidenceOnly.run(terms.confidence, now, c.licenseId)
      }

      if (terms.licenseeLegalName || terms.licenseeAddress) {
        const norm = terms.licenseeLegalName ? normalizeCompanyName(terms.licenseeLegalName) : null
        fillLicensee.run(
          terms.licenseeAddress,
          terms.licenseeLegalName,
          norm,
          terms.licenseeLegalName,
          c.licenseeId
        )
      }
      for (const code of terms.markCodes) {
        const m = markId.get(code) as { id: number } | undefined
        if (m) insertLicenseMark.run(c.licenseId, m.id)
      }
      result.ok += 1
    } catch (err) {
      result.failed += 1
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`${label}: ${message}`)
    }
    result.processed += 1
    await sleep(600) // pace both APIs
  }

  result.remaining = extractionCounts(db).pending
  onProgress?.({
    processed: result.processed,
    total: batch.length,
    current: 'done',
    ok: result.ok,
    failed: result.failed
  })
  return result
}
