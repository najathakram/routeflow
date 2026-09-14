# F38 — driver at-door money, offline close-out, driver run linkage (build plan / design digest)

Run: raw (non-data-point, lead ruling 2026-09-13 05:1xZ) · branch `fix/F38-driver-at-door` off
master `2d353752` · worktree `rf-F38` · REG tests red-first (commits `1bf5986e`, `1475b5a6`).
No migration, no data repair, no `*.module.ts` change, no new endpoint.

## Rows

| Id   | Sev              | Tier | REG test                                                                                                          | Where                                                                                   |
| ---- | ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| B305 | critical (money) | T3   | `apps/mobile/__tests__/run-money.test.ts` "REG-B305 …" (5) + `apps/api/src/routes/routes.run-stop-select.spec.ts` | mobile driver payment/stop screens · api run-stop select                                |
| B306 | medium (money)   | T1   | `invoices.service.spec.ts` + `routes.service.spec.ts` "REG-B306 …" (6)                                            | `voidPayment`, `getRunCashCollections`, `enrichRunsWithCollectedPayments`, `reopenStop` |
| B307 | high             | T3   | `apps/mobile/__tests__/returns-logic.test.ts` "REG-B307 …" (3)                                                    | `summarizeSubmissions`, driver return screen                                            |
| B308 | medium (money)   | T3   | `apps/mobile/__tests__/offline-errors.test.ts` "REG-B308 …" (3)                                                   | `classifyMutationError`, payment close-out, at-stop order create                        |
| B309 | high (tenancy)   | T1   | `orders.service.spec.ts` "REG-B309 …" (4)                                                                         | `OrdersService.create()` DRIVER branch                                                  |

## Design packs

### B305 — the at-door amount due is the server's tax-inclusive total

- Cause: `RUN_STOP_INCLUDE.orders.select` projects only line items; `run-money.ts` sums line
  subtotals; the invoice bills subtotal + tax (`invoices.service.ts:1447-1473`). Evidence:
  invoice 128.51, driver asked 116.83, change on 130 shown 13.17 instead of 1.49.
