# FAFO App

**Find. Audit. Flag. Oppose.** — trademark infringement case management for
Paleo Certified, Inc. dba The Paleo Foundation.

Case tracking, AI-drafted enforcement letters (AMANDA protocol) and referral
summaries, "Infringing Proof" evidence-package PDFs, and settlement-income
reporting with a JP-vs-Trestle resolution credit split.

## Orientation

This repo is being moved into Claude Code as the project grows. **Start with
[`CLAUDE.md`](./CLAUDE.md)** — it explains the domain, the hard constraints, and
(importantly) that the current build is *reference context*, not an architecture
you're locked into. A fresh rebuild is on the table.

## What's here

```
CLAUDE.md            Read first. Domain spec + hard constraints + rebuild stance.
current-build/       The working app as it exists today (Vite + React).
                     Reference implementation — mine it or replace it.
server/              Two Cloud Run services (Google Docs generator, Drive proxy).
                     UI-independent; likely reused as-is. See server/README.md.
docs/                Master reference (the requirements doc), MCP save point,
                     Drive-proxy setup, license style sample.
```

## Running the current build

```bash
cd current-build
npm install
npm run dev        # http://localhost:5173
```

Data lives in the browser (`localStorage`); use the in-app Backup panel to
export JSON. Full conventions and the roadmap are in `CLAUDE.md`.
