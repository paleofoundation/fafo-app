# fafo-drive-proxy — deployment files

Recovered 2026-07-27 from the Google Drive folder `1 - FAFO App/fafo-drive-proxy/`
(the copy that produced the running Cloud Run service). The root `server/README.md`
previously noted these were missing; they are the authoritative deploy artifacts.

`../fafo-drive-proxy.js` in this repo is byte-identical to the Drive copy apart
from comment spacing, so no code change was needed.

## Files

| File | Purpose |
|---|---|
| `package.json` | express + googleapis, `main`/`start` → `fafo-drive-proxy.js` (the root README's note about a stale `server.js` entry point does **not** apply to this copy) |
| `Dockerfile` | node:20-slim, `PORT=8080` (stored in Drive as `Dockerfile.txt`) |
| `deploy.sh` | One-command Cloud Run deploy; enables APIs, creates the service account, prompts to share the Drive folder, then deploys |

## To deploy

`deploy.sh` expects the service source beside it, so copy the app in first:

```bash
cp ../fafo-drive-proxy.js .
./deploy.sh
```

Note the script begins with `cd ~/Downloads/FAFO` — edit that line to point at
this directory before running.

## Known values

- **GCP project:** `project-b0292460-be69-4b2e-b3c`
- **Region:** `us-central1`
- **Service account:** `fafo-drive-proxy@project-b0292460-be69-4b2e-b3c.iam.gserviceaccount.com` (needs Editor on the Drive folder)
- **`CASES_FOLDER_ID`:** `1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ` — the `Cases` folder inside `1 - FAFO App`. Distinct from the folder root `1cUdKdKlzcdi-5dYE_Esgx3nVPd824f89`.

## Outstanding issue (unchanged)

This service authenticates as a **service account**, which has no Drive storage
quota of its own, so uploads can fail regardless of available space. The
docs-mcp service already solved this by using the owner refresh token; this
proxy has not been migrated. The v2 desktop app calls the Drive API directly
from the main process, so it does not depend on this service.
