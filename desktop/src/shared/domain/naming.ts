/**
 * Parsers for the naming conventions used across SignNow, the local LEGAL
 * archive, and template filenames. Verified against the real tree at
 * ~/Desktop/PaleoFoundation/LEGAL (survey 2026-07-27).
 *
 * IMPORTANT: a ":" seen in Finder is a "/" at the POSIX layer, but Node's fs
 * returns the literal ":" byte in directory listings, so these parsers treat
 * ":" as the separator it visually is. Never EMIT ":" or "/" when creating
 * file or folder names — use safeFilename().
 */

export const MARK_CODES = ['CP', 'K', 'KETO', 'PF', 'GF', 'PB', 'PV', 'HM'] as const
export type MarkCode = (typeof MARK_CODES)[number]

/** Normalize K → KETO so downstream code sees one code per program. */
function normalizeMarkCode(raw: string): MarkCode | null {
  const up = raw.trim().toUpperCase()
  if (up === 'K') return 'KETO'
  return (MARK_CODES as readonly string[]).includes(up) ? (up as MarkCode) : null
}

export interface ParsedAgreementTemplate {
  markCodes: MarkCode[]
  year: number | null
  /** Cat A/B/C revenue category, when encoded */
  category: string | null
}

/** Parse template filenames like "CP:K:PF:GF:PV License Agreement 2025.pages" or "GF License Agreement 2025 - Cat B.pages". */
export function parseAgreementTemplateName(fileName: string): ParsedAgreementTemplate | null {
  const base = fileName.replace(/\.(pages|pdf|docx?)$/i, '')
  const m = base.match(/^([A-Za-z:]+)\s+License Agreement\b(.*)$/)
  if (!m) return null
  const codes = (m[1] ?? '')
    .split(':')
    .map(normalizeMarkCode)
    .filter((c): c is MarkCode => c !== null)
  if (codes.length === 0) return null
  const rest = m[2] ?? ''
  const year = rest.match(/\b(20\d{2})\b/)?.[1]
  const cat = rest.match(/\bCat\s+([A-C])\b/i)?.[1]
  return { markCodes: codes, year: year ? parseInt(year, 10) : null, category: cat?.toUpperCase() ?? null }
}

export interface ParsedSignnowGroupName {
  company: string
  year: number | null
}

/** Parse SignNow document-group names like "RAWCOLOGY INC. License Agreement 2025". */
export function parseSignnowGroupName(name: string): ParsedSignnowGroupName | null {
  const m = name.match(/^(.*?)\s*License Agreement\s*(20\d{2})?\s*$/i)
  if (!m || !m[1]) return null
  return { company: m[1].trim(), year: m[2] ? parseInt(m[2], 10) : null }
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
] as const

export interface ParsedEvidenceFolder {
  isoDate: string
  /** optional evidence-type suffix, e.g. "Purchased Packaging" */
  label: string | null
}

/**
 * Parse dated evidence folder names: "August 15, 2022",
 * "March 5, 2024 - Purchased Packaging", and "x"-prefixed variants.
 */
export function parseEvidenceFolderName(folderName: string): ParsedEvidenceFolder | null {
  const cleaned = folderName.replace(/^x/i, '').trim()
  const m = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s*[-–]\s*(.+))?$/)
  if (!m) return null
  const monthIdx = MONTHS.indexOf((m[1] ?? '').toLowerCase() as (typeof MONTHS)[number])
  if (monthIdx === -1) return null
  const day = parseInt(m[2] ?? '', 10)
  const year = parseInt(m[3] ?? '', 10)
  if (day < 1 || day > 31) return null
  const iso = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { isoDate: iso, label: m[4]?.trim() ?? null }
}

/**
 * Case folders like "4505 Meats : Evans Food Group" or "Terrafertil:Nestle"
 * encode a brand/parent-entity relationship.
 */
export interface ParsedCaseFolder {
  primaryName: string
  relatedEntity: string | null
}

export function parseCaseFolderName(folderName: string): ParsedCaseFolder {
  const parts = folderName.split(':').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 2) {
    return { primaryName: parts[0]!, relatedEntity: parts.slice(1).join(' / ') }
  }
  return { primaryName: folderName.trim(), relatedEntity: null }
}

/** Match key for licensee names across SignNow, folders, and sheets. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|inc|llc|ltd|corp|corporation|co|company|s\.?a\.?|dba|ulc|uab|apc)\b\.?/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Ported from FAFOApp.jsx safeFilename — export naming stays `FAFO_{label}_{name}_{date}`. */
export function safeFilename(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

export function exportFilename(label: string, infringer: string, isoDate: string, ext: string): string {
  return `FAFO_${safeFilename(label)}_${safeFilename(infringer)}_${isoDate}.${ext}`
}
