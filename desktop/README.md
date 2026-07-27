# FAFO Desktop (v2)

Electron + React + TypeScript rebuild of FAFO. Single-user macOS app for
Jonathan Pendergrass. See `/CLAUDE.md` and `/docs/FAFO_App_Master_Reference.md`
for the domain; the plan of record lives with the repo owner's Claude sessions.

## Dev setup

Node 22 is installed via Homebrew as a keg-only formula:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd desktop
npm install
npm run rebuild     # compile better-sqlite3 against Electron's ABI (once per Electron upgrade)
npm run dev         # launch with hot reload
```

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run build`,
`FAFO_SMOKE=1 npx electron out/main/index.js` (boot check without a window —
build first).

## Layout

- `src/shared/domain/` — pure, unit-tested domain logic (pricing bands,
  settlement math, sell-off deadlines, naming parsers, AMANDA/SUMMARY prompts).
  No Node or DOM imports — everything here runs anywhere.
- `src/main/` — Electron main process: SQLite (better-sqlite3, WAL) via
  `db/migrations.ts` + `db/queries.ts`, typed IPC in `ipc.ts`. The DB lives in
  Electron `userData` (`~/Library/Application Support/fafo-desktop/fafo.sqlite`),
  NOT in the repo. Binary evidence is never stored in the DB — references only.
- `src/preload/` — contextBridge exposing the typed `window.fafo` API.
- `src/renderer/` — React UI. Design language: minimal/clean, outlined buttons,
  status colors (Open yellow / In Progress blue / Resolved grey), inline-edit
  fields that save on blur — no separate edit modes.

## Milestone status

- **M0 (scaffold + domain core): done.**
- **M1 (deadline surface): done** — dashboard sorted by urgency, overdue
  notifications at launch, four active matters seeded with known dates.
- M2 next: SignNow backfill + local Infringement Cases import + review queues.
  See the approved plan for M2–M5.

## Building the desktop app (double-clickable)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd desktop
npm run install-app     # builds and installs to /Applications/FAFO.app
```

`npm run package` alone leaves the bundle in `desktop/release/mac-arm64/FAFO.app`
(gitignored). `install-app` copies it over `/Applications/FAFO.app`; the Desktop
alias points there, so it picks up new builds automatically.

The icon is generated into `build/icon.png` (navy tile, block "FAFO"). The app is
ad-hoc signed only — fine for a locally built single-user tool, and it carries no
quarantine attribute because it was never downloaded. It is **not** notarized, so
it would warn if copied to another Mac.

Packaged and dev builds share the same data directory
(`~/Library/Application Support/FAFO`), so the database, encrypted secrets, and
Outlook token are identical in both. Only one may run at a time — the
single-instance lock makes the second launch hand off to the first.
