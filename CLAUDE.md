# FAFO App — Claude Code Project Guide

**Find. Audit. Flag. Oppose.** — trademark infringement case management for
Paleo Certified, Inc. dba The Paleo Foundation.

Claude Code reads this file automatically at the start of each session.

---

## Read this first: the current build is CONTEXT, not a commitment

The app in `current-build/` is a working reference implementation. It runs, and
it captures a lot of hard-won domain logic — but **it is not a foundation you
are obligated to keep.** The project may be torn down and rebuilt to suit new
needs.

So when planning:

- **In plan mode, be prepared to start fresh.** Treat `current-build/` as a
  spec and a source of tested logic, not as an architecture to preserve.
  Proposing a clean rebuild is a legitimate, often preferable, option.
- Do **not** assume the current toolchain carries forward. The existing build
  happens to use **Vite + React** (see `current-build/`), but that is an
  implementation detail of the current version, not a project requirement.
- What *does* carry forward is in this file and in `docs/` and `server/`: the
  domain model, the enforcement protocols, and the hard technical constraints
  below. Those are framework-independent and expensive to rediscover.

If you keep the current code, `current-build/FAFOApp.jsx` is a single ~4,300-line
React file — splitting it into modules is a sensible early task. If you rebuild,
mine it for the case model, the AMANDA letter logic, the settlement math, and
the PDF/evidence flow.

---

## What the app does (the durable spec)

A single-user tool for managing certification-mark enforcement across the Paleo
Foundation portfolio (Certified Paleo, KETO Certified, Paleo Friendly, Grain
Free Certified, Plant-Based Certified). Core capabilities, in rough priority:

- **Case management** — infringers, marks involved, type (expired license /
  unlicensed use), status (Open / In Progress / Resolved), notes, payments,
  attached files, license dates.
- **Enforcement letters (AMANDA protocol)** and **legal referral summaries**,
  drafted via the Anthropic API. AMANDA = Facts → Authority (contract section +
  Lanham Act §1114 / §1125(a)) → Consequence → single request; sign-off
  "Regards,"; close "Absent a response, we will proceed accordingly."
- **Infringing Proof** — compile manually-supplied URLs + screenshots into a
  branded evidence PDF ("Exhibit A" cover), saved to the case's Drive folder.
- **Metrics** — settlement income by year and infringement type, plus a
  **JP-vs-Trestle resolution credit split** (who carried each case) with an
  explicit "Unassigned" bucket so totals never silently misstate.

Outside counsel is **Trestle Law, APC** (Amanda Bruss, Kristen Roberts,
paralegal Kayley Seedborg). The authoritative domain reference — org details,
license clause numbers, the settlement formulas, the 14 revenue/pricing bands,
FAFO evidence classification, and full case history — is
**`docs/FAFO_App_Master_Reference.md`**. Read it before touching enforcement,
settlement, or pricing logic. Any rebuild should treat it as the requirements doc.

---

## Hard constraints & hard-won lessons (framework-independent)

These are verified and cost real time to learn. They apply regardless of what
you build the frontend with.

- **The artifact-sandbox CSP wall — the reason this project is moving.** In the
  Claude.ai artifact host, `fetch` to `*.run.app` was silently blocked by the
  sandbox Content Security Policy: Drive uploads failed with "Failed to fetch"
  even though the service was healthy (`/health` returned `{"ok":true}` from a
  normal browser tab). Any real local/hosted environment removes this wall.
  Cross-origin calls to the Cloud Run services just need normal CORS or a dev
  proxy — nothing exotic.

- **Persistence must not depend on `window.storage`.** That was the old artifact
  host's storage API; it fails silently and won't exist elsewhere. The current
  build uses browser `localStorage` as source of truth with `window.storage` as
  a best-effort secondary. A rebuild should pick a real persistence layer
  (localStorage, IndexedDB, or a backend) and not lean on `window.storage` at all.
  Current keys: `fafo_trademarks`, `fafo_cases_v2`, `fafo_docs`,
  `fafo_legacy_payments`, `fafo_logo_<id>`.

- **Never store large base64 blobs in the case record.** Screenshots and
  generated PDFs are deliberately NOT persisted client-side — only a lightweight
  reference (URLs, dates, Drive link) is kept. Embedding image/PDF bytes has
  caused storage bloat and data loss. Keep binary payloads in Drive; store links.

- **Logos are kept per-trademark under `fafo_logo_<id>`**, separate from the
  trademark record, to avoid value-size limits. Hydrated on load.

- **Downscale images before embedding in a PDF** (current build: 1600px longest
  edge, JPEG q0.82). Raw retina/4K screenshots can exceed Cloud Run's request cap.

- **jsPDF (client-side) can't render the brand fonts.** Georgia/Calibri aren't
  built in, so the client PDF uses Times as the nearest serif. The
  **`server/fafo-docs-mcp.js`** path renders TRUE brand styling via Google Docs —
  prefer it when fidelity matters, or embed a real font file if generating PDFs
  client-side.

- **Service accounts have no Drive storage quota of their own** — uploads fail on
  quota regardless of free space. The Docs MCP server fixed this by
  authenticating as the owner via an OAuth refresh token. `fafo-drive-proxy.js`
  still uses a service account and has NOT been migrated (known TODO).

- **The OAuth consent screen is in "Testing" mode**, expiring the refresh token
  ~every 7 days. Publishing to "Production" is the permanent fix. Full procedure
  in `docs/SAVEPOINT-v1.0.4.md`.

---

## The backend services (`server/`) — likely to be reused as-is

Even in a full frontend rebuild, these two Cloud Run services are probably worth
keeping; they're independent of the UI. See `server/README.md` for endpoints,
auth, and env vars.

- **fafo-docs-mcp** — HTML → branded Google Doc; owner refresh-token auth; also
  exposes an MCP surface.
- **fafo-drive-proxy** — per-infringer Drive folders + file upload;
  service-account auth (migration to refresh-token pending).

GCP project `project-b0292460-be69-4b2e-b3c`, region `us-central1`.

---

## If you keep the current build

It uses Vite + React. `cd current-build && npm install && npm run dev`. A
`vite.config.js` proxy maps `/drive` and `/docs-mcp` to the Cloud Run services
so browser calls are same-origin. Version is tracked in the `APP_VERSION` const
and changelog comment at the top of `FAFOApp.jsx` (currently `v1.0.4-r66`);
revisions increment as `rNN`.

Design language to preserve either way: minimal/clean, outlined buttons, status
color coding (Open = yellow, In Progress = blue, Resolved = grey), inline-editable
fields with auto-save, no separate edit modes. Case documents belong in that
case's Drive folder.

---

## Roadmap (highest legal value first)

1. **Deadline surface** — sell-off windows (license end + 180 days) and letter
   response clocks. Missed deadlines are legally unrecoverable and nothing
   surfaces them yet. This is the top priority in any architecture.
2. **Per-mark policing record export** — one-button enforcement history per mark
   (supports validity / anti-abandonment posture).
3. **Settlement calculator** — LD formula (1 yr fee × months, 80–85% compromise)
   vs. legacy (current fee × years, 2–3×), with revenue-band lookup.
4. **Repeat-infringer linking** — auto-flag willfulness when an infringer matches
   a closed case.
5. **Response-clock tracking** per letter.

Infrastructure: migrate `fafo-drive-proxy.js` to refresh-token auth; publish the
OAuth consent screen to Production.
