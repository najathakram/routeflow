# Finance, Bookkeeping & Reporting

_Turning the orders and deliveries RouteFlow already knows about into receivables, margin, cash and expense reporting — without re-keying anything._

## The problem

A wholesale distributor sells on account: goods go out on a van, an invoice follows, and money
arrives days or weeks later as cash, a check, a bank transfer or a card. Meanwhile the same bank
account pays for stock bought on supplier credit, fuel, rent, wages and repairs. When that runs on
spreadsheets, a paper delivery book and WhatsApp, the owner cannot answer three questions without
an evening of re-typing: who owes me and how long have they owed it, did I actually make money
last month, and what did that pallet really cost me. Bad debt is discovered when a customer stops
answering the phone, cash-flow surprises arrive as a bounced supplier payment, and at year end the
accountant re-keys twelve months of invoices and receipts from scratch.

## Why it matters to a tenant

Every invoice, payment, credit note, supplier bill and expense already exists inside RouteFlow
because the same system took the order and delivered it, so receivables, margin and cash reports
come out of operational data with zero re-keying. Concretely: an AR aging bucketed to the day
across every open invoice, roughly twenty canned reports behind one date-range toolbar with CSV
export and print, sixteen analytics endpoints including gross margin with a real COGS estimate,
and receipt OCR that turns a photographed receipt into itemised expense lines. The bank-settlement
date is modelled separately from the recording date (`InvoicePayment.settledAt` vs `paidAt`), so a
post-dated check does not inflate this month's cash.

The honest counterweight: several of these numbers are currently wrong in ways described below —
the P&L and cash-flow reports double-count inventory purchases, and there is no general ledger, so
the accountant still re-keys at year end.

## Core use cases

1. **Know what I am owed, and how old it is** — every unpaid invoice, its remaining balance, and
   how many days past due, bucketed so the operator can work the phone from oldest to newest, and
   write off what will never arrive.
2. **Know whether I made money** — revenue, cost of goods sold and operating expenses for a chosen
   period, plus the cash that actually moved in and out, so the owner can see profit and liquidity
   without waiting for the accountant.
3. **Capture what I spent** — record supplier bills, fuel, rent, wages and mileage against a
   category with a receipt attached, so the profit figure is built on real costs rather than an
   optimistic guess.

## Must have (P0)

| ID      | Capability                                                          | Status     | What it does                                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-M1  | Record a payment against an invoice                                 | SHIPPED ✅ | Cash, check, card or transfer recorded against an open invoice; paid total and status update inside a transaction.                                                                              | `POST /api/v1/bookkeeping/transactions/:id/payments` → `bookkeeping.controller.ts:72-76` → `bookkeeping.service.ts recordPayment` (line 166), wrapped in `prisma.tenantTransaction`; Prisma model `InvoicePayment`.                                                                                                                                                                                                               |
| FIN-M2  | AR aging — who owes what, and for how long                          | SHIPPED ✅ | Every open invoice bucketed by days past due with per-bucket totals and a grand total.                                                                                                          | `GET /reports/aging` and `/reports/ar-aging-invoices` → `getArAgingInvoices` (line 1325); also on `finance-dashboard`.                                                                                                                                                                                                                                                                                                            |
| FIN-M3  | Expense capture with a category and a receipt                       | PARTIAL 🟡 | Record a spend with amount, date, category, method, optional supplier/customer, and attach a receipt. Twenty IRS-shaped categories seeded per tenant.                                           | `bookkeeping.controller.ts:118-187`; `createExpense` (414); `irs-categories.constant.ts`. PARTIAL: `POST /expense-categories` exists but its web hook has no caller anywhere — a tenant cannot create its own category.                                                                                                                                                                                                           |
| FIN-M4  | Profit & Loss for a period                                          | BROKEN 🔴  | Revenue, COGS, gross profit, opex by category, net profit and margin for a window.                                                                                                              | `getProfitAndLoss` (line 944). Mixes cash-basis revenue with accrual-basis expenses, and double-counts INVENTORY_PURCHASE (once as opex, once inside COGS) because the shadow `Expense` row survives auto-conversion to a `VendorBill`.                                                                                                                                                                                           |
| FIN-M5  | Cash flow — money in vs money out                                   | BROKEN 🔴  | Total received, total paid out and net for a window, on the date money actually moved.                                                                                                          | `getCashFlow` (line 1007). Money-in correctly uses `settledAt ?? paidAt`; money-out sums every `Expense` plus every `BillPayment` with no INVENTORY_PURCHASE exclusion, double-counting stock purchases.                                                                                                                                                                                                                          |
| FIN-M6  | Finance overview dashboard                                          | PARTIAL 🟡 | AR aging bands, a twelve-month sales/receipts/expenses chart, top expense categories, and today/week/month/quarter/year summaries.                                                              | `GET /finance-dashboard` (ungated) → `getFinanceDashboard` (1171). PARTIAL: receipts/period summaries bucket on `InvoicePayment.createdAt`, not `settledAt ?? paidAt`, disagreeing with cash-flow. verified: the 12 monthly aggregations run sequentially, but the 5 period summaries run in parallel via `Promise.all` (lines 1302-1308) — "17+ sequential queries" overstates it.                                               |
| FIN-M7  | Report catalogue with date range, CSV export and print              | SHIPPED ✅ | ~20 canned reports behind a shared date-range toolbar, exportable to CSV or printable.                                                                                                          | `finance/reports/page.tsx` `REPORT_GROUPS`; export via `report-export.ts`. verified: the Ledger report reads `GET /transactions`, not `/bookkeeping/reports/*`, and carries no plan-flag gate — so when reporting entitlement enforcement is enabled the other 18 reports 403 while the Ledger keeps working.                                                                                                                     |
| FIN-M8  | Tenant isolation of financial data                                  | BROKEN 🔴  | One tenant's invoices, payments, credit notes, bills and purchase orders are invisible and untouchable from another tenant's session.                                                           | Reads are scoped via `forTenant()`, but `DELETE /api/v1/settings/financial-data` runs ten unscoped `deleteMany({})` calls behind only an OPERATOR role check — any operator token wipes every tenant's financial history. Matches bug-register B126/B127.                                                                                                                                                                         |
| FIN-M9  | Cash-basis date — when the money actually landed                    | PARTIAL 🟡 | A post-dated or deposited check reports its cash effect on the settlement date, not the date the paper was handed over.                                                                         | `InvoicePayment.settledAt` read via `settledDateFilter` (lines 42-44); applied on exactly two surfaces (`getCashFlow`, `getPaymentsReceivedReport`). verified: `settledAt` is operator-supplied on record and edit, and the check-clearing flow at `invoices.service.ts:5034-5051` deliberately refuses to auto-stamp it on clearing "because doing so would move a reporting window" — a real design decision, not an oversight. |
| FIN-M10 | Analytics dashboard scoped by a date range                          | SHIPPED ✅ | Revenue trend, AOV, DSO, gross margin, sales by category, top products/customers, turnover, dead stock, margin alerts, route/driver performance — all filtered by one shared picker.            | `GET /api/v1/analytics/*`, 16 endpoints, class-gated `flag.analytics`; regression-covered by `analytics.service.spec.ts`.                                                                                                                                                                                                                                                                                                         |
| FIN-M11 | Bad-debt write-off and its report                                   | SHIPPED ✅ | An uncollectable invoice is written off with a reason and date, drops out of receivables, and appears on a dedicated report.                                                                    | `POST /invoices/:id/write-off` → `writeOff` (4719); `GET /reports/bad-debts` → `getBadDebtsReport` (1587); excluded from revenue via `REAL_INVOICE_STATUSES`.                                                                                                                                                                                                                                                                     |
| FIN-M12 | Money rounding discipline across finance writes                     | PARTIAL 🟡 | Every monetary value written or reported is rounded to cents through the shared helper.                                                                                                         | `roundMoney` applied in P&L, gross-margin trend, bulk-mark-paid. PARTIAL: `createExpense` computes mileage amount and sums itemized lines with no `roundMoney` before writing to a `Decimal(10,2)` column.                                                                                                                                                                                                                        |
| FIN-M13 | Customer advance payments / money on account                        | SHIPPED ✅ | A deposit or round-figure overpayment is held as a running balance and drawn down against future invoices.                                                                                      | `POST/GET /customers/:id/advance-payments`, `/apply` — `customers.controller.ts:213-229`; Prisma `AdvancePayment` (schema:2690); overpaying an invoice auto-creates one (`invoices.service.ts:4911-4915`); voiding/deleting an application restores the balance; regression `invoices.service.spec.ts:3095-3130`.                                                                                                                 |
| FIN-M14 | Standalone payment recording, payments register, and receipt images | SHIPPED ✅ | Record a payment against a customer (allocated across open invoices, excess to advance), browse a paginated payments register, export it to CSV, and attach a photographed check or receipt.    | `POST /invoices/payments/record`; `GET /invoices/payments` (paginated, filterable, sortable by `settledAt`); `GET /invoices/payments/export` (streamed server CSV); `POST/GET/DELETE /invoices/payments/:id/image`. Web: `finance/payments/page.tsx` ("Payments Received"); mobile: `(operator)/payments/{index,record,[id]}.tsx`.                                                                                                |
| FIN-M15 | Check lifecycle                                                     | SHIPPED ✅ | Advance a check payment through Recorded → Deposited → Cleared → Bounced; clearing only stamps `settledAt` when the operator supplied one, so clearing never silently moves a reporting window. | `PATCH /invoices/:id/payments/:paymentId/check-status`; enum `CheckStatus`; `invoices.service.ts:5034-5051`. This is the writer behind FIN-M9's `settledAt` and the VOID/bounced-check exclusions six other capabilities depend on.                                                                                                                                                                                               |
| FIN-M16 | Customer statement of account with monthly PDF                      | SHIPPED ✅ | A period statement of every invoice, payment and credit for one customer, available as a month-by-month PDF and via a buyer-facing self-serve endpoint.                                         | `GET /customers/:id/statement`, `/statements`, `/statements/:month` (PDF) → `customers.service.ts getStatementForOperator` (860); `statement.service.ts` + `statement-pdf.service.ts`; buyer twin `GET /customers/me/statement`; security-pinned `customers.security.spec.ts:104`; money-pinned `customers.service.spec.ts:984-1071`; mobile `(operator)/customers/[id]/statement.tsx`.                                           |

