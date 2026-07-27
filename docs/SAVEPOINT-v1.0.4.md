# FAFO Docs MCP — Save Point v1.0.4

**Date:** June 12, 2026
**Live service:** https://fafo-docs-mcp-134533637471.us-central1.run.app
**Current Cloud Run revision at save time:** fafo-docs-mcp-00017-b8r
**FAFO App version (unchanged this session):** v1.0.3-r49

---

## What changed in v1.0.4

The single headline change: **the Drive storage quota problem is fixed at the root.**

The server now authenticates by default using a stored Google OAuth **refresh token**
for the owner account (jinthemad@gmail.com), minting fresh access tokens on each call.
Files are created by, owned by, and charged to the user's own Drive quota. The service
account is out of the Drive write path entirely, so its lack of quota no longer matters.

`/create-doc` now works with **no `X-User-Token` header** — the Cloud Shell token-paste
step is no longer required for the server to function.

### Auth precedence (getClients)
1. `X-User-Token` header (per-request GCP access token) — override, still supported
2. `GOOGLE_REFRESH_TOKEN` env (default path) — owner's Drive  ← NEW
3. Application Default Credentials (service account) — legacy fallback

### Cloud Run env vars (set this session)
- `GOOGLE_REFRESH_TOKEN` — long-lived refresh token (owner consent; NOT in source)
- `GOOGLE_OAUTH_CLIENT_ID` = 134533637471-pgktnj9o850agqa1h6ci3mppq2689qu3.apps.googleusercontent.com
- `GOOGLE_OAUTH_CLIENT_SECRET` = (Web OAuth client secret; stored as env var)
- `CASES_FOLDER_ID` = 1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ
- `QUOTA_PROJECT` = project-b0292460-be69-4b2e-b3c

---

## How the refresh token was obtained (for re-minting)

- OAuth consent screen: **External**, **Testing** mode, test user = jinthemad@gmail.com
- OAuth client type: **Web application** (Desktop type lacks redirect URIs)
  - Client ID: 134533637471-pgktnj9o850agqa1h6ci3mppq2689qu3.apps.googleusercontent.com
  - Authorized redirect URI: the Cloud Shell Web Preview URL on port 8085
    (e.g. https://8085-cs-<id>-default.cs-<region>.cloudshell.dev/)
- Scopes: https://www.googleapis.com/auth/drive + .../auth/documents
- Consent flow: local http.server on :8085 captures the redirect `code`, exchanges it
  at https://oauth2.googleapis.com/token with access_type=offline & prompt=consent.
- Refresh token saved to ~/fafo_refresh_token.txt in Cloud Shell (never pasted to chat).

### IMPORTANT — token expiry
While the consent screen stays in **Testing** mode, Google expires the refresh token
after **~7 days** (≈ June 19, 2026). When Drive calls start failing:
  - Quick fix: re-run the consent flow to mint a new token, then update the
    GOOGLE_REFRESH_TOKEN env var on Cloud Run.
  - Permanent fix: publish the consent screen to **Production** (Drive/Docs are
    sensitive-but-not-restricted for own-account use → no verification needed),
    which makes refresh tokens long-lived.

---

## Deploy commands (reference)

```bash
cd ~/fafo-docs-mcp
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/project-b0292460-be69-4b2e-b3c/fafo-drive-proxy/fafo-docs-mcp \
  --project project-b0292460-be69-4b2e-b3c
gcloud run deploy fafo-docs-mcp \
  --image us-central1-docker.pkg.dev/project-b0292460-be69-4b2e-b3c/fafo-drive-proxy/fafo-docs-mcp \
  --region us-central1 \
  --service-account fafo-drive-proxy@project-b0292460-be69-4b2e-b3c.iam.gserviceaccount.com \
  --allow-unauthenticated --ingress all \
  --project project-b0292460-be69-4b2e-b3c
# (omit --set-env-vars to preserve the refresh-token vars)
```

To update only the refresh token (no rebuild):
```bash
REFRESH_TOKEN=$(cat ~/fafo_refresh_token.txt)
gcloud run services update fafo-docs-mcp --region us-central1 \
  --project project-b0292460-be69-4b2e-b3c \
  --update-env-vars "GOOGLE_REFRESH_TOKEN=${REFRESH_TOKEN}"
```

---

## Verified working

- `/health` → {"ok":true,"service":"fafo-docs-mcp","version":"1.0.4"}
- `/create-doc` with NO token → doc created in Zint folder, correctly formatted
  (navy Georgia H1/H2, slate bold H3, Calibri body, grey divider rules)
- Full ~8-section Zint referral summary rendered correctly
  (test file: 1klvlZsEzV6MblkgCIdfPvLYLJdHfVzfJL88PJfxdeGI)

---

## Still open (TODO — not done this session)

1. **Claude connector integration** — the /oauth/* and /.well-known/* endpoints in
   the server are a NON-FUNCTIONAL placeholder. They do NOT implement real
   OAuth 2.1 + PKCE + Dynamic Client Registration (RFC 7591), which Claude's
   connector system requires and which rejects the static-token stand-in.
   A proper build (e.g. Auth0/Stytch in front, or full spec by hand) is needed
   if the connector matters. The quota fix makes this cleaner if pursued.

2. **Wire the FAFO app 📋 button** to POST directly to /create-doc. Now feasible
   since the server needs no caller-supplied token. App would POST {title, html,
   folderId} and surface the returned editUrl/pdfUrl/docxUrl.

3. **Security hygiene** — two OAuth client secrets passed through chat this session;
   treat both clients as single-purpose. Refresh token itself never touched chat.
   Revoke anytime at myaccount.google.com → Security → Third-party access.

---

## Drive folder IDs (current)
- Root (1 - FAFO App): 1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89
- Versions:            1q2dwV6j9qJpqZpAW3VEoPuuzTWeFsJjo
- Logos:               1xe-tWgQsqv14GkuNhzQqACtoSm2g2v1I
- Chat Archive:        137gu8VzHZticI0CQlI-74jTA917DZt6Q
- Cases:               1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ
- Zint Nutrition:      1dJ1hUXzslDYhtUAxhSrRhuZWdvp7HoOs
