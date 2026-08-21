# Plan: feature verification suite — write-path smoke + UI e2e for everything shipped 2026-08-20

> Authored by Fable 5 on 2026-08-20. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

The repo has three verification layers today, and each has a blind spot:

1. **Unit specs** (`npm run verify`) — ~3,100 Jest tests, strong, but mocked at the
   Prisma boundary: they prove logic, not that the deployed system works.
2. **`scripts/post-deploy-check.mjs`** — authenticated probe of the live API, but it
   only reads: health, login, five list endpoints, money-format checks. **It touches
   none of the write paths shipped recently** (stock-count sessions, variant assign,
   supplier payment allocation, bulk mark-paid, boxed-line proration, statement scan).
3. **Playwright e2e** — good role coverage, but nothing exercises the new UI surfaces
   (boxed order entry, pack-size prompts, stock-count tab, variant-split modal).

Build a fourth layer — **`scripts/feature-smoke.mjs`**, an authenticated WRITE-path
smoke that provisions its own fixtures on the approved test tenant, exercises every
new feature through the real API, asserts the money invariants, and cleans up after
itself — plus four new Playwright specs for the UI surfaces, wired into the standing
`regression` script and documented in a verification matrix.

**Division of labour (deliberate):** the API smoke owns every WRITE assertion because
its cleanup is programmatic and reliable; the new Playwright specs stay
**read-only-or-cancel** (build state in the UI, assert, then Escape/discard/cancel)
so repeated UI runs never mutate the tenant. Do not blur this line.

## Constraints & conventions

- **Test-tenant policy is absolute.** The smoke script must call
  `assertTestTenant()` from `scripts/lib/test-tenants.cjs` on its tenant slug at
  startup and refuse to run otherwise. Default tenant `e2e-routeflow`. Every row the
  script creates is named with the `E2E-SMOKE-` prefix. It must NEVER mutate a row it
  did not create this run.
- **Idempotent / rerunnable.** A crashed previous run must not break the next one:
  find-or-create the fixture supplier/customer by their `E2E-SMOKE-` names; clean up
  in `finally`; tolerate leftovers.
- **Env contract mirrors `scripts/post-deploy-check.mjs`** (read it first and reuse
  its conventions — `SMOKE_BASE_URL` (default the prod API), `SMOKE_TENANT_SLUG`,
  `SMOKE_OPERATOR_USERNAME`/`PASSWORD` (default admin/Admin@123), the `x-tenant-slug`
  header on every request, `pass()`/`fail()` reporting, exit 1 on any failure).
- **Money assertions compare to the house formula**, 2dp:
  `subtotal = round(boxPrice × (boxes + pieces / unitsPerBox))`.
- **Playwright:** every new spec file gets its OWN project entry in
  `apps/web/playwright.config.ts` (house rule — a spec without a project silently
  never runs; this has happened before). Existing spec numbers run 01–12 with `10`
  free; use **13–16**. All four new projects depend on `["setup"]` and use the
  operator storage state (`AUTH_DIR/operator.json`) exactly like `critical-paths`.
- **Prettier**: semicolons, double quotes, printWidth 100, trailing commas. No new
  dependencies. No API/app code changes — if a scenario cannot be tested without
  changing app code, SKIP it with a printed reason instead.
- `npm run verify` must stay green; the new e2e specs are NOT run by `verify`.

## Work packages

Files are DISJOINT. WP2 owns `playwright.config.ts` and adds ALL FOUR project
entries (13–16); WP3 only creates its two spec files matching the names WP2 wires.

### WP1 — `scripts/feature-smoke.mjs` + wiring + verification matrix

