# B297 build spec — excise rate snapshot + LOCKED filing guard (SA-088, 2026-09-24)

Owner ruling 2026-09-14 (B297 record): freeze the excise rate per line at delivery (snapshot column, next
schema migration) plus a LOCKED filing status with an edit guard. Read on origin/master bc7b0ad9.

## 1. The defect, traced (file:line at bc7b0ad9)

1. `orders.service.ts:236-280` `recomputeLineCategoryTaxes` re-prices EVERY regulated order line at the LIVE
   `TrackedCategory.rate/taxType/priceIncludesTax` on each `updateOrderItems` save (callers :932, :1240, :4608,
   :5529). Nothing on the line records the rate it was sold at: `OrderItem` carries only
   `trackedCategoryId` + `categoryTaxAmount` (sales.prisma), `InvoiceItem` the same.
2. A post-delivery edit (`POST_DELIVERY_EDIT_STATUSES`, :3198) with a clean, fully-invoiced partition
   (`shouldSkipInPlaceResync` false) calls `resyncOrderInvoicesForEdit` (:4840 → invoices.service.ts:2017),
   which rebuilds each invoice's lines from the order lines; `buildInvoiceItemData` COPIES/prorates the order
   line's `categoryTaxAmount` (the re-priced one) onto the invoice line.
3. `rebuildSiblingDrafts` then calls `resyncInvoiceLedger` (:1801-1820) for EVERY rebuilt draft: it reverses
   the invoice's SALE rows and rewrites fresh ones at `soldAt: new Date()` — even when nothing money-bearing
   changed (a note edit). The ledger's never-backdate rule (regulated-ledger.service.ts:122) books both into
   TODAY's `periodBucket`.
4. `RegulatedFilingStatus` is `GENERATED | FAILED` only (compliance.prisma:102); `prepareFiling` regenerates
   from the ledger on demand; nothing marks a period closed.

So one unrelated edit to a June order (a) changes June's invoice excise to today's rate and (b) books a
reversal + re-sale pair into the current period. Two independent fixes are needed: the rate must be frozen
on the line (fixes a), and a resync must write nothing when nothing changed and must be refused when the
sale's period is closed (fixes b).

Other LIVE-rate sites, classified (every `computeCategoryTax(` caller outside pricing):

- NEW-sale writers (rate at write time IS the snapshot moment — correct, but they must now also STORE it):
  orders.service.ts:2111 (create), order-templates.service.ts:503, invoices.service.ts:3439 (invoice
  update rebuilds lines), manual-invoice-lines.ts:99, invoice-unit-line.ts:76, unit-line-build.ts:189
  (units_v1 order lines).
- RECOMPUTE of a stored line (must read the snapshot, never the live rate): orders.service.ts:264 and
  invoices.service.ts:6285 (`applyPriceAdjustment`, the REG-B57 live-recompute convention the owner's
  ruling changes).

## 2. Design decisions

D1 · SNAPSHOT = the trio, typed, on BOTH line tables. `categoryTaxType TrackedCategoryTaxType?`,
`categoryTaxRate Decimal(12,4)?`, `categoryPriceIncludesTax Boolean?` on `OrderItem` and `InvoiceItem`
(same precision as `TrackedCategory.rate`). Rate alone is not a snapshot: `computeCategoryTax` needs all
three, and a line re-priced with a snapshot rate but a live taxType is a mixed basis. Reusing the existing
enum means no `ALTER TYPE`. Typed columns, not JSON: matches `unitsPerBox Int?` and stays queryable for
the sizing/backfill reports. Nullable, no default, no backfill in the migration (metadata-only ADD COLUMN;
the 20260921180000 migration is the style reference, including its ORDERING note: apply to prod BEFORE the
schema PR merges, because the rebuilt client selects the new columns).

