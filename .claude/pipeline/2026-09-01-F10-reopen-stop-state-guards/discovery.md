# Discovery — F10: reopenStop and stop-state guards

**Status:** IMPLEMENTED (see spec.md / build-plan.md) · Batch F10 of the bug-register burn-down
campaign · board issue #523 · branch `fix/F10-reopen-stop-state-guards` (worktree
`.claude/worktrees/rf-F10`, cut from `master@df1ef9a3`).

## The problem, in the register's words

Six confirmed register bugs (B54, B55, B71, B72, B120, B121) cluster around one seam: the
delivery stop/run state machine in `apps/api/src/routes/routes.service.ts` mutates money-,
stock-, and compliance-bearing state without guarding **where the transition comes from** or
**who is making it**.

- **Whose problem:** every tenant running deliveries. Drivers and operators hit it weekly —
  every reopen of a delivered stop silently inflates inventory (B55); every reopen of a paid
  delivery strands a PAID invoice against an order the system then says was never delivered,
  and the re-delivery's second cash collection is unrecorded (B54). Any tenant driver can
  hijack another driver's run (B72); any in-tenant user can replace a completed regulated
  delivery's compliance signature months later (B121) or destroy its only evidence pointers
  with one reopen tap (B120). A COMPLETED stop can be PATCHed to SKIPPED, blinding the
  delivered-order demotion guard (B71).
- **Cost of shipping nothing:** inventory drifts upward permanently (uncosted positive SALE
  rows poison COGS), cash goes missing without a trace, and regulated-delivery evidence is
  falsifiable/destroyable — audit-failure territory for tobacco-class tenants.
- **Current workaround:** none that users can see. Operators discover stock drift at count
  time and cannot explain it; stranded invoices surface as unpaid-vs-paid disputes.
- **Success signal:** the six REG-B## jest specs pass; `campaign-check --batch F10` flips the
  six ledger rows to `done`; the D4 repair flight quantifies and repairs historical B55/B54
  damage post-deploy.

## Discovery verdicts (per the campaign plan — verified on `master@df1ef9a3`)

All six: **CONFIRMED on master@df1ef9a3, EVIDENCE MOVED to the line numbers below** (file is
now 2729 lines; hunt-round and re-anchor-log lines drifted after F05's G7 landed).

| ID | Verdict | Evidence on df1ef9a3 |
|----|---------|----------------------|
| B54 | CONFIRMED | `routes.service.ts:2600–2613` — reopen payment guard reads legacy `transaction.findMany`; repo-wide grep: **zero** `.transaction.create` writers in `apps/api/src`; the reopen tx (2615–2719) never references Invoice/InvoicePayment. Live writer is `InvoicePayment` via `recordDeliveryPaymentInTx` (`invoices.service.ts`, called from `completeWithPayment` step 4, routes.service.ts:2258). `CONFIRMED_PAYMENT = { status: "PAID" }` (`invoices/payment-predicates.ts:23`) is the house confirmed-money predicate, already imported by routes.service.ts. |
| B55 | CONFIRMED | `routes.service.ts:2645–2660` — positive `type:"SALE"` StockMovement + `currentStock: { increment: qty }` per DELIVERED/PARTIAL mutation. The ONLY two `type:"SALE"` StockMovement writers in the repo are these lines. `completeStop` (1911–2105) and `completeWithPayment` (2113–2330) write no stock. `orders.service.ts:4135` doc comment confirms: currentStock is settled at order time and re-settled only on item edit — delivery decrements nothing, so there is nothing to reverse. |
| B71 | CONFIRMED | `routes.service.ts:1680–1708` — updateStopStatus: driver-isolation check only, no from-state guard on stop or run; a COMPLETED stop PATCHes to SKIPPED. Demotion guard `orders.service.ts:2437` keys on `stop?.status === "COMPLETED"` and is then blind. Contrast reopenStop's own guard (2579–2582) and completeStop's (1937). |
| B72 | CONFIRMED | `routes.service.ts:1368–1431` — updateRunStatus: no driver row loaded, no `run.driverId` comparison, no from-state matrix (`dto/update-run-status.dto.ts` is a bare `@IsEnum`); COMPLETED→SCHEDULED and CANCELLED→IN_PROGRESS both pass. (Since the hunt round it HAS gained a stops-complete check and the B152 cash backstop for COMPLETED — those stay.) `completeStop` loads the caller's driver (1950–1953) but never compares to `run.driverId`; `completeWithPayment` identical (2159–2162). |
| B120 | CONFIRMED (was NO_TOKEN_UNVERIFIED — now verified) | `routes.service.ts:2683–2698` — reopen reset writes `signatureUrl: null`, `podPhotoUrls: []` with no archival; no `this.storage.delete` anywhere in the file; `getStopPod` (1870–1909) reads only those columns, so the stored artifacts become unreachable. |
| B121 | CONFIRMED (was NO_TOKEN_UNVERIFIED — now verified) | `routes.service.ts:1828–1863` — attachPodArtifact checks run/stop existence only; **takes no user param**; a new artifactId bypasses the idempotency match (1843–1853) and overwrites `signatureUrl` unconditionally (1860). Controller `routes.controller.ts:226–235`: `@Roles(OPERATOR, DRIVER)`, no `@CurrentUser`, no driver-run binding. |

## Client transition census (what the matrix must not break)

- Web sends **only `CANCELLED`** to `PATCH /route-runs/:id/status` (`routes/page.tsx:261`,
  `routes/[id]/page.tsx:623`, `routes/[id]/dispatch/page.tsx:200`).
- Mobile driver sends **`IN_PROGRESS`** (start run, `(driver)/route/index.tsx:194`) and
  **`COMPLETED`** (`:398`).
- Existing spec `routes.service.spec.ts:577` exercises operator SCHEDULED→COMPLETED (backfill
  flow) — must stay green. Hence the matrix is a **deny-list**, not a whitelist.

## Who else is affected that nobody asked

- The RF-016 auto-complete inside `completeStop`/`completeWithPayment` flips runs
  IN_PROGRESS→COMPLETED in their own tx (F05 lesson) — a legal transition; the new matrix
  lives on the updateRunStatus entry point and does not need to run there, but the
  **ownership** guard must cover both completion paths (it does — R5).
- The offline replay path (same-artifactId POD upload) must keep working — the idempotent
  branch returns before the new signature-immutability guard.

## Strongest hostile objection

"You're adding guards to a state machine with live traffic — you'll break a flow you didn't
census." Answer: the census above covers every client call site of the three endpoints
(grep'd web + mobile); the matrix is deny-list-minimal (exactly the two indefensible classes
from the register); every currently-green existing spec stays green except ones whose mocks
must now model the new collaborator reads, which are updated in the same PR.

## Why now

Campaign wave order: routes.service.ts lane is F02b → F05 → F10 → **F11 → F12 → F22+F24**;
F10 is next and F11 (CANCEL path, deleteRun settlement gates) builds on these guards.