- **files:** `scripts/feature-smoke.mjs`, `package.json`, `docs/testing/verification-matrix.md`
- **brief:** One script, sectioned like `post-deploy-check.mjs`, running these
  scenarios in order. Read `scripts/post-deploy-check.mjs` FIRST and copy its
  auth/header/reporting conventions.

  **Startup:** assertTestTenant; login as operator; create-or-find the run fixtures:
  - `E2E-SMOKE-SUPPLIER` (supplier),
  - `E2E-SMOKE-CUSTOMER` (customer; buyers/tiers irrelevant, cheapest shape),
  - `E2E-SMOKE-BOXED` product: `pricePerUnit: 20`, `unitsPerBox: 6`, `unit: "box"`
    (create fresh each run with a timestamp suffix to avoid name-unique collisions;
    track its id for cleanup),
  - `E2E-SMOKE-PARENT` product (no unitsPerBox, `pricePerUnit: 10`) for the variant
    scenario.

  **S1 — boxed proration (the pieces question).** Create a DRAFT order for the smoke
  customer with the boxed product: line `{boxes: 0, pieces: 2}` → expect line
  subtotal `round(20 × (0 + 2/6)) = 6.67`; second line-shape `{boxes: 1, pieces: 2}`
  → `26.67`. Assert the ORDER subtotal equals the sum. Then PATCH the order items
  with an incremental diff (`replaceAll: false`, one id-less added line) and assert
  the pre-existing lines SURVIVE (the wipe-class regression). Delete the draft.

  **S2 — stock-count session lifecycle.** `POST /inventory/stock-counts` (name
  `E2E-SMOKE count <ts>`) → `PUT :id/lines` for the boxed product with
  `{boxes: 1, pieces: 3, mode: "ADD"}` → expect the line's `countedQty` = 9 (boxes
  through `normalizeBoxesPieces`). `PUT` again with `{countedQty: 1, increment: true}`
  → 10. Commit → expect `applied ≥ 1` and a `reference` starting `STOCK_COUNT-`.
  Commit AGAIN → expect `alreadyCommitted: true` (idempotency). `GET /inventory/
stock-counts?status=COMMITTED` → the session row carries a numeric
  `netVarianceMoney`. **Compensating cleanup:** start a second session counting the
  product back to its pre-run stock (captured before S2), commit it, so the tenant's
  stock is net-unchanged even though both sessions remain as history.

  **S3 — variant assign.** Raise parent stock by 10 via
  `POST /inventory/movements/adjustment`. Then:
  (a) `POST /inventory/variant-assign` asking for 9,999 → expect **400** with code
  `INSUFFICIENT_UNASSIGNED` and parent stock unchanged;
  (b) assign 4 to `newVariant: { name: "E2E-SMOKE-VAR" }` → expect parent −4,
  variant created with stock 4, response `reference` starts `VARIANT_ASSIGN-`, and
  `GET /inventory/movements?reference=` (if supported — else filter client-side by
  the product ids) shows one negative parent + one positive variant movement.
  **Cleanup:** adjustment −4 on the variant, −6 on the parent (returning both to
  zero net), then deactivate both created products.

  **S4 — supplier payment allocation + on-account credit.** Create TWO vendor bills
  for the smoke supplier (totals 50 and 30; whatever minimal DTO the API needs — read
  `apps/api/src/vendor-bills` DTOs). Record a supplier-level payment of **90**
  (`POST /vendor-bills/payments/record`): expect both bills PAID, all created
  BillPayments sharing ONE `paymentGroupId`, and a surplus of 10 → the response (or a
  follow-up read) shows a SupplierCredit with balance 10. Then create a THIRD bill of
  10 and expect the credit to auto-apply (bill PAID or its paid total = 10, credit
  balance 0). **This third bill IS the credit drain** — without it the leftover
  credit would auto-apply to the NEXT run's bills and break its assertions. Cleanup:
  bulk-delete the three bills (the existing vendor-bills bulk delete endpoint).

  **S5 — bulk mark-paid.** Create two more bills (20 and 15) + confirm a VOID/draft
  edge if cheaply possible: `POST /bookkeeping/bills/bulk-mark-paid` with both ids →
  expect `paid: 2`, `totalAmount: 35`, `skipped: []`. Call it AGAIN with the same ids
  → expect `paid: 0` and both skipped with a nothing-owed reason (exact string not
  asserted — assert the shape). Cleanup: bulk-delete.

  **S6 — estimate double-convert guard.** Create an estimate for the smoke customer
  (one line, any product), `POST :id/accept`, `POST :id/convert-to-invoice` → 200/201
  once; convert AGAIN → expect **400**; `POST :id/accept` again → expect **400**
  ("converted estimates cannot be re-accepted" class). Cleanup: void the created
  invoice (`POST /invoices/:id/void` or the repo's actual route — read the invoices
  controller), leave the CONVERTED estimate (history rows on the test tenant are
  acceptable; note it in the section output).

  **S7 — find-by-product + sales summary invariant.** `GET /orders?productId=<boxed>`
  → every returned order contains a line for it (use the S1 draft window or create/
  delete a dedicated draft). `GET /analytics/product-sales/<any seeded product with
sales, else expect an empty-shape 200>` → assert
  `summary.avgPrice ≈ summary.totalRevenue / summary.totalQty` when `totalQty > 0`
  (the revenue-weighted invariant), else all-null empties.

  **S8 — uploads stay fail-closed (read-only).** With the operator token:
  `GET /uploads/products/00000000-0000-0000-0000-000000000000/x.png` → **403**;
  `GET /uploads/invoice-pdfs/00000000-0000-0000-0000-000000000000.pdf` → **403**;
  `GET /uploads/tenants/some-other-tenant/logo.png` → **403**. (Missing owner row
  must DENY — that is the fail-closed contract.)

  **S9 — route-registration for the statement scanner (no model call).**
  `GET /supplier-statements` → 200 list shape; `POST /supplier-statements/scan` with
  no body → 4xx that is NOT 404 (route exists; we never invoke the AI from smoke).

  **Wiring:** `package.json` gains `"feature-smoke": "node scripts/feature-smoke.mjs"`
  and `"regression"` becomes
  `"npm run verify && npm run post-deploy-check && npm run feature-smoke"`.

  **`docs/testing/verification-matrix.md`:** one table — rows = every feature shipped
  in the 2026-08-20 batch (PR-A…PR-F items, B4–B14, pack size, boxed pieces flow),
  columns = layer (unit / feature-smoke / e2e / post-deploy) with the exact command
  and spec/section name covering it, plus an honest "not covered" column (e.g. AI
  statement parse needs a real key + document; driver-role e2e does not exist;
  nightly.yml only fires while the repo is public, so it is dormant between ship
  windows — the recurring gates are the post-deploy webhook and `npm run regression`).

