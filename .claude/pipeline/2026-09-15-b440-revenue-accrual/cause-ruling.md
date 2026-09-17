# Cause ruling — B440 / B455 / B456 — revenue = accrual net sales

Ruled from S1 + S2 only (no repo access). S2 overrides S1 wherever they conflict. Line numbers are
S1/S2's read of master — the build re-anchors by content, never by number.

## 1. Cause verdict

**Two independent read-side defects at six sites in `apps/api/src/bookkeeping/bookkeeping.service.ts`,
plus one line the fix must create.** There is NO shared write-side root cause.

- **Defect A — wrong date/status basis (cash used as accrual).** `getSummary` (:1093-1096) and
  `getProfitAndLoss` revenue (:985-989) + COGS (:990-995) key on `status: PAID` + `paidAt` window;
  `getMobileDashboard` (:1223-1225) labels the cash figure `totalCollected` as `revenue`/feeds
  `netIncome`. `paidAt` is a correct cash-basis fact with 4 legitimate consumers; the readers chose the
  wrong key.
- **Defect B — gross, never net.** No site in the file subtracts credit notes; no site anywhere reads
  `Return.refundAmount` for `EXTERNAL_REFUND` (B455 — `returns.service.ts` persists it correctly at
  :712-720; the value is simply read by nothing). `getFinanceDashboard` and `getSalesByCustomer` are
  accrual-correct on date/status but gross, and additionally exclude `WRITTEN_OFF` (inconsistent with
  the ruling that a write-off is revenue at issue).
- **B456 is not a defect on master** (S2 proof: read side filters `PAID`; write side forbids writing
  off a `PAID` invoice — mutually exclusive by construction; today revenue $0 / bad-debt $0 is
  consistent). It becomes necessary the instant Defect A is fixed with a predicate that includes
  `WRITTEN_OFF`. Bad-debt line and revenue-basis change are arithmetically inseparable → same diff.
- **Refuted and closed:** `credit-notes.service.ts:605-608` (`applyCreditInTx` paidAt stamp) is NOT the
  cause and is a hard must-NOT-change line (§4). `REAL_INVOICE_STATUSES` is NOT the wanted predicate
  (it excludes `WRITTEN_OFF`). `returns.service.ts:726-727` is NOT a defect site — 0 lines change there.

## 2. Fix design (minimal diff) + invariants

### Decisions (the seven asks, resolved)

- **D1 — predicate.** New export in `apps/api/src/common/invoiced-sales.ts`, directly below
  `REAL_INVOICE_STATUSES`:
  `export const ACCRUAL_REVENUE_STATUSES = { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] } as const;`
  with a 3-line comment: "revenue/net-sales predicate — WRITTEN_OFF _is_ revenue at issue (bad debt is a
  later expense); `REAL_INVOICE_STATUSES` is the units/COGS-lines predicate and is unchanged." Same file
  so the two predicates and their difference live in one place. `REAL_INVOICE_STATUSES` and every
  current consumer of it: byte-identical.
- **D2 — WRITTEN_OFF exclusion in `getFinanceDashboard`/`getSalesByCustomer`: fixed in this diff.**
  Both sites move onto the shared helper to get CN/refund netting; the helper carries exactly ONE
  predicate. A status override parameter would recreate the six-site drift this ruling removes, and a
  dashboard that drops a written-off invoice retroactively would disagree with the P&L for the same
  month. Sales ≠ profit: these two sites get net sales, NOT a bad-debt term.
- **D3 — out of scope, must NOT change:** `credit-notes.service.ts:608` (`{status: PAID, paidAt: new
Date()}`), `bookkeeping.service.ts:238` (payment-path stamp), `invoices.service.ts:5415`
  (`dto.paidAt`), and the four cash readers `getCashFlow` (:49), `analytics.service.ts:655`,
  `buyer/statement.service.ts:103`, `customers.service.ts:1698`. `getMobileDashboard.totalCollected`
  (:1180-1187, `RECEIVED_METHOD_FILTER`) byte-identical. `returns.service.ts`: 0 lines.
