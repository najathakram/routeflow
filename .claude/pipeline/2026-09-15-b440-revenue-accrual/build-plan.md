# Build plan: B440 / B455 / B456 — revenue = accrual net sales

> **Stage S5 — "how".** Transcribed by Sonnet @ medium on 2026-09-15 from Fable's S3 ruling
> (`cause-ruling.md`) and S4 test plan (`bug-test-plan.md`), both in this directory. This is
> transcription, not planning — every task-graph decision here traces to those two artifacts or
> to a fact verified directly against the repo/engine source on 2026-09-15 (cited inline as
> "verified"); nothing was invented. Genuinely open items are called out in **Open questions**,
> not guessed.
> Status: `DRAFT`
> Tree: branch `fix/B440-revenue-accrual` @ `7b8bf085`, worktree
> `C:/ClaudeCode/routeflow/.claude/worktrees/rf-B440`. Line numbers cited below were re-verified
> against this exact commit on 2026-09-15 and hold byte-for-byte; re-anchor by content if a later
> commit shifts them (cause-ruling.md's own instruction).
> This file is the ONLY context the pipeline's agents receive. `mode: 'bugfix'`, `scale: 'major'`.

**Gate to pass before S6:** every fix task's `dependsOn` chain reaches a `root-cause` AND a
`repro-test`; every `revert-probe` depends on its `fix`; no two tasks share a file without a
`dependsOn` path between them. Verified below (see **Task graph correctness**).

---

## Objective

`getSummary`, `getProfitAndLoss`, `getMobileDashboard`, `getFinanceDashboard`,
`getSalesByCustomer` and `getBadDebtsReport` in `apps/api/src/bookkeeping/bookkeeping.service.ts`
report revenue/sales on a cash-and-gross basis (`status:PAID`+`paidAt`, no credit-note or
external-refund netting) instead of accrual net sales (issued, non-void/draft, net of credit
notes and external refunds) — B440. A settled-by-return-credit-note invoice counts as full
revenue (B440's own filed symptom) and `Return.refundAmount` for `EXTERNAL_REFUND` returns is
persisted correctly but read by nothing (B455). Once the revenue predicate is widened to include
`WRITTEN_OFF` invoices (required to fix B440), a write-off must also appear as a bad-debt expense
or profit is overstated — today this is not a live defect (PAID-filter and
cannot-write-off-a-PAID-invoice are mutually exclusive by construction) but becomes one the
instant B440 lands (B456).

**In scope:** one new predicate + three helper functions in `apps/api/src/common/invoiced-sales.ts`
(F1); re-sourcing the six read sites above onto them (F2/F3); the bad-debt expense line that ships
in the same diff as the revenue-basis change (D4); regression tests T1-T12; registry/lessons/
code-map bookkeeping for B440/B455/B456 only.

**AMENDMENT 2026-09-15 (owner ruling, post-S5, before S6):** revenue excludes sales tax collected
— standard accounting. `gross = invoice.total − invoice.taxAmount` (shipping and discount stay IN
revenue; only tax comes out). `Invoice.taxAmount` already folds in category/excise tax
(`taxAmount = regularTax + categoryTax`, verified across 4+ computation sites in
`invoices.service.ts`), so one subtraction excludes both — no separate category-tax term needed.
Every "Revenue"/"Sales" figure this run touches (P&L, dashboard, Sales-by-Customer) is therefore
**pre-tax** — state this explicitly in the PR body and keep Playwright proof fixtures consistent
with it. `CreditNote` has no `taxAmount` column yet (a future lane adds one); PR1 subtracts
`amount` as-is, with a code comment marking the future change point — see FIX1 and T12 below.
`externalRefunds` needs no change (already pre-tax; `priceReturn` uses `subtotal` only, verified
by the minter). **Do not add a `feeForPaymentId` clause** — a different, later lane owns that.

**Explicitly out of scope:** B448-B458 (separate filed bugs — DOCS1 must not touch their registry
rows); FU-1 (EXTERNAL_REFUND pricing basis), FU-2 (units/COGS not netted for returns), FU-3
(analytics.service.ts cash-basis revenue series), FU-4 (stale period snapshots) — all filed by the
lead per cause-ruling.md §8, not fixed here; any change to
`credit-notes.service.ts:605-608`, `returns.service.ts`, `invoices.service.ts:5415`/`:5527-5559`,
or the four cash readers (`getCashFlow` :49, `analytics.service.ts` :655,
`buyer/statement.service.ts` :103, `customers.service.ts` :1698) — these are refuted-cause /
must-not-change anchors (cause-ruling.md §1, §4).

---

## Constraints & conventions

- **Stack:** NestJS 11 / Prisma 7 / Jest, `apps/api` workspace only — nothing here touches
  `apps/web`/`apps/mobile`/`packages/*` (verified: `getProfitAndLoss`/`getSummary`/
  `getMobileDashboard`/`getFinanceDashboard`/`getSalesByCustomer`/`getBadDebtsReport` all return
  inferred, ad-hoc object shapes — `grep -r` for these names across `packages/types/api/*.ts`
  returns zero hits, so no shared DTO gains a field and no cross-workspace typecheck is needed).
- **Test runner:** Jest, `*.spec.ts` beside the source file. `apps/api/src/common/invoiced-sales.spec.ts`
  and `apps/api/src/bookkeeping/bookkeeping.service.spec.ts` both **already exist** — every RT
  task extends them in place, never creates a new file.
- **Existing pattern to copy:** `fetchInvoicedSaleLines` in `apps/api/src/common/invoiced-sales.ts`
  (client/arg conventions: `db: InvoicedSalesDb`, `opts: {from,to,dateBasis,status?}`) — F1's new
  helpers mirror its shape.
- **Money discipline:** every component of `net` is `roundMoney`'d individually before combining
  (repo convention, `@routeflow/pricing`); never re-derive a total from raw Prisma output without it.
- **Must NOT change** (refuted-cause / cash-basis anchors — a reviewer finding a diff touching
  these is a blocker): `credit-notes.service.ts:605-608` (paidAt stamp on payment application);
  `returns.service.ts` (0 lines — B455 is a pure read-side gap); `invoices.service.ts:5415`/
  `:5527-5559`; `getCashFlow` (:49), `analytics.service.ts:655`, `buyer/statement.service.ts:103`,
  `customers.service.ts:1698` (the four legitimate cash consumers of `paidAt`);
  `getMobileDashboard.totalCollected`/`totalInvoiced` (:1180-1187, :1214, `RECEIVED_METHOD_FILTER`);
  `REAL_INVOICE_STATUSES` and every existing consumer (units/COGS predicate, correctly excludes
  `WRITTEN_OFF`, byte-identical); finance-dashboard `receipts` lines (B421, byte-identical).
- **Landmine:** `bookkeeping.service.spec.ts` and `invoiced-sales.spec.ts` are each written to by
  TWO different repro-test tasks in this plan (RT2+RT3 share the former) — see **Task graph
  correctness** for how that's serialized.

---

## Task graph correctness (mechanically checked before launch by `validateTasks`)

- Every `fix` (FIX1/FIX2/FIX3) depends, directly or transitively, on `RC1` (root-cause) and its
  own repro-test (RT1/RT2/RT3 respectively). ✓
- Every `revert-probe` (P1-P11) depends on the `fix` it probes (P1-P4,P11→FIX1, P5-P7→FIX2,
  P8-P10→FIX3). ✓ Probes run strictly sequentially regardless (SKILL.md's A10 phase excludes
  `revert-probe` tasks from the parallel wave graph entirely — verified in `pipeline.js`), so P1-P4
  and P5-P10 sharing files with each other inside their own group is a non-issue.
- **File-sharing pairs and how each is resolved:**
  - `invoiced-sales.ts`: only FIX1 owns it. No conflict.
  - `bookkeeping.service.ts`: FIX2 and FIX3 both own it → **FIX3 depends on FIX2** (matches the
    proposal; F3's sites (:1223-1225, :1286-1375, :1468-1504) are textually disjoint from F2's
    (:985-1028, :1093-1096, :1665-1698) but the file is shared, so ordering is mandatory, not
    optional).
  - `bookkeeping.service.spec.ts`: **RT2 and RT3 both own it** (the proposal did not carry a
    `dependsOn` edge between them — a real gap, not a stated decision). Fixed here: **RT3 depends
    on RT2**, mirroring the FIX2→FIX3 ordering it feeds. `invoiced-sales.spec.ts` is owned only by
    RT1 — no conflict there.
  - `credit-notes.service.spec.ts` (pin P-c) and `.claude/lessons/LESSONS.md`/code-map files
    (DOCS1) are owned by exactly one task each. No conflict.

---

## Task summary (19 tasks: 1 root-cause, 3 repro-test, 3 fix, 11 revert-probe, 1 docs)

Authoritative detail (files/tests/dependsOn/brief) is the `### <id>` heading for each task below —
**this is what the engine's `task-brief.mjs` actually slices and hands to every agent** (see
**Engine-mechanics findings**). The `## Pipeline args` JS block's own `brief` strings are a
secondary, human-skimmable summary only.

- **RC1** (root-cause) — confirm the B440/B455/B456 verdict still holds on `7b8bf085`.
- **RT1** (repro-test) — `invoiced-sales.spec.ts`: T1, T2, T3, T7.
- **RT2** (repro-test) — `bookkeeping.service.spec.ts`: T4, T5, T6, T11 (getSummary/P&L/bad-debt).
- **RT3** (repro-test, after RT2) — `bookkeeping.service.spec.ts`: T8, T9, T10 (mobile/finance/by-customer) + pins P-a/P-b.
- **FIX1** — `common/invoiced-sales.ts`: `ACCRUAL_REVENUE_STATUSES` + the three fetch helpers.
- **FIX2** (after FIX1) — `bookkeeping.service.ts`: `getProfitAndLoss`, `getSummary`, `getBadDebtsReport`.
- **FIX3** (after FIX2) — `bookkeeping.service.ts`: `getMobileDashboard`, `getFinanceDashboard`, `getSalesByCustomer`.
- **P1-P4, P11** (revert-probe, after FIX1) — revert each of `invoiced-sales.ts`'s five behaviors
  (predicate, CN netting, refund netting, bad-debt basis, and — AMENDMENT 2026-09-15 — tax exclusion).
- **P5-P7** (revert-probe, after FIX2) — revert `getSummary`/P&L-revenue+COGS/bad-debt-term.
- **P8-P10** (revert-probe, after FIX3) — revert mobile/finance/by-customer sales expressions.
- **DOCS1** (docs, after all 11 probes) — code-map, lessons, registry proof lines.

---

## Engine-mechanics findings (verified 2026-09-15 against `pipeline.js` and the scripts — load-bearing, not cosmetic)

These correct or extend what this run's brief described, based on reading the actual scripts that
will execute, not just `SKILL.md`'s prose (which is stale in three places below):

1. **`task-brief.mjs` slices a `### <id>` markdown H3 heading from `build-plan.md` itself**
   (fence-aware — code fences are skipped when scanning for headings), default cap 16 KB, and
   _that_ file (`<runDir>/tasks/<id>/brief.md`) is what every implementer/root-cause/test-author/
   docs prompt is told to read. The JS `tasks[].brief` string is never read by any agent prompt —
   `pipeline.js` only ever hands agents the path to `brief.md`. `CFG.caps.briefBytes` (1536)
   exists as a config constant but is referenced nowhere else in `pipeline.js` — it is unenforced.
   **Consequence:** the real per-task detail (exact code, anchors) must live in this file's
   `### <id>` prose sections, not stuffed into the JS array. This build plan does both: full
   detail below, a short pointer-style `brief` string in the JS block.
2. **`review-pack.mjs`'s "Spec excerpt" section requires an exact `## Objective` (or `## Preamble`)
   and `## Acceptance criteria` H2 heading**, matched by `^##\s+Objective\s*$` — nothing else on
   the line. This file uses `## Objective` (not `## Preamble`) per `BUILD-PLAN.md`'s own rule that
   major/HIGH-risk work deletes the Preamble shortcut.
3. **`radius` on a task is `[before, after]` — two non-negative integers, context-line counts
   around each call-site hit `review-pack.mjs` finds automatically by grepping the repo for the
   diff's newly-exported symbols** (confirmed in `review-pack.mjs`'s own arg parser, which now
   _rejects_ a file-path-shaped `--radius` as a usage error, and in `pipeline.js`'s
   `radiusFlag` builder, which silently drops the flag unless `t.radius` is a 2-element numeric
   array). `SKILL.md`'s own inline example (`radius: ['<path>']`) and last week's F27-build
   precedent (which passed a 3-file array) both reflect a **now-superseded** scheme — replaying
   that precedent today would silently no-op the radius section, not fail. This plan uses the
   current, correct `[before, after]` shape.