### WP2 — Playwright: config + boxed order entry + pack-size prompts

- **files:** `apps/web/playwright.config.ts`, `apps/web/e2e/13-boxed-order-entry.spec.ts`, `apps/web/e2e/14-pack-size-prompt.spec.ts`
- **brief:** Add FOUR project entries (13–16, names `boxed-order-entry`,
  `pack-size-prompt`, `stock-count-ui`, `variant-split-ui`), each `dependencies:
["setup"]` + operator storage state, mirroring the `critical-paths` entry verbatim.
  WP3 creates specs 15–16; wire them here so neither spec can silently not run.

  **13 — boxed order entry (read-only: never submits).** As operator, open the
  order builder (the same entry the `create-order-escape` spec uses — read that spec
  for the navigation/selectors). Pick any customer (first row, data-agnostic), search
  for a product whose row exposes the cases/pieces inputs (find one by looking for
  the sell-by toggle; if the tenant has no boxed product, `test.skip` with a clear
  message — the smoke script provisions one, but do not depend on ordering between
  suites). Enter cases 0 / pieces 2 and assert the rendered line total equals
  `boxPrice × 2/unitsPerBox` within a cent (read the box price and pack size off the
  page rather than hardcoding). Then cases 1 / pieces 2 → assert again. **Escape out
  via the existing draft/escape flow — never place the order.**

  **14 — pack-size prompts (read-only: never saves).** Open the product-create modal
  (button on `/products`). Three assertions, clearing the form between each:
  (a) name "E2E Cola 24PK", unit "case" → the prompt appears with **24** pre-filled;
  (b) name "E2E Shot 5CT - 12Pack" → the AMBIGUOUS prompt appears with an **empty**
  input and copy naming both counts;
  (c) name "E2E Widget 12CT", unit "each" → **no prompt renders at all**.
  Close the modal without saving. These three are the parser's refusal contract made
  visible — the cases where a wrong answer silently mis-prices sales.

### WP3 — Playwright: stock-count UI + variant-split UI

