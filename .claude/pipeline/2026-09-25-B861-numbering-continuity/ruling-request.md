# B861 — design ruling request to the SA (numbering / money)

From: "Let invoices continue a client's old numbering (B861)" · base origin/master **21085bcb** ·
branch `bug/2158-b861-numbering-card-never-reaches-live-invoice-num (board #2158)` (worktree `cool-leakey-1635b0`, nothing committed yet).
Evidence: `cause-brief.md` (same dir). S2 refutation: see §0.

## 0. Cause (S2 verdict)

**Confirmed** (Opus, `cause-refutation.md`). Diverging line `numbering.service.ts:254`
(`year > 0 && isYearScoped(docType)` → `mintForYear`, keyed on the calendar year, seeded from DEFAULTS).
Year-0 rows have ONE writer (`updateSettings`, i.e. card saves) and no live reader. Not a regression:
the card has never reached a live number since #135 (2026-07-08). Wider than filed: the PAYMENT row
(§5) and two scripts (`import-zoho.js:364-397`, `backfill-invoices.js:17-25`) mint their own numbers.
Hazards S2 found that any live-card design must handle are folded into §2.

## 1. The fork — what does a SAVED card row mean for live minting? (Q1)

Today: card writes `(tenant, docType, year 0)`; every live mint passes `year = now.getFullYear()` and,
for INVOICE/ESTIMATE/CREDIT_NOTE, mints the per-year `INV-<year>-####` series seeded from DEFAULTS.
Nothing live reads year 0. A migrating wholesaler who saves "next 10543" gets `INV-2026-0001`.

|                     | Meaning of a saved row                                                                                                                           | Live number after "INV-", 10543, pad 5    | Trade                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A** (recommended) | Saved row IS that doc type's live series: continuous, **no year segment, never resets**. No saved row → today's per-year series, byte-identical. | `INV-10543`, `INV-10544`, … across years  | Matches the card's copy + preview and what "continue where your old system left off" means (old systems rarely carry a year). Reuses `NumberingSequence` year-0 rows — no schema change. Existing saved rows go live on deploy (§3). |
| B                   | Saved row seeds the current year's per-year series                                                                                               | `INV-2026-10543`; Jan 1 → `INV-2027-0001` | Not continuity; card preview must show the year; resets yearly.                                                                                                                                                                      |
| C                   | Copy-only: stop promising, remove INV/EST/CN rows                                                                                                | `INV-2026-0001`                           | Drops the migration feature the 09-24 onboarding rulings rely on; contradicts REG-B861 as the lead framed it.                                                                                                                        |
| D                   | A + a per-tenant "keep a year segment" toggle                                                                                                    | either                                    | Needs storage (column/migration or a TenantConfig key). Defer as a feature.                                                                                                                                                          |

## 2. Collision guard + imported numbers under A (Q2)

Recommended — reuse the ONE existing guarded mint primitive (L-096/L-167), generalised to year 0:

- Configured path = row exists at year 0 for a year-scoped docType → no lazy seed; atomic increment;
  every candidate proven free before return; a clash jumps via `GREATEST("nextNumber", max+1)` in one
  statement; ≤ 5 attempts → 409. Standalone-vs-`tx` rules unchanged (D7, L-100). Callers unchanged.
- **"Taken" is numeric, not exact-string**, for the configured series: imported old-system numbers live
  in exactly this namespace and may carry different zero padding (`INV-08842` imported vs candidate
  `INV-8842` — unique as strings, the same invoice number to a human). Match
  `^<escaped prefix>0*<n>(-R\d+)?$`; max-scan `^<escaped prefix>(\d{1,9})(?:-R\d+)?$`.
- **Prefix is tenant free text (≤ 16 chars, may be empty) → regex-escape it.** Today `:417` interpolates
  it unescaped (safe only because it is always a default): `INV.` over-matches, `INV(` is an invalid
  regex → Postgres throws → aborts the CALLER's tx on the delivery path (`:259-260`).
- **The max-scan must drop the year segment for the configured series** — `:417` requires
  `<prefix><year>-`, so a year-less series scans 0, each clash skips ONE number and 5 clashes → 409:
  exactly the "next lands inside the imported block" migration case.