4. **`revert-probe` tasks take singular `file: '<path>'` and `test: '<one command>'` fields — NOT
   plural `files`/`tests` arrays.** `pipeline.js`'s `revertProbePrompt`/`runRevertProbeTask`/the
   post-run digest collector all read `t.file`/`t.test` directly; a `files: []`/`tests: []` shape
   (as `SKILL.md`'s own inline `RP1` example shows) is simply never read for this task type. Each
   probe's `test` here is a single, directly-runnable jest command (using `-t` with a `|`
   alternation where cause-ruling.md §7 names two REG tokens for one probe), matching "run ONLY
   this, nothing else" in the engine's own probe prompt.

---

## Task detail

Everything an agent needs for its own task — nothing here says "as discussed" or points outside
this file.

### RC1 — Confirm the B440/B455/B456 cause verdict

- **type:** root-cause · **files:** none · **tests:** none · **dependsOn:** none · **risk:** HIGH

VERIFY (this is confirmation of already-thorough investigation, not fresh discovery — S1/S2 did
the work; cause-ruling.md §1 states the verdict) that the following still holds on HEAD
(`7b8bf085`), re-anchoring every citation by content if a line number has drifted:

**Two independent read-side defects in `apps/api/src/bookkeeping/bookkeeping.service.ts`, no
shared write-side cause.** Defect A (cash used as accrual): `getSummary` (~~:1093-1096) and
`getProfitAndLoss` revenue (~~:985-989)/COGS (~~:990-995) key on `status:PAID`+`paidAt` instead of
`issueDate`; `getMobileDashboard` (~~:1223-1225) literally sets `revenue`/`netIncome` from
`totalCollected`. `paidAt` itself is correct — it has 4 legitimate cash consumers (`getCashFlow`
~:49, `analytics.service.ts` ~:655, `buyer/statement.service.ts` ~:103, `customers.service.ts`
~:1698) that must NOT change. Defect B (gross, never net): no site subtracts `CreditNote`
amounts; no site reads `Return.refundAmount` for `EXTERNAL_REFUND` (B455 — `returns.service.ts`
persists it correctly at ~:712-720, it's simply unread); `getFinanceDashboard`/`getSalesByCustomer`
are accrual-correct on date/status but gross, and wrongly exclude `WRITTEN_OFF`. B456 is **not** a
live defect on HEAD (the `PAID` read filter and the write-side refusal to write off a `PAID`
invoice are mutually exclusive, so today's $0/$0 is internally consistent) — it becomes required
the instant Defect A's predicate is widened to include `WRITTEN_OFF` (ships in the same diff,
cause-ruling.md §2 D4). Refuted, must NOT be the cause and must NOT change:
`credit-notes.service.ts:605-608` (payment-application `paidAt` stamp); `REAL_INVOICE_STATUSES`
(units/COGS predicate, correctly excludes `WRITTEN_OFF`, not the revenue predicate);
`returns.service.ts:726-727` (0 lines change there).

Report `reproduced` and `causeConfirmed` true only if every fact above still holds; otherwise stop
and name exactly what diverged (never let a downstream `fix` task start on an unconfirmed cause).

### RT1 — Repro tests: the new helper (`invoiced-sales.spec.ts`)

- **type:** repro-test · **files:** none (repro-test owns no production files) · **tests:**
  `apps/api/src/common/invoiced-sales.spec.ts` · **dependsOn:** RC1 · **risk:** HIGH

Extend the existing `apps/api/src/common/invoiced-sales.spec.ts` in place (do not create a new
file). Add five new `describe`/`it` blocks proving T1, T2, T3, T7, T12 from `bug-test-plan.md` —
copy each test's Setup/Asserts/Fails-today column verbatim, do not invent a different oracle:

- **T1 `REG-B440-predicate`** — pure constant check, no DB stub: `ACCRUAL_REVENUE_STATUSES` deep-
  equals `{notIn:[DRAFT,VOID]}`; `REAL_INVOICE_STATUSES` still deep-equals
  `{notIn:[DRAFT,VOID,WRITTEN_OFF]}` (existing behavior, a pin not a new assertion). Fails today:
  `ACCRUAL_REVENUE_STATUSES` has no export from `./invoiced-sales`.
- **T2 `REG-B440-net`** — extend `stubDb()` (currently wires only `invoice`/`stockMovement`/
  `product`, :20-24) with `creditNote` and `return` models. Fixture: invoice `_sum.total`→500
  (window on `issueDate`), CreditNote sum→200 (window on `createdAt`, never `appliedAt`), Return
  sum (`refundMethod:"EXTERNAL_REFUND"`)→50. Assert the invoice query's `where` is exactly
  `{status: ACCRUAL_REVENUE_STATUSES, issueDate: window}` with no `paidAt` key anywhere; assert
  `fetchAccrualNetSales(...)` deep-equals `{gross:500, creditNotes:200, externalRefunds:50,
net:250}`. Fails today: `fetchAccrualNetSales` is not exported.
- **T3 `REG-B455-refund`** — two variants on the T2 stub: (a) no Return row → net 300; (b) Return
  row `{refundMethod:"EXTERNAL_REFUND", refundedAt: window, refundAmount:50}` → net 250. Assert the
  Return query's `where` is `{refundMethod:"EXTERNAL_REFUND", refundedAt: window}`,
  `_sum:{refundAmount:true}`, and the value passes through unmodified (no re-pricing).
- **T7 `REG-B456-basis`** — new describe: a WRITTEN_OFF invoice, was PARTIAL before write-off
  (total 500, confirmed payments 150, credits applied 50 → unpaid balance 300); `writtenOffAt` in
  window, `issueDate` outside it. Assert `fetchBadDebtExpense`'s query keys on
  `{status: WRITTEN_OFF, writtenOffAt: window}` — never `issueDate` — and returns 300 (Invoice has
  no persisted balance column per `finance.prisma`, so this is a derived total/paid/credits sum).

- **T12 `REG-B440-tax` (AMENDMENT 2026-09-15)** — own dedicated fixture, does not reuse T2's
  500/200/50/250 sentinels (T4-T11 chain off those): invoice `subtotal` 400, `discount` 20,
  `shippingFee` 15, `regularTax` 20, `categoryTax` 30 → `taxAmount` 50 → `total` 445. Assert
  `fetchAccrualNetSales(...).gross === 395` (`= total − taxAmount = subtotal − discount +
shippingFee`, proving BOTH regular and category tax are excluded via the one `taxAmount`
  subtraction, and that shipping/discount stay IN `gross`). Fails today (before this amendment):
  `gross` would be 445 (full `total`, tax included).

**Note (harness, bug-test-plan.md):** `Return.refundMethod` is a plain `String?`
(`sales.prisma`) — use the literal `"EXTERNAL_REFUND"`, never an enum member.

### RT2 — Repro tests: getSummary / getProfitAndLoss / getBadDebtsReport (`bookkeeping.service.spec.ts`)

- **type:** repro-test · **files:** none · **tests:** `apps/api/src/bookkeeping/bookkeeping.service.spec.ts`
  · **dependsOn:** RC1 · **risk:** HIGH

Extend `bookkeeping.service.spec.ts` in place. This task and RT3 **share this one file** — RT3
depends on this task; do not touch anything inside `describe("REG-B11 ...")` (:656) or the
`getFinanceDashboard`/`getSalesByCustomer`/mobile describes — those are RT3's.

- **T4 `REG-B440-summary`** — rebase `describe("getSummary")`'s "should return aggregated
  financial summary" (:262-278): swap the blanket 5000 `invoice.aggregate` mock for the T2 fixture
  (gross 500/CN 200/refund 50); `invoicePayment.aggregate`/`invoice.count` fixtures unchanged.
  Assert `result.totalRevenue===250`, response also carries `grossRevenue:500, creditNotes:200,
externalRefunds:50`, helper called with the request's own window, no `invoice.aggregate` call
  carries `paidAt`. **Same edit also updates** "should handle empty data gracefully" (:280-294,
  P-f in bug-test-plan.md — not a new REG, just keeping the all-zero fixture's shape in sync: it
  gains `grossRevenue:0, creditNotes:0, externalRefunds:0` alongside `totalRevenue:0`).
- **T5 `REG-B440-pnl`** — rebase "estimates COGS from the same PAID/paidAt invoice set as revenue"
  (:865-905, `describe("getProfitAndLoss")` starts :862): same COGS/expense fixture, revenue via
  the helper (500/200/50→250). Assert `result.revenue===250`; the `cogsFetch` call
  (`prisma.invoice.findMany.mock.calls[0][0]`) has `status:ACCRUAL_REVENUE_STATUSES`, `issueDate`
  window, and `.where.paidAt` is `undefined` — this INVERTS the existing pin at ~:898-903 (which
  asserted `status==="PAID"` + a `paidAt` window), it does not delete it.
- **T6 `REG-B456-baddebt`** — T5's fixture + expenses 40 (was 100) + a WRITTEN_OFF fixture (T7's,
  bad debt 300). Assert `result.badDebtExpense===300`, `result.netProfit===-90` (250−0−40−300),
  and `result.revenue` is unaffected by the bad-debt mock.