D2 · NULL SNAPSHOT MEANS "FROZEN AS STORED", NEVER "USE THE LIVE RATE". Recompute of a line with a NULL
snapshot keeps its stored `categoryTaxAmount` when the basis is unchanged, and when the basis changes it
PRORATES the stored amount by the basis ratio (per-unit family: `unitBasisQty` ratio; PERCENT_OF_SALE:
subtotal ratio) — the line's own effective rate, never an invented one — and logs a warn naming the line.
One helper in `@routeflow/pricing`, `recomputeCategoryTax({ snapshot, storedAmount, basisBefore, basisAfter })`,
is the ONLY implementation; the two recompute sites call it. This makes legacy lines safe on day one
without any backfill, which is why D3 is an improvement, not a prerequisite.

D3 · BACKFILL FROM SALE ROWS IS UNSAFE — do not do it. (i) A ledger row's `categoryTax` is rounded cents; the
rate is not recoverable from it (0.0525 × 12 = 0.63 also fits 0.0521..0.0529), and for the tobacco
tenants today rate = 0, where every rate fits. (ii) The ledger row belongs to the INVOICE line, and a
partial/delivered-basis bill prorates it, so it does not even carry the order line's full figure. (iii) A
line can have several rows (SALE + reversals + B681 corrections), and a resync-rewritten row already carries
a re-priced amount — the very defect. Instead: a PROVABLE backfill, owner-run, dry-run first, report per
tenant/category (SA-058 shape): set the trio to the category's CURRENT values ONLY where
`computeCategoryTax(current trio, the line's current basis) === stored categoryTaxAmount` (the line proves
it was priced at this rate); leave NULL otherwise. Never in the migration.

D4 · LOCKED. Add `LOCKED` to `RegulatedFilingStatus`, plus `lockedAt DateTime?`, `lockedById String?`,
`lockReason String?` on `RegulatedFiling`. A filing can be locked only when its `periodEnd <= now` (a running
period never locks), it is GENERATED, and `assertNoParkedReversals` passes for its buckets. Lock is an
explicit tenant-admin action with a required reason and an audit row; there is NO unlock endpoint in this
work (an unlock is a later super-admin ruling with its own PR). Semantics: a LOCKED filing closes the
(tenant, category, periodKey) triple. Two guards, defence in depth:
(a) EDIT GUARD (user-facing): before a money-bearing change to a regulated line whose invoice SALE rows
bucket into a LOCKED filing for that category, refuse with 409 `FILED_PERIOD_LOCKED` naming the filing
and period. Money-bearing = qty/boxes/pieces/unitLabel/subtotal/categoryTaxAmount of a regulated line
changes, or a regulated line is added/removed/cancelled. Non-money edits (notes, delivery date,
shipping) proceed and, with D5, write no ledger rows. Sites: `updateOrderItems` (before the tx),
`applyPriceAdjustment`, invoice `update` on an ISSUED invoice, credit-note and return paths that
reverse a locked-period SALE are NOT blocked (a return is a new event booked today per the
never-backdate rule; the locked period's SUM is untouched) — state this in the body so nobody "fixes" it.
(b) LEDGER GUARD (last line): `writeSaleEntries` / `reverseInvoiceEntries` / the correction writers refuse
any row whose `periodBucket` (of its `soldAt`) is covered by a LOCKED filing for the row's category:
throw `LEDGER_PERIOD_LOCKED`, never write. Under never-backdate this can only fire when the current
period is locked, which (a)'s `periodEnd <= now` rule makes impossible except across the bucket
boundary — it exists to make the invariant structural, not to be hit.

D5 · RESYNC WRITES ONLY WHEN SOMETHING CHANGED. `resyncInvoiceLedger` computes, per invoice line, the TARGET
(qty, unitBasisQty, netSales, categoryTax from the rebuilt line) and the NET HELD (Σ signed rows for the
line key, `preserveReturns` semantics as today, corrections included per SA-034(a)); when every line's
target equals its net held (money to the cent, qty to 0.001) it writes NOTHING. Otherwise it behaves as
today (reverse + rewrite) for the changed lines only. This is the fix for "a note edit books a pair into
today's period" and is independent of the snapshot.

D6 · The write moment is the snapshot moment (SA-043): every NEW-sale writer in §1 stamps the trio from the
category it just priced with. Invoice lines built from order lines (`buildInvoiceItemData`) COPY the order
line's trio (the invoice inherits the order's sale-time rate; it does not re-read the category).

