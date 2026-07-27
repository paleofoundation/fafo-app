# current-build/ — reference implementation

This is the FAFO App exactly as it exists today: **Vite + React**, a single
large `FAFOApp.jsx` (~4,300 lines) plus the minimal Vite scaffold to run it.

**Treat this as context, not commitment.** See the root `CLAUDE.md`: the project
may be rebuilt fresh. This folder exists so a new session can (a) run the current
app, and (b) mine it for tested logic — the case model, AMANDA letter drafting,
settlement math, the Infringing Proof / evidence-PDF flow, and the metrics /
resolution-credit split.

Run it:

```bash
npm install
npm run dev        # http://localhost:5173
```

`vite.config.js` proxies `/drive` and `/docs-mcp` to the Cloud Run services so
browser calls are same-origin (this is what the old artifact sandbox blocked).

Version lives in the `APP_VERSION` const and the changelog comment at the top of
`FAFOApp.jsx` — currently `v1.0.4-r66`.