- **T11 `REG-B456-report`** — new `describe("getBadDebtsReport")` (zero existing coverage): using
  T6/T7's shared WRITTEN_OFF fixture and window, assert `getBadDebtsReport().total ===` the P&L's
  `badDebtExpense` (300) — a cross-method consistency guard, both must derive from the same
  `fetchBadDebtExpense` amount expression.

**Note (harness):** all 3 `getProfitAndLoss` tests (:865,:907,:935) and both `getSummary` tests
(:262,:281) set a blanket `prisma.invoice.aggregate.mockResolvedValue(...)` that ignores `where` —
it still satisfies the post-fix `invoice.aggregate` call, but the new `creditNote`/`return` reads
fall through to the mock factory's `_sum:{}` default unless T4/T5/T6 explicitly mock them too.
P&L tests 2/3 (:907,:935) assert only `cogs`, never `revenue` — no edit needed there as long as
the helper reads `_sum.x ?? 0` defensively.

### RT3 — Repro tests: mobile / finance / by-customer (`bookkeeping.service.spec.ts`)

- **type:** repro-test · **files:** none · **tests:** `apps/api/src/bookkeeping/bookkeeping.service.spec.ts`
  · **dependsOn:** RC1, RT2 (same file — RT2 lands first) · **risk:** HIGH

