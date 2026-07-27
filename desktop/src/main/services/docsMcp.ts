/**
 * Client for the deployed fafo-docs-mcp Cloud Run service (server/README.md):
 * HTML in → brand-formatted Google Doc in the Drive cases folder, owner
 * refresh-token auth handled service-side. URL from docs/SAVEPOINT-v1.0.4.md.
 */

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

export async function createBrandedDoc(
  title: string,
  html: string,
  folderId?: string | null
): Promise<BrandedDocResult> {
  const res = await fetch(`${DOCS_MCP_URL}/create-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Default to the Cases folder so exports land where v1 filed them.
    body: JSON.stringify({ title, html, folderId: folderId ?? CASES_FOLDER_ID })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `docs-mcp ${res.status}: ${body.slice(0, 200) || 'no body'}${res.status === 401 || res.status === 500 ? ' — the service refresh token may have expired (OAuth consent screen is in Testing mode; see docs/SAVEPOINT-v1.0.4.md)' : ''}`
    )
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
