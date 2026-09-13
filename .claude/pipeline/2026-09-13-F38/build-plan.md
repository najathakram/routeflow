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
- Fix: (api) export `RUN_STOP_INCLUDE` and add `subtotal: true, tax: true, total: true` to its
  `orders.select` (`Order.tax/total` already exist and are kept in sync — `sales.prisma:559-561`).
  (mobile) `orderAmountDue` = `Number(total)` when present, else the legacy pre-tax sum;
  `stopAmountDue`; `reconciledAmountDue` prorates the order's tax by delivered/ordered subtotal —
  the server's own rule (`invoices.service.ts:1454-1456`) — from the three order totals.
  `payment.tsx` and `index.tsx` use them; the posted amount is the corrected figure.
- Invariants: `lineItemSubtotal`/`sumOrderLineItems`/`sumStopOrders` unchanged (REG-B49); no
  client-side tax rate math (no mirror of `packages/pricing`); a payload without totals falls back
  to today's pre-tax figure (old API), never to NaN.
- Oracles: 128.51 (was 116.83); change 1.49 (was 13.17); half-delivered → 64.26.

### B306 — a RUN-tagged over-collection advance is reversible; reconciliation and reopen respect it

- Cause: `recordDeliveryPaymentInTx` books excess as `AdvancePayment{reference:"RUN:<run>:STOP:<stop>"}`
  (`invoices.service.ts:5035-5046`); nothing reverses it; run cash sums every RUN-prefixed
  advance unconditionally (`routes.service.ts:1579-1613`, `~1780`); `reopenStop` ignores advances.
- Fix (no schema): `voidPayment` — when the voided payment's invoice belongs to an order with
  `routeRunStopId` and no CONFIRMED payment remains for that stop, reverse the stop's advances:
  `balance: 0`, `reference += ":REVERSED"`, note appended; an already-applied advance
  (`balance !== amount`) throws instead of being silently reversed. Reconciliation queries add
  `NOT: { reference: { endsWith: ":REVERSED" } }`. `reopenStop` blocks on an unreversed advance.
- Invariants: the money write stays inside `voidPayment`'s transaction (L-081); advances applied to
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
  stop, or a stop/run mismatch; the link block uses the resolved run id.
- Invariants: OPERATOR/CUSTOMER paths byte-identical; a rejected link creates no order.

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

- approach-rotation hook resolves its state file relative to cwd (`apps/api/.claude/pipeline/approach-rotation.json` written from a drifted cwd) — same class as the BUGS_ROOT trap (B278).
- Returns credit total (`return/index.tsx` uses `sumStopOrders`, pre-tax) — decide whether return credits should carry tax; out of F38's scope.

## Status

- 2026-09-13 06:1xZ: all five fixes committed (ce3c1373 B306 · 0510a3f3 B309 · 939f6246 B305 api · c52b0d0b B305 mobile · 2ac0ade3 B307/B308); Opus refute-first review and revert probes in progress; push waits for the verify slot.