- **T8 `REG-B440-mobile`** — new test, own fixture (not REG-B11's $200/$300/$800): helper→net
  250; `paymentAgg`→collected 100; expenses 40; bad debt 300. Assert `revenue===250`,
  `netIncome===250-40-300`, `totalCollected===100`, `revenue!==totalCollected`.
- **T9 `REG-B440-finance`** — extend the :760-786 fixtures so the monthly-bucket loop and every
  `summaryTable.*` figure source `sales` from the helper's per-bucket `net` (one call per bucket).
  Assert `totalSales`, each bucket's `sales`, and every `summaryTable.<period>.sales` equal that
  bucket's `net`; no inline `notIn:[DRAFT,VOID,WRITTEN_OFF]` sales aggregate remains; existing
  receipts assertions (:756-757, :761-786) stay untouched (B421, byte-identical).
- **T10 `REG-B440-bycustomer`** — new `describe("getSalesByCustomer")` (zero existing coverage):
  one normal customer (net 250), one CN-only customer (gross 0, CN 200 → net −200). Assert
  `salesAmount` equals the by-customer map's `net`; the CN-only customer's `salesAmount===-200`
  (negative net is legitimate, never clamped).
- **Pin P-a** — inside `describe('REG-B11 ...')` (:656): remove `expect(result.revenue).toBe(200)`
  (:724) from the existing mobile test — that assertion's replacement now lives in T8. Leave every
  `totalCollected` assertion in that describe byte-identical.
- **Pin P-b** — the REG-B421 test (:727-758): remove `expect(dashboard.revenue).toBe(250)` (:750)
  — replaced by T9. Leave `totalCollected`/`paymentsThisWeek`/finance-receipts assertions
  (:748-749, :756-757) byte-identical.

**Note (harness):** `getFinanceDashboard`'s per-bucket calls (12 months + 5 summary periods) need
a constant `mockResolvedValue`, not `Once`.

### FIX1 — `apps/api/src/common/invoiced-sales.ts`: the accrual-net-sales helper

- **type:** fix · **files:** `apps/api/src/common/invoiced-sales.ts` · **dependsOn:** RC1, RT1 ·
  **risk:** HIGH · **effort:** high · **radius:** `[3, 3]`

**Radius reasoning:** this task's new exports (`ACCRUAL_REVENUE_STATUSES`,
`fetchAccrualNetSales`, `fetchAccrualNetSalesByCustomer`, `fetchBadDebtExpense`) are what
`review-pack.mjs` will find call sites for once FIX2/FIX3 land — each call site is expected to be
a short one-line const assignment or destructure (mirroring how `fetchInvoicedSaleLines` is
already called in this file). 3 lines before/after is enough to see the assignment and its
immediate statement without pulling in the surrounding 20-line dashboard method; cause-ruling.md
§4 already names the exact line ranges that must change, so a wide radius adds noise, not signal.

**Exact shapes (cause-ruling.md §2, "F1" — transplant, do not reinvent):**

```ts
export const ACCRUAL_REVENUE_STATUSES = {
  notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID],
} as const;
// revenue/net-sales predicate -- WRITTEN_OFF *is* revenue at issue (bad debt is a later expense);
// REAL_INVOICE_STATUSES is the units/COGS-lines predicate and is unchanged.

export type AccrualNetSales = {
  gross: number;
  creditNotes: number;
  externalRefunds: number;
  net: number;
};
export async function fetchAccrualNetSales(
  prisma,
  tenantId: string,
  window: { gte: Date; lte: Date },
  opts?: { customerId?: string },
): Promise<AccrualNetSales>;
export async function fetchAccrualNetSalesByCustomer(
  prisma,
  tenantId,
  window,
): Promise<Map<string, AccrualNetSales>>;
export async function fetchBadDebtExpense(prisma, tenantId, window): Promise<number>;
```

Place `ACCRUAL_REVENUE_STATUSES` directly below `REAL_INVOICE_STATUSES` (:39-41) — same file, so
the two predicates and their difference live in one place. `REAL_INVOICE_STATUSES` and every
current consumer of it stay byte-identical.

- **AMENDMENT 2026-09-15 — `gross` excludes sales tax:** `gross = roundMoney(sumTotal −
sumTaxAmount)`, from ONE `invoice.aggregate` call reading both `_sum.total` AND `_sum.taxAmount`
  where `{tenantId, status: ACCRUAL_REVENUE_STATUSES, issueDate: window}` — **no `paidAt` key
  anywhere in this helper.** `Invoice.taxAmount` already includes category/excise tax
  (`taxAmount = regularTax + categoryTax`, verified across `invoices.service.ts`'s single-invoice
  create ~:527-533, order-driven reconcile ~:1550-1564, multi-invoice split ~:1272-1278, edit
  ~:3543-3549, partial-bill drafts ~:1985-1990 — every path folds category tax into `taxAmount`
  before computing `total`), so this one subtraction excludes both; do not add a second term for
  category tax. Shipping and discount stay IN `gross` (only tax is removed).
- `creditNotes` = CreditNote amount summed where `createdAt: window` (the CN's own date;
  `appliedAt` is a settlement event — the same trap as `paidAt` — never used). Include both
  applied and unapplied CNs; exclude a VOID/DRAFT-like CN status if the model has one.
  **AMENDMENT 2026-09-15 — subtract `amount` as-is (CreditNote has no `taxAmount` column today,
  verified `finance.prisma:470-503`).** Add this exact comment at the subtraction site: `// TODO
B459 (returns-in-orders lane): once CreditNote.taxAmount ships, subtract (amount - taxAmount)
here instead of amount.` Do not add the column yourself. **PR-body note (verified against
  `apps/web/app/(dashboard)/credit-notes/page.tsx`):** a line-based manual credit is pre-tax (UI
  prefills/caps each line at `InvoiceItem.subtotal`, :152-157/:172-174); a freeform/lump-sum credit
  (no line selected) is a bare operator-typed number with no cap or validation against any invoice
  figure (:447-454) — it MAY include tax in practice, and PR1 cannot detect or correct that. State
  this as a known imprecision that closes with B459, not a PR1 blocker.
- `externalRefunds` = `Return` `_sum.refundAmount` where `{refundMethod: EXTERNAL_REFUND,
refundedAt: window}`. The `refundMethod` filter is load-bearing — CN-method returns are already
  netted via their CreditNote. **No change needed (2026-09-15 amendment): already pre-tax —
  `priceReturn` prices from `subtotal` only, verified on master by the minter.**
- `net = roundMoney(gross − creditNotes − externalRefunds)`, every component `roundMoney`'d.
  Negative net is legitimate (CN-heavy period) — never clamp. **`gross` here is the amended
  (pre-tax) figure above — `net` itself is unaffected by the amendment except through `gross`.**
- **Do NOT add a `feeForPaymentId` clause (2026-09-15 amendment)** — that column doesn't exist; a
  later check-payments lane adds a returned-check-fee exclusion to this same helper. Out of scope.
- `ByCustomer`: three `groupBy customerId` reads → map; derive `customerId` through the invoice/
  order relation if CreditNote/Return lack it directly. Rows = union of customers across all
  three reads.
- `fetchBadDebtExpense` = sum over `{status: WRITTEN_OFF, writtenOffAt: window}` of the **unpaid
  balance at write-off** — use a persisted balance column if `Invoice` has one, else
  `total − amountPaid − creditsApplied`. Extract this amount expression out of the current
  `getBadDebtsReport()` (~:1665-1698 on HEAD) so the report and the P&L share ONE expression.
- `fetchInvoicedSaleLines`'s `status` option currently only accepts `InvoiceStatus |
typeof REAL_INVOICE_STATUSES` (verified on HEAD, ~:87) — widen it to a general Prisma status
  filter so FIX2's COGS call can pass `ACCRUAL_REVENUE_STATUSES`. No other change to that function.
- Header comment (~:28-30, verified byte-identical to cause-ruling.md's citation): keep "returns /
  credit notes are not netted out of units or COGS" (still true, deliberate — FU-2) and add "net
  sales: see `fetchAccrualNetSales`".

### FIX2 — `bookkeeping.service.ts`: getProfitAndLoss / getSummary / getBadDebtsReport

- **type:** fix · **files:** `apps/api/src/bookkeeping/bookkeeping.service.ts` · **dependsOn:**
  RC1, RT2, FIX1 · **risk:** HIGH · **effort:** high · **radius:** `[3, 3]`

**Radius reasoning:** this task consumes FIX1's exports but is unlikely to introduce any _new_
top-level export of its own (it's a NestJS service method body) — `review-pack.mjs`'s Radius
section will likely read "(no new exported symbols in the diff)" for this task, which is fine; a
tight `[3,3]` costs nothing extra and stays consistent with FIX1/FIX3.

**Anchors — must NOT change (cause-ruling.md §4):** `:238` payment-path `paidAt` stamp; `:49`
`getCashFlow`; every `invoicePayment` read; `credit-notes.service.ts:605-608` (different file,
covered by the pin at `credit-notes.service.spec.ts:393` in RT2/RT3's scope — do not touch).

- **Revenue** (~~:985-989) → `fetchAccrualNetSales(prisma, tenantId, window)`; `revenue = net`; add
  `grossRevenue`, `creditNotes`, `externalRefunds` to the return (additive — lets a reviewer check
  the identity from the response). **COGS** (~~:990-995) → same call's `dateBasis: "issueDate"`,
  `status: ACCRUAL_REVENUE_STATUSES` (one collection with revenue, L-119). Add
  `badDebtExpense = fetchBadDebtExpense(...)`; `netProfit = revenue − cogs − expenses −