### Testing criteria

#### FIN-M1

- [ ] Given an invoice with total 100.00 and no payments, when 40.00 is recorded, then status becomes PARTIAL and totalPaid is exactly 40.00. `Jest`
- [ ] A payment marked VOID (bounced check) is excluded when recomputing the paid total, and a fresh full payment is accepted rather than rejected as already paid. `Jest`
- [ ] Two concurrent record-payment calls for the same invoice never let the persisted sum exceed the total by more than a 0.001 epsilon. `Jest`
- [ ] Tenant A's operator calling this route with tenant B's invoice id returns 404, not 200. `Jest`

#### FIN-M2

- [ ] An invoice fully paid by a non-VOID payment appears in no bucket. `Jest`
- [ ] With `intervalDays=15`, bucket totals sum to the grand total to the cent. `Jest`
- [ ] An invoice with a null due date lands in the `current` bucket rather than being dropped. `Jest`
- [ ] A tenant with zero open invoices renders an explicit empty state, not an error. `Playwright`

#### FIN-M3

- [ ] A fresh tenant has exactly the 20 IRS system categories, marked `isCustom=false`. `Jest`
- [ ] Itemized lines of 10.005 and 20.00 sum to a rounded `Expense.amount` equal to the sum of line items. `Jest`
- [ ] A receipt upload over 10 MB is rejected and no `receiptKey` is written. `Jest`
- [ ] A soft-deleted expense disappears from every report that filters `deletedAt: null`. `Jest`

#### FIN-M4

- [ ] A 1,000.00 INVENTORY_PURCHASE expense auto-converted to a vendor bill, sold against, appears in exactly one of `cogs`/`operatingExpenses` — fails today. `Jest`
- [ ] Given revenue 1,000, cogs 600, opex 200, then grossProfit is 400.00 and netProfit 200.00, both rounded to cents. `Jest`
- [ ] An invoice issued in January, paid in March, windowed to March, counts revenue in March priced at January's average cost. `Jest`
- [ ] A period with zero revenue reports `netMarginPct` as 0, never `NaN`/`Infinity`. `Jest`

#### FIN-M5

- [ ] A 500.00 INVENTORY_PURCHASE expense converted to a vendor bill and paid in the same window counts once in `totalOut`, not twice. `Jest`
- [ ] A check recorded 1/28 with `settledAt` 2/3 is excluded from January and included in February. `Jest`
- [ ] A legacy row with `settledAt` null reports on `paidAt`, matching pre-`settledAt` behaviour. `Jest`
- [ ] An empty window returns `totalIn`/`totalOut`/`netCashFlow` all 0. `Jest`

#### FIN-M6

- [ ] A payment typed 3/1 with `paidAt` 2/20 shows in the February receipts bar, not March — fails today. `Jest`
- [ ] `finance-dashboard.monthlySales.totalReceipts` equals `reports/cashflow.totalIn` for the same span. `Jest`
- [ ] A tenant with no invoices renders 12 zeroed months and an empty `topExpenses` array. `Playwright`
- [ ] The endpoint's query count is asserted, not just wall-clock latency, for a 5,000-invoice tenant. `Jest`

#### FIN-M7

- [ ] A CSV field containing a comma or quote is quoted and inner quotes doubled on export. `Playwright`
- [ ] A from-date later than the to-date is blocked by the toolbar rather than issuing a silently empty request. `Playwright`
- [ ] A zero-row report renders an empty state and exports a header-only CSV. `Playwright`
- [ ] The Ledger report and the other 18 reports behave identically once `flag.reports` enforcement is enabled — assert both, not just the gated 18. `Playwright`

#### FIN-M8

- [ ] Tenant A's operator calling `DELETE /settings/financial-data` leaves tenant B's invoice count unchanged — fails today. `Jest`
- [ ] The route requires a typed-back confirmation and is denied below tenant-owner role. `Jest`
- [ ] A PAID invoice with settled payments is never deleted by this route. `Jest`
- [ ] Every deletion writes an AuditLog row with tenantId, userId and row counts removed. `Jest`

#### FIN-M9

- [ ] A payment with `paidAt` 1/30 and `settledAt` 2/2 places in February on both cash-flow and payments-received. `Jest`
- [ ] A legacy row with `settledAt` null falls back to `paidAt` identically across surfaces. `Jest`
- [ ] A post-dated check with a future `settledAt` is excluded from a window ending today. `Jest`
- [ ] Clearing a check with no operator-supplied `settledAt` leaves the existing reporting window untouched. `Jest`

#### FIN-M10

- [ ] Every card on the analytics page carries the shared from/to params — no card fetches without them. `Playwright`
- [ ] An unrecognised `?range=` on `GET /analytics/demand/:productId` returns 400. `Jest`
- [ ] With `tobacco_dealer` + `tobacco.excludeFromMainAnalytics`, tobacco is excluded from analytics but still counted in bookkeeping P&L. `Jest`
- [ ] A never-invoiced product returns `hasAnySales=false`, distinct from "zero this window." `Jest`

#### FIN-M11

- [ ] A written-off invoice no longer appears in any AR aging bucket. `Jest`
- [ ] A written-off invoice contributes 0 to revenue in revenue trend, gross margin and sales-by-customer. `Jest`
- [ ] A write-off with a prior partial payment reports `balance` = total − non-VOID payments. `Jest`
- [ ] Writing off an already-VOID invoice is rejected. `Jest`

