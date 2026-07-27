/**
 * Client for the deployed fafo-docs-mcp Cloud Run service (server/README.md):
 * HTML in → brand-formatted Google Doc in the Drive cases folder, owner
 * refresh-token auth handled service-side. URL from docs/SAVEPOINT-v1.0.4.md.
 */

const DOCS_MCP_URL = 'https://fafo-docs-mcp-134533637471.us-central1.run.app'

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
    body: JSON.stringify(folderId ? { title, html, folderId } : { title, html })
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