badDebtExpense` (~:1019-1028). COGS stays gross of restocked returns (FU-2, deliberate).
- **getSummary** (~:1093-1096) → `totalRevenue = net` + the same three breakdown fields; if the
  method returns a net/profit figure, subtract `badDebtExpense` too.
- **getBadDebtsReport** (~:1665-1698) → totals via `fetchBadDebtExpense` (same window semantics —
  this method currently takes no `from`/`to` args at all; add a window parameter, or default it to
  the full-tenant-history equivalent your `fetchBadDebtExpense` call needs. T11 requires this
  total to equal the P&L's `badDebtExpense` for the SAME window).

### FIX3 — `bookkeeping.service.ts`: getMobileDashboard / getFinanceDashboard / getSalesByCustomer

- **type:** fix · **files:** `apps/api/src/bookkeeping/bookkeeping.service.ts` · **dependsOn:**
  RC1, RT3, FIX1, FIX2 (shares the file with FIX2 — must serialize after it) · **risk:** HIGH ·
  **effort:** high · **radius:** `[3, 3]`

**Anchors — must NOT change:** `:1180-1187` + `:1214` (mobile `totalCollected`/`totalInvoiced`,
`RECEIVED_METHOD_FILTER`); every `receipts`/`RECEIVED_METHOD_FILTER` line in the finance dashboard
(B421); CN ledger methods `:2090`/`:2167`.

- **Mobile** (~:1223-1225): `revenue = net`, `netIncome = net − <existing expense term> −
badDebtExpense`; `totalInvoiced`/`totalCollected` untouched; no new fields (mobile mirrors web
  later, not this diff).
- **Finance dashboard** (~:1286-1294, :1318, :1336-1375): every `sales`/`totalSales`/
  `summaryTable.*.sales` = the helper's per-bucket `net` (one call per bucket, `Promise.all`);
  delete the inline `notIn:[DRAFT,VOID,WRITTEN_OFF]` sales aggregates; top-level response gains
  `grossSales`, `creditNotes`, `externalRefunds`. `receipts` lines byte-identical.
- **By-customer** (~:1468-1504): `salesAmount = byCustomer.get(id).net`; delete the inline
  aggregate; no new per-row fields.

### P1 — revert-probe: `ACCRUAL_REVENUE_STATUSES` back to `REAL_INVOICE_STATUSES`'s contents

- **type:** revert-probe · **file:** `apps/api/src/common/invoiced-sales.ts` · **test:**
  `cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B440-predicate|REG-B440-net"`
  · **dependsOn:** FIX1 · **risk:** HIGH

Revert `ACCRUAL_REVENUE_STATUSES`'s literal contents to `REAL_INVOICE_STATUSES`'s
(`{notIn:[DRAFT,VOID,WRITTEN_OFF]}`). Must turn T1 red (deep-equal fails) and T2's where-shape
assertion red (cause-ruling.md §7). Must NOT be run alongside T3/T7 — this probe only runs the
two named tests.

### P2 — revert-probe: credit-note netting → 0

- **type:** revert-probe · **file:** `apps/api/src/common/invoiced-sales.ts` · **test:**
  `cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B440-net"` · **dependsOn:**
  FIX1 · **risk:** HIGH

Revert `fetchAccrualNetSales` so the CreditNote read always contributes 0 (skip the query, or
force the sum to 0). Must turn T2 red (net becomes 300, not 250).

### P3 — revert-probe: external-refund netting → 0 / drop the `refundMethod` filter

- **type:** revert-probe · **file:** `apps/api/src/common/invoiced-sales.ts` · **test:**
  `cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B455-refund"` ·
  **dependsOn:** FIX1 · **risk:** HIGH

Revert the Return read to always contribute 0 (or drop the `refundMethod:"EXTERNAL_REFUND"`
filter so a CN-method return would double-count). Must turn T3 red.

### P4 — revert-probe: bad-debt amount → gross `total` (ignore paid/credits)

- **type:** revert-probe · **file:** `apps/api/src/common/invoiced-sales.ts` · **test:**
  `cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B456-basis"` · **dependsOn:**
  FIX1 · **risk:** HIGH

Revert `fetchBadDebtExpense` to sum `total` directly (ignore `amountPaid`/`creditsApplied`). Must
turn T7 red (300 expected, gross 500 would be returned instead).

### P5 — revert-probe: `getSummary` back to the inline PAID/paidAt aggregate

- **type:** revert-probe · **file:** `apps/api/src/bookkeeping/bookkeeping.service.ts` ·
  **test:** `cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-summary"`
  · **dependsOn:** FIX2 · **risk:** HIGH

Revert `getSummary`'s revenue read to the original `status:PAID`+`paidAt` blanket aggregate. Must
turn T4 red. T5-T11 must stay green (proves the revert is scoped to `getSummary` only).

### P6 — revert-probe: P&L revenue + COGS back to the PAID/paidAt basis

- **type:** revert-probe · **file:** `apps/api/src/bookkeeping/bookkeeping.service.ts` ·
  **test:** `cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-pnl|REG-B456-baddebt"`
  · **dependsOn:** FIX2 · **risk:** HIGH

Revert P&L's revenue back to the inline aggregate and COGS back to `{status:PAID, dateBasis:
paidAt}`. Must turn T5 and T6 red. T4 must stay green.

### P7 — revert-probe: drop the `badDebtExpense` term from `netProfit`

- **type:** revert-probe · **file:** `apps/api/src/bookkeeping/bookkeeping.service.ts` ·
  **test:** `cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B456-baddebt|REG-B456-report"`
  · **dependsOn:** FIX2 · **risk:** HIGH

Revert `netProfit`'s formula to drop the `− badDebtExpense` term (or make `getBadDebtsReport`
return a total that no longer matches the P&L figure). Must turn T6 and T11 red. T5 must stay
green.

### P8 — revert-probe: mobile `revenue` back to `totalCollected`

- **type:** revert-probe · **file:** `apps/api/src/bookkeeping/bookkeeping.service.ts` ·
  **test:** `cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-mobile"`
  · **dependsOn:** FIX3 · **risk:** HIGH

Revert `getMobileDashboard.revenue` to `totalCollected`. Must turn T8 red. The REG-B11 pin
assertions must stay green (proves the split kept the cash pin intact).

### P9 — revert-probe: finance dashboard `sales` back to the inline gross aggregate

- **type:** revert-probe · **file:** `apps/api/src/bookkeeping/bookkeeping.service.ts` ·
  **test:** `cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-finance"`
  · **dependsOn:** FIX3 · **risk:** HIGH

Revert the finance-dashboard sales figures to the inline gross aggregate (WRITTEN_OFF excluded).
Must turn T9 red. Receipts assertions must stay green.

### P10 — revert-probe: by-customer `salesAmount` back to inline gross

- **type:** revert-probe · **file:** `apps/api/src/bookkeeping/bookkeeping.service.ts` ·
  **test:** `cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-bycustomer"`
  · **dependsOn:** FIX3 · **risk:** HIGH

Revert `getSalesByCustomer` to the inline gross `Number(inv.total)` sum. Must turn T10 red.

### P11 — revert-probe: `gross` back to full `total` (AMENDMENT 2026-09-15)

- **type:** revert-probe · **file:** `apps/api/src/common/invoiced-sales.ts` · **test:**
  `cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B440-tax"` · **dependsOn:**
  FIX1 · **risk:** HIGH