- **D4 — B456 packaging.** One coupled task (F2) with the P&L revenue-basis change. REG-B456 asserts
  the FINAL end-state; its "fails today" value is the compound failure (revenue $0 because of the `PAID`
  filter AND `badDebtExpense` undefined). No intermediate tree is isolated. Rule generalised: wherever a
  _profit/net-income_ figure is derived from accrual revenue (`getProfitAndLoss`, `getMobileDashboard.
netIncome`, `getSummary` if it returns a net figure) the bad-debt term is subtracted in the same diff;
  wherever only _sales_ is shown (finance dashboard, by-customer) there is no bad-debt term.
- **D5 — EXTERNAL_REFUND pricing basis (`priceReturn` vs `billedBasisFor`): DEFERRED, filed.** Net
  sales subtracts the money actually given back — the persisted `Return.refundAmount` is the economic
  fact regardless of how it was priced. Reconciling here would mean either changing what
  `returns.service.ts` writes (write-side, S2: no change) or re-deriving a figure in the reporting layer
  that disagrees with what was paid (re-derivation is the money-discipline anti-pattern). The helper
  reads `refundAmount` as persisted and says so in a comment. Follow-up FU-1 (§8) filed by the lead.
- **D6 — task boundaries.** F1 = helper (`common/invoiced-sales.ts` + its spec). F2 = P&L + summary +
  bad debt (`bookkeeping.service.ts`, HIGH-risk money). F3 = the three dashboard/by-customer sites (same
  file, serialized after F2). F4 = docs/registry. B455 lives entirely in F1's `Return` read + F2/F3
  consuming `net`.
- **D7 — existing-test re-basing is in scope of F2/F3** (§3 pins + §4). The bookkeeping spec mocks the
  new helper functions the same way it already mocks `fetchInvoicedSaleLines` (`cogsFetch`); Prisma
  `where`-shape proofs live in the helper spec. No bookkeeping test may depend on the mock factory
  provisioning `creditNote.aggregate` / `return.aggregate`.

### F1 — `apps/api/src/common/invoiced-sales.ts` (new exports; mirror `fetchInvoicedSaleLines`' client/arg conventions)

