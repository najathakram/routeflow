# F16 · Numbering, aggregates and pagination

**Bug IDs (8):** B12, B80, B89, B100, B110, B117, B144, B169

**Root cause:** Aggregates computed over a capped page instead of in SQL, and lists paginated on a non-unique column. B100 is the sharp one: invoice numbers minted from an UNSCOPED cross-tenant max+1, with a pad-4 string sort that jams the series permanently at 9999.

**Ships as:** One PR. Widen the card beyond the cited lines: `limit: 999` is a literal page size silently truncating at FIVE KPI reads (invoices/page.tsx:235, vendor-bills/page.tsx:1053 and :2321, credit-notes/page.tsx:557, estimates/page.tsx:704) — unify the three magic numbers (0 = real fetch-all sentinel, 999, 1000) for two concepts. useOrders has no `search` parameter at all (web/lib/api/orders.ts:170-181) — B144's fix is a DTO + hook change, then deleting the client-side filter AND sort at orders/page.tsx:335-361. returns/page.tsx:404 fetches a second limit:500 query purely to compute two counts — should consume the same new server aggregate.

**Files:** invoices.service.ts · customers.service.ts · supplier-statements · orders list DTO · web invoices, orders, returns, vendor-bills, credit-notes, estimates pages

**Together because:** One class of mistake (client-side aggregation / non-unique pagination) across many list endpoints.

**Guardrails / shared infra:** Uses the F01 counter table and delivers G6 — adopt the existing NumberingService.reserveNext (import/numbering.service.ts:167) for all five independent findFirst-max-and-increment minters (invoices.generateInvoiceNumber, credit-notes.nextCnNumber, estimates.nextEstNumber, returns.generateReturnNumber, invoices.nextPaymentNumberInTx). NO new counter table — NumberingSequence already exists (schema.prisma:3772); B100 needs at most a year dimension added to it via F01.

**Dependencies / lane notes:** Requires F01, F03, F15 (semantic/positional). Last in three lanes: orders.service.ts (F06->F07->F11->F22+F24->F16), invoices.service.ts (F03->F07->F09->F16), customers.service.ts (F02->F15->F16).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F16.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B12  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B80  | T2   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B89  | T1   | e5b0af8e       | OUT_OF_BOUNDS                |
| B100 | T1   | 0cd59277       | OUT_OF_BOUNDS                |
| B110 | T2   | 0cd59277       | NO_TOKEN_UNVERIFIED          |
| B117 | T1   | 0cd59277       | MOVED (disambiguate in-file) |
| B144 | T2   | 0b2c3a0a       | OUT_OF_BOUNDS                |
| B169 | T1   | 0b2c3a0a       | OK                           |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B12 — Invoice KPI tiles go wrong past 999 invoices

**Area:** Invoices · web

**Meant to do:** Invoice-list KPI tiles (Total Outstanding, Due Today, Due in 30, Overdue, Avg Days to Pay) should reflect every invoice accurately and stay fast as the tenant's invoice volume grows.

**Actually does:** `PaymentSummaryBar` in apps/web/app/(dashboard)/invoices/page.tsx calls `useInvoices({ limit: 999 })` (line 235) and reduces the client-side array in a `useMemo` (lines 238-305) to compute every KPI tile. The API's own hard ceiling is `MAX_LIST_LIMIT = 1000` (apps/api/src/common/pagination.ts:11), so 999 is deliberately just under that cap — any tenant with more invoices than that silently drops the oldest ones (default sort is `issueDate desc`) from every tile.

**The gap:** Past 999 invoices the tiles quietly become wrong (undercounted outstanding/overdue) with no error or indication, and the full-record client-side fetch+reduce is inherently less efficient than a server aggregate.

**Evidence:** apps/web/app/(dashboard)/invoices/page.tsx:235 (`useInvoices({ limit: 999 })`), 249-305 (client reduce for totalOutstanding/dueToday/dueIn30/overdue/avgDays); apps/api/src/common/pagination.ts:11 (MAX_LIST_LIMIT=1000); apps/api/src/invoices/dto/list-invoices.dto.ts:35 (`@Max(MAX_LIST_LIMIT)`); contrast apps/api/src/invoices/invoices.service.ts:4098-4187 listAllPayments computing `summary.totalReceived` server-side (PAID-only, lines 4174-4180) and apps/web/lib/api/invoices.ts:254-264 useInvoicePayments consuming that server `summary` — the Payments Received page's KPI pattern the claim references.