#### FIN-M12

- [ ] Distance 12.7 at rate 0.6750 persists as exactly 8.57. `Jest`
- [ ] Itemized lines of 33.335 and 33.335 sum to `roundMoney(Σ lines)`. `Jest`
- [ ] Every report total equals the rounded sum of its own rows to the cent. `Jest`
- [ ] Boxed invoice lines feeding COGS use the stored line subtotal, never `qty × unitPrice`. `Jest`

#### FIN-M13

- [ ] Overpaying an invoice by 50.00 creates an `AdvancePayment` of 50.00. `Jest`
- [ ] Applying an advance debits its balance and reduces the target invoice's outstanding amount. `Jest`
- [ ] Voiding or deleting an applied advance restores the balance. `Jest`
- [ ] Another tenant's advance payments are never visible or applicable. `Jest`

#### FIN-M14

- [ ] Recording a customer payment above open invoice totals allocates the excess to an `AdvancePayment`. `Jest`
- [ ] The payments register paginates and sorts correctly by `settledAt`. `Jest`
- [ ] CSV export streams from the server and matches the register's filtered rows. `Jest`
- [ ] A receipt image attached to a payment is retrievable and deletable, tenant-scoped. `Jest`

#### FIN-M15

- [ ] A check moves Recorded → Deposited → Cleared without a supplied `settledAt` and the reporting window is unchanged. `Jest`
- [ ] Marking Bounced flips the payment to VOID and it is excluded from every paid-sum. `Jest`
- [ ] An invalid status transition (e.g. Cleared → Recorded) is rejected. `Jest`
- [ ] Only a payment method of CHECK exposes this transition. `Jest`

#### FIN-M16

- [ ] A generated month's statement PDF total matches the sum of that customer's invoices/payments/credits for the month. `Jest`
- [ ] VOID payments and expired credits are excluded from the statement. `Jest`
- [ ] The buyer-facing `/customers/me/statement` endpoint returns only the calling buyer's own data. `Jest`
- [ ] `GET /customers/:id/statements` lists only months that actually have activity. `Playwright`

## Nice to have (P1)

| ID      | Capability                                                      | Status     | What it does                                                                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-N1  | Receipt OCR into expense line items                             | PARTIAL 🟡 | Photograph a supplier receipt and have line items, quantities and unit costs extracted automatically.                                                                   | `POST /expenses/:id/extract-items`, addon-gated `ocr`. PARTIAL: the web control at `vendor-bills/page.tsx:1723` renders unconditionally with no addon check, so a tenant without `ocr` gets a raw 403.                                                                                                                                                                                                                  |
| FIN-N2  | Bulk CSV expense import with batch rollback                     | PARTIAL 🟡 | Import a year of expenses from a spreadsheet and undo the whole batch in one action if the mapping was wrong.                                                           | `POST /import/expenses`, `GET /import/expenses/batches`, `DELETE /import/expenses/batch/:batchId`. verified: only the upload endpoint has a UI caller (`settings/import/page.tsx:107`) — the batch list and rollback have zero callers in web or mobile, so a mis-mapped import cannot be undone from any screen.                                                                                                       |
| FIN-N3  | Mileage expenses with a dated rate table                        | PARTIAL 🟡 | Log a trip's distance and compute reimbursement from the rate in force on that date.                                                                                    | `GET/POST/DELETE /mileage-rates`; `getApplicableMileageRate` (349). PARTIAL: create/delete hooks exist but have no UI caller — no screen can create a rate (bug-register B42).                                                                                                                                                                                                                                          |
| FIN-N4  | Bulk mark-paid across bills and expenses through the ledger     | SHIPPED ✅ | Select a batch of supplier bills or expenses and settle them in one action, writing real payment rows.                                                                  | `POST /bills/bulk-mark-paid` → `bulkMarkPaid` (568), `payBillFully` (668); regression `bulk-mark-paid.spec.ts`.                                                                                                                                                                                                                                                                                                         |
| FIN-N5  | Sales analysis by customer, item and driver                     | SHIPPED ✅ | Who bought the most, what sold the most, and which driver's round generated the most revenue.                                                                           | `GET /reports/sales-by-customer\|item\|driver`; `analytics/customers/top`, `/products/top`.                                                                                                                                                                                                                                                                                                                             |
| FIN-N6  | Collection speed — DSO and time-to-get-paid                     | PARTIAL 🟡 | Average days from invoice to payment, with a distribution across day bands.                                                                                             | `GET /analytics/dso` → `getDso` (620); `GET /reports/time-to-get-paid` (1662). verified: `getDso` windows on **issue date**, not payment date — a 7-day window CAN report DSO far above 7, contrary to the original claim; the real defect is survivorship — only invoices that reached PAID are counted, so a short window reads flatteringly low by excluding slow payers still outstanding. Bug-register B119, Open. |
| FIN-N7  | Gross margin with a real COGS estimate                          | SHIPPED ✅ | Margin for a period from the same invoice set as revenue, costed at the product's average cost as at invoice date.                                                      | `GET /analytics/gross-margin` → `getGrossMarginTrend` (875) using `invoiced-sales.ts`; spec `analytics.service.spec.ts:34`.                                                                                                                                                                                                                                                                                             |
| FIN-N8  | Working-capital signals — turnover, dead stock, margin alerts   | SHIPPED ✅ | Which products are turning, which are dormant, and which sit under a 20% margin.                                                                                        | `GET /analytics/inventory/turnover\|dead-stock\|margin-alerts` (465, 505, 589).                                                                                                                                                                                                                                                                                                                                         |
| FIN-N9  | Per-product demand series for reorder decisions                 | SHIPPED ✅ | Units and revenue per bucket for one product across 30d/6m/1y/5y, with first/last-sale markers.                                                                         | `GET /analytics/demand/:productId` (776); `demand-range.ts` with spec `demand-range.spec.ts`.                                                                                                                                                                                                                                                                                                                           |
| FIN-N10 | Refund and credit-note history                                  | SHIPPED ✅ | A period view of money that went back out — voided payments and credit-note refunds.                                                                                    | `GET /reports/refund-history` → `getRefundHistory` (1980).                                                                                                                                                                                                                                                                                                                                                              |
| FIN-N11 | Customer balance and receivable summary                         | SHIPPED ✅ | Outstanding balance per customer and a date-ordered receivables ledger.                                                                                                 | `GET /reports/customer-balance` (1470); `GET /reports/receivable-summary` (2055); VOID exclusion pinned `bookkeeping.service.spec.ts:365`.                                                                                                                                                                                                                                                                              |
| FIN-N12 | Finance reports on mobile                                       | PARTIAL 🟡 | Read the core finance reports from a phone while away from the desk.                                                                                                    | `(operator)/reports/` ships 5 of ~20 report ids. verified: this understates mobile finance as a whole — mobile separately ships a full expense-capture flow (`(operator)/expenses/*`), payment recording and review (`(operator)/payments/*`), vendor-bill/supplier screens, and a customer statement screen. The **report catalogue** specifically is the thin part (5/20); the operational finance surface is not.    |
| FIN-N13 | Exclude regulated/tobacco lines from headline analytics         | SHIPPED ✅ | A dealer whose tobacco business distorts headline charts can hide it from main analytics while keeping it in compliance reporting and accounting.                       | `tobaccoExclusionActive` (analytics.service.ts:152) requiring addon + config key together; spec `analytics.service.spec.ts:427`.                                                                                                                                                                                                                                                                                        |
| FIN-N14 | Commission payouts land in the P&L automatically                | SHIPPED ✅ | Paying a sales agent books a COMMISSIONS_AND_FEES expense, so the cost shows up in profit and cash reports without a manual journal.                                    | verified anchor: `commission-statements.service.ts:359-368` looks up (or self-seeds) the category and calls `tx.expense.create` inside the payout transaction. Gated by the `sales_agents` addon.                                                                                                                                                                                                                       |
| FIN-N15 | Expense status lifecycle with batch transitions                 | BROKEN 🔴  | Track a spend through PENDING → RECEIVED → PAID (or VOID), with timestamps auto-stamped, and move a selection in bulk.                                                  | verified: `buildStatusPatch` (512) and `POST /expenses/batch-status` exist, but **nothing reads the status** — P&L opex, cash-flow money-out, mobile dashboard and finance-dashboard all filter only `deletedAt: null`. A VOID expense still reduces net profit and still counts as cash out.                                                                                                                           |
| FIN-N16 | Inventory valuation for the balance-sheet line                  | PARTIAL 🟡 | What the stock on hand is currently worth.                                                                                                                              | `GET /inventory/valuation` → `getValuation` (1326). PARTIAL: `Product.costingMethod` offers FIFO/LIFO/AVCO/STANDARD/LAST_COST but valuation is weighted-average for every method — the FIFO/LIFO lot-consumption path has no caller.                                                                                                                                                                                    |
| FIN-N17 | Payment correction: edit, void and delete with ledger reversal  | SHIPPED ✅ | Edit a recorded payment's amount or date, void it, or delete it, with the advance-payment draw-down and invoice status recomputed rather than a total mutated in place. | `PATCH /invoices/:id/payments/:paymentId`, `/void`, `DELETE /invoices/:id/payments/:paymentId` (`invoices.service.ts:3731-3752, 4659-4675`).                                                                                                                                                                                                                                                                            |
| FIN-N18 | Supplier credits — the AP mirror of advance payments            | SHIPPED ✅ | An overpayment to a supplier is held as an on-account credit and drawn down automatically against the next bill.                                                        | Prisma `SupplierCredit` (schema:2717); written by `vendor-bills.service.ts:2005`; covered by feature-smoke S4 credit-drain scenario.                                                                                                                                                                                                                                                                                    |
| FIN-N19 | Cost-basis maintenance and AVCO recompute                       | SHIPPED ✅ | Set or bulk-set a product's cost basis and recompute average costs — the direct input to every margin figure.                                                           | `PATCH /inventory/products/:id/cost-basis`, `POST /inventory/cost-basis/bulk`, `POST /inventory/recompute-costs`; mobile `set-cost.tsx`, `bulk-set-cost.tsx`, `recompute-costs.tsx`.                                                                                                                                                                                                                                    |
| FIN-N20 | Product price-history, cost-history and per-buyer sales history | SHIPPED ✅ | Historical price and cost series per product, and a paginated per-product sales history.                                                                                | `GET /analytics/price-history/:productId`, `/cost-history/:productId`, `/product-sales/:productId` (636, 646, 679); the latter carries its own 1-500 payload clamp.                                                                                                                                                                                                                                                     |
| FIN-N21 | Bulk expense entry from a single form                           | SHIPPED ✅ | Enter a batch of expenses in one form submission with a per-row created/errors report.                                                                                  | `POST /expenses/bulk` → `bulkCreateExpenses` (471, `Promise.allSettled`); wired at `finance/expenses/new/page.tsx:706`.                                                                                                                                                                                                                                                                                                 |
| FIN-N22 | Per-customer income chart                                       | SHIPPED ✅ | A revenue-over-time series for a single customer.                                                                                                                       | `GET /customers/:id/income-chart` (`customers.controller.ts:347`).                                                                                                                                                                                                                                                                                                                                                      |
| FIN-N23 | Inventory-purchase repair/backfill for mis-routed expenses      | SHIPPED ✅ | Convert existing INVENTORY_PURCHASE expenses that arrived via import into vendor bills after the fact.                                                                  | `POST /import/expenses/repair-inventory` → `backfillInventoryPurchaseExpenses` (921-932). Note: this repair path leaves the same shadow `Expense` row behind that drives the FIN-M4/FIN-M5 double-count — any fix to those must cover this path too.                                                                                                                                                                    |

