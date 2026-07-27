# FAFO Cloud Run services

Two independent Node/Express services. Each deploys to its own Cloud Run
service under GCP project `project-b0292460-be69-4b2e-b3c`, region
`us-central1`. They are **not** part of the Vite app build — deploy separately.

> Note: the entry files here are named `fafo-docs-mcp.js` and
> `fafo-drive-proxy.js`. If you keep the deployment `package.json` `main`/`start`
> pointing at `server.js` (as in the original bundle), rename accordingly or
> update the `start` script to match.

---

## 1. fafo-docs-mcp  (`fafo-docs-mcp.js`)

Turns HTML into a brand-formatted Google Doc (navy Georgia headings, slate H3,
Calibri body, grey dividers) and returns edit / PDF / Word links.

- `GET  /health`
- `POST /create-doc` — `{ title, html, folderId? }`
- `POST /mcp` — MCP protocol surface (initialize / tools/list / tools/call)

**Auth precedence** (`getClients`): `X-User-Token` header → `GOOGLE_REFRESH_TOKEN`
env (owner's Drive — the default working path) → Application Default Credentials
(service account, legacy fallback).

**Env vars:** `GOOGLE_REFRESH_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `CASES_FOLDER_ID`, `QUOTA_PROJECT`.

⚠️ The OAuth consent screen is in **Testing** mode, so the refresh token expires
~every 7 days. Publish to **Production** for a long-lived token. Full re-minting
procedure and deploy commands are in `../docs/SAVEPOINT-v1.0.4.md`.

The `/oauth/*` and `/.well-known/*` endpoints are a **non-functional placeholder**
for a future Claude connector — they do NOT implement real OAuth 2.1 + PKCE +
Dynamic Client Registration and will be rejected by Claude's connector system.

---

## 2. fafo-drive-proxy  (`fafo-drive-proxy.js`)

Creates a Drive folder per infringer and uploads files into it.

- `GET  /health`
- `POST /folder` — `{ infringerName }` → `{ folderId, folderUrl }`
- `POST /upload` — `{ infringerName, fileName, mimeType, base64 }` → `{ fileId, fileUrl, folderId }`

**Auth:** service account. ⚠️ Service accounts have **no Drive storage quota of
their own**, so uploads can fail on quota regardless of free space. The Docs MCP
server already solved this by authenticating as the owner via a refresh token;
**this proxy has not yet been migrated** — doing so is a known TODO.

**Env vars:** `CASES_FOLDER_ID`, `ALLOWED_ORIGIN`. One-time setup in
`../docs/DRIVE_PROXY_SETUP.md`.

---

## Deploying (either service)

Each needs its own `package.json` (express + googleapis) and a Node 18+
`Dockerfile`, then:

```bash
gcloud run deploy <service-name> \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

See `../docs/SAVEPOINT-v1.0.4.md` for the exact build/deploy commands and the
env-var update recipes used previously.
