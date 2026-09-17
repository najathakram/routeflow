# Bug test plan — B440 / B455 / B456 — revenue = accrual net sales

> Fable @ high ruled the decisions in `cause-ruling.md` (§3 tests, §4 blast radius, §7 probes);
> this is a Sonnet @ medium transcription — no new test decision, expected value, or where-clause
> shape beyond what the ruling states. Fixture sentinels (§3): gross 500 · CN 200 · external
> refund 50 · net 250 · collected 100 · bad debt 300 · expenses 40 · cogs 0. Helper spec
> `apps/api/src/common/invoiced-sales.spec.ts` already exists — extend in place, do not create.
> Service spec `apps/api/src/bookkeeping/bookkeeping.service.spec.ts` likewise.
> **AMENDMENT 2026-09-15 (owner ruling, post-S5): revenue excludes sales tax collected.** T12 adds
> its own dedicated fixture (subtotal 400 · discount 20 · shipping 15 · regularTax 20 ·
> categoryTax 30 · taxAmount 50 · total 445 · gross 395) — does not reuse the sentinels above,
> since T4-T11 chain off those. `gross` is now `roundMoney(sumTotal − sumTaxAmount)` everywhere
> else in this document, not `sumTotal` alone.

## Red set (REG-tagged; in the red gate)