- **Stale-card rewind (D8 class)**: `updateSettings` sets `nextNumber` absolutely (`:141`) and the card
  sends all three fields on every save from drafts loaded once (`page.tsx:429-457`) — once the row is
  live, a stale tab or a prefix-only edit winds the counter back. Proposed: web sends only changed fields
  AND the save carries the `nextNumber` it loaded (409 if the row moved since) — or save uses
  `GREATEST` unless lowering is explicit. Which?
- Empty prefix: the column is non-null default `""` so `current.prefix ?? d.prefix` (`:326`) never falls
  back; under A an empty prefix mints bare `10543` (QuickBooks-style) — allow?
- `-R{i}`: count `<base>-R<k>` as taking `<base>` (only the base is checked today).
- Cost: one tenant-scoped regex probe per candidate vs today's indexed equality (B275 already filed
  for guard scan cost). Alternative if you prefer cheap: exact-string per candidate + numeric max check
  at save time.
- Sub-choice: (i) guard loop as above — may back-fill a free number below an imported one (same as the
  per-year series today); (ii) "max-first": reserve `GREATEST(next, numericMax+1)` every mint — never
  mints below an existing number, no loop. I lean (i) for one primitive; (ii) is stricter.
- Imports unchanged: they keep original numbers and never call `reserveNext`; a delta load after the
  save is absorbed by the guard (jump past it).
- `updateSettings` keeps absolute `nextNumber` (the tenant is setting it on purpose); the guard makes a
  low value safe. Should save REJECT `next ≤ numeric max` instead (400 naming the taken number)?

## 3. Transition — rows already saved (Q3, data question)

Under A, any tenant that already saved an INV/EST/CN card row switches series on deploy (card live
since 2026-07-08, #135). Report first: a read-only count of year-0 rows per docType with, per row,
whether the tenant has live per-year docs (counts only, no identifiers). Owner decides if > 0:
activate as saved / require a re-save / leave rows but gate on something. Needs `railway run`
(warn-then-approve) — who runs it, and is it a merge condition?

## 4. Card preview + REG-B100-D2b (Q4)

The unconfigured row previews `INV-0001`, which live minting never produces. Recommended: the preview is
the TRUE next live number in both modes (unconfigured → the per-year next, e.g. `INV-2026-0413`;
configured → `prefix+pad(next)` after the guard's numeric max). `configured` stays year-0-only, so
T1i REG-B100-D2b keeps `configured:false` but its `preview:'INV-0001'` expectation changes — authorize?

## 5. PAYMENT row (Q5)

The card's 4th row (PAYMENT) is dead too: payments mint `PAY-<tenantShort>-####` from `PaymentCounter`
(`invoices.service.ts:5272-5310`), never `NumberingService`. Recommended: drop PAYMENT from the card in
this PR (`DOCUMENT_NUMBER_TYPES` → the three live types; `PUT …/PAYMENT` → 400) and file wiring as a
new B-id if wanted. Or keep B861 to three rows and file the PAYMENT row separately — your call.

## 6. Copy + docs (Q6)

Copy drops "and note it on the document" (nothing notes it — the skip is a server log line) and says
an unsaved row uses the yearly series. `docs/product/tenancy.md` TEN-N5/TEN-M9 and the playbook's
stage 7 / questionnaire D1 / checklist / defects table live on the UNMERGED `docs/wholesaler-onboarding`
branch (no PR): the lead sequences which lands first; this PR updates them on top.

## 7. Proposed invariant (for your wording)

Per tenant and doc type in {INVOICE, ESTIMATE, CREDIT_NOTE}: a saved year-0 row ⇒ live numbers are
`prefix + pad(n)`, strictly increasing, never numerically equal (same prefix, `-R` aware) to any existing
document of that type; no saved row ⇒ today's `INV-<year>-####` invariant unchanged. Tenant explicit,
standalone reservation before any rollback-able tx, no nested tx (L-100).

This AMENDS B100/F16b ruling D1 ("exactly `INV-<year>-NNNN`", January reset) for tenants with a saved
row — please say so in the ruling so the B100 pins that assume it (T1i D2b preview; unit P2 is the
year-0 fast path) change on your word, not the builder's.

Closes: B861. Touches: B852 (its dead Invoicing-tab prefix input should point at this card — no change
here). Files if ruled: PAYMENT-row wiring (Q5); `import-zoho.js` local-counter fallback minting
`INV-<year>-####` from 1 (B268-class, script) — sibling, not widened into this PR.