Revert `fetchAccrualNetSales` to drop the `− taxAmount` term (`gross = sumTotal` again). Must turn
T12 red (445 instead of 395). T2/T3/T7 must stay green (proves the tax exclusion is scoped to
`gross`'s own formula, not entangled with CN/refund/bad-debt netting).

### DOCS1 — Registry, lessons, code-map bookkeeping

- **type:** docs · **files:** `.claude/code-map/api/feature-modules-1.md`,
  `.claude/code-map/api/feature-modules-6.md`,
  `.claude/code-map/api/bootstrap-cross-cutting/bootstrap-and-money-pricing.md`,
  `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`, `.claude/campaign/bugs.jsonl` ·
  **tests:** none · **dependsOn:** P1, P2, P3, P4, P5, P6, P7, P8, P9, P10, P11

**Dependency reasoning:** depends on all 11 probes, not just the 3 fix tasks. Cause-ruling.md §7's
own words: "Harness-integrity: P5–P10 are what prove the helper mocks are not tautological — a
reverted site reads the blanket aggregate (500), never the mocked net (250)." Flipping the
registry to "fixed"/"proven" before that proof exists would be an unverified claim — the probes
(not merely green fix-task reviews) are this run's actual evidence that the new tests protect
against regression, so the registry write is the run's last step.

- **Code map:** update the existing `bookkeeping.service.ts` entries in `feature-modules-1.md`
  (~:155, lists `getSummary`/`getMobileDashboard`/`getFinanceDashboard`/`getBadDebtsReport`) and
  `feature-modules-6.md` (the `getProfitAndLoss` entry, which currently documents the 2026-07-31
  COGS re-sourcing) to describe the accrual-net-sales basis; add a short bullet to
  `bootstrap-cross-cutting/bootstrap-and-money-pricing.md` (already lists `common/invoiced-sales.ts`)
  naming the three new exports. Surgical edits only — do not regenerate either file.
- **Lessons:** read `.claude/lessons/_meta.json`'s `nextId` **fresh at the moment you write** (do
  not reuse the value read during S5 planning — other lanes may have landed commits since) and
  grep `LESSONS.md` to confirm that id doesn't already exist. Entry body (Symptom/Root
  cause/Lesson/Guard), Lesson line from cause-ruling.md §8 verbatim: "a figure's basis (cash vs
  accrual) is part of its name — a `revenue:` fed by a `*Collected` value is a labeling bug; a new
  P&L expense line ships with the revenue predicate that makes it necessary, never alone." Bump
  `_meta.json` and regenerate the digest (`node scripts/validate-lessons.mjs --digest`).
- **Registry:** B440 exists in `.claude/campaign/bugs.jsonl` today (`"register":"open"`,
  `location: apps/api/src/bookkeeping/bookkeeping.service.ts:1093-1095 getSummary()`) — mark it
  proven/proven-pending-deploy (per the bug-registry skill's own state rules for a test-proven,
  not-yet-merged fix) citing T1, T2, T4, T5, T8, T9, T10, T12 and this build-plan's path as evidence.
  **B455 and B456 do not exist in `bugs.jsonl` as of this writing — see Open questions.** Do NOT
  touch any B448-B458 row (separate, out-of-scope bugs).

---

## Acceptance criteria

1. `ACCRUAL_REVENUE_STATUSES` exported from `common/invoiced-sales.ts`, exactly
   `{notIn:[DRAFT,VOID]}`; `REAL_INVOICE_STATUSES` unchanged.
2. `fetchAccrualNetSales`/`fetchAccrualNetSalesByCustomer`/`fetchBadDebtExpense` exist, never key
   on `paidAt`, and `net = roundMoney(gross − creditNotes − externalRefunds)` with no clamping.
   `gross = roundMoney(sumTotal − sumTaxAmount)` (AMENDMENT 2026-09-15) — excludes both regular and
   category/excise tax via the one `taxAmount` subtraction; shipping/discount stay in `gross`.
3. `getSummary`, `getProfitAndLoss`, `getMobileDashboard`, `getFinanceDashboard`,
   `getSalesByCustomer` all report `net` (not gross, not cash) as their revenue/sales figure;
   `getProfitAndLoss`/`getMobileDashboard.netIncome`/`getSummary` (if net) subtract
   `badDebtExpense`; `getFinanceDashboard`/`getSalesByCustomer` do not (sales ≠ profit).
4. `getBadDebtsReport().total` equals the P&L's `badDebtExpense` for the same window.
5. Every cash-basis figure (`totalCollected`, `getCashFlow`, DSO, statements, customer balances)
   is byte-identical to before this change.
6. T1-T12 all fail on HEAD (`7b8bf085`) and pass after the fix; every named pin
   (REG-B11/REG-B421/credit-notes :393/getCashFlow :534-539) stays green throughout.
7. All 11 revert-probes catch their named regression and are provably restored afterward.
8. No schema/migration change anywhere in this batch (cause-ruling.md §6: no data repair needed) —
   including no new `CreditNote.taxAmount` column (AMENDMENT 2026-09-15: deferred to B459).
9. (AMENDMENT 2026-09-15) The PR body states plainly that "Revenue"/"Sales" figures are now
   pre-tax, and records the freeform-manual-credit tax-ambiguity as a known imprecision.

---

## Verification commands

**Scoped to `apps/api`** — all three fix tasks (and every test file) live in that one workspace;
verified no shared DTO in `packages/types/api/*` gains a field, so no `packages/types`/`apps/web`
typecheck is warranted (see **Constraints & conventions**).