- **files:** `apps/web/e2e/15-stock-count-ui.spec.ts`, `apps/web/e2e/16-variant-split-ui.spec.ts`
- **brief:** File names MUST match WP2's project wiring exactly.

  **15 — stock count (discard-only: never commits).** Inventory → Stock Count tab.
  Start a session; add a line via the manual-add path (search any product); assert
  the line renders with a counted qty and the "n unsaved"/synced indicator resolves;
  open Review and assert the expected → counted → variance columns render; then
  **Discard** the session and assert it disappears from "Continue count". Assert the
  history list page loads. Zero stock impact by construction.

  **16 — variant split (cancel-only: never applies).** Find a parent product with
  variants (products list filtered/searched; if none exists on the tenant,
  `test.skip` with a clear message). Open "Assign to variants" from the product page.
  Assert: the Remaining pool renders; typing a qty above the pool CLAMPS or disables
  Apply (the over-assignment block); the STANDARD-cost case hides the per-row cost
  field if the parent is STANDARD (conditional assert — only when the badge/data
  says so). **Cancel** — never submit.

### WP4 — nightly + handoff notes

- **files:** `.github/workflows/nightly.yml`, `HANDOFF.md`
- **effort:** low
- **brief:** In `nightly.yml`, add a `feature-smoke` job step after the existing
  post-deploy-check step (same env: `SMOKE_BASE_URL`, `SMOKE_TENANT_SLUG:
e2e-routeflow`), running `npm run feature-smoke`. Do NOT touch the schedule, do
  NOT re-enable any other workflow, and keep the existing public-repo comment —
  extend it with one honest line: this workflow is dormant while the repo is
  private; the recurring gates are the post-deploy webhook and `npm run regression`.
  In `HANDOFF.md`, add a short "Verification layers" block under the session-
  mechanics section listing the four layers and their commands, and pointing at
  `docs/testing/verification-matrix.md`.

## Acceptance criteria

1. `npm run feature-smoke` runs green top to bottom against a local stack AND is
   safe-by-construction for prod: refuses non-test tenants, only mutates rows it
   created, cleans up in `finally`, exits 1 on any failure.
2. S1 asserts boxed proration to the cent for pieces-only and mixed lines, and that
   an incremental item PATCH does not wipe untouched lines.
3. S2 proves the stock-count lifecycle including the idempotent double-commit and
   `netVarianceMoney` on the list row, and leaves tenant stock net-unchanged.
4. S3 proves `INSUFFICIENT_UNASSIGNED` refuses atomically and a real assign moves
   stock parent→variant under one `VARIANT_ASSIGN-` reference.
5. S4 proves paymentGroupId grouping, overpayment→SupplierCredit, and credit
   auto-apply — and drains the credit so reruns stay deterministic.
6. S5 proves bulk mark-paid pays through the ledger and skips already-settled bills
   on rerun. S6 proves the estimate double-convert/re-accept guards. S8 proves the
   uploads endpoint fails closed. S9 proves the statement routes exist without
   invoking the model.
7. All four new Playwright specs have project entries and pass against the standing
   e2e target; 13/14 are read-only, 15 discards, 16 cancels — none mutates tenant
   state that survives the test.
8. `npm run regression` chains verify → post-deploy-check → feature-smoke.
9. The verification matrix lists every batch feature with its covering layer(s) and
   an honest not-covered column.
10. `npm run verify` stays green (18/18, 0 lint errors).

## Verification commands

- `npm run verify`
- `node --check scripts/feature-smoke.mjs` (syntax gate — the script's live run needs
  a reachable API, which the pipeline gate does not have)
- `cd apps/web && npx playwright test --list` (proves the four new projects resolve
  their spec files; listing requires no browser or server)

## Risks & rollback

- **The smoke script writes to a live tenant (the approved test one).** The three
  non-negotiables: assertTestTenant at startup, only-touch-what-you-created, cleanup
  in finally. Review these before anything else.
- **Credit leakage between runs** is the subtle one — S4's drain bill exists
  precisely so a leftover SupplierCredit cannot poison the next run's assertions.
- **Playwright specs must not depend on feature-smoke having run** — each skips
  gracefully when the tenant lacks a boxed/variant product.
- Rollback: the script and specs are purely additive; removing them restores the
  prior verification setup untouched.