| T#  | Title | Setup | Asserts | Fails TODAY with | File |
|---|---|---|---|---|---|
| T1 | REG-B440-predicate | Pure constant check — import `ACCRUAL_REVENUE_STATUSES` and `REAL_INVOICE_STATUSES` from `./invoiced-sales`; no DB stub. | `ACCRUAL_REVENUE_STATUSES` deep-equals `{notIn:[DRAFT,VOID]}`; `REAL_INVOICE_STATUSES` still deep-equals `{notIn:[DRAFT,VOID,WRITTEN_OFF]}` (already passes at :35-36 — unaffected, not a new pin). | `ACCRUAL_REVENUE_STATUSES` has no export from `./invoiced-sales` — `TypeError: Cannot read properties of undefined`. | `apps/api/src/common/invoiced-sales.spec.ts` (new describe; file exists) |
| T2 | REG-B440-net | `stubDb()` extended with `creditNote`/`return` models (Harness notes); invoice `_sum.total`→gross 500 (window on `issueDate`); CreditNote sum→200 (window on `createdAt`); Return sum (`refundMethod:"EXTERNAL_REFUND"`, window on `refundedAt`)→50. | `invoice` query `where = {status: ACCRUAL_REVENUE_STATUSES, issueDate: window}`, no `paidAt` key anywhere; CreditNote keys on `createdAt`, never `appliedAt`; result deep-equals `{gross:500, creditNotes:200, externalRefunds:50, net:250}`. | `fetchAccrualNetSales` not exported — `TypeError: fetchAccrualNetSales is not a function`. | `apps/api/src/common/invoiced-sales.spec.ts` (new describe) |
| T3 | REG-B455-refund | T2 stub, two variants: (a) no Return row → net 300 (500−200−0); (b) Return row `{refundMethod:"EXTERNAL_REFUND", refundedAt: window, refundAmount:50}` → net 250. | Return `where = {refundMethod:"EXTERNAL_REFUND", refundedAt: window}`, `_sum:{refundAmount:true}`; value passed through as-persisted, no re-pricing. | Same as T2 — helper undefined. | `apps/api/src/common/invoiced-sales.spec.ts` (new describe) |
| T4 | REG-B440-summary | Rebase "should return aggregated financial summary" (:260-278): swap the blanket `invoice.aggregate` 5000 mock for the T2 fixture (gross 500/CN 200/refund 50); `invoicePayment.aggregate`/`invoice.count` fixtures unchanged. | `result.totalRevenue===250`; response also carries `grossRevenue:500,creditNotes:200,externalRefunds:50`; helper called with the request's own window; no `invoice.aggregate` call carries `paidAt`. | expected 250, received 5000 (today's blanket PAID/paidAt aggregate). | `bookkeeping.service.spec.ts` `describe("getSummary")` |
| T5 | REG-B440-pnl | Rebase "estimates COGS from the same PAID/paidAt invoice set as revenue" (:865-905): same COGS/expense fixture; revenue via the helper (500/200/50→250). | `result.revenue===250`; `cogsFetch=prisma.invoice.findMany.mock.calls[0][0]` has `status:ACCRUAL_REVENUE_STATUSES`, `issueDate` window; `cogsFetch.where.paidAt` undefined. | Pin at :898-903 inverted, not deleted: expected `status===ACCRUAL_REVENUE_STATUSES`/`paidAt` undefined, received `"PAID"` + a paidAt window. | same file, `describe("getProfitAndLoss")` |
| T6 | REG-B456-baddebt | T5 fixture + expenses 40 (was 100) + WRITTEN_OFF fixture → bad debt 300 (T7). | `result.badDebtExpense===300`; `result.netProfit===-90` (250−0−40−300); `result.revenue` unaffected by the bad-debt mock. | `badDebtExpense` undefined AND `revenue` is 0 today (compound: PAID filter excludes every WRITTEN_OFF invoice). | same file, `describe("getProfitAndLoss")` |
| T7 | REG-B456-basis | New describe: WRITTEN_OFF invoice, was PARTIAL before write-off — total 500, confirmed payments 150, credits applied 50 → unpaid balance 300; `writtenOffAt` in window, `issueDate` outside it. | Query keys on `{status:WRITTEN_OFF, writtenOffAt:window}` (never `issueDate`); amount = 300 (derived — Invoice has no persisted balance/amountPaid/creditsApplied column, confirmed against `finance.prisma`). | `fetchBadDebtExpense` not exported — `TypeError`. | `apps/api/src/common/invoiced-sales.spec.ts` (new describe) |
| T8 | REG-B440-mobile | New test, own fixture (not REG-B11's $200/$300/$800): helper→net 250; `paymentAgg`→collected 100; expenses 40; bad debt 300. | `revenue===250`; `netIncome===250-40-300`; `totalCollected===100`; `revenue!==totalCollected`. | Today `revenue: totalCollected` literally aliased — expected 250, received 100. | same file, adjacent to `describe('REG-B11 …')` |
| T9 | REG-B440-finance | Extend :760-786 fixtures: monthly-bucket and `summaryTable.*` sales source from the helper's per-bucket `net` (250), one call per bucket. | `totalSales`, each bucket's `sales`, every `summaryTable.<period>.sales` = that bucket's `net`; no inline `notIn:[DRAFT,VOID,WRITTEN_OFF]` aggregate remains; existing receipts assertions (:756-757,761-786) untouched. | `sales` = gross inline aggregate (500), WRITTEN_OFF excluded, never netted. | same file, `getFinanceDashboard` describes |
| T10 | REG-B440-bycustomer | New describe (zero existing coverage): one normal customer (net 250), one CN-only customer (gross 0, CN 200 → net −200). | `salesAmount` = by-customer map's `net`; CN-only customer's `salesAmount===-200` (negative net never clamped). | Today sums `Number(inv.total)` gross; CN-only customer absent or gross, never −200. | same file, new `describe("getSalesByCustomer")` |
| T11 | REG-B456-report | New describe (zero existing coverage): T6/T7's WRITTEN_OFF fixture, one shared window. | `getBadDebtsReport().total === ` P&L's `badDebtExpense` (300). | Today sums gross balance (no credits-applied term); P&L field doesn't exist either. | same file, new `describe("getBadDebtsReport")` |
| T12 | REG-B440-tax | **AMENDMENT 2026-09-15 (owner ruling: revenue excludes sales tax).** New describe, own dedicated fixture (does not reuse 500/200/50/250): invoice `subtotal` 400, `discount` 20, `shippingFee` 15, `regularTax` 20, `categoryTax` 30 → `taxAmount` 50 → `total` 445. | `fetchAccrualNetSales(...).gross === 395` (`= total − taxAmount = subtotal − discount + shippingFee`) — proves BOTH regular and category tax are excluded via the single `taxAmount` subtraction, and that shipping/discount stay IN `gross`. | `gross` would be 445 (full `total`, tax included) before this amendment. | `apps/api/src/common/invoiced-sales.spec.ts` (new describe) |

## Pins (no REG token; outside the red gate)

| T# | Frozen behavior | File |
|---|---|---|
| P-a | REG-B11 mobile test (:720-725): `totalCollected` assertion stays; `expect(result.revenue).toBe(200)` (:724) removed, moved into T8. | `bookkeeping.service.spec.ts` |
| P-b | REG-B421 test (:727-758): `totalCollected`/`paymentsThisWeek`/finance-receipts assertions (:748-749,756-757) stay; `expect(dashboard.revenue).toBe(250)` (:750) removed. | same file |
| P-c | `credit-notes.service.spec.ts:393` — `applyCreditInTx`'s `{status:"PAID", paidAt: expect.any(Date)}` stamp, byte-identical (D3). | `credit-notes.service.spec.ts` |
| P-d | `"getCashFlow counts money in on the settled date, keeping legacy rows on paidAt"` (:534-539) already exists and exercises `paidAt`; unchanged — no new pin needed. | `bookkeeping.service.spec.ts` |
| P-e | T1's `REAL_INVOICE_STATUSES` half (:35-36) unchanged. | `invoiced-sales.spec.ts` |
| P-f | "should handle empty data gracefully" getSummary test (:280-294) — **resolved, not a true pin**: it's the SECOND of S1's "2 whole-object `toEqual`s" that T4 already covers rebasing (§3, T4 notes). All-zero fixture means `totalRevenue` stays 0, but the object gains the same new zero-valued breakdown fields (`grossRevenue:0,creditNotes:0,externalRefunds:0`) T4 adds — update the expected object's SHAPE in the same edit as T4, no new REG token (it isn't itself proving a distinct wrong value, just kept in sync). | `bookkeeping.service.spec.ts` |