### Testing criteria

#### FIN-N1

- [ ] A tenant without the `ocr` addon never sees the extract control (today it renders and 403s). `manual`
- [ ] A successful extraction replaces, not appends, existing line items and updates the amount only when the extracted total is > 0. `Jest`
- [ ] An unparseable image returns 400 and leaves existing line items intact. `Jest`
- [ ] An `AiUsageEvent` row is recorded on every outcome, including failure. `Jest`

#### FIN-N2

- [ ] 200 imported rows share one `importBatchId` and the batch list reports count 200 and summed amount. `Jest`
- [ ] Rollback soft-deletes every expense in the batch; it disappears from P&L, cash flow and expense reports. `Jest`
- [ ] Rollback is idempotent when called twice. `Jest`
- [ ] A batch list/rollback control is reachable from the import settings screen — currently absent. `Playwright`

#### FIN-N3

- [ ] Rates effective 1/1 (0.67) and 7/1 (0.70): an expense dated 6/30 snapshots 0.67, one dated 7/1 snapshots 0.70. `Jest`
- [ ] The snapshot is immutable after the rate table changes. `Jest`
- [ ] No rate for the date leaves `mileageRateSnapshot` null rather than silently computing 0. `Jest`
- [ ] A tenant admin can create and retire a mileage rate from a UI — currently impossible. `manual`

#### FIN-N4

- [ ] A request naming both a bill and its already-linked expense writes exactly one `BillPayment`. `Jest`
- [ ] A VOID bill in the selection is reported in `skipped` and the rest of the batch settles. `Jest`
- [ ] A bill with no outstanding balance is skipped with a reason. `Jest`
- [ ] After the batch, `Σ BillPayment.amount == VendorBill.totalPaid` for every touched bill. `Jest`

#### FIN-N5

- [ ] Sales exclude DRAFT, VOID and WRITTEN_OFF invoices. `Jest`
- [ ] Per-item revenue uses the stored line subtotal, never `qty × unitPrice`. `Jest`
- [ ] Per-customer totals sum to the period's invoiced total for the same status filter. `Jest`
- [ ] An ad-hoc line with null `productId` is excluded from sales-by-item rather than crashing. `Jest`

#### FIN-N6

- [ ] A 7-day issue-date window can legitimately report DSO above 7 days — assert this is possible, not blocked. `Jest`
- [ ] Invoices still open at 90 days are either included at current age or the surface states "paid invoices only." `Jest`
- [ ] Zero paid invoices in the window reports `dso: 0, count: 0` with an empty-state caption. `Jest`
- [ ] Distribution percentages sum to 100.00 (±0.01) when count > 0. `Jest`

#### FIN-N7

- [ ] Revenue and COGS derive from one fetch — changing the window changes both or neither. `Jest`
- [ ] A product with no cost history contributes 0 to COGS without zeroing its revenue too. `Jest`
- [ ] An ad-hoc line contributes revenue but 0 COGS. `Jest`
- [ ] `grossMarginPct` is 0, not NaN, when revenue is 0. `Jest`

#### FIN-N8

- [ ] A product sold daily but restocked yearly is not reported as dead stock. `Jest`
- [ ] Supplying a from/to range replaces the rolling `daysInactive` window. `Jest`
- [ ] `margin-alerts` skips products with price ≤ 0 or cost ≤ 0. `Jest`
- [ ] With the tobacco exclusion active, tobacco is absent from all three while P&L still includes it. `Jest`

#### FIN-N9

- [ ] Bucket boundaries are deterministic regardless of the runner's timezone (`now` injected). `Jest`
- [ ] Month buckets use `Date.UTC`, never `setMonth`. `Jest`
- [ ] `hasAnySales=false` distinguishes "never invoiced" from "zero this window." `Jest`
- [ ] 6m returns 26 weekly buckets, 1y returns 12 monthly, 5y returns 60 monthly. `Jest`

#### FIN-N10