```ts
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

- **AMENDMENT 2026-09-15 (owner ruling, relayed by lead, post-S5): revenue excludes sales tax collected — standard accounting.** `gross` = Σ`(invoice.total − invoice.taxAmount)`, not Σ`invoice.total`. Verified against `apps/api/src/invoices/invoices.service.ts` (4+ independent computation sites: single-invoice create ~:527-533, order-driven reconcile ~:1550-1564, multi-invoice split ~:1272-1278, invoice edit/recreate ~:3543-3549, partial-bill drafts ~:1985-1990): `taxAmount = roundMoney(regularTax + categoryTax)` in every path, and `total = subtotal − discount + shippingFee + taxAmount`. **Category/excise tax is already folded into `taxAmount`, not a separate component of `total`** — `InvoiceItem.categoryTaxAmount` (finance.prisma:277) is a per-line snapshot summed into `categoryTax` and folded into the invoice's single `taxAmount` field (comment at invoices.service.ts:461: "folded into taxTotal below"). **Consequence: subtracting `taxAmount` once already excludes both regular AND category tax — no separate category-tax term is needed.** Shipping and discount stay IN revenue (only tax comes out): `gross = total − taxAmount = subtotal − discount + shippingFee`.
- `gross` = `invoice.aggregate` `_sum.total` AND `_sum.taxAmount` where `{tenantId, status: ACCRUAL_REVENUE_STATUSES, issueDate: window}`, then `gross = roundMoney(sumTotal − sumTaxAmount)` — no `paidAt` key anywhere in the helper.
- `creditNotes` = CreditNote amount summed where `createdAt: window` (the CN's own date; `appliedAt` is a
  settlement event — the same trap as `paidAt` — never used). Exclude a VOID/DRAFT-like CN status if
  the model has one; include applied AND unapplied CNs (an issued, unapplied CN still reduces net sales).
  **AMENDMENT 2026-09-15:** `CreditNote` has no `taxAmount` column today (verified: `finance.prisma:470-503`
  lists only `amount`/`amountUsed`) — subtract `amount` as-is in PR1, tax-inclusive or not. A future lane
  (returns-in-orders + B459) adds `CreditNote.taxAmount`; the helper will then subtract `amount − taxAmount`.
  **Do not add that column now** — put a one-line code comment at this exact subtraction naming B459 as the
  future change point. **Manual credit-note amount semantics, verified against
  `apps/web/app/(dashboard)/credit-notes/page.tsx`:** a LINE-based credit (line selection used) is
  provably pre-tax — the UI prefills each line's amount from `InvoiceItem.subtotal` (:152-157) and hard-caps
  it there (`"A line credit can't exceed its line total"`, :172-174), and the backend mirrors this
  (`credit-notes.service.ts` builds `CreditNoteItem.amount` as a fraction of `lineSubtotal`, pre-tax, with
  `categoryTax` tracked as its own separate field). A FREEFORM/lump-sum credit (no line selection) has
  **no enforced tax semantics** — it's a plain operator-typed number (`credit-notes/page.tsx:447-454`) with
  no default, no cap, and no validation against any invoice figure — so it MAY be tax-inclusive in practice,
  and PR1 cannot detect or correct this. **State this in the PR body as a known imprecision** (freeform
  manual credits may over-subtract by their tax portion) that closes when B459 lands, not a blocker for PR1.
- `externalRefunds` = `Return` `_sum.refundAmount` where `{refundMethod: EXTERNAL_REFUND, refundedAt: window}`.
  The `refundMethod` filter is load-bearing: CN-method returns are already netted via their CreditNote.
  **AMENDMENT 2026-09-15:** already pre-tax — `priceReturn` prices from `subtotal` only (verified on master
  by the minter) — no further change needed for `externalRefunds`.
- **AMENDMENT 2026-09-15: do NOT add a `feeForPaymentId` clause.** That column doesn't exist; the
  check-payments lane adds a returned-check-fee exclusion to this SAME helper later. Out of scope for PR1.
- `net = roundMoney(gross − creditNotes − externalRefunds)`; every component `roundMoney`'d. Negative
  net is legitimate (CN-heavy period) — never clamp; clamping re-hides the CN.
- `ByCustomer`: three `groupBy customerId` reads → map; if CreditNote/Return lack a direct `customerId`,
  derive it through the invoice/order relation (`findMany` + `select`) and reduce in memory (window-bounded).
  Rows = union of customers in any of the three reads.
- `fetchBadDebtExpense` = sum over `{status: WRITTEN_OFF, writtenOffAt: window}` of the **unpaid balance
  at write-off** (`PARTIAL` invoices can be written off): use the persisted balance column if Invoice has
  one, else `total − amountPaid − creditsApplied`. Extract this amount expression from
  `getBadDebtsReport()` (:1665-1694) so report and P&L share ONE expression; if the report sums `total`
  today, it is the same gross-vs-net defect shape and is corrected by adopting the helper.
- `fetchInvoicedSaleLines`: if its `status` option only accepts a single enum value, widen it to a Prisma
  status filter so COGS can pass `ACCRUAL_REVENUE_STATUSES`. No other change.
- Header comment (:28-30): keep "returns / credit notes are not netted out of units or COGS" (still
  true, deliberate — FU-2) and add "net sales: see `fetchAccrualNetSales`".

### F2 — `bookkeeping.service.ts`: `getProfitAndLoss`, `getSummary`, `getBadDebtsReport`

- Revenue (:985-989) → `fetchAccrualNetSales(prisma, tenantId, window)`; `revenue = net`; add
  `grossRevenue`, `creditNotes`, `externalRefunds` to the return (additive, lets a reviewer check the
  identity from the response). COGS (:990-995) → `{dateBasis: "issueDate", status: ACCRUAL_REVENUE_STATUSES}`
  (L-119: one collection with revenue). Add `badDebtExpense = fetchBadDebtExpense(...)`;
  `netProfit = revenue − cogs − expenses − badDebtExpense` (:1019-1028). COGS stays gross of restocked returns (FU-2).
- `getSummary` (:1093-1096) → `totalRevenue = net` + the same three breakdown fields; if it returns a
  net/profit figure, subtract `badDebtExpense` (D4).
- `getBadDebtsReport` → totals via `fetchBadDebtExpense` (same window semantics).

### F3 — `bookkeeping.service.ts`: `getMobileDashboard`, `getFinanceDashboard`, `getSalesByCustomer`

- Mobile (:1223-1225): `revenue = net`, `netIncome = net − <existing expense term> − badDebtExpense`;
  `totalInvoiced` (:1214) and `totalCollected` untouched; no new fields (mobile mirrors web later).
- Finance dashboard (:1286-1294, :1318, :1336-1375): every `sales`/`totalSales`/`summaryTable.*.sales`
  = helper `net` for that bucket's window (one call per bucket, `Promise.all`); delete the inline
  `notIn [DRAFT, VOID, WRITTEN_OFF]` sales aggregates; top-level gains `grossSales`, `creditNotes`,
  `externalRefunds`. `receipts` lines (B421) byte-identical.
- By-customer (:1468-1504): `salesAmount = byCustomer.get(id).net`; delete the inline aggregate; no new per-row fields.

### Invariants preserved

- **I1** cash figures byte-identical (`totalCollected`, `getCashFlow`, DSO, statements, customer balances).
- **I2** every return netted exactly once — CN-method via CreditNote, EXTERNAL_REFUND via `refundAmount`.
- **I3** revenue and COGS share one predicate + one date basis (`issueDate`).
- **I4** `net = roundMoney(gross − creditNotes − externalRefunds)`; consumers read `net`, never re-derive.
- **I5** a write-off never changes revenue in any period; it appears only as bad debt in its `writtenOffAt` period.
- **I6** `REAL_INVOICE_STATUSES` and all its consumers unchanged.
- **I7 (AMENDMENT 2026-09-15)** `gross` excludes ALL sales tax (regular + category/excise, both folded
  into `Invoice.taxAmount`) but keeps shipping and discount: `gross = total − taxAmount = subtotal −