Per round (cheap, after every task's implement/fix round):

```bash
npm run check-types -w apps/api
npm run lint -w apps/api
```

Final (once, deciding the result): the full `apps/api` suite, not a narrow file list — this diff
touches one shared service file with many describe blocks and many downstream readers
(`getCashFlow`, statements, customer balances, commission statements) that share the same Prisma
mock setup; a file-scoped final gate could hide a break in a describe block this run didn't
intend to touch, and there is no cross-workspace surface to also cover, so the full single-
workspace suite is affordable:

```bash
npm test -w apps/api
npm run check-types -w apps/api
npm run lint -w apps/api
```

Red-gate reference (not a `verifyCommands` entry — the engine's own per-task Red gate reads
`t.tests` directly; this is `bug-test-plan.md`'s own documented command, useful for a human
re-running the red set by hand):

```bash
cd apps/api && npx jest src/common/invoiced-sales.spec.ts src/bookkeeping/bookkeeping.service.spec.ts --runInBand -t "REG-B4(40|55|56)"
```

---

## Risks & rollback

| Risk                                                                                                                              | Likelihood                | Blast radius                                                                 | Mitigation                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A sixth revenue/sales site elsewhere in the repo shares the same cash-as-accrual or gross-not-net shape                           | medium                    | money report wrong elsewhere                                                 | `siblingPatterns` sweep (post-loop, `mode:'bugfix'`) — every hit is a filed owner-question (FU-3 candidate: `analytics.service.ts`), never fixed in this run (scope discipline, L-008) |
| `getBadDebtsReport` needs a new window parameter it didn't have before                                                            | low-medium                | callers of `getBadDebtsReport()` (report/controller) need a signature update | FIX2's own brief names this; T11 pins the P&L/report consistency; the controller call site is inside `apps/api` and covered by the full-suite final gate                               |
| Registry proof lines flipped before B455/B456 exist as filed rows                                                                 | low (raised, not guessed) | a `bugs.mjs` command referencing a nonexistent id fails loudly, not silently | DOCS1's brief explicitly defers this decision — see Open questions                                                                                                                     |
| (AMENDMENT 2026-09-15) A freeform/lump-sum manual credit note's `amount` may include tax (no UI cap ties it to an invoice figure) | low-medium, unmeasured    | net sales slightly over-subtracted for those specific credits until B459     | Documented as a known imprecision in the PR body, not fixed here (CreditNote has no `taxAmount` column to net against)                                                                 |

- **Rollback:** revert the diff (`FIX1`/`FIX2`/`FIX3`'s commits); no migration, no data repair
  (cause-ruling.md §6) — every figure is computed at read time from correctly persisted facts.
- **Deploy day:** existing rows need no backfill; the very next read of any of the six methods
  reports the corrected figure. No feature flag/entitlement gate involved.
- **Observability:** a P&L/summary/dashboard `revenue` figure that suddenly differs from
  `totalCollected` post-deploy is the expected, intended signal this fix landed — document this in
  the PR body so it isn't mistaken for a regression. **(AMENDMENT 2026-09-15)** the PR body must
  also state plainly that these figures are now pre-tax (exclude sales tax collected), and note the
  freeform-manual-credit tax-ambiguity above as a known imprecision, not a regression.

---

## Open questions (raised, not guessed)

1. **B455 and B456 are not yet rows in `.claude/campaign/bugs.jsonl`** (verified 2026-09-15 —
   only B440 is filed there; `grep -n "B455\|B456"` returns nothing). The cause-ruling and test
   plan use both ids throughout (`REG-B455-refund`, `REG-B456-baddebt`/`basis`/`report`) as if
   already registry rows. Per this project's standing rule ("file bugs only on a master-merged
   tree — `file` mints max+1 per branch"), this worktree (`fix/B440-revenue-accrual`, not master)
   is not a safe place to mint two new ids mid-run — a parallel lane could mint the same number.
   DOCS1's brief instructs it to re-check `bugs.jsonl` fresh at execution time and escalate to the
   lead/owner rather than minting B455/B456 itself if they still don't exist. Raising this rather
   than guessing a resolution.
2. **`getBadDebtsReport()`'s new window parameter** — cause-ruling.md §2 says "same window
   semantics" as `fetchBadDebtExpense`, but the method today takes no `from`/`to` args at all and
   its controller/caller signature isn't in either source artifact. FIX2's brief flags this as an
   implementation-time decision (default to a sensible full-history window, or thread a new param
   through the controller) rather than prescribing one — genuinely a "how", not a "what", call.

---

## Pipeline args

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-15-b440-revenue-accrual/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-15-b440-revenue-accrual/bug-test-plan.md',
  scriptsDir: 'C:/Users/nakram/.claude/skills/dev-pipeline/scripts',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '<SET AT ACTUAL LAUNCH TIME>', // literal placeholder -- launch is gated behind a host-access queue; fill in the real ISO timestamp at the moment of the actual Workflow-tool call, never before
  runDir: '.claude/pipeline/2026-09-15-b440-revenue-accrual',
  scale: 'major',
  mode: 'bugfix',
  // profile omitted -- a HIGH-risk file is present (bookkeeping.service.ts, invoiced-sales.ts),
  // so S0/S6's default (standard) already applies; do not force it.
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-B440',
  context: 'B440/B455/B456: revenue/sales basis fixed from cash+gross to accrual net sales across bookkeeping.service.ts (6 read sites) + a new common/invoiced-sales.ts helper. HIGH risk: money/revenue-recognition math.',
  baselineSha: '7b8bf085',
  // formatCommand deliberately OMITTED: grepped pipeline.js directly (2026-09-15) -- it has no
  // formatCommand mechanism anywhere (confirms 2026-09-14-743-fix-round's build-plan.md finding
  // still holds a day later). The npm script exists (`npm run format`, root package.json) but the
  // engine never reads args.formatCommand, so passing it here would be inert, not incorrect.

  siblingPatterns: [
    { pattern: 'status:\\s*InvoiceStatus\\.PAID[\\s\\S]{0,200}?paidAt:\\s*\\{',
      note: 'a PAID+paidAt aggregate -- classify each hit cash (keep) vs accrual (defect). Expected survivors: the four cash readers (getCashFlow, analytics.service.ts, buyer/statement.service.ts, customers.service.ts). Priority file for this pattern: apps/api/src/analytics/analytics.service.ts already has a paidAt DSO read -- any *revenue* series there is the same shape as B440 (file FU-3, do not fix here).' },
    { pattern: 'notIn:\\s*\\[[^\\]]*WRITTEN_OFF',
      note: 'inline status exclusion -- each hit is either a REAL_INVOICE_STATUSES use (units/COGS, keep) or a revenue figure (defect).' },
    { pattern: 'revenue\\w*:\\s*\\w*[Cc]ollected',
      note: 'cash mislabeled as revenue.' },
    { pattern: '_sum:\\s*\\{\\s*total:\\s*true',
      note: 'gross-not-net candidate -- judge each hit by whether the same method also reads creditNote/return; a method with neither is the B440 shape.' },
    { pattern: 'refundMethod',
      note: 'any consumer of Return.refundMethod outside returns.service.ts or this run\'s new helper is netting returns via CreditNote only -- the same B455 gap.' },
  ],

  tasks: [
    { id: 'RC1', title: 'Confirm B440/B455/B456 cause verdict', type: 'root-cause',
      files: [], tests: [], dependsOn: [], risk: 'HIGH',
      brief: 'Verify cause-ruling.md \u00a71\'s verdict still holds on 7b8bf085: two independent read-side defects in bookkeeping.service.ts (Defect A cash-as-accrual at getSummary/getProfitAndLoss/getMobileDashboard; Defect B gross-not-net + unread Return.refundAmount=B455), no shared write cause; B456 not live today, required the instant Defect A widens to WRITTEN_OFF. Full detail in this file\'s "### RC1" section.' },

    { id: 'RT1', title: 'Repro tests: invoiced-sales.spec.ts (T1,T2,T3,T7,T12)', type: 'repro-test',
      files: [], tests: ['apps/api/src/common/invoiced-sales.spec.ts'], dependsOn: ['RC1'], risk: 'HIGH',
      brief: 'Extend invoiced-sales.spec.ts in place: T1 (predicate deep-equal), T2 (fetchAccrualNetSales where-shape + 500/200/50/250), T3 (Return refundMethod filter, no re-pricing), T7 (fetchBadDebtExpense keys on writtenOffAt not issueDate, 300), T12 (AMENDMENT 2026-09-15: gross excludes taxAmount -- own fixture subtotal 400/discount 20/shipping 15/tax 50 (incl. category tax) -> gross 395). Full oracles in this file\'s "### RT1" section.' },

    { id: 'RT2', title: 'Repro tests: getSummary/P&L/badDebtsReport (T4,T5,T6,T11)', type: 'repro-test',
      files: [], tests: ['apps/api/src/bookkeeping/bookkeeping.service.spec.ts'], dependsOn: ['RC1'], risk: 'HIGH',
      brief: 'Extend bookkeeping.service.spec.ts: T4 rebase getSummary (250 + breakdown fields), T5 rebase getProfitAndLoss (invert the PAID/paidAt pin), T6 badDebtExpense=300/netProfit=-90, T11 new getBadDebtsReport describe consistent with P&L. Do not touch RT3\'s describes (REG-B11, finance, by-customer). Full detail in "### RT2".' },

    { id: 'RT3', title: 'Repro tests: mobile/finance/by-customer (T8,T9,T10) + pins', type: 'repro-test',
      files: [], tests: ['apps/api/src/bookkeeping/bookkeeping.service.spec.ts'], dependsOn: ['RC1', 'RT2'], risk: 'HIGH',
      brief: 'Same file as RT2 (serialized after it). T8 mobile revenue!=totalCollected, T9 finance sales=per-bucket net, T10 new by-customer describe incl. negative net. Also: remove the superseded revenue assertions at REG-B11 (:724) and REG-B421 (:750) -- their replacements are T8/T9. Full detail in "### RT3".' },

    { id: 'FIX1', title: 'invoiced-sales.ts: ACCRUAL_REVENUE_STATUSES + 3 helpers', type: 'fix',
      files: ['apps/api/src/common/invoiced-sales.ts'], tests: [], dependsOn: ['RC1', 'RT1'],
      risk: 'HIGH', effort: 'high', radius: [3, 3],
      brief: 'New export ACCRUAL_REVENUE_STATUSES={notIn:[DRAFT,VOID]} below REAL_INVOICE_STATUSES (:39-41, unchanged). fetchAccrualNetSales/fetchAccrualNetSalesByCustomer/fetchBadDebtExpense per this file\'s "### FIX1" exact signatures -- gross=roundMoney(sumTotal-sumTaxAmount) via issueDate (never paidAt; AMENDMENT 2026-09-15: excludes sales tax, taxAmount already folds in category tax so one subtraction covers both, shipping/discount stay in), creditNotes via createdAt (never appliedAt, subtract amount as-is + a TODO-B459 comment), externalRefunds via refundMethod+refundedAt (already pre-tax), net=roundMoney(gross-creditNotes-externalRefunds) never clamped. Widen fetchInvoicedSaleLines\'s status option to a general filter. Do NOT add a feeForPaymentId clause. Full code block in "### FIX1".' },

    { id: 'FIX2', title: 'bookkeeping.service.ts: getProfitAndLoss/getSummary/getBadDebtsReport', type: 'fix',
      files: ['apps/api/src/bookkeeping/bookkeeping.service.ts'], tests: [], dependsOn: ['RC1', 'RT2', 'FIX1'],
      risk: 'HIGH', effort: 'high', radius: [3, 3],
      brief: 'Revenue+COGS (~:985-995) via fetchAccrualNetSales (issueDate/ACCRUAL_REVENUE_STATUSES, one collection with revenue per L-119); netProfit subtracts fetchBadDebtExpense (~:1019-1028). getSummary (~:1093-1096) totalRevenue=net+breakdown. getBadDebtsReport (~:1665-1698) totals via the same helper, same window as the P&L (needs a new window param -- see Open questions). Must NOT touch :238 paidAt stamp, :49 getCashFlow, credit-notes.service.ts. Full detail in "### FIX2".' },

    { id: 'FIX3', title: 'bookkeeping.service.ts: mobile/finance/by-customer dashboards', type: 'fix',
      files: ['apps/api/src/bookkeeping/bookkeeping.service.ts'], tests: [], dependsOn: ['RC1', 'RT3', 'FIX1', 'FIX2'],
      risk: 'HIGH', effort: 'high', radius: [3, 3],
      brief: 'Mobile (~:1223-1225) revenue=net, netIncome subtracts badDebtExpense; totalInvoiced/totalCollected untouched. Finance dashboard (~:1286-1375) every sales figure = per-bucket net, delete inline notIn[..WRITTEN_OFF] aggregates, receipts byte-identical (B421). By-customer (~:1468-1504) salesAmount=map net. Must NOT touch :1180-1187/:1214 mobile cash fields. Full detail in "### FIX3".' },

    { id: 'P1', title: 'Revert-probe: ACCRUAL_REVENUE_STATUSES -> REAL_INVOICE_STATUSES contents', type: 'revert-probe',
      file: 'apps/api/src/common/invoiced-sales.ts',
      test: 'cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B440-predicate|REG-B440-net"',
      dependsOn: ['FIX1'], risk: 'HIGH',
      brief: 'Revert the predicate\'s contents to REAL_INVOICE_STATUSES\'s. Must catch T1 (deep-equal) and T2\'s where-shape.' },

    { id: 'P2', title: 'Revert-probe: credit-note netting -> 0', type: 'revert-probe',
      file: 'apps/api/src/common/invoiced-sales.ts',
      test: 'cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B440-net"',
      dependsOn: ['FIX1'], risk: 'HIGH',
      brief: 'Force the CreditNote contribution to 0. Must catch T2 (net becomes 300, not 250).' },

    { id: 'P3', title: 'Revert-probe: external-refund netting -> 0', type: 'revert-probe',
      file: 'apps/api/src/common/invoiced-sales.ts',
      test: 'cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B455-refund"',
      dependsOn: ['FIX1'], risk: 'HIGH',
      brief: 'Force the Return/refundMethod contribution to 0 (or drop the refundMethod filter). Must catch T3.' },

    { id: 'P4', title: 'Revert-probe: bad-debt amount -> gross total', type: 'revert-probe',
      file: 'apps/api/src/common/invoiced-sales.ts',
      test: 'cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B456-basis"',
      dependsOn: ['FIX1'], risk: 'HIGH',
      brief: 'Revert fetchBadDebtExpense to sum gross total (ignore paid/credits). Must catch T7 (300 expected, 500 reverted).' },

    { id: 'P5', title: 'Revert-probe: getSummary -> inline PAID/paidAt aggregate', type: 'revert-probe',
      file: 'apps/api/src/bookkeeping/bookkeeping.service.ts',
      test: 'cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-summary"',
      dependsOn: ['FIX2'], risk: 'HIGH',
      brief: 'Revert getSummary\'s revenue read to the original blanket PAID/paidAt aggregate. Must catch T4; T5-T11 must stay green.' },

    { id: 'P6', title: 'Revert-probe: P&L revenue+COGS -> PAID/paidAt basis', type: 'revert-probe',
      file: 'apps/api/src/bookkeeping/bookkeeping.service.ts',
      test: 'cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-pnl|REG-B456-baddebt"',
      dependsOn: ['FIX2'], risk: 'HIGH',
      brief: 'Revert P&L revenue to the inline aggregate and COGS to status:PAID/paidAt. Must catch T5 and T6; T4 must stay green.' },

    { id: 'P7', title: 'Revert-probe: drop badDebtExpense from netProfit', type: 'revert-probe',
      file: 'apps/api/src/bookkeeping/bookkeeping.service.ts',
      test: 'cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B456-baddebt|REG-B456-report"',
      dependsOn: ['FIX2'], risk: 'HIGH',
      brief: 'Revert netProfit to drop the -badDebtExpense term (or desync getBadDebtsReport from it). Must catch T6 and T11; T5 must stay green.' },

    { id: 'P8', title: 'Revert-probe: mobile revenue -> totalCollected', type: 'revert-probe',
      file: 'apps/api/src/bookkeeping/bookkeeping.service.ts',
      test: 'cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-mobile"',
      dependsOn: ['FIX3'], risk: 'HIGH',
      brief: 'Revert getMobileDashboard.revenue to totalCollected. Must catch T8; REG-B11 pins must stay green.' },

    { id: 'P9', title: 'Revert-probe: finance sales -> inline gross aggregate', type: 'revert-probe',
      file: 'apps/api/src/bookkeeping/bookkeeping.service.ts',
      test: 'cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-finance"',
      dependsOn: ['FIX3'], risk: 'HIGH',
      brief: 'Revert finance-dashboard sales figures to the inline gross (WRITTEN_OFF-excluded) aggregate. Must catch T9; receipts assertions must stay green.' },

    { id: 'P10', title: 'Revert-probe: by-customer salesAmount -> inline gross', type: 'revert-probe',
      file: 'apps/api/src/bookkeeping/bookkeeping.service.ts',
      test: 'cd apps/api && npx jest src/bookkeeping/bookkeeping.service.spec.ts -t "REG-B440-bycustomer"',
      dependsOn: ['FIX3'], risk: 'HIGH',
      brief: 'Revert getSalesByCustomer to the inline gross Number(inv.total) sum. Must catch T10.' },

    { id: 'P11', title: 'Revert-probe: gross -> full total (AMENDMENT 2026-09-15)', type: 'revert-probe',
      file: 'apps/api/src/common/invoiced-sales.ts',
      test: 'cd apps/api && npx jest src/common/invoiced-sales.spec.ts -t "REG-B440-tax"',
      dependsOn: ['FIX1'], risk: 'HIGH',
      brief: 'Drop the -taxAmount term so gross=sumTotal again. Must catch T12 (445 instead of 395); T2/T3/T7 must stay green.' },

    { id: 'DOCS1', title: 'Registry, lessons, code-map bookkeeping', type: 'docs',
      files: [
        '.claude/code-map/api/feature-modules-1.md',
        '.claude/code-map/api/feature-modules-6.md',
        '.claude/code-map/api/bootstrap-cross-cutting/bootstrap-and-money-pricing.md',
        '.claude/lessons/LESSONS.md',
        '.claude/lessons/_meta.json',
        '.claude/campaign/bugs.jsonl',
      ],
      tests: [],
      dependsOn: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'],
      brief: 'Update the bookkeeping.service.ts code-map entries in feature-modules-1.md/-6.md + the invoiced-sales.ts entry in bootstrap-and-money-pricing.md for the accrual-net-sales basis. Append one LESSONS.md entry (id = _meta.json nextId read FRESH at write time, grep first) with the Lesson line from cause-ruling.md \u00a78 verbatim. Flip B440 to proven/proven-pending-deploy citing T1,T2,T4,T5,T8,T9,T10,T12 -- B455/B456 do not exist in bugs.jsonl yet, re-check fresh and escalate rather than mint ids (see this file\'s Open questions). Do not touch any B448-B458 row.' },
  ],

  verifyCommands: {
    perRound: [
      'npm run check-types -w apps/api',
      'npm run lint -w apps/api',
    ],
    final: [
      'npm test -w apps/api',
      'npm run check-types -w apps/api',
      'npm run lint -w apps/api',
    ],
  },
}
```