- Fix (as built after Opus round 1 — the first cut read `Order.total`, which carries NO discount and
  the whole shipping fee on every visit of a split delivery; blocker): the driver's amount due is
  the order's OPEN DRAFT INVOICE as the server last computed it. (api) `RUN_STOP_INCLUDE` is
  exported and its `orders.select` projects `subtotal/tax/total/discountAmount/shippingFee` plus
  `invoices: { where: { status: DRAFT, deliveryBatchId: null }, select: { id, subtotal, taxAmount,
discount, shippingFee, total }, take: 1 }` — the exact rows `findOpenOrderDraft`
  (`invoices.service.ts:1340`) reconciles at delivery; `total = subtotal + taxAmount + shippingFee -
discount` (:1232), `taxAmount` folds regular + category tax. **Round 2 (Opus found three residuals):**
  a regulated SEPARATE_INVOICE order carries SEVERAL open drafts (base + `-R#`,
  `reconcileSplitOrderDrafts` ~:2154), so the projection takes them ALL (`orderBy createdAt asc`, no
  `take`) and `orderAmountDue` = Σ open drafts' `total`; the `Order.total - discountAmount` fallback
  is GONE (`Order.total` is already net of discount on the create path, orders.service.ts:2428, but
  not on edit/merge — no client-side convention is safe; TO FILE) — without a draft the figure
  falls back to the legacy pre-tax sum; the short-pick estimate follows the server's rule exactly
  (:1447-1473): `deliveredSubtotal − Σdraft.discount + Σdraft.shippingFee + order.tax ×
deliveredSubtotal/order.subtotal + Σ_delivered lines categoryTaxAmount × deliveredQty/qty` —
  `Order.tax` is the REGULAR tax only, category tax is the server's per-line `categoryTaxAmount`
  (now projected on `RUN_LINE_ITEMS_SELECT`; `OrderItem` has no `taxRate` column) scaled by delivered quantity; the short-pick
  label reads "(est. — final on invoice)". **Round 3 (Opus):** neither `Order.tax` nor the per-line
  category snapshots are exemption-aware while the invoice zeroes both for a tax-exempt customer, so
  the stop payload now projects the customer's exemption flag and the short-pick estimate zeroes
  both tax terms when it is set (exempt, deliver only the regulated line: 100, not 160). Known
  residual → TO FILE: an order whose invoice was already SENT pre-delivery matches no open DRAFT and
  is quoted pre-tax (pre-existing; the amount due there is the invoice's remaining balance).
  `payment.tsx` and `index.tsx` use them; the posted amount is the corrected figure.
- Invariants: `lineItemSubtotal`/`sumOrderLineItems`/`sumStopOrders` unchanged (REG-B49); no
  client-side tax-rate math (no mirror of `packages/pricing` — the server's own draft is read);
  every `Number()` guarded by `Number.isFinite`, never NaN; a payload without the draft falls back
  as above.
- Oracles: draft 128.51 (was 116.83); change 1.49 (was 13.17); DISCOUNT draft 95 vs `Order.total`
  110; SPLIT FEE drafts 65 then 55 (never 121); MULTI-DRAFT 120 + 80 = 200 (never one sibling);
  short-pick, Opus's example (order subtotal 200 / regular tax 20; A plain 100, B regulated 100 with
  category 50; draft 270): A only → 110, B only → 160, both → 270; fee/discount whole on a half
  delivery → 50; per-unit category scales 50 × 4/10 = 20; no draft → legacy line sum, never a
  discount guess; malformed total → line sum.
- **Round 4 (2026-09-13, independent pre-merge review — blocked #710):** the two halves of the
  door quote were fed from DIFFERENT line sets. `payment.tsx` built `deliveredSubtotal` from the
  filtered `shortPickLines` (`status !== "CANCELLED" && deliveredQty === 0`, off the rich
  `order.lineItems`) but `deliveredCategoryTax` from the RAW run-payload `o.lineItems`, and
  `run-money.ts#deliveredCategoryTax` defaults a line absent from the plan to FULLY delivered — so a
  CANCELLED regulated line, or a regulated line already billed on an earlier split visit, added its
  full `categoryTaxAmount` while contributing zero subtotal (cash over-collected at the door →
  `AdvancePayment` the customer must be made whole on). It survived three in-lane Opus rounds
  because each file is correct on its own — the defect lives in the seam. Fix `df635fdb`: new pure
  `run-money.ts#shortPickCategoryTax(lineItems, shortPickLines, plan)` restricts the sum to
  `shortPickLines`' ids and delegates (`deliveredCategoryTax`'s default stays — it is right for
  `buildDeliveries`); the page calls it, so both halves derive from ONE set. Tests derive their
  expectations from named terms, and a source-pin test fences the screen (the unit tests cannot
  import it, so a revert to the raw-lines call would otherwise stay green):
  - **Cancelled regulated line → 43.20** (old composition 55.20). This one IS a server oracle and was
    independently re-derived: `Order.subtotal`/`tax` are recomputed from non-cancelled lines
    (`orders.service.ts` ~:4481-4487), so billable = B alone (40) + 4.00 × 40/50 = 43.20.
  - **Split-delivery visit 2 → 42.00** (old 62.00) **fences the DOOR COMPOSITION, not a server
    invoice** (corrected after the round-4 refutation, which refuted my first framing): the server's
    `reconcileOrderDeliveredInvoices` → `rebuildSiblingDrafts` (`invoices.service.ts` ~:1863-1872)
    bills `billQtyOf = deliveredQty` with NO `priorBilledQty`, so a rebuilt visit-2 draft would be
    272.00. No reachable path to `deliveredQty > 0` with the stop still open was found
    (`completeWithPayment` completes the stop; `reopenStop` zeroes it) → latent, not live.
  - Scope guard + tax-exempt guard (40.00) unchanged.
    Lesson candidate for the follow-up: two halves of one money figure must derive from ONE line set —
    a seam between files is invisible to per-file review, and an independent pre-merge pass (not more
    in-lane rounds) is the instrument that finds it; a test may only claim a server oracle it can
    actually derive from the server's own code.

### B306 — a RUN-tagged over-collection advance is reversible; reconciliation and reopen respect it

- Cause: `recordDeliveryPaymentInTx` books excess as `AdvancePayment{reference:"RUN:<run>:STOP:<stop>"}`
  (`invoices.service.ts:5035-5046`); nothing reverses it; run cash sums every RUN-prefixed
  advance unconditionally (`routes.service.ts:1579-1613`, `~1780`); `reopenStop` ignores advances.
- Fix (no schema): `InvoicesService.reverseRunAdvancesInTx(tx, { runId, stopId, reason })` reverses
  the stop's `RUN:<run>:STOP:<stop>` advances (`balance: 0`, `reference += ":REVERSED"`, note
  `REVERSED <ISO>: <reason>`), throws on an already-applied one (`balance !== amount`), and is a
  no-op when the order has no `runId` (Opus minor: never build `RUN:null:…`). `voidPayment` calls it
  once no CONFIRMED payment remains for the stop. Reconciliation queries add
  `NOT: { reference: { endsWith: ":REVERSED" } }`. `reopenStop` (as built after Opus round 1 — the
  first cut blocked on ANY advance, which dead-ended the zero-payable case it was written for) keeps
  the "Payment already recorded" guard for confirmed money and otherwise reverses the advance INSIDE
  its own transaction via the same helper, then proceeds.