## Harness notes

- Confirmed real: all 3 `getProfitAndLoss` tests (:865,:907,:935) and both `getSummary` tests (:262,:281) set a blanket `prisma.invoice.aggregate.mockResolvedValue(...)` that ignores `where`. It still satisfies post-fix `invoice.aggregate` calls, but the helper's new `creditNote`/`return` reads fall through to `createMockPrisma`'s factory default (`_sum:{}`) unless T4/T5/T6 explicitly mock them too (D7).
- `fetchInvoicedSaleLines`/`cogsFetch` is NOT `jest.mock`'d anywhere in the spec — it's exercised by stubbing raw `prisma.invoice.findMany` and letting the real helper run. "Mock the new helper functions the same way" is transcribed as: stub the new helper's raw Prisma calls the same way, not a module-level `jest.mock` — see raised question below.
- P&L tests 2/3 (:907,:935) assert only `cogs`, never `revenue` — no edit needed as long as the helper reads `_sum.x ?? 0` defensively.
- `invoiced-sales.spec.ts`'s `stubDb()` (:20-24) wires only `invoice`/`stockMovement`/`product` — T2/T3/T7 need `creditNote`+`return` added or fail immediately.
- `getFinanceDashboard`'s per-bucket calls (12 months + 5 summary periods) need a constant `mockResolvedValue`, not `Once`.
- `Return.refundMethod` is a plain `String?` (sales.prisma) — use literal `"EXTERNAL_REFUND"`, not an enum member.

## Commands

- `redGate.commands`: `cd apps/api && npx jest src/common/invoiced-sales.spec.ts src/bookkeeping/bookkeeping.service.spec.ts --runInBand -t "REG-B4(40|55|56)"` → expect fail today.
- Registry proof lines: `REG-B440` (T1,T2,T4,T5,T8,T9,T10,T12), `REG-B455` (T3), `REG-B456` (T6,T7,T11).
