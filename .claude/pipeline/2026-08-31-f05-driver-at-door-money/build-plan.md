# F05 — build plan

**Status: APPROVED for execution** · worktree `.claude/worktrees/rf-F05`, branch
`fix/F05-driver-at-door-money-settlement` off `master 26037bd4` · dev-pipeline Workflow, scale
**major**. Money batch: close-out adds the standing **Fable adversarial pass over the final
diff** before the PR opens (house rule). Board #518 — PR body carries `Closes #518`.

## P1 — invoices region: excess → AdvancePayment (B83)

- **satisfies:** R4 · **provenBy:** T-B83
- **Files (owns exclusively):** `apps/api/src/invoices/invoices.service.ts` (**`:4491-4657`
  ONLY** — `updatePayment` starts `:4658`, hard boundary), `apps/api/src/invoices/invoices.service.spec.ts`
- Tail of `recordDeliveryPaymentInTx`: `excess = remaining` (already roundMoney'd — never
  re-derive as `amount - applied`); single-customer resolution from the loaded payable invoices,
  with a `tx.order.findMany` customerId fallback ONLY on the `:4576` zero-payable-invoice path
  (which today discards the whole amount — absorb it, don't early-return past the tail);
  multi-customer → no advance, warn stays with the caller. New trailing
  `context?: { runId?; stopId? }` param; reference token `RUN:<runId>:STOP:<stopId>` (load-bearing
  — P2's expected-cash helper matches its prefix). Return gains `excess`/`advancePaymentId`.
  Spec update: only the `:3753` residual case changes contract; new cases per T-B83.

## P2 — routes API: G7 select, DTO productId, settlement, backstops

- **satisfies:** R1 R3 R5 R6 R7 · **provenBy:** T-B49a T-B148a T-B148b T-B152a T-B152b T-B152c
  T-B152d · **dependsOn:** P1 (caller destructures the new return shape)
- **Files (owns exclusively):** `apps/api/src/routes/routes.service.ts`,
  `apps/api/src/routes/routes.controller.ts`, `apps/api/src/routes/dto/complete-stop.dto.ts`,
  `apps/api/src/routes/dto/settle-run.dto.ts` (new), `apps/api/src/routes/routes.service.spec.ts`,
  `apps/api/src/routes/dto/complete-stop.dto.spec.ts` (new)
- `RUN_LINE_ITEMS_SELECT` hoisted directly above `RUN_STOP_INCLUDE` with a G7 doc comment, spread
  into the const body and BOTH `findOneRun` copies (`:1139-1148`, `:1245-1254`); +`subtotal`,
  `boxes`, `pieces`, `unitsPerBox`. `RunDeliveryDto.productId` optional; both
  `deliveryMutation.create` sites persist it. `getRunCashCollections` private helper (imports
  `CONFIRMED_PAYMENT` from `invoices/payment-predicates`); `collectedPayments` on `findOneRun`
  always + driver-scoped `findAllRuns`/`findMyRuns` (batched). `POST :id/settlement` +
  `SettleRunDto` + `settleRun` (ownership per `updateRun :1282-1291`; server-computed expected;
  reason on `|variance| > 0.01`; formatted `settlementNote` + `settlementVariance`).
  `updateRunStatus` COMPLETED backstop after the incomplete-stops guard; RF-016 auto-complete
  gate in `completeStop` (`:1744-1757`) AND `completeWithPayment` (`:1965-1979`). Caller warn
  block (`:1944-1963`) → booked-advance log + additive response fields.

## P3 — mobile: run-money, server-truth settlement gate, screens

- **satisfies:** R2 R8 R11 · **provenBy:** T-B49m T-B152m · **dependsOn:** P2 (payload contract)
- **Files (owns exclusively):** `apps/mobile/lib/run-money.ts` (new),
  `apps/mobile/lib/run-settlement.ts`, `apps/mobile/lib/api/routes.ts`,
  `apps/mobile/app/(driver)/route/index.tsx`, `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`,
  `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx`,
  `apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx`,
  `apps/mobile/app/(driver)/route/settlement.tsx`, `apps/mobile/store/runSettlementStore.ts`,
  `apps/mobile/__tests__/run-money.test.ts` (new), `apps/mobile/__tests__/run-settlement.test.ts`
- Types additive (`RouteRunOrderItem` money fields as `number | string | null`; `RouteRun` gains
  notes/settlement/collectedPayments; new `useSettleRun`). Four `qty*unitPrice` reducers →
  run-money sums. Gate → `shouldForceSettlement(run)` OR store signal. `settlement.tsx`: expected
  from server payload (store fallback), `useSettleRun` then COMPLETED; delete the notes-append
  PATCH + `notesAppendedRef` + `(run as any).notes`. Store file itself: doc-comment update only
  (no longer the gate; still the per-device echo).

## P4 — web: settlement read surface + registered e2e (B167)

- **satisfies:** R9 R10 R11 · **provenBy:** T-B167 · **dependsOn:** P2
- **Files (owns exclusively):** `apps/web/lib/api/routes.ts`,
  `apps/web/app/(dashboard)/routes/[id]/page.tsx`, `apps/web/e2e/23-run-settlement-note.spec.ts`
  (new), `apps/web/playwright.config.ts`
- Read-only Settlement card for every status (note text, signed variance badge, legacy
  `run.notes` when present). e2e seeds via `e2e/helpers/api.ts` on `e2e-routeflow`, settles with
  variance+reason, completes, asserts visibility on the detail page. `projects[]` entry
  `run-settlement` patterned on `payment-truth` (`:317-330`) incl. the "WITHOUT THIS ENTRY THE
  SPEC NEVER RUNS" comment.

## Pipeline args

`scale: 'major'` · workdir `.claude/worktrees/rf-F05` · testPackages TP1 (api:
routes.service.spec additions + complete-stop.dto.spec + invoices.service.spec additions) and
TP2 (mobile: run-money.test + run-settlement.test additions); TP3 (web e2e spec) is AUTHORED in
P4 but excluded from the red gate (T2, post-deploy discharge — `npx playwright test --list`
proves registration instead) · redGate `-t "REG-B(49|83|148|152|167)"` in both jest homes,
expect fail · verify perRound: api `npx tsc -p tsconfig.build.json`; final: api jest (JSON
artifact), mobile jest (JSON artifact), web `npx tsc --noEmit`, mobile tsc,
`cd apps/web && npx playwright test --list` (project `run-settlement` resolves),
`node scripts/campaign-check.mjs --batch F05`. Mutation targets: drop a field from
`RUN_LINE_ITEMS_SELECT` (T-B49a red); revert the P1 tail to discard `remaining` (T-B83 red);
remove `productId` from `RunDeliveryDto` (T-B148a red); remove the `updateRunStatus` backstop
(T-B152c red); remove the RF-016 gate from ONE flow (T-B152d red); `run-money` body →
`qty*unitPrice` (T-B49m red) — each against its `-t` scope. uiVerify: B167 card on the local
stack (db:up + api dist + web dev) if practical, else defer the screenshot to the post-deploy
e2e run and attach that to the PR thread — decided at the UI-verify phase, recorded either way.

## ⚠️ Campaign-wide trap found at close-out: `playwright test --list` POISONS the e2e artifact

`apps/web/playwright.config.ts` emits a JSON reporter to `.campaign/runs/web-e2e.json`, and
**`--list` writes that file too** — as an all-skipped report (`expected: 0, skipped: 134`). Since
`campaign-check` reads that artifact for every T2 row claiming `done`, a bare
`npx playwright test --list` makes the WHOLE-LEDGER check fail on batches that have nothing to do
with the current one (here: F02b's B24/B130/B154, discharged weeks ago against the deployed
build). It is not a regression and the fix is not to touch those rows.

**Always run `npx playwright test --list --reporter=list`** — the CLI flag overrides the config's
reporters, proves the project entry resolves, and leaves the artifact alone. If a bare `--list`
already ran, delete `.campaign/runs/web-e2e.json` (gitignored, local-only) before pushing — the
pre-push hook runs `npm run verify`, which ends in the whole-ledger `campaign-check`.

## Red-gate remediation notes (carry into P2/P3/P4)

- **Signature-only stubs MUST be replaced, never shipped.** Three stubs exist purely so the
  red-gate tests fail on assertions instead of missing-symbol errors:
  `RoutesService.settleRun` (`routes.service.ts`, returns `{}`) → **P2**;
  `lineItemSubtotal` / `sumOrderLineItems` / `sumStopOrders` (`apps/mobile/lib/run-money.ts`,
  return `undefined`) and `shouldForceSettlement` (`apps/mobile/lib/run-settlement.ts`, returns
  `undefined`) → **P3**. Every one of them typechecks clean, so nothing in the repo will catch a
  forgotten stub: a leftover `run-money` stub ships NaN driver totals and a leftover
  `shouldForceSettlement` ships a settlement gate that is permanently falsy (silently never
  fires). Grep for `STUB —` in `apps/api/src/routes` and `apps/mobile/lib` before the close-out.
- **R1's only content oracle is one test.** `routes.service.spec.ts`'s
  `REG-B49: carries subtotal/boxes/pieces/unitsPerBox…` (`toEqual`) is the sole assertion that
  inspects `RUN_LINE_ITEMS_SELECT`'s FIELDS; the three sibling tests assert `toBe` identity only
  and would pass against any shared object. Do not delete or relax it.
- **`apps/api/tsconfig.json` excludes `**/*.spec.ts`**, so `npx tsc --noEmit` cannot catch a
  misspelled import in an API spec (a bad named import silently resolves to `undefined`). Treat
  jest — not tsc — as the only gate on API spec imports.
- **Settlement cash basis is pinned to `CONFIRMED_PAYMENT`** (F03's shared predicate), imported
  by the T-B152a where-args assertion rather than restating `status: "PAID"`. Keep it imported in
  the implementation too.

## Manual verification

(none — 4×T1 + 1×T2)

## Close-out checklist

1. **Fable adversarial pass over the money diff** (P1 + P2 backstops + the four mobile money
   sites).
2. Ledger `F05.jsonl`: B49/B83/B148/B152 → `proven` (jest JSON artifacts), B167 →
   `proven-pending-deploy`; `pr`/`proof`/`buildPlan` fields set.
3. `campaign-check --batch F05` green · code map (api.md routes block ~508-514 incl. the
   `recordDeliveryPaymentInTx` and DriverPaymentsGuard entries, mobile.md (driver) block +
   Routes row, web routes entry) · CHANGELOG bullet (re-append anchor) · `_meta.json` mappedSha
   bump + notes REPLACED · HANDOFF: replace the stale owner-pause banner (owner dispatched F05 —
   the resume instruction), prepend `## ✅ SHIPPED`, update the campaign line.
4. Register chips + republish `310ae33a…`; guide driver articles → flag to owner (shared
   artifact). Note the F10 interplay (post-reopen re-collection books the full second amount as
   an advance) on F10's card.
5. Merge window: public → CI verify green → squash → Railway `BUILDING` wait per service →
   private (read back) → `post-deploy-check` + `feature-smoke`; deploy-signal e2e discharges
   B167 → `done` (stamp rides the next batch's PR).