- [ ] A VOID payment appears here and simultaneously stops reducing the invoice balance in AR aging. `Jest`
- [ ] A credit note applied against an invoice appears once, not once per allocation row. `Jest`
- [ ] The report total equals the sum of its rows to the cent. `Jest`
- [ ] An empty period returns an empty array with the period echoed, not a 404. `Jest`

#### FIN-N11

- [ ] Σ per-customer balance equals `finance-dashboard.arAging.total` for the same instant. `Jest`
- [ ] A VOID payment does not reduce a customer's reported balance. `Jest`
- [ ] An over-paid customer shows a negative balance rather than being clamped to 0. `Jest`
- [ ] Another tenant's customers never appear in either report. `Jest`

#### FIN-N12

- [ ] Each mobile report's numbers match the equivalent web report for the same period, to the cent. `Playwright`
- [ ] Mobile reports are read-only; no mutation control is reachable from them. `manual`
- [ ] Mobile's expense, payment and statement flows are exercised, not just its 5 reports, when assessing finance parity. `manual`
- [ ] The mobile report index states plainly that the remaining ~15 reports are web-only. `manual`

#### FIN-N13

- [ ] With the toggle on, tobacco revenue is subtracted from analytics revenue but P&L revenue is unchanged. `Jest`
- [ ] With the addon off, the config key alone has no effect. `Jest`
- [ ] AOV keeps the full invoice count while removing only the tobacco value portion. `Jest`
- [ ] Route/driver performance, DSO and cost history are never filtered by this toggle. `Jest`

#### FIN-N14

- [ ] A 250.00 payout creates exactly one Expense of 250.00 categorised COMMISSIONS_AND_FEES. `Jest`
- [ ] That expense appears in expenses-by-category and reduces P&L netProfit by 250.00. `Jest`
- [ ] Reversing a payout removes or offsets the expense. `Jest`
- [ ] With the `sales_agents` addon off, no such rows are created. `Jest`

#### FIN-N15

- [ ] A VOID expense contributes 0 to P&L opex — fails today. `Jest`
- [ ] A VOID expense contributes 0 to cash-flow totalOut — fails today. `Jest`
- [ ] Moving PENDING → PAID stamps `receivedAt`/`paidAt` once, idempotently on resend. `Jest`
- [ ] A batch containing one nonexistent id still transitions the rest and reports the true count updated. `Jest`

#### FIN-N16

- [ ] A FIFO-labelled product's valuation reconciles with the weighted-average figure, and the UI does not claim a FIFO basis. `Jest`
- [ ] A product with null `averageCost` is excluded rather than valued at 0. `Jest`
- [ ] Total valuation equals the sum of per-product rows, rounded to cents. `Jest`
- [ ] The surface states valuation is point-in-time-now with no as-at-date parameter. `manual`

#### FIN-N17

- [ ] Editing a payment's amount recomputes invoice status inside the same transaction. `Jest`
- [ ] Voiding a payment reverses any advance-payment draw-down it created. `Jest`
- [ ] Deleting a payment restores the invoice's prior balance exactly. `Jest`
- [ ] Cross-tenant edit/void/delete attempts return 404. `Jest`

#### FIN-N18

- [ ] An overpayment to a supplier creates a `SupplierCredit` for the excess. `Jest`
- [ ] The credit draws down automatically against the next bill from that supplier. `Jest`
- [ ] A credit never applies across suppliers. `Jest`
- [ ] Credit balance is reflected in AP-facing cash-out reporting. `Jest`

#### FIN-N19

- [ ] Setting a cost basis updates `Product.averageCost` and future COGS estimates immediately. `Jest`
- [ ] Bulk cost-basis set applies atomically — a failure on one row does not partially apply the rest. `Jest`
- [ ] Recompute-costs reconciles `averageCost` against purchase history without drifting on repeat runs. `Jest`
- [ ] Mobile cost-basis screens write through the same endpoints as web. `manual`

#### FIN-N20

- [ ] Price-history and cost-history return chronologically ordered series with no gaps mislabeled as zero. `Jest`
- [ ] `product-sales` respects its 1-500 payload clamp. `Jest`
- [ ] A product with no history returns an empty series, not an error. `Jest`
- [ ] Another tenant's product history is never returned. `Jest`

#### FIN-N21

- [ ] A bulk submission with one invalid row still creates the valid rows and reports the failures. `Jest`
- [ ] Every row in a bulk create is rounded through the same money helper as a single create. `Jest`
- [ ] The bulk form is reachable from `finance/expenses/new`. `Playwright`
- [ ] A fully-failing bulk submission creates zero rows, not partial garbage. `Jest`

#### FIN-N22

- [ ] The chart's totals match `sales-by-customer` for the same customer and window. `Jest`
- [ ] A customer with no sales in the window renders an empty chart, not an error. `Playwright`
- [ ] Written-off invoices are excluded from the chart's revenue. `Jest`
- [ ] Cross-tenant customer ids return 404. `Jest`

#### FIN-N23

- [ ] Running the repair on an already-converted expense is a no-op, not a duplicate vendor bill. `Jest`
- [ ] The repair leaves the same shadow-Expense trail that FIN-M4/FIN-M5 must exclude — assert both together in one fixture. `Jest`
- [ ] The repair is scoped to the calling tenant only. `Jest`
- [ ] The repair is idempotent across repeated runs. `Jest`

## Advanced / future (P2)

| ID      | Capability                                                        | Status     | What it does                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-A1  | Double-entry general ledger and chart of accounts                 | MISSING ⬜ | Every money event posts balanced debit/credit journal lines against a tenant chart of accounts, producing a trial balance that nets to zero. | No `JournalEntry`, `LedgerAccount` or `ChartOfAccounts` model in `schema.prisma`; only `ExpenseCategory` (a flat 20-code list) and report-time aggregation exist.                                                                                                                                                                                             |
| FIN-A2  | Balance sheet                                                     | MISSING ⬜ | Assets, liabilities and equity at a point in time.                                                                                           | No balance-sheet route in `bookkeeping.controller.ts`. The ingredients exist (AR aging, AP via VendorBill, `GET /inventory/valuation`) but nothing composes them.                                                                                                                                                                                             |
| FIN-A3  | Export to an accounting package (QuickBooks / Xero / journal CSV) | MISSING ⬜ | Hand the accountant a file the accounting package ingests.                                                                                   | Only inbound migration connectors exist. verified: a server-streamed CSV export DOES exist for payments (`GET /invoices/payments/export`) and for customers (`GET /customers/export`) — but neither is a journal, so the domain-level gap stands; a remediation proposing to "build a streamed export" should build on the payments export, not duplicate it. |
| FIN-A4  | Bank feed and reconciliation                                      | MISSING ⬜ | Pull bank transactions and match them to recorded payments and expenses.                                                                     | No banking module. The closest analogue is `supplier-statements/` (`statement-matcher.ts`), which reconciles a supplier statement to vendor bills, not a bank statement to cash.                                                                                                                                                                              |
| FIN-A5  | Period close and lock date                                        | MISSING ⬜ | Freeze a reported month so nobody backdates an invoice or edits an expense into a signed-off period.                                         | No lock-date field on `Tenant`/`TenantConfig` and no period guard anywhere in `bookkeeping`; `updateExpense` accepts an arbitrary new date with no check.                                                                                                                                                                                                     |
| FIN-A6  | Sales-tax liability and filing report                             | MISSING ⬜ | Tax collected, owed and paid per jurisdiction for a filing period.                                                                           | No tax report in the bookkeeping family. Tax is captured per line (`InvoiceItem.taxRate`) and a tenant default exists (`TenantConfig.taxRate`), but nothing aggregates it.                                                                                                                                                                                    |
| FIN-A7  | Budget vs actual and a forward cash forecast                      | MISSING ⬜ | Set a monthly budget per category and see variance; project cash from open receivables minus scheduled payables.                             | No `Budget` model. Forecasting today is inventory-only (`GET /inventory/forecasting`), about reorder points, not cash.                                                                                                                                                                                                                                        |
| FIN-A8  | Multi-currency and per-tenant currency display                    | MISSING ⬜ | A tenant outside the US sees, enters and reports in its own currency.                                                                        | `TenantConfig.currency` defaults to USD. verified: it is consumed once — `payment-requests.service.ts:307` reads it for the Stripe payment-request currency — but every display surface (`formatting.ts`, `format.ts`) still hardcodes USD, and no FX-rate model or per-document currency column exists.                                                      |
| FIN-A9  | Scheduled and emailed reports                                     | MISSING ⬜ | A month-end P&L and AR aging that arrive by email without anyone logging in.                                                                 | No scheduled-report job for finance. verified: a `ReportCadence` (MONTHLY/QUARTERLY/ANNUAL) enum and cron already exist for the regulated/compliance filing stream — proving the cron+email seam works, just not wired to finance reports.                                                                                                                    |
| FIN-A10 | Customer and route profitability                                  | MISSING ⬜ | Net contribution per customer and per delivery round — revenue minus COGS minus allocated cost of serving them.                              | The pieces exist separately (sales-by-customer, COGS estimation, route/driver metrics, customer-tagged expenses) and are never joined; no endpoint computes contribution.                                                                                                                                                                                     |
| FIN-A11 | Landed cost allocation                                            | MISSING ⬜ | Push freight, duty and handling on a supplier bill into the unit cost of the goods it delivered.                                             | `Product.averageCost` is AVCO-maintained from purchase unit costs, but no mechanism apportions a freight/duty line across goods lines; no landed-cost field on `VendorBillItem`.                                                                                                                                                                              |
| FIN-A12 | Anomaly detection on spend and margin                             | PARTIAL 🟡 | Flag a duplicate supplier bill, an outsized expense, or a product whose margin quietly collapsed.                                            | Two narrow detectors exist: duplicate purchase-invoice detection (409 guard) and a fixed under-20%-margin list with a hardcoded, non-tenant-configurable threshold. No expense anomaly detection or trend-break alerting.                                                                                                                                     |