discount + shippingFee`. Every consumer's "Revenue"/"Sales" figure is therefore pre-tax — state this
  explicitly in the PR body.

## 3. Regression tests

Fixture sentinels (no two figures coincide): gross 500 · CN 200 · external refund 50 · **net 250** ·
collected 100 · bad debt 300 · expenses 40 · cogs 0. Helper spec = `common/invoiced-sales.spec.ts`
(create if absent); service tests in `bookkeeping.service.spec.ts` with the helper mocked.

| T#  | REG token           | fails-today-on                                           | passes-after                                                                                                                                                                                                                                                                                                                            | notes                                                                                                                       |
| --- | ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T1  | REG-B440-predicate  | `ACCRUAL_REVENUE_STATUSES` undefined                     | deep-equals `{notIn:[DRAFT,VOID]}`; `REAL_INVOICE_STATUSES` still `{notIn:[DRAFT,VOID,WRITTEN_OFF]}`                                                                                                                                                                                                                                    | second half is a pin                                                                                                        |
| T2  | REG-B440-net        | helper undefined                                         | `where` shapes: invoice `{status: ACCRUAL_REVENUE_STATUSES, issueDate: window}` and no `paidAt` key; CN on `createdAt` not `appliedAt`; result `{500,200,50,250}`                                                                                                                                                                       | helper spec                                                                                                                 |
| T3  | REG-B455-refund     | helper undefined                                         | Return read `{refundMethod: EXTERNAL_REFUND, refundedAt: window}`, `_sum.refundAmount`; with return→0 net is 300, →50 net is 250                                                                                                                                                                                                        | proves the method filter + passthrough (no re-pricing)                                                                      |
| T4  | REG-B440-summary    | `totalRevenue` = blanket `PAID`/`paidAt` aggregate value | `totalRevenue` 250, breakdown fields present, helper called with the request window, no `invoice.aggregate` call carrying `paidAt`                                                                                                                                                                                                      | re-base the 2 whole-object `toEqual`s to the new shape (keep strict)                                                        |
| T5  | REG-B440-pnl        | pin :896-904 asserts `status PAID` + `paidAt`            | `revenue` 250; `cogsFetch` called with `{dateBasis:"issueDate", status: ACCRUAL_REVENUE_STATUSES}` and window; `paidAt` undefined                                                                                                                                                                                                       | the old pin is inverted, not deleted                                                                                        |
| T6  | REG-B456-baddebt    | `badDebtExpense` undefined AND revenue 0 (compound)      | `badDebtExpense` 300; `netProfit = 250 − 0 − 40 − 300 = −90`; `revenue` unchanged by the bad-debt mock                                                                                                                                                                                                                                  | end-state assertion (D4)                                                                                                    |
| T7  | REG-B456-basis      | helper undefined                                         | `fetchBadDebtExpense` where `{status: WRITTEN_OFF, writtenOffAt: window}` (not `issueDate`); amount = unpaid balance for a PARTIAL fixture (total 500, paid 150, credits 50 → 300)                                                                                                                                                      | helper spec; pins I5                                                                                                        |
| T8  | REG-B440-mobile     | `revenue === totalCollected` (100)                       | `revenue` 250, `netIncome` 250 − 40 − 300, `totalCollected` 100, `revenue !== totalCollected`                                                                                                                                                                                                                                           | split out of REG-B11: its `totalCollected` lines stay byte-identical                                                        |
| T9  | REG-B440-finance    | `sales` 500 gross; WRITTEN_OFF excluded                  | `sales`/`totalSales`/each `summaryTable.*.sales` = per-bucket `net`; helper called once per bucket; no inline sales aggregate with `notIn`                                                                                                                                                                                              | receipts assertions untouched                                                                                               |
| T10 | REG-B440-bycustomer | `salesAmount` gross                                      | per-customer `salesAmount` = map `net`; a CN-only customer appears with −200                                                                                                                                                                                                                                                            | negative net allowed                                                                                                        |
| T11 | REG-B456-report     | P&L field undefined                                      | `getBadDebtsReport` total === P&L `badDebtExpense` for one window                                                                                                                                                                                                                                                                       | consistency guard                                                                                                           |
| T12 | REG-B440-tax        | `gross` = 445 (full `total`, tax included)               | `gross` = 395 (`total − taxAmount`); dedicated fixture: subtotal 400, discount 20, shippingFee 15, regularTax 20, categoryTax 30 → `taxAmount` 50, `total` 445 → `gross` 395 (= subtotal − discount + shippingFee, proving BOTH tax components are excluded via the one `taxAmount` subtraction, and shipping/discount stay IN revenue) | **AMENDMENT 2026-09-15** — proves I7; own fixture, does not reuse the 500/200/50/250 sentinels since T4-T11 chain off those |

**Pins (must stay green, unchanged):** REG-B11/B421 `totalCollected` assertions (:720-725, :748-750
minus the moved `revenue` line); every `credit-notes.service.spec` assertion on the :608 stamp; any
`getCashFlow` spec on `paidAt` (add a one-line pin if none exists); T1's `REAL_INVOICE_STATUSES` half.

## 4. Blast radius

Radius = lines that change; anchors = context lines that must be byte-identical before/after.

| Task                             | Radius (changes)                                                                                                                                                                | Anchors (must not change)                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| F1 `common/invoiced-sales.ts`    | new exports after :41; `fetchInvoicedSaleLines` status-option type only if needed; header :28-30 comment                                                                        | `REAL_INVOICE_STATUSES` :39-41 literal; `fetchInvoicedSaleLines` query/return shape                          |
| F2 `bookkeeping.service.ts`      | :985-995 (revenue+COGS), :1019-1028 (return), :1093-1096 + getSummary return, :1665-1694 (`getBadDebtsReport` body)                                                             | :238 paidAt stamp; :49 `getCashFlow`; every `invoicePayment` read                                            |
| F2 `bookkeeping.service.spec.ts` | `describe("getSummary")` :259-295 expected objects; `describe("getProfitAndLoss")` :862-958 — flip :896-904, replace the blanket `invoice.aggregate` reliance with helper mocks | all non-P&L/non-summary describes                                                                            |
| F3 `bookkeeping.service.ts`      | :1223-1225; :1286-1294, :1318, :1336-1375 sales expressions only; :1468-1504 sales expression                                                                                   | :1180-1187 + :1214 (mobile); `receipts`/`RECEIVED_METHOD_FILTER` lines (B421); CN ledger methods :2090/:2167 |
| F3 `bookkeeping.service.spec.ts` | REG-B11 :720-725/:748-750 — move ONLY the `revenue` assertion into T8                                                                                                           | the `totalCollected` assertions                                                                              |
| never                            | `credit-notes.service.ts:605-608`, `returns.service.ts`, `invoices.service.ts:5415`/`:5527-5559`, the four cash readers                                                         | entire files                                                                                                 |

Cross-workspace: response types in `packages/types/api/*` (if the summary/P&L/finance DTOs live there)
gain optional fields only — additive; web/mobile consumers need no change. Web `npm test` must stay green.

## 5. Sibling pattern

Run after F3; hits inside `bookkeeping.service.ts` must be zero for sales; hits elsewhere are FILED
(scope discipline L-008), not fixed here.

- `status:\s*InvoiceStatus\.PAID[\s\S]{0,200}?paidAt:\s*\{` — a PAID+paidAt aggregate; classify each
  hit cash (keep) vs accrual (defect). Expected survivors: the four cash readers.
- `notIn:\s*\[[^\]]*WRITTEN_OFF` — inline exclusion; each hit is either a `REAL_INVOICE_STATUSES` use
  (units/COGS, keep) or a revenue figure (defect).
- `revenue\w*:\s*\w*[Cc]ollected` — cash mislabeled as revenue.
- `_sum:\s*\{\s*total:\s*true` in a method with no `creditNote` read — gross-not-net candidate.
- `refundMethod` outside `returns.service.ts`/the helper — any other consumer netting returns via CN only.
- Priority file for the sweep: `apps/api/src/analytics/analytics.service.ts` (has a `paidAt` DSO read;
  any _revenue_ series there is the same shape → file FU-3).

## 6. Data repair

**No.** All six figures are computed at read time from correctly persisted facts (`paidAt` is a true
cash stamp; `Return.refundAmount`/`refundedAt` are correct; write-offs stamp `writtenOffAt`). Nothing
persisted is wrong. One build-time check, one grep: if a persisted period-close/report snapshot model
exists, it is stale under the new basis → read-only report first, not a rewrite (FU-4, conditional).

## 7. Probe plan (revert-probe task per file; each must turn the named REG red, and nothing else)

| Probe                                          | Revert                                                             | Must go red          | Must stay green                                   |
| ---------------------------------------------- | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------- |
| P1 `invoiced-sales.ts`                         | `ACCRUAL_REVENUE_STATUSES` → contents of `REAL_INVOICE_STATUSES`   | T1, T2 (where shape) | T3, T7                                            |
| P2 `invoiced-sales.ts`                         | CN read → 0                                                        | T2                   | T3                                                |
| P3 `invoiced-sales.ts`                         | Return read → 0 / drop `refundMethod` filter                       | T3                   | T2 gross                                          |
| P4 `invoiced-sales.ts`                         | bad-debt amount → `total` (ignore paid/credits)                    | T7                   | —                                                 |
| P5 `bookkeeping.service.ts`                    | `getSummary` back to inline `PAID`/`paidAt` aggregate              | T4                   | T5–T11                                            |
| P6 `bookkeeping.service.ts`                    | P&L revenue back to inline aggregate; COGS back to `paidAt`/`PAID` | T5, T6               | T4                                                |
| P7 `bookkeeping.service.ts`                    | drop the `badDebtExpense` term from `netProfit`                    | T6, T11              | T5                                                |
| P8 `bookkeeping.service.ts`                    | `revenue: totalCollected`                                          | T8                   | REG-B11 pins (proves the split kept the cash pin) |
| P9 `bookkeeping.service.ts`                    | finance `sales` back to inline gross aggregate                     | T9                   | receipts assertions                               |
| P10 `bookkeeping.service.ts`                   | by-customer back to inline gross                                   | T10                  | —                                                 |
| P11 `invoiced-sales.ts` (AMENDMENT 2026-09-15) | `gross` back to `total` (drop the `− taxAmount` term)              | T12                  | T2, T3, T7                                        |

Harness-integrity: P5–P10 are what prove the helper mocks are not tautological — a reverted site reads
the blanket aggregate (500), never the mocked net (250).

## 8. Follow-ups to file (ids minted by the lead on a master-current tree) + open fact lookups

- **FU-1** EXTERNAL_REFUND priced via `priceReturn`, CN-method via `billedBasisFor` — equivalent returns
  may yield different amounts (write-side consistency; D5).
- **FU-2** units/COGS not netted for restocked returns (documented limitation, `invoiced-sales.ts:28-30`).
- **FU-3** (conditional) analytics revenue series on the cash basis, from the §5 sweep.
- **FU-4** (conditional) persisted period snapshots stale under the new basis (§6).
- Lesson candidate (id from the lead): a figure's basis (cash vs accrual) is part of its name — a
  `revenue:` fed by a `*Collected` value is a labeling bug; a new P&L expense line ships with the
  revenue predicate that makes it necessary, never alone.

Fact lookups pinned to F1 (rules already given, no owner question): CreditNote amount/status/`customerId`
fields; Return `customerId`/`refundMethod` enum name; whether Invoice carries a persisted balance
column. **No owner or S2-round-2 question is blocking.**