**Suggested fix:** Add a server-computed summary endpoint/aggregate for the invoice-list KPI tiles (mirroring listAllPayments' summary pattern) instead of fetching up to 999 full invoice records and reducing client-side.

### B80 — Payment receipt page reports "not found" for any payment outside the 200 most recent

**Area:** apps/web/app/(dashboard)/finance/payments/[id]/page.tsx

**Meant to do:** Clicking any payment row — including from a filtered or older view — opens that payment's receipt page.

**Actually does:** The page fetches useInvoicePayments({limit:200}) (default sort paidAt desc) and does a client-side `find(p => p.id === id)`. A dedicated usePaymentDetail(id) hook hitting the working GET /invoices/payments/:paymentId endpoint exists and is never called from this page.

**The gap:** Any payment beyond the 200 most recent renders "Payment not found" even though the row that linked to it is directly reachable and the correct single-fetch endpoint already exists, unused.

**Evidence:** apps/web/app/(dashboard)/finance/payments/[id]/page.tsx:27-37, :82-91; apps/web/lib/api/invoices.ts:252-257 (useInvoicePayments) and :735-741 (usePaymentDetail, unused); apps/api/src/invoices/invoices.controller.ts:91-94; apps/api/src/invoices/invoices.service.ts:4098-4154 (listAllPayments, clamped limit, paidAt desc); apps/web/app/(dashboard)/finance/payments/page.tsx:784, :836 (both entry points route here).

**Suggested fix:** Swap the client-side find for the existing usePaymentDetail(id) hook.

### B89 — Invoice and payment date filters close the window at server-local end of day

**Area:** apps/api/src/invoices/invoices.service.ts

**Meant to do:** A dateTo filter closes a UTC-consistent window so results don't depend on the server process's local timezone — as every other date-range query in the API does.

**Actually does:** Four blocks parse dateTo as a UTC-midnight Date then call local-time `.setHours(23,59,59,999)` on it, producing an `lte` bound shifted by the server's UTC offset while the `gte` side stays true UTC midnight.

**The gap:** Asymmetric boundary construction (local setHours over a UTC-parsed base, against setUTCHours everywhere else). Verified direction: for any non-UTC server timezone the bound lands EARLIER than true UTC end-of-day, so legitimate rows late in the target day silently drop out of filtered reports — it does not leak next-day rows in.

**Evidence:** apps/api/src/invoices/invoices.service.ts:2798-2818, :4130-4138, :5167-5175 (all four sites); contrast apps/api/src/bookkeeping/bookkeeping.service.ts (17 setUTCHours sites), analytics.service.ts:154, inventory.service.ts:144, tobacco.service.ts:26. Live check: under America/Los_Angeles the bound resolves to 2026-08-26T06:59:59.999Z, under Asia/Kolkata to 18:29:59.999Z — both short of the true UTC day end. invoices.service.spec.ts:2978-2984 asserts the buggy local expectation, so no test catches it.

**Suggested fix:** Use `.setUTCHours(23,59,59,999)` at all four sites and update the spec expectation.

### B100 — Invoice numbers minted from unscoped cross-tenant max+1; pad-4 string sort jams the series at 9999

**Area:** Invoicing · API

**Meant to do:** Each tenant gets its own clean INV-YYYY-NNNN sequence starting at 0001, and invoice creation keeps working no matter how many invoices exist.

**Actually does:** New-invoice paths compute next number from the GLOBAL max across all tenants (bare prisma, no forTenant), and the desc string sort over pad-4 numbers pins the max at 9999, looping 409s forever past 10000.

**The gap:** No counter table; unscoped scan leaks cross-tenant volume into numbering; string sort makes creation permanently fail once any series passes 9999.

**Evidence:** apps/api/src/invoices/invoices.service.ts:2723-2733 (client = db ?? this.prisma; orderBy invoiceNumber desc; padStart(4)), :243-244, :467 (create path, no db), :2664 (createPartialFromOrder, no db), :2700-2701 (P2002→409 'please retry'); apps/api/src/prisma/prisma.service.ts:223-227 (forTenant is opt-in; bare client unscoped; no RLS policies exist in any migration — grep for ROW LEVEL SECURITY returns nothing); apps/api/prisma/schema.prisma:1896 (@@unique([tenantId, invoiceNumber])); siblings verified: estimates.service.ts:16-25 (tenant-scoped but same pad-4 string-sort wall), orders.service.ts:1908-1916 (pad-5). Computed: 'INV-2026-9999' > 'INV-2026-10000' lexicographically ('9'>'1' at position 9), so findFirst desc returns 9999 forever and seq re-mints 10000 on every call.

**Suggested fix:** Add a per-tenant, per-year InvoiceCounter table (like PaymentCounter) updated atomically inside the create transaction; or at minimum run the scan through forTenant()/tx and sort numerically (parse the suffix or order by a numeric column). Apply the same fix to the EST/CN/BILL/PO/CST/ORD generators.

### B110 — Customer statement Outstanding/Overdue silently drops unpaid invoices past a 100-invoice cap

**Area:** Customer statement · operator web + buyer web/mobile

**Meant to do:** The Outstanding/Overdue balance on the operator's customer page and the buyer's Payments/Finances screens reflects every unpaid invoice the customer has, regardless of invoice count.

**Actually does:** getStatementForOperator fetches only the 100 newest invoices (50 credits/advances) and reduces in memory; any still-unpaid invoice older than the newest 100 is silently omitted from Outstanding/Overdue on every surface, with no partial-data flag.

**The gap:** Aggregate figures computed over a capped page instead of a SQL aggregate; error grows silently with tenant history.

**Evidence:** apps/api/src/customers/customers.service.ts:864-877 (take:100), 878-895 (take:50 ×2), 923-934 (capped reduces); same shape in getMyStatement :254-278 (take:50); reused by buyers via apps/api/src/buyer/buyer.controller.ts:232-239; rendered at apps/web/app/(dashboard)/customers/[id]/page.tsx:1948, 2390, 3694, apps/web/app/buyer/portal/[seller]/payments/page.tsx:141,260, finances/page.tsx:105, apps/mobile/app/(customer)/payments.tsx:51,119.

**Suggested fix:** Compute outstanding/overdue with grouped SQL aggregates over ALL non-PAID/VOID/WRITTEN_OFF invoices (and availableCredit over all open credits), keeping the take:100 list purely for display; apply the same to getMyStatement.

### B117 — Statement bill matching caps candidates at 500 with no orderBy

**Area:** Supplier statements · API

**Meant to do:** A supplier statement line should match its real corresponding vendor bill no matter how many historical bills the supplier has accumulated.

**Actually does:** Both fetchMatchableBills copies query vendorBill.findMany with take: 500 and no orderBy; past 500 non-VOID bills (PAID included, so the set grows forever) the candidate pool is capped and DB-order-arbitrary, so real bills become invisible to the matcher.

**The gap:** Lines backed by excluded bills report UNMATCHED as false discrepancies, non-deterministically; the apply step re-derives from the same capped pool.

**Evidence:** apps/api/src/supplier-statements/supplier-statements.service.ts:528-541 (take: 500 at :540, no orderBy); apps/api/src/supplier-statements/statement-apply.service.ts:445-458 (identical query, take: 500 at :457) with its :435-443 comment confirming it mirrors the review-grid query exactly; :108-120 (apply re-runs matchStatementLines against this same pool to validate confirmed lines).

**Suggested fix:** Remove the cap or raise it with orderBy: { billDate: "desc" } and, better, restrict candidates to bills with outstanding balance (totalOwed > totalPaid) so the pool stays small and deterministic; apply the same change to both copies.

### B144 — Orders search filters only the loaded page and then hides the pager, so off-page matches are unreachable

**Area:** Orders list · web

**Meant to do:** Typing a customer name or order number into "Search customer or order #…" finds that order anywhere in the tenant's history, like every other filter on the same toolbar.

**Actually does:** useOrders is called without any search param; the query filters one page of data in a useMemo, and both the per-page selector and the page buttons are hidden while a search is active.

**The gap:** An order past page 1 reports "No orders match your search" and the pager needed to reach it has just disappeared.

**Evidence:** apps/web/app/(dashboard)/orders/page.tsx:320-329 (useOrders takes status/urgent/dates/productId/fulfillPath/page/limit only), :335-362 (client-side filter and sort over the loaded page), :611-617 (the input), :952-997 ("(filtered)" and the empty state), :979 and :998 (the !customerSearch guards that hide both pagers); apps/web/lib/api/orders.ts:170-189 (the param type has no search); server support already exists at apps/api/src/orders/dto/list-orders.dto.ts:14 and orders.service.ts:283-285.

**Suggested fix:** Send the debounced query as search to GET /orders and drop both the client-side filter and the !customerSearch pager guards. Note the server's search currently matches only customer.businessName and sits in an else-if with customerId — extend it to an OR over orderNumber so the placeholder's promise actually holds.

### B169 — Orders, invoices and customers paginate on a non-unique sort column with no id tiebreaker

**Area:** List pagination · API

**Meant to do:** Paging through a list shows every matching row exactly once, in a stable order, however many rows share the same sort-key value.

**Actually does:** All three findAll implementations pass a single-column orderBy to skip/take with no unique secondary key, so rows tied on the sort key have no guaranteed order between the page-1 and page-2 queries.

**The gap:** A row tied at a page boundary can appear on both adjacent pages or on neither, with no signal to the operator.

**Evidence:** apps/api/src/orders/orders.service.ts:306-324 (orderBy createdAt desc, skip/take); apps/api/src/invoices/invoices.service.ts:2821-2844 (allowlisted single field, default issueDate); apps/api/src/customers/customers.service.ts:141-179 (single field or createdAt desc); none of the three appends a unique column.

**Suggested fix:** Append { id: "desc" } — matching the primary direction — as the final orderBy element in all three findAll implementations; a one-line change per service with no API surface change.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