### Testing criteria

#### FIN-A1

- [ ] For any period, Σ debits == Σ credits across all journal lines. `Jest`
- [ ] Recording an invoice payment posts exactly two balanced lines. `Jest`
- [ ] A trial balance's AR account equals the AR aging grand total at the same instant. `Jest`
- [ ] Reversing a transaction posts an offsetting entry rather than mutating the original. `Jest`

#### FIN-A2

- [ ] Assets == Liabilities + Equity for any as-at date. `Jest`
- [ ] The receivables line equals the AR aging grand total at the same date. `Jest`
- [ ] The inventory line equals `GET /inventory/valuation` at the same date. `Jest`
- [ ] An as-at date before the tenant's first transaction returns an all-zero statement. `Jest`

#### FIN-A3

- [ ] An export for a closed month matches `GET /reports/invoice-details` for the same window on count and total. `Jest`
- [ ] Re-exporting the same period is byte-identical (deterministic ordering). `Jest`
- [ ] Every exported row carries a stable RouteFlow id so re-import is idempotent. `Jest`
- [ ] Amounts export with exactly 2 decimals and no thousands separators. `Jest`

#### FIN-A4

- [ ] A bank line matching a recorded payment on amount and date within tolerance is auto-matched. `Jest`
- [ ] An unmatched bank line stays in an exceptions queue, never silently dropped. `Jest`
- [ ] Importing the same statement twice creates no duplicate matches. `Jest`
- [ ] After reconciliation, reconciled-balance equals the bank closing balance for the period. `Jest`

#### FIN-A5

- [ ] With a lock date, creating/editing an invoice, payment or expense on/before it is rejected and nothing persists. `Jest`
- [ ] A user with explicit reopen permission can lift the lock, audited. `Jest`
- [ ] Re-running a locked month's P&L is byte-identical on any later date. `Jest`
- [ ] The lock is per tenant and never crosses tenants. `Jest`

#### FIN-A6

- [ ] Tax collected equals Σ(line subtotal × line taxRate) across non-DRAFT/VOID/WRITTEN_OFF invoices for a quarter. `Jest`
- [ ] A credit note issued in the period reduces the liability for that period. `Jest`
- [ ] A tax-exempt customer contributes 0 and is listed separately with its exemption reference. `Jest`
- [ ] Changing the tenant default tax rate never retroactively changes an issued invoice's tax. `Jest`

#### FIN-A7

- [ ] A 5,000.00 budget vs 5,400.00 actual reads −400.00 (−8.0%) and flags over budget. `Jest`
- [ ] A 13-week projection's week-one inflow equals the sum of invoice balances due that week. `Jest`
- [ ] Changing an invoice due date moves that amount to the new week on next read. `Jest`
- [ ] No budget set shows an empty-state prompt, not an implied 0-budget overspend. `Jest`

#### FIN-A8

- [ ] A GBP-configured tenant sees £ on every finance surface — dashboard, reports, exports, PDFs. `Playwright`
- [ ] A GBP tenant's exported CSV carries the GBP symbol or code, not $. `Jest`
- [ ] Changing tenant currency never re-denominates historical documents. `Jest`
- [ ] Mixed-currency totals are refused or explicitly converted at a stored rate. `Jest`

#### FIN-A9

- [ ] A weekly AR-aging schedule delivers exactly one email per cycle to configured recipients. `Jest`
- [ ] Attached figures match the same report requested interactively for the identical window. `Jest`
- [ ] A delivery failure is retried and surfaced in-app. `Jest`
- [ ] Disabling a schedule stops delivery within one cycle, audited. `Jest`

#### FIN-A10

- [ ] For 10,000 revenue, 6,500 COGS, 400 tagged expense, contribution reads 3,100 before allocation. `Jest`
- [ ] The shared-cost allocation basis is stated on the surface; allocated amounts sum to the allocated pool. `Jest`
- [ ] Σ per-customer contribution + unallocated overhead == P&L netProfit for the period. `Jest`
- [ ] A zero-revenue customer with tagged cost still appears, showing negative contribution. `Jest`

#### FIN-A11

- [ ] A 1,000 goods / 100 freight bill, allocated by value, raises each product's cost basis by exactly 10% with no rounding residue. `Jest`
- [ ] After allocation, Σ(unit cost × qty received) equals the bill's allocable total to the cent. `Jest`
- [ ] Re-allocating an already-allocated bill is refused or reverses the prior allocation first. `Jest`
- [ ] Period gross margin after allocation is strictly lower, by exactly the freight consumed by sales. `Jest`

#### FIN-A12

- [ ] An expense 3σ above its category's trailing 12-month mean is surfaced for review, not auto-posted. `Jest`
- [ ] A bill matching supplier + amount + date window returns 409 with the matched bill id. `Jest`
- [ ] The margin-alert threshold is a tenant setting, not hardcoded at 20%. `Jest`
- [ ] No alert fires in a tenant's first 30 days; the surface states why. `Jest`

## How this varies by tenant