- Invariants: the money write stays inside the calling transaction (L-081); idempotent on a second
  void/reopen (an exact-reference match never sees a `:REVERSED` row — L-104); advances applied to
  later invoices are never zeroed (the existing ADVANCE re-credit path is untouched).
- Oracles: the exact `findMany`/`update` shapes (L-113); reversed rows excluded from cash totals.

### B307 / B308 — an offline-queued mutation is a success

- Cause: `api-client.ts:183` rejects with `{ isOfflineQueued: true }` after enqueueing; the return
  screen's result map drops the flag so `summarizeSubmissions` files it as failed ("still to
  send"); the payment close-out and at-stop order-create `catch`/`onError` re-arm the button.
- Fix: `classifyMutationError(e) → {kind:"queued"|"error", message}` (mirrors `skip-stop.ts:48-57`);
  `summarizeSubmissions` gains a `queued` bucket; the three screens toast "queued, will sync" and
  navigate back exactly as on success, never re-arming the submit button.

### B309 — a DRIVER may only link an order to a stop on their own in-progress run

- Cause: `orders.service.ts:2569-2582` writes `dto.routeRunId`/`routeRunStopId` for any caller
  with no ownership, run-status or stop-status check.
- Fix: in the DRIVER branch, BEFORE the order row is written: resolve the driver, load the stop
  (`{id,status,routeRunId}`) and run (`{id,driverId,status}`); 403 on foreign run (same message
  as `routes.service.ts:2470-2479`, B72's rule), 400 on a run not IN_PROGRESS, a COMPLETED/SKIPPED
  stop, or a stop/run mismatch; the link block uses the resolved run id. After Opus round 1: the
  CUSTOMER branch rejects any `routeRunId`/`routeRunStopId` outright (a buyer must never attach an
  order to a driver's manifest) — the link block itself is role-agnostic and the controller admits
  CUSTOMER. Known stricter behaviour: an at-stop create on a SCHEDULED (not yet started) run now
  400s, matching `completeWithPayment`'s own in-progress rule.
- Invariants: OPERATOR path byte-identical; a rejected link creates no order.

## DECIDE-30 conditions (standing go)

(a) no data repair — PASS · (b) no migration — PASS · (c) Opus-high refute-first review of the
radius — recorded in the PR body · (d) every REG red on its own wrong value before the fix — commits
`1bf5986e`, `1475b5a6` (red proofs quoted in the PR body).

## Manual verification

T3 rows: the jest oracles above prove the logic; the screen behaviour is verified by hand on a
device/emulator against the compose stack and recorded here at discharge time.

| REG id   | Manual check (device against `test` tenant)                                                 | Expected                                                                                                                         | Result  |
| -------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| REG-B305 | Driver opens a stop whose order has tax; payment screen amount due and the stop card figure | both show the invoice's tax-inclusive total; change on an over-payment is total-based                                            | pending |
| REG-B307 | Airplane mode; submit a return at a stop                                                    | toast says queued/will sync; no "still to send" resend prompt; on reconnect exactly one return exists                            | pending |
| REG-B308 | Airplane mode; complete a stop with payment; create an at-stop order                        | toast says queued/will sync; screen navigates back; submit button never re-armed; on reconnect one completion / one order exists | pending |

## TO FILE (after W18 — id-minting held by routeflow-0d)

Consolidated at bookkeeping time from the inline residuals above plus both review passes — eight items, six product and two tooling:

1. **`Order.total`'s discount convention is not client-safe** — it is already net of discount on the create path (`orders.service.ts:2428`) but not on edit/merge, so no client-side convention holds. The fix reads the server's open DRAFT invoices instead; the column's inconsistency is still there for the next consumer.
2. **An invoice already SENT pre-delivery matches no open DRAFT**, so the at-door figure falls back to the pre-tax line sum — the amount due there is really the invoice's remaining balance (pre-existing; not reachable through F38's own flows).
3. **Partial prior delivery is quoted at zero** — a line with `0 < deliveredQty < qty` is excluded from `shortPickLines` entirely, so neither its remaining subtotal nor its remaining excise reaches the door quote. Latent: no reachable path to `deliveredQty > 0` with the stop still open was found (`completeWithPayment` completes the stop, `reopenStop` zeroes it).
4. **`cancel()`'s TRIAL branch never reaches the Stripe block** (found reviewing the sibling billing lane, same class): a TRIAL tenant holding a live `stripeSubId` via platform-admin `extendTrial()` ends the trial locally while Stripe keeps invoicing. Zero exposure today.
5. **Returns credit total is pre-tax** (`return/index.tsx` uses `sumStopOrders`) — decide whether return credits carry tax; out of F38's scope.
6. **Hygiene, non-blocking:** `invoices.service.ts` ~:5648 `tx.invoicePayment.count({ where: { …CONFIRMED_PAYMENT, invoice: { order: { routeRunStopId } } } })` — the tenant proxy scopes the top-level model only; the nested `invoice.order` filter is unscoped. UUID keys make collision implausible; hygiene, not an exploit.
7. **Tooling:** the approach-rotation hook resolves its state file relative to cwd (`apps/api/.claude/pipeline/approach-rotation.json` written from a drifted cwd) — same class as the `BUGS_ROOT` trap (B278).
8. **Tooling:** `docker-compose.yml` hard-codes `container_name: routeflow_*` with no top-level `name:`, so `npm run local:up` from a worktree derives its project from the worktree DIRECTORY and collides with whatever stack holds those names (hit running this batch's own compose gate; L-103 predicted it). The house pattern for a second stack is a scratchpad override renaming the containers; `-p routeflow` adopts the default one.

## Status

- 2026-09-13 06:1xZ: all five fixes committed (ce3c1373 B306 · 0510a3f3 B309 · 939f6246 B305 api · c52b0d0b B305 mobile · 2ac0ade3 B307/B308); Opus refute-first review and revert probes in progress; push waits for the verify slot.
- Revert probes (pre-fix file back → REG red → HEAD → green): B305 mobile 5/14 red → 14/14; B306 2 red (+1 guard) → 3/3; B309 4/4 red → 4/4; round-1 B305 discount oracle 7/18 red (`Received: 110` / `121`) → 18/18; round-2 multi-draft/short-pick red by revert (120 vs 200, 135 vs 110); round-3 exempt red (160 vs 100).
- Opus refute-first rounds: **1** → 2 blockers + 4 majors + 5 minors (B305 basis = `Order.total`; B306 reopen dead end; B308 NewOrderScreen re-arm/re-key; B309 CUSTOMER path; NaN/`RUN:null`/queued shape) → fix round 1 (7d8b6a76 api, 722055d1 mobile). **2** → B306/B308/B309 CONFIRMED-CORRECT; B305 three residuals (multi-draft `take: 1`, discount fallback, category tax on short-pick) → fix round 2 (7e2083ee) + sibling spec mocks (9c350301). **3** → multi-draft/fallback RESOLVED, short-pick rule matches the server's linear snapshot proration; tax-exempt regression → fix round 3 (2b16d3db), hunk reviewed by the lead.
- Final suites after round 3: mobile 128 suites / 1580 tests, api routes sweep 199/199 (full api 4683 green after round 2; re-run in full before the push), web 501, pricing 206; `check-types` clean on api + mobile. Ledger: raw-run row appended via `pipeline-ledger.mjs append-manual --approach raw` from this session's true usage.
- **2026-09-13 16:22Z — MERGED as PR #710 (master `14048230`).** Round 4 (the independent pre-merge review's excise-seam finding) was fixed, refuted clean, and carried in one force-push that also re-authored all 20 commits off the repo-level test identity (`Smoke Test <smoke@test.local>` had been left in `.git/config`, affecting every worktree). Pre-push: uncached `turbo run test --force` — api 4684 / mobile 1586 / web 501 / pricing 206, campaign-check 173 claims backed. Delta re-review returned CLOSED with nothing introduced.
- **Bookkeeping (Option B, this PR):** code-map rows for the touched api + mobile files; lessons **L-118** (a client money figure reproduces the server's billing rule from the inputs the server bills from, never a column) and **L-119** (both halves of one money figure derive from ONE collection; a seam needs an independent pre-merge pass, not another in-lane round), with **L-112** archived for headroom — the register is now structurally full at 40/40 entries and 40,957/40,960 bytes, raised to the lead as an owner decision on the byte cap; `bugs.mjs prove B305–B309 --pr 710` recorded against this digest; the RUN-LOG entry appended to the vendored `dev-pipeline/references/RUN-LOG.md`; the eight items above filed for 0d.
