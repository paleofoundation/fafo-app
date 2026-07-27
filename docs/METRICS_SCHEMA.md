# FAFO Metrics Export — Schema & Import Guide (for v2 / Claude Code)

This bundle is everything the v2 FAFO app needs to reproduce and extend the
Metrics feature from the current (v1) app, without re-deriving anything.

## What's in this bundle

| File | What it is |
|---|---|
| `METRICS_SCHEMA.md` | This file — the format spec + import guidance. |
| `metrics-seed-example.json` | A **real, correctly-shaped example** built from the v1 seed data. Use it to build and test the importer. |
| `metrics-seed-example.csv` | The same example in CSV form. |

The **actual data** comes from the running v1 app: open it → **Metrics tab →
⬇ Export for v2**, pick JSON (recommended) or CSV, and Copy/Download. That export
matches this schema exactly. The example here has only 4 rows and no legacy/credit
data; a live export will be larger and will include `legacy_entry` rows and any
JP/Trestle credit assigned.

---

## The core idea

Metrics is built from **money events**. There is exactly **one row per money
event**, and an event is one of two kinds:

- `rowType: "case_payment"` — a payment attached to a case (a case can have 0..n).
- `rowType: "legacy_entry"` — a historical settlement recorded directly in the
  Metrics tab, not tied to a live case (pre-app history).

Everything the Metrics tab shows (income by year, by infringement type, and the
JP-vs-Trestle resolution split) is an aggregation over these rows. **The v2 app
should store rows at this granularity and aggregate at read time**, not store
pre-summed totals.

---

## JSON envelope

```jsonc
{
  "schema": "fafo.metrics.v2",        // format id — check this on import
  "exportedAt": "2026-07-27T14:08:39.155Z",
  "sourceAppVersion": "v1.0.4-r67",
  "notes": "...human-readable reminder of the rules...",
  "resolverValues": ["JP", "Trestle", null],
  "infringementTypes": ["Expired License", "Unlicensed Use - Change in Ownership", "Unlicensed Use - Never Certified"],
  "trademarks": [ { "id": 1, "name": "...", "description": "... Reg. No. ..." } ],
  "summary": {
    "totalRows": 42,
    "receivedRows": 30,
    "realizedIncome": 128250,
    "byResolver": { "JP": 60000, "Trestle": 55000, "Unassigned": 13250 }
  },
  "rows": [ /* the money events — see below */ ]
}
```

`summary` is a convenience/verification block. **Recompute it from `rows` on
import and confirm it matches** — if it doesn't, trust `rows` and flag the
mismatch. `trademarks` is a lookup so `trademarkIds` on each row can resolve to
names; the reg number is embedded in `description`.

---

## Row fields

Every row (both kinds) has these fields. Fields that don't apply to a kind are
present but empty/null (so JSON and CSV stay rectangular).

| Field | Type | Meaning / notes |
|---|---|---|
| `rowType` | string | `"case_payment"` or `"legacy_entry"`. |
| `caseId` | number \| null | Source case id for `case_payment`; `null` for legacy. |
| `legacyId` | number \| null | Source legacy-entry id for `legacy_entry`; absent/null for case payments. |
| `infringer` | string | Company name. For legacy rows this may be a description or blank. |
| `contact` | string | Contact person, if known (case rows only). |
| `infringementType` | string | One of `infringementTypes`. Drives the by-type breakdown. |
| `caseStatus` | string | `Open` / `In Progress` / `Resolved`. Legacy rows are always `Resolved`. |
| `resolvedBy` | `"JP"` \| `"Trestle"` \| null | **Resolution credit.** `null` = unassigned — see the rule below. |
| `trademarkIds` | number[] | Marks involved; resolve via the `trademarks` lookup. In CSV, pipe-joined (e.g. `1\|2`). |
| `settlementPosition` | string | Free-text settlement position from the case (e.g. `"$10,000 + full cessation"`). Not a computed number — see caveat. |
| `dateOpened` | string (YYYY-MM-DD) | When the case opened (case rows). |
| `amount` | number | The money amount for THIS event, in USD. Legacy `amount` is the recorded settlement. |
| `paymentDate` | string (YYYY-MM-DD) | Date of this payment. May be blank on legacy rows that only have a year. |
| `year` | number \| null | Derived: `parseInt(paymentDate.slice(0,4))`, or the legacy entry's explicit year. The by-year axis. |
| `received` | boolean | **Whether the money was actually collected.** Only `received: true` rows count as realized income. Legacy rows are `true` by definition. |
| `source` | string | Where the infringement was found (`Website`, `Social Media`, etc.), or `"Legacy entry"`. |
| `url` | string | Infringement URL, if recorded. |

---

## Rules the v2 app MUST preserve

These are load-bearing — they're why the v1 numbers are trustworthy.

1. **Only `received: true` rows are realized income.** A case can have pending
   (unreceived) payments representing a settlement position that hasn't been
   collected. Do not count them in income totals. (You may show them separately
   as "pending/expected" if useful.)

2. **`resolvedBy: null` is "Unassigned" — report it as its own bucket, never
   folded into JP or Trestle.** Folding it in would silently misstate both
   columns. In the v1 app, JP + Trestle + Unassigned always reconciles to the
   total. Preserve that identity as a test.

3. **`year` is derived, not authoritative.** Prefer `paymentDate` when present;
   fall back to the legacy `year`. If both are missing, the row has no year and
   should be surfaced as such rather than silently dropped.

4. **Aggregate at read time.** Store rows; compute income-by-year,
   income-by-type, and the resolver split on demand. Don't persist summaries as
   source of truth.

---

## Caveat worth knowing (data-quality, carried over from v1)

Most v1 **preset/seed cases carry their amount as free text in
`settlementPosition`** (e.g. `"$10,000 + full cessation"`) and have an **empty
`payments[]`**, so they produce **no rows** in this export. Only cases where a
payment was actually entered and marked received show up as income. This is
correct behavior (unrealized ≠ realized), but it means the export reflects money
*collected and recorded in-app*, not every settlement ever discussed.

If v2 wants the fuller historical picture, two options:
- Backfill: enter the real payments on those cases in v1 before exporting, or
- Parse `settlementPosition` heuristically in v2 (lossy — amounts are embedded in
  prose, sometimes with multiple figures like `"$3,000 + $5,250 sell-off"`).

The clean path is backfilling actual payments so `received`/`amount`/`paymentDate`
are structured rather than parsed from prose.

---

## Suggested v2 data model (starting point, not prescriptive)

```ts
type Resolver = "JP" | "Trestle" | null;

interface MoneyEvent {
  id: string;
  kind: "case_payment" | "legacy_entry";
  caseId?: string | null;
  infringer: string;
  infringementType: string;
  resolvedBy: Resolver;
  trademarkIds: number[];
  amount: number;          // USD
  paymentDate?: string;    // YYYY-MM-DD
  year: number | null;     // derived if absent
  received: boolean;       // only true counts as income
  source?: string;
  url?: string;
  settlementPosition?: string;
}
```

Importer sketch:
1. Verify `schema === "fafo.metrics.v2"`.
2. Map each `rows[i]` to a `MoneyEvent`.
3. Recompute `summary` and assert it equals the file's `summary` (warn on drift).
4. Assert `JP + Trestle + Unassigned === realizedIncome` over `received` rows.