| Variation                                                                                                                                                                                                 | Mechanism                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The full canned-report catalogue can be withheld from lower plans; core money endpoints (summary, dashboard, transactions, expenses, bulk-mark-paid, finance-dashboard) stay open by deliberate decision. | Plan flag `flag.reports` via `@RequirePlanFlag` on each `reports/*` handler — except the Ledger report, which reads `GET /transactions` and carries no gate at all.                                                                |
| The entire analytics surface (16 endpoints) is plan-restricted at the controller class level, and purchasable à la carte.                                                                                 | Plan flag `flag.analytics`, class-level on `AnalyticsController`; also mapped to the FORECASTING addon SKU.                                                                                                                        |
| Both of the above gates are currently inert — every tenant on every plan gets all reports and all analytics regardless of entitlement.                                                                    | Kill switch: `flag.reports` and `flag.analytics` are in `DARK_PLAN_FLAGS`; `PlanFlagGuard` returns true unless `PLAN_FLAG_ENFORCEMENT === 'on'`. Slated for removal 2026-10-01.                                                    |
| Inventory demand forecasting and reorder-point editing are a separate paid capability from analytics.                                                                                                     | Plan flag `flag.forecasting`; also the FORECASTING addon SKU.                                                                                                                                                                      |
| AI receipt/document reading is per-tenant purchasable; without it, expenses are keyed by hand.                                                                                                            | Addon key `ocr`; granted from the platform-admin addon toggle.                                                                                                                                                                     |
| A regulated-goods dealer can hide that product class from headline analytics while keeping it in compliance reporting and the accounting P&L.                                                             | Addon `tobacco_dealer` AND tenant config key `tobacco.excludeFromMainAnalytics` — both required.                                                                                                                                   |
| Sales-agent commissions appear in the P&L only for tenants running an agent model.                                                                                                                        | Addon `sales_agents`; payouts book a COMMISSIONS_AND_FEES expense.                                                                                                                                                                 |
| Expense chart of accounts.                                                                                                                                                                                | **NOT CONFIGURABLE in practice** — `POST /expense-categories` exists but has zero UI callers, so every tenant is locked to the same fixed 20 IRS-shaped categories (bug-register B41).                                             |
| Mileage reimbursement rates.                                                                                                                                                                              | **NOT CONFIGURABLE in practice** — create/delete routes exist but no screen calls them (bug-register B42).                                                                                                                         |
| AR aging bucket width.                                                                                                                                                                                    | Request-scoped query param only (`?intervalDays=N`), **not a stored tenant setting**; the finance-dashboard bands are hardcoded regardless.                                                                                        |
| Display currency and business timezone.                                                                                                                                                                   | `TenantConfig.currency`/`.timezone` exist in the data model but are **barely consumed** — currency is read once (Stripe payment requests) and every display surface hardcodes USD; timezone has no reader at all in `bookkeeping`. |
| Fiscal year start.                                                                                                                                                                                        | **NOT CONFIGURABLE** — hardcoded to 1 January in every default window across bookkeeping and analytics.                                                                                                                            |
| Inventory costing method (FIFO/LIFO/AVCO/STANDARD/LAST_COST).                                                                                                                                             | Per-product column exists, but **presentational only** — valuation is weighted-average for every method because the FIFO/LIFO lot-consumption path has no caller.                                                                  |
| Basis of accounting (cash vs accrual).                                                                                                                                                                    | **NOT CONFIGURABLE — and currently mixed**: P&L revenue is cash-basis, P&L expenses are accrual-basis, hardcoded.                                                                                                                  |

## Gaps for a great UX

| Severity | Gap                                                                                                 | Impact                                                                                                                                                                                                                                                                                                                                                                               | Suggested direction                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | `DELETE /settings/financial-data` destroys every tenant's financial history from any operator token | Ten unscoped `deleteMany({})` calls bypass tenant scoping entirely, guarded only by an OPERATOR role check. One click at one tenant erases paid invoices, payment history and supplier bills for every other tenant — unrecoverable without a restore, and it destroys legally-retained PAID documents.                                                                              | Delete the endpoint, or rewrite against `forTenant()` with a typed-back tenant-slug confirmation, owner-level role gate, refusal on any PAID invoice, and an AuditLog row with deleted-row counts. Add a Jest spec asserting tenant B survives tenant A's call.              |
| CRITICAL | P&L and cash flow double-count inventory purchases                                                  | The shadow `Expense` row survives auto-conversion to a `VendorBill`; neither `getProfitAndLoss` nor `getCashFlow` excludes INVENTORY_PURCHASE, while `listExpenses`/`listExpenseCategories` do — proving the intent. A stock-heavy distributor sees reported profit far too low and reported cash outflow roughly doubled. The repair/backfill path (FIN-N23) leaves the same trail. | Apply the same INVENTORY_PURCHASE exclusion used by `listExpenses` to `getProfitAndLoss`, `getCashFlow`, and every expense report; or drop the shadow row once conversion succeeds. Pin with a Jest spec covering both the original conversion and the repair-backfill path. |
| CRITICAL | Plan gates for reports and analytics are dark, with no UI gate surface behind them                  | Every tenant gets the full catalogue free today. Flipping `PLAN_FLAG_ENFORCEMENT` on would turn 18 of 19 reports into a generic error state and silently swallow analytics 403s into empty charts — no upsell, no explanation, and the Ledger report would keep working ungated.                                                                                                     | Wire `LockedPage`/`InlineResolveModal` into the reports and analytics pages before enforcement, add a gate to the Ledger report for consistency, and audit live-tenant entitlement impact first.                                                                             |
| HIGH     | The P&L mixes cash-basis revenue with accrual-basis expenses, with no basis selector                | Reported net profit corresponds to no recognised accounting basis and will not agree with either a cash-basis or accrual set of books, with no label telling the reader which is in play.                                                                                                                                                                                            | Add an explicit cash/accrual toggle applied consistently across revenue, COGS and expenses; label the active basis on the report header.                                                                                                                                     |
| HIGH     | Dashboard cash figures bucket payments on `createdAt`, disagreeing with the cash-flow report        | Finance-dashboard, summary and mobile-dashboard window payments on the row-insert timestamp instead of `settledAt ?? paidAt`; a check received in February but keyed in March shows in the wrong month, and the operator sees two different "cash this month" numbers in the same product.                                                                                           | Replace `createdAt` with the shared `settledDateFilter` helper in all three dashboard readers.                                                                                                                                                                               |
| HIGH     | No period close or lock date                                                                        | Nothing stops backdating an invoice or editing an expense's date into an already-reported month; re-running last quarter's P&L can return a different number every time.                                                                                                                                                                                                             | Add a per-tenant lock date, enforce it in a shared guard on every finance write path, allow an audited reopen.                                                                                                                                                               |
| HIGH     | Reports return unbounded payloads with no server-side pagination                                    | Invoice-details, bad-debts, payments-received and AR aging-invoices all issue unbounded `findMany`; CSV export materialises the whole set client-side. Note: the transactions/Ledger and invoice-payments endpoints ARE already server-paginated — the gap is specifically the reports family, not the whole domain.                                                                 | Add limit/offset to every list-shaped report with a server-enforced max; keep aggregate totals server-side over the full set; stream CSV export server-side using the existing payments-export pattern as the template.                                                      |
| HIGH     | No general ledger and no accounting-package export — the accountant still re-keys                   | No chart of accounts beyond a flat 20-code list, no journal, no trial balance, no balance sheet, and no outbound accounting export (only inbound migration connectors and a payments/customers CSV, neither a journal).                                                                                                                                                              | Ship a deterministic per-period journal CSV derived from existing invoice/payment/expense/bill tables before attempting a full posting engine — a fraction of the work, most of the re-keying removed.                                                                       |
| MEDIUM   | Expense categories and mileage rates are API-only — the client hooks are dead                       | A tenant is locked to the 20 seeded categories and cannot enter a mileage rate at all, making the mileage-expense feature unusable in practice (bug-register B41, B42, both Open).                                                                                                                                                                                                   | Add a Finance → Settings panel exposing category create/rename and a dated mileage-rate table.                                                                                                                                                                               |
| MEDIUM   | Currency and timezone are hardcoded on display                                                      | Every finance surface pins USD and server-local/UTC period boundaries regardless of `TenantConfig.currency`/`.timezone`; a distributor invoicing near midnight in their own timezone can book into the wrong period.                                                                                                                                                                 | Thread `TenantConfig.currency` through a formatting provider on web and mobile; take period boundaries from `TenantConfig.timezone` via a shared helper, following the `demand-range.ts` pattern of injecting `now` rather than reading the clock.                           |
| MEDIUM   | Mobile ships 5 of ~20 reports                                                                       | An owner on the road cannot see aging details, payments-received, expense breakdowns or bad debts from the mobile report catalogue — exactly what a collections call needs — even though mobile's broader finance surface (expenses, payments, statements) is otherwise strong.                                                                                                      | Extend the mobile report registry to the receivables and payments families first, reusing the same endpoints.                                                                                                                                                                |
| MEDIUM   | Money edits carry no field-level audit                                                              | The global audit interceptor records only route + user + IP; an expense amount changed from 100.00 to 10,000.00 leaves no before/after trail, unlike invoices, credit notes, commissions and regulated filings which all call `AuditService` explicitly.                                                                                                                             | Call `AuditService` with before/after values from `createExpense`, `updateExpense`, `deleteExpense`, `recordPayment` and `bulkMarkPaid`; surface an expense history strip on the detail view.                                                                                |
| MEDIUM   | Windowed DSO reads misleadingly (survivorship, not the originally-suspected window cap)             | `getDso` and `getTimeToGetPaid` count only invoices that reached PAID, so narrowing the range drops the slow payers still outstanding and understates true collection time; the card renders with no caption explaining the basis (bug-register B119, Open).                                                                                                                         | Either include still-open invoices at their current age, or caption the card "paid invoices only, issued in period" and disable it for windows shorter than the tenant's average terms.                                                                                      |
| MEDIUM   | The OCR scan control is visible to tenants without the addon                                        | Server-gated on `@RequireAddon('ocr')`, but the client wires the button unconditionally — a tenant without the addon clicks it and gets a raw 403.                                                                                                                                                                                                                                   | Gate the control on the addon hook, following the pattern used elsewhere for route/delivery access; render a disabled "Add AI scanning" affordance when off.                                                                                                                 |
| LOW      | `createExpense` writes unrounded money                                                              | Mileage amount (`distance × Decimal(10,4) rate`) and summed itemized lines are written to a `Decimal(10,2)` column with no `roundMoney` — the only money write in this service that skips the shared helper.                                                                                                                                                                         | Wrap both computations in `roundMoney`; add the invariant to the Jest spec.                                                                                                                                                                                                  |
| LOW      | The bookkeeping transaction detail page is unreachable                                              | The detail page exists with an invoice-PDF download, but nothing links to it — the ledger report renders the invoice number as a plain span (bug-register B14, Open).                                                                                                                                                                                                                | Link the ledger's invoice-number cell to the existing detail page, or remove the orphaned route if the invoice page is canonical.                                                                                                                                            |