## 3. PR plan (small, ordered; schema first; the owner applies one migration)

PR 1 · `feat(schema): excise rate snapshot columns + LOCKED filing status (B297 step 1)` — prisma models
(sales.prisma OrderItem/InvoiceItem trio; compliance.prisma enum value + three RegulatedFiling columns), the
`MODEL_DOMAIN` map untouched (no new model), ONE migration.sql in the 20260921180000 style (header explains
each column, ADD COLUMN nullable no default, `ALTER TYPE "RegulatedFilingStatus" ADD VALUE 'LOCKED'` —
allowed inside Prisma's transaction on PG ≥ 12 as long as nothing USES the value in the same migration;
nothing does), `split-prisma-schema.mjs --check` green, `lint:migrations` green, NO code reads or writes
the columns yet. Prod: fresh backup → `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`
→ drift gate exit 0 → THEN merge (L-184). Red-first: `enum-parity.spec.ts` (packages/types enums.ts gains
LOCKED) and a schema spec asserting the columns exist on both models.

PR 2 · `feat(regulated): stamp the category tax trio on every new sale line (B297 step 2)` — the six
NEW-sale writers in §1 + `buildInvoiceItemData` copying the trio; one shared `categoryTaxSnapshotOf(category)`
helper so no site hand-types three fields. Ledger unchanged. Red-first (each fails before the change):
create() order line carries the trio; template order line; manual invoice line; invoice update line;
unit-line-build line; invoice-unit-line; a rebuilt invoice line copies the ORDER line's trio, not the live
category (fixture: category rate changed between sale and rebuild). Plus a callsites pin: every
`computeCategoryTax(` caller in apps/api/src is in an allow-list that names it as writer-with-snapshot or
recompute-from-snapshot (the B661 `no-second-legacy-line-pieces.spec.ts` shape).

PR 3 · `fix(regulated): recompute reads the line's rate snapshot, never the live rate (B297 step 3)` —
`recomputeCategoryTax` helper in `packages/pricing` (D2) with its own spec; `recomputeLineCategoryTaxes`
and `applyPriceAdjustment` (:6285) call it; the live category is no longer fetched at either site. THIS PR
is the B297 headline fix. Red-first: (1) raise the category rate, then edit a note on a delivered June order
→ each line's `categoryTaxAmount` unchanged (fails today); (2) NULL snapshot + unchanged basis → unchanged
amount; (3) NULL snapshot + qty 12→6 on a PER_UNIT line → amount halves (prorated), warn logged; (4) snapshot
present + qty change → recomputed at the SNAPSHOT rate, not live; (5) price adjustment on an issued invoice
after a rate change → excise unchanged; (6) PERCENT_OF_SALE prorates by subtotal ratio. A read-only sizing
script (owner-run, SA-058 shape) reports, per tenant/category, how many regulated lines would be re-priced
by today's rate (stored ≠ live recompute) — the blast radius the owner sees BEFORE PR 3 lands.

PR 4a · `fix(regulated): a ledger resync writes nothing when nothing changed (B297 step 4a)` — D5 in
`resyncInvoiceLedger`, target-vs-net-held per line, one helper reused from `reverseInvoiceEntries`'s
remaining computation (no second netting implementation). Red-first: note edit on a delivered regulated
order → zero new ledger rows (fails today: 2 rows per line); qty edit → exactly the changed line gets a
REVERSAL + SALE pair; re-running the resync twice → idempotent; a prior return reversal is preserved.

