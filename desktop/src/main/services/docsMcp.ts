/**
 * Client for the deployed fafo-docs-mcp Cloud Run service (server/README.md):
 * HTML in → brand-formatted Google Doc in the Drive cases folder, owner
 * refresh-token auth handled service-side. URL from docs/SAVEPOINT-v1.0.4.md.
 */

import { getSecret, SECRET_DOCS_MCP_KEY } from '../secrets'

const DOCS_MCP_URL = 'https://fafo-docs-mcp-134533637471.us-central1.run.app'

/**
 * The `Cases` folder inside Drive's `1 - FAFO App` — where v1 filed generated
 * letters and per-case subfolders. Recovered from the deployed proxy's
 * CASES_FOLDER_ID (server/drive-proxy-deploy/deploy.sh). Distinct from the
 * folder root, 1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89.
 */
export const CASES_FOLDER_ID = '1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ'

export interface BrandedDocResult {
  editUrl: string | null
  pdfUrl: string | null
  raw: Record<string, unknown>
}

/** One capture, already downscaled, for the service to stage and inline. */
export interface DocImage {
  id: string
  dataBase64: string
  mimeType: string
  widthPt: number
  heightPt: number
}

export async function createBrandedDoc(
  title: string,
  html: string,
  folderId?: string | null,
  images: DocImage[] = []
): Promise<BrandedDocResult> {
  // The service rejects anonymous callers. Cloud Run's invoker check is public
  // by necessity — the desktop app cannot mint a Google identity token — so
  // this shared secret is the control that actually gates Drive access.
  const sharedKey = getSecret(SECRET_DOCS_MCP_KEY)
  if (!sharedKey) {
    throw new Error(
      'No docs-mcp key stored, so Drive export cannot authenticate. Use "Save as file" ' +
        'to get this document out, and re-run server/remint-drive-token.py or restore the ' +
        'key in Settings.'
    )
  }
  const res = await fetch(`${DOCS_MCP_URL}/create-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FAFO-Key': sharedKey },
    // Default to the Cases folder so exports land where v1 filed them.
    body: JSON.stringify({
      title,
      html,
      folderId: folderId ?? CASES_FOLDER_ID,
      ...(images.length ? { images } : {})
    })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // invalid_grant is the specific, recurring failure: Google expires the
    // service's refresh token every ~7 days while the consent screen sits in
    // Testing mode. Name the fix rather than the symptom — and point at the
    // local save, so the export is never a dead end.
    if (res.status === 401) {
      throw new Error(
        'The docs-mcp service rejected our key. It was rotated or never stored — ' +
          'use "Save as file" for now and restore the key in Settings.'
      )
    }
    if (body.includes('invalid_grant')) {
      throw new Error(
        'Google rejected the stored refresh token (invalid_grant). It expires about every 7 days ' +
          'while the OAuth consent screen is in Testing mode. Use "Save as file" to get this ' +
          'document out now, then re-mint the token or publish the consent screen to Production ' +
          '— procedure in docs/SAVEPOINT-v1.0.4.md.'
      )
    }
    throw new Error(`docs-mcp ${res.status}: ${body.slice(0, 200) || 'no body'}`)
  }
  const raw = (await res.json()) as Record<string, unknown>
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = raw[k]
      if (typeof v === 'string' && v.startsWith('http')) return v
    }
    return null
  }
  return {
    editUrl: pick('editUrl', 'edit_url', 'docUrl', 'url'),
    pdfUrl: pick('pdfUrl', 'pdf_url'),
    raw
  }
}