## Cross-domain handoffs

- **Invoices → Finance**: every revenue, AR aging and receivable figure reads `Invoice`/`InvoiceItem`/`InvoicePayment`. Status semantics are load-bearing — DRAFT/VOID/WRITTEN_OFF are excluded wholesale, and VOID payments (bounced checks) must stay excluded from every paid-sum. A status-transition change silently moves money in five reports.
- **Invoices ↔ Orders**: order/invoice reconciliation keeps the two in sync; order-date backdating sets the invoice issue date and therefore which reporting period a sale lands in.
- **Inventory → Finance**: COGS and gross margin are estimated from `Product.averageCost` at the invoice's issue date. Any change to AVCO maintenance moves reported profit. `GET /inventory/valuation` is the closing-inventory figure a balance sheet would need. Cost-basis maintenance (FIN-N19) is the operator-facing input to all of it.
- **Vendor bills / purchases → Finance**: `BillPayment` is the money-out ledger for cash flow; the INVENTORY_PURCHASE expense→VendorBill auto-conversion is the handoff that currently double-counts in P&L and cash flow, and the repair/backfill path inherits the same defect.
- **Supplier statements → AP**: reconciles a supplier's statement to vendor bills and applies the result — the closest thing to reconciliation in the product today, and the natural template for a future bank feed (FIN-A4). Supplier credits (FIN-N18) are the AP mirror of customer advance payments (FIN-M13).
- **Credit notes & returns → Finance**: credit notes feed the refund-history report and reduce receivables; returns/credit notes are documented as NOT netted out of analytics units or COGS.
- **Sales agents → Finance**: a commission payout books a COMMISSIONS_AND_FEES expense, reaching the P&L and cash flow with no bookkeeping code changes; deleting or voiding a payout must offset the expense's cost recognition.
- **Billing / entitlements → Finance**: `PlanFlagGuard` + entitlements decide whether reports and analytics exist for a tenant; the dark-flag kill switch currently neutralises both gates, so flipping it is a cross-domain release event, not a config change.
- **Regulated / tobacco → Finance**: excise and compliance filings are a separate reporting stream; the tobacco exclusion toggle removes tobacco from analytics but must never remove it from the P&L.
- **Import / migration → Finance**: bulk expense import (with batch rollback) and the CSV source connectors are how a tenant's historical books arrive; comma-formatted amounts from a QuickBooks/Excel export are a known parsing hazard.
- **Storage / uploads → Finance**: expense receipts, invoice PDFs and payment receipt images are HMAC-signed objects on the Railway volume, forming part of the audit trail for a claimed expense or payment.
- **Payments / Stripe Connect → Finance**: buyer-initiated payments create `InvoicePayment` rows that flow into cash reports; the `settledAt` vs `paidAt` distinction is where a gateway payout date belongs. `TenantConfig.currency` already reaches this handoff even though display surfaces do not.
- **Customers → Finance**: advance payments, standalone payment recording, and monthly statement PDFs are all customer-scoped finance surfaces that sit alongside the invoice/payment core, not inside the reports family.
- **Audit → Finance**: the global audit interceptor records only the route of every finance mutation, no values — finance is currently the largest money surface in the product with no field-level audit of its own.
- **Mobile ↔ Web**: mobile consumes the same endpoints as web for reports, but also ships its own expense-capture, payment-recording and statement screens that mirror web's customer-facing finance surfaces more completely than the report catalogue alone suggests — any response-shape change must be checked against both clients, since web is the golden reference.

## What we could not verify

- Nothing was executed — no Jest, no Playwright, no live API call. Every status above is a code reading against the repo, cross-checked by a second adversarial read. Per this repo's own standing rule, a cached test replay proves nothing, so a local "green" run would not have been trusted here either.
- The two double-count findings (P&L opex+COGS; cash flow expense+BillPayment) are inferred from verified code facts (the shadow Expense row survives conversion; neither report excludes it; sibling list endpoints do exclude it) but no fixture was constructed to observe the doubled number directly. Confidence is high; a regression spec should confirm before anyone quotes a figure from these reports.
- `apps/web/lib/api/finance.ts` was checked by targeted grep for hook names, not read end to end; a caller for one of the "dead" hooks (expense-category creation, mileage-rate creation) could in principle exist outside the paths searched, though all of `apps/web/app` was grepped for each name.
- Several report bodies (refund-history, receivable-summary, sales-by-driver, ar-aging-details, estimate-details, expenses-by-customer) had their routes and entry points confirmed but not every internal line read — their test criteria are written from the route contract and sibling patterns rather than derived from a full read.
- Bug-register cross-references (B14, B40, B41, B42, B118, B119, B126/B127) are taken from the local bug register; B41, B42 and B126/B127 were independently re-confirmed in source during this pass.
- The deployed environment's `PLAN_FLAG_ENFORCEMENT` value was not checked — the "gates are currently dark" claim reflects the code default, not confirmed production configuration.
- Which plan tier grants `flag.reports` vs `flag.analytics` is read from design-package specs, not a seeded catalog row, so the tier boundary may have moved since.
- This domain's analysis required a second adversarial pass that produced two status corrections, seven evidence corrections, two understated findings, and eleven previously-missed capabilities (four of them Must Have) — a materially heavier correction rate than a clean first pass. Treat the reconciled version here as more reliable than either input alone, but a further human spot-check of the double-count and FIN-N15 findings specifically is worthwhile before they drive prioritization.