PR 4b · `feat(regulated): LOCKED filing status, lock endpoint, edit guard, ledger guard (B297 step 4b)` —
D4: `POST /regulated/filings/:id/lock` (tenant admin; reason required; audit row with actor, filing,
period, reason; refuses a running period, a FAILED filing, parked reversals); `assertNotLockedForEdit`
called by `updateOrderItems`, `applyPriceAdjustment`, ISSUED-invoice `update`; ledger-level refusal in the
three writers. Red-first: lock refused while `periodEnd > now`; lock refused with parked reversals; a
money edit to a locked-period line → 409 with the filing id; a note edit to the same order → 200 and zero
ledger rows (needs 4a); a return against a locked-period sale → allowed, books today; `writeSaleEntries`
with a soldAt bucketing into a locked period → throws, zero rows; `prepareFiling` on a LOCKED filing →
returns the stored artifact, never regenerates (today it regenerates on demand — that must stop for LOCKED).
Enum parity + the registry of platform flags untouched (no new flag).

PR 5 · `chore(regulated): provable rate-snapshot backfill (B297 step 5, owner-run)` — D3 script under
apps/api/scripts, `assertSafeTarget`, `--dry-run` default with a per-tenant/category report
(matched / left NULL / rate-0), `--apply` gated; never touches a line whose stored amount does not equal the
current-rate recompute. Optional; lands after PR 3 so the NULL class is already safe.

Every PR: `Bookkeeping-Follow-Up: pending` trailer; lessons entry after PR 3 (the "a recompute that reads a
live rate is a backdated re-price" rule) in the docs follow-up.

## 4. Ordering, dependencies, and the units question

- PR 1 → prod migration applied + drift 0 → PR 2 → PR 3 → PR 4a → PR 4b → PR 5. PR 4a and 4b are
  independent of PR 2/3 in code but 4b's "note edit writes nothing" test needs 4a.
- UNITS: **PR 1 and PR 2 must land before `flag.units_v1` is enabled for any non-test tenant.** Two of the
  six new-sale writers are the units paths (`unit-line-build.ts:189`, `invoice-unit-line.ts:76`); a unit line
  born before PR 2 has a NULL snapshot and joins the legacy class forever (safe under D2 — prorated, never
  re-priced — but never recomputable at its own rate). PR 3, 4a, 4b do not gate units. PR 3 is the Release 1
  item the owner named; it does not depend on units landing.
- Pilot pack-edit and B681 routine: no interaction (different columns, different writers); the B681
  correction rows carry `correctsEntryId` and are included in D5's net-held per SA-034(a).

## 4a. Resequencing (SA-096, 2026-09-23)

PR 1 + PR 2 ship as ONE PR (L-184 ordering still binds). PR 5 (backfill) lands BEFORE PR 3, because the owner's
production sizing found zero mismatches, so the backfill is exact. PR 3's NULL branch is "price at live ONCE and stamp the trio used, warn naming the line" (SA-096a — never
"keep": seven creators defer the amount to the recompute with a NULL trio, SA-098a) (no basisBefore plumbing).
The stamp-on-NULL net is PART OF PR 3's definition (SA-098b): PR 3 never lands without it, and it fills a NULL
trio only — never overwrites a present one., guarded structurally by (i) the PR-2 callsite
allow-list over every creator of a regulated line, keyed on `trackedCategoryId:` writes (SA-098a(c)), with merges
COPYING the losing line's trio and same-product edits PRESERVING it (only a substitute re-stamps) and (ii) a standing count gate (regulated lines with a NULL
trio = 0) in post-deploy-check / the drift lane. See SA-096 in RULINGS.

## 5. Explicit non-goals

Rate effective-dating on `TrackedCategory` (history table): not needed once the line carries its rate.
Unlock endpoint: deferred to a super-admin ruling. Re-pricing legacy lines to their "true" historical rate:
impossible without a rate history; D2/D3 are the honest floor.
