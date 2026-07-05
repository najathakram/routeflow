## 8. Operator — Finance: Dashboard, Invoices, Recurring, Payments, Credit Notes, Estimates, Expenses, Reports, Bookkeeping

**Role(s):** Operator / Tenant Admin (back-office AR + AP). CUSTOMER role sees a read-only slice of `/invoices` only (no create/delete/export — gated by `user.role === "CUSTOMER"`). • **Entered via:** the dashboard left-nav **Finance** group and the **Invoices** top-level item. This is the largest operator area — accounts-receivable (customer invoices, payments, credit notes, estimates) **and** accounts-payable (expenses, inventory purchases) plus the whole finance-reporting stack.

Money math flows through `apps/web/lib/pricing.ts` (`computeLineSubtotal` boxed proration, `normalizeBoxesPieces`, `roundMoney`, `getTierPrice`) — the web mirror of the API/mobile helpers. Every displayed amount is `$X.XX` via `lib/formatting.ts` `fmt`. Invoice **total = subtotal + tax** (±$0.01), locked by `e2e/06-critical-paths.spec.ts` CP-01/03/04/07.

> **Routing note — six of the listed routes are thin redirects, not screens.** Documented here so the redesign doesn't build pages for them:
> | Route | Redirects to |
> |---|---|
> | `/finance` | `/finance/dashboard` |
> | `/finance/customers` | `/finance/reports?report=customer-balance` |
> | `/invoices/create` | `/invoices/new` (the scan-to-add builder, documented in `04-op-orders.md`) |
> | `/invoices/payments` | `/finance/payments` |
> | `/bookkeeping` | `/finance/reports?report=ledger` |
> | _(none else)_ | |
>
> Real pages: `/finance/dashboard`, `/invoices` (list), `/invoices/[id]`, `/invoices/[id]/edit`, `/invoices/recurring` (+`/new`), `/credit-notes` (+`[id]`), `/estimates` (+`[id]`), `/finance/expenses` (+`/new`), `/finance/payments` (+`[id]`), `/finance/reports`, `/bookkeeping/[transactionId]`, `/shipments`.

---

### 8.1 Finance overview

#### Finance dashboard — `/finance/dashboard`

- **File:** `apps/web/app/(dashboard)/finance/page.tsx` (redirect) → `apps/web/app/(dashboard)/finance/dashboard/page.tsx`
- **Purpose:** Single-glance AR + cash health. Header `<h1>` reads **"Finance Overview"** (page title set to match).
- **Shows:** Data from `useFinanceDashboard()`.
  - **Total Receivables** card — big `{arAging.total}`, "View Report" link → `/finance/reports?report=ar-aging`. A **stacked AR-aging bar** (Current / 1-15 / 16-30 / 31-45 / 45+) with per-bucket `$` labels; empty → "No outstanding receivables".
  - **Sales and Expenses** — CSS bar chart (`BarChart`, custom SVG-free) of monthly `{sales.data}` (sales/receipts/expenses per month) with a `Total Sales / Receipts / Expenses` legend showing YTD totals.
  - **Top Expenses** — SVG `DonutChart` of `{topExpenses}` (top 5 categories); "View all" → `/finance/expenses`.
  - **Sales, Receipts & Dues** table — rows Today / This Week / This Month / This Quarter / This Year from `{summaryTable}` (sales, receipts green, due red).
  - **Action stats** (4 clickable tiles): Overdue (>30d) → `reports?report=ar-aging`; Received this week → `/finance/payments`; Total expenses YTD → `/purchases?tab=expenses`; Net outstanding this month → `/invoices?status=OVERDUE`.
- **Actions:** **Refresh** (`refetch`); every AR bar segment + bucket label is a deep-link (`current`→`/invoices?status=SENT`, all overdue buckets → `/invoices?status=OVERDUE`).
- **States:** full-page spinner while loading; each block guards on `?? 0` / empty text.

---

### 8.2 Invoices (AR)

#### Invoices list — `/invoices`

- **File:** `apps/web/app/(dashboard)/invoices/page.tsx`
- **Purpose:** Browse / filter / sort / export all customer invoices.
- **Shows:**
  - Header "All Invoices" + (non-customer) toolbar: **Export** (CSV), **Payments Received** (→`/invoices/payments`), **Recurring**, **New Invoice** (→`/invoices/new`).
  - **PaymentSummaryBar** — 5 KPIs computed client-side over `useInvoices({limit:999})`: **Total Outstanding** (→filter SENT), **Due Today**, **Due Within 30 Days**, **Overdue** (→filter OVERDUE), **Avg. Days to Get Paid** (→filter PAID). Clickable KPIs toggle the status filter.
  - **Status tabs:** All / Draft / Sent / Viewed / Partial / Overdue / Paid / Void / Written Off.
  - **Filter bar:** search (invoice# / customer, 300ms debounce), issue-date range (`dateFrom`/`dateTo`; URL-persisted via `useUrlFilters`).
  - **Table:** Date · Invoice # (+ a **"From Order"** vs **"Manual"** pill keyed on `orderId`) · Customer · **Status** (contextual `renderStatus` — e.g. "Overdue by 3 days", "Partial · Due in 5d", "Due Today") · Due Date · Amount (`total`) · Balance Due (red if > 0) · row actions. Sortable columns: issueDate, invoiceNumber, status, dueDate, total.
  - **Pagination:** per-page 10/20/50/100 + numbered pager.
- **Actions:** row click → `/invoices/[id]`; **View** (eye); **Delete** (inline confirm, non-customer only) → `useDeleteInvoice`; **Export** → `apiClient.get("/invoices",{limit:1000})` → `downloadCsv` (warns if >1000 rows).
- **States:** loading spinner; error row; two empty states (no-match vs no-invoices, each with a CTA) via `EmptyState variant="invoices"`. Customer role hides toolbar + delete.

#### Invoice detail — `/invoices/[id]`

- **File:** `apps/web/app/(dashboard)/invoices/[id]/page.tsx` (~2000 lines — the richest screen in the app)
- **Purpose:** View one invoice as a printable document; send, collect payment, adjust, void, write-off, duplicate, reopen, revert, unvoid, edit payments, record shipment.
- **Shows:**
  - Header: `invoiceNumber` + `Badge status`.
  - **Zoho-style action toolbar** (all conditional on status — see States):
    - **Edit** (DRAFT, non-pending-mirror) → `/invoices/[id]/edit`.
    - **Send** (DRAFT) → `handleSend`; **Send Reminder** (SENT/VIEWED/OVERDUE) → `useSendInvoiceReminder`.
    - **Print** (always) → `useDownloadInvoicePdf` → hidden iframe `.print()`.
    - **PDF** (always) → `useDownloadInvoicePdf` → same-origin blob download (never `window.open`, which 401s — the storage endpoint needs the JWT).
    - **Revert to Draft** (SENT/VIEWED/OVERDUE with `amountPaid===0`) → `useRevertInvoiceToDraft`.
    - **Unvoid** (VOID) → `useUnvoidInvoice` → back to DRAFT.
    - **Record Payment** dropdown (SENT/VIEWED/PARTIAL/OVERDUE) → Record Payment modal / Write Off modal.
    - **Adjust Prices** (not PAID/VOID/WRITTEN_OFF, non-mirror) → inline `AdjustPricesPanel`.
    - **⋯ More:** Duplicate, Reopen Invoice (PAID only), Void Invoice.
  - **What's-Next banner** — status-specific guidance (Draft→"send it", Sent→"record payment", Partial→"follow up", Overdue→"contact customer", Paid→"paid in full", Written Off).
  - **Pending-mirror banner** — when `orderId && DRAFT && order.status !== DELIVERED/PARTIALLY_DELIVERED`: the invoice auto-mirrors an undelivered order; Edit/Send hidden — "edit the order, not the invoice" (links to `/orders/[orderId]`).
  - **Invoice document** (2/3): `StatusRibbon` (diagonal corner), `TenantLogo`, Bill-To (customer name/contact/address), issue/due/terms/order#, **line-item table** (dark navy header) — each line Description · Qty · **Rate** (with `priceType` SPECIAL green "Special price" / DISCOUNTED amber "Discounted price" — both show strikethrough `originalPrice` above net `unitPrice`) · Amount. Totals: Subtotal, Discount, Tax, Shipping, **Total**, Amount Paid, **Balance Due**. Notes.
  - **Sidebar** (1/3): Linked Order card; **ShipmentCard** (carrier + tracking, editable unless VOID/WRITTEN_OFF, `useUpdateInvoiceShipment`); **Payment History** (each payment: amount, date, method badge, reference, notes — inline edit/delete for non-CREDIT_NOTE/ADVANCE payments when status isn't VOID/WRITTEN_OFF/PAID); Balance summary.
- **Actions / hooks:** `useSendInvoice` (mark-sent, no email), `useSendInvoiceEmail`, `useSendInvoiceReminder`, `useVoidInvoice`, `useReopenInvoice`, `useRecordInvoicePayment`, `useWriteOffInvoice`, `useUpdateInvoicePayment`, `useDeleteInvoicePayment`, `useDownloadInvoicePdf`, `useRevertInvoiceToDraft`, `useUnvoidInvoice`, `useAdjustInvoicePrices`, `useCreateInvoice` (duplicate).
  - **Record Payment modal:** method (CASH/CHECK/ACH/CREDIT_CARD/OTHER — default ACH), amount (pre-filled to balanceDue), reference, notes.
  - **Adjust Prices panel:** per-item new unit price + **scope** radio (This invoice only / All open invoices for this customer since `<date>`). Backend rejects on PAID/VOID/WRITTEN_OFF ("issue a credit note instead") — button hidden in those states.
  - **No-email modal:** Print / Download PDF / **Mark as Sent** when `customer.email` is null (never surfaces the placeholder sentinel).
  - **Write-off modal:** required reason (bad-debt).
- **States:** loading spinner; not-found fallback; balanceDue forced to 0 when VOID/WRITTEN_OFF. Terminal statuses collapse the toolbar. Amount-paid computed from `payments`, not a stored field.

#### Invoice edit (draft only) — `/invoices/[id]/edit`

- **File:** `apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx`
- **Purpose:** Full draft editor. **Guards: only `status === "DRAFT"`** — anything else shows "Only DRAFT invoices can be edited."
- **Shows:** two-column form — **Dates** (issue/due), **Line Items** (per-row `ProductSearchInput` with barcode scan + inline "create product" via `InlineCreateProductModal`; Qty / Unit Price / **Disc. $** / **Tax %** / remove), Notes & Terms (reference/PO, subject, notes, payment terms), **Adjustments** (invoice-level discount $, shipping fee $), live **Invoice Summary** (subtotal, discount, tax, shipping, total).
- **Actions:** Save Changes → `useUpdateInvoice` (serializes items with `taxRate`/`discount` optional). Cancel → detail.
- **States:** loading / not-found / non-draft guards; per-field validation (issue date required, ≥1 item, all descriptions, qty > 0).

#### New invoice (scan-to-add builder) — `/invoices/new`

- Lives in **`04-op-orders.md`** (the manual scan-to-add order/invoice builder). `/invoices/create` redirects here.

---

### 8.3 Recurring invoices (standing-order billing)

#### Recurring list — `/invoices/recurring`

- **File:** `apps/web/app/(dashboard)/invoices/recurring/page.tsx`
- **Purpose:** Manage templates that auto-generate invoices on a schedule.
- **Shows:** grid of template cards — customer, **Active/Paused** pill, `freqLabel` (Weekly/Every 2 weeks/Monthly + day), item count + "Auto-send" flag, **Next run** / **Last run** dates.
- **Actions:** **Run Now** (`useRunRecurringInvoice` → generates an invoice now, navigates to it); pause/resume toggle (`useDeactivateRecurringInvoice` / `useUpdateRecurringInvoice {isActive}`); **New Template**.
- **States:** loading spinner; empty card with "Create First Template".

#### New recurring template — `/invoices/recurring/new`

- **File:** `apps/web/app/(dashboard)/invoices/recurring/new/page.tsx`
- **Shows:** Customer search; **Schedule** (frequency WEEKLY/BIWEEKLY/MONTHLY → Day-of-Week or Day-of-Month 1–28 with a month-end warning; **First Run Date**; **Auto-send** checkbox); Line Items (product search + qty + unit price); Notes & Terms; Adjustments (discount / shipping).
- **Actions:** Create Template → `useCreateRecurringInvoice` (`dayOfWeek` only for weekly/biweekly, `dayOfMonth` only for monthly; `nextRunAt` ISO).
- **States:** validation (customer, first-run date, ≥1 item, descriptions, qty > 0).

---

### 8.4 Payments received (AR receipts)

> **Naming flag:** `/finance/payments` is **Payments _Received_** — money coming IN against invoices (AR receipts), _not_ payments OUT to suppliers. There is no AP-payments-out screen; supplier payment is done via vendor-bill "Mark received"/expense status. The prompt's "payments OUT / reconcile" description does not match the code.

#### Payments list — `/finance/payments`

- **File:** `apps/web/app/(dashboard)/finance/payments/page.tsx` (`/invoices/payments` redirects here)
- **Purpose:** Ledger of all recorded invoice payments; record a new (multi-invoice) payment.
- **Shows:** header "Payments Received"; **summary cards** (Total Received + count, Filtered Count, **Advance Balance** = unallocated advance funds) from `data.summary`; filter bar (search, date range, method incl. CREDIT_NOTE/ADVANCE, status PAID/DRAFT/VOID, customer, Clear, **Export CSV**); sortable table — Date · Payment # · Invoice(s) (link) · Customer · Mode (colored method badge) · Reference · **Status** badge · Amount · **⋯ actions** (View Receipt / View Invoice / Void). `/` focuses search. Void rows dim to 50%.
- **Actions:** **Record Payment** modal (`useRecordPaymentStandalone`) — pick customer → auto-loads their open invoices (SENT/VIEWED/PARTIAL/OVERDUE with `balanceDue>0`) → enter amount / bank charges / date / mode / reference → **greedy auto-allocation** across invoices (editable per-line, capped at each `amountDue`); shows Allocated vs Total received and **"⚠ Unallocated (→ advance)"** excess. Save as **Draft** or **Paid**. Void → `useVoidPayment` (reverses the invoice effect). Export → `useExportPayments`.
- **States:** loading spinner; two empty states; pagination (25/page).

#### Payment receipt — `/finance/payments/[id]`

- **File:** `apps/web/app/(dashboard)/finance/payments/[id]/page.tsx`
- **Purpose:** Printable single-payment receipt.
- **Shows:** receipt card — Payment # + status pill, Received From / Payment Date / Payment Mode / Reference, **Applied to Invoice** (link + amount), totals (Amount Received − Bank Charges = Total Applied), notes.
- **Actions:** **Void Payment** (`confirm` → `useVoidPayment`, hidden when VOID). Back to Payments.
- **States:** ⚠ **no single-payment endpoint** — it fetches `useInvoicePayments({limit:200})` and `.find(p.id===id)`; a payment beyond the first 200 shows "Payment not found."

---

### 8.5 Credit notes

#### Credit-notes list — `/credit-notes`

- **File:** `apps/web/app/(dashboard)/credit-notes/page.tsx`
- **Purpose:** Browse credit notes (customer credits / refunds / adjustments). **Statuses: DRAFT / ISSUED / APPLIED / VOID.**
- **Shows:** KPI chips (All / Draft / Issued / Applied / Void — Void danger-styled) that also filter; filter bar (search, status `Select`, issue-date range); table — CN # · Customer · Invoice # · Issue Date · Amount · **Status** `Badge` · view; pagination (10/20/50/100).
- **Actions:** **New Credit Note** modal (`useCreateCreditNote`) — customer (searchable), optional invoice (filtered to that customer), amount, reason (required), issue date, notes. Row → detail.
- **States:** loading / error / two empty states.

#### Credit-note detail — `/credit-notes/[id]`

- **File:** `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx`
- **Shows:** header CN # + `Badge`; document card via `DocumentLetterhead` — Credit To, issue date, applied-to invoice link, big Credit Amount, Reason, Notes; Summary + Audit sidebars.
- **Actions (status-gated):** DRAFT → **Issue** (`useIssueCreditNote`) + **Void**; ISSUED → **Apply to Invoice** (`ApplyToInvoiceModal` lists that customer's open invoices SENT/VIEWED/PARTIAL/OVERDUE → `useApplyCreditNote`) + **Void**; APPLIED/VOID → read-only italic note. (Applying a credit note posts a `CREDIT_NOTE`-method payment on the target invoice — see the invoice payment-history badges.)
- **States:** loading / not-found.

---

### 8.6 Estimates (quotes)

#### Estimates list — `/estimates`

- **File:** `apps/web/app/(dashboard)/estimates/page.tsx`
- **Purpose:** Browse quotes. **Statuses in code: DRAFT / SENT / ACCEPTED / DECLINED / EXPIRED (+ VOID).** _(Prompt said REJECTED/CONVERTED — actual enum is DECLINED/EXPIRED; conversion produces an invoice but there is no CONVERTED status.)_
- **Shows:** KPI chips (All/Draft/Sent/Accepted/Declined/Expired) that filter; search + status `Select` + date range; table — Estimate # · Customer · Issue Date · Expiry Date · Total · `Badge` · view; pagination (20/page).
- **Actions:** **New Estimate** modal — customer search (shows pricing **Tier**), issue/expiry dates (expiry defaults +30d), **product search + barcode/Enter scan** with tier-aware pricing (`getTierPrice`, per-customer overrides via `useCustomerPrices`), **boxed box/pieces steppers** using `computeLineSubtotal`, "TIER" strikethrough badge, live subtotal, notes. Row → detail.
- **States:** loading / error / two empty states.

#### Estimate detail — `/estimates/[id]`

- **File:** `apps/web/app/(dashboard)/estimates/[id]/page.tsx`
- **Shows:** header + `Badge`; document (`DocumentLetterhead`, Prepared For, issue/valid-until, line items, Subtotal/Tax/Total, notes); Summary / Dates / Audit sidebars; "Customer Accepted" green banner when ACCEPTED.
- **Actions (status-gated):** DRAFT → **Send** (`useSendEstimate`), **Convert to Invoice** (`useConvertEstimateToInvoice` → navigates to new invoice), **Void**; SENT → **Mark Accepted** / **Mark Declined** / Convert; ACCEPTED → **Convert to Invoice**; DECLINED/EXPIRED → read-only. **Void** available unless read-only.
- **States:** loading / not-found; `canConvert = DRAFT|SENT|ACCEPTED`.

---

### 8.7 Expenses & inventory purchases (AP)

#### Expenses (tabbed) — `/finance/expenses`

- **File:** `apps/web/app/(dashboard)/finance/expenses/page.tsx` (`?tab=inventory|other`, default `inventory`)
- **Purpose:** Two tabs under one header ("Expenses — Inventory purchases and other business expenses").
- **Tab A — Inventory Purchases** (`InventoryPurchasesTab`): this is the **vendor-bills** surface (AP for stock).
  - **Shows:** blue info banner (receiving a bill updates stock + recalculates weighted-average cost); actions row (**Scan Invoice** via `ScanInvoiceModal` AI-OCR, **New Purchase**, bulk **Delete N selected**); KPI chips (Total Outstanding, Due This Week, **Needs Item Mapping** amber toggle — draft bills whose costs won't reach inventory); filter bar (search, status DRAFT/RECEIVED/PARTIAL/PAID/VOID, bill-date range); sortable table with row-select checkboxes — Bill # (+ amber "needs items" pill) · Supplier · PO # · Bill Date · Due Date (Overdue red) · Total · Paid · Balance · Status · view; pagination.
  - **Actions:** **New Inventory Purchase** modal (`useCreateVendorBill`) — barcode **scan strip**, supplier (`SupplierSelect`, remembers last via `usePreferences`), optional **linked PO**, bill/due dates, line items with **ProductCombobox** (barcode scan, auto-fills `averageCost`) + inline product create, live total. Bulk delete (`useBulkDeleteVendorBills`; only DRAFT/VOID deletable, others skipped). Row → `/vendor-bills/[id]` (detail documented in `07-op-warehouse.md`).
- **Tab B — Other Expenses** (`OtherExpensesTab`): one-off business expenses.
  - **Shows:** actions (**Select** mode, **New Expense** → `/finance/expenses/new`); bulk-action bar (Mark Received / Mark Paid via `useBatchUpdateExpenseStatus`); filters (category, date range); table — Date · Category · Description · Supplier · **Status** `Badge` · **Receipt** (upload / view / **Sparkles = AI extract line items** `useExtractExpenseItems` / replace / link-to-vendor-bill / remove) · Amount · delete; running "N expenses · $total".
  - **Row click** → **ExpenseDetailModal** (amount, date, status, category/supplier/customer/method/reference/employee, mileage fields, billable, receipt image/PDF preview, line items, linked vendor bill).
  - **Actions/hooks:** `useExpenses`, `useDeleteExpense`, `useUploadExpenseReceipt`, `useDeleteExpenseReceipt`, `useGetExpenseReceiptUrl`, `useExtractExpenseItems` (OCR), `useBatchUpdateExpenseStatus`.
  - **Expense statuses:** PENDING (default) / RECEIVED / PAID / VOID.
- **States:** each tab has its own loading/empty/pagination; `Suspense` wrapper for `useSearchParams`.

#### New expense — `/finance/expenses/new`

- **File:** `apps/web/app/(dashboard)/finance/expenses/new/page.tsx`
- **Purpose:** Three-tab manual expense entry. _(No receipt-OCR here — OCR lives in the expenses-list receipt column and the vendor-bill ScanInvoiceModal.)_
- **Tab 1 — Record Expense:** date, category (or **Itemize** → per-line account/notes/amount rows with clone/remove), amount, reference #, supplier, customer, payment method, employee, **Billable-to-customer** checkbox (when customer set), description, notes. → `useCreateExpense`.
- **Tab 2 — Record Mileage:** date, employee, calc-by **Distance** or **Odometer** (start/end), unit (mile/km), **auto-calculated amount** from the applicable `useMileageRates` snapshot, reference, customer, notes → `useCreateExpense({isMileage})`.
- **Tab 3 — Bulk Add:** spreadsheet-style rows (date, category, amount, customer, billable) → `useBulkCreateExpenses` (reports created/failed counts).
- **States:** per-tab validation toasts; on save → `/finance/expenses`.

---

### 8.8 Reports

#### Finance reports — `/finance/reports`

- **File:** `apps/web/app/(dashboard)/finance/reports/page.tsx` (~2460 lines; `/finance/customers` redirects to `?report=customer-balance`)
- **Purpose:** Full reporting suite — a **left catalog** (6 groups) + a **right report viewer** driven by `?report=` (and `?from`/`?to`/`?customerId`/`?categoryId`) URL params. Recharts for the charted reports.
- **Report catalog (18 reports across 6 groups):**
  - **Sales:** Sales by Customer (bar + drill to customer-balance), Sales by Item (bar), Sales by Driver (bar).
  - **Receivables:** AR Aging Summary (15/30/60-day interval buckets, drill to details), AR Aging Details, Invoice Details (status tabs, customer-context filter), Bad Debts (written-off), Customer Balance Summary (bar: outstanding + overdue), Estimate Details (status tabs), Receivable Summary (all AR txns).
  - **Payments Received:** Payments Received, Time to Get Paid (avg days + bucket histogram), Refund History (voided payments + CN refunds).
  - **Purchases & Expenses:** Expense Details, Expenses by Category, Expenses by Customer.
  - **Profit & Loss:** Profit & Loss, Cash Flow.
  - **Transaction Ledger:** Transactions Ledger (`useTransactions` — Invoice # / Customer / Date / Total / Paid / Balance / Status, with inline **Record Payment** on unpaid rows via `useRecordPayment`).
- **Shows/Actions:** report header (label + description) + **Export CSV** (scrapes the visible `<table>` DOM into `exportReportCSV`) + **Print** (`window.print`); a **date toolbar** (`ReportToolbar`, default Jan-1 → today) for date-scoped reports (AR-aging/bad-debts/customer-balance/ledger don't need dates); tables have skeleton loading rows, error+retry, empty states, and totals footers. Many rows deep-link to `/invoices/[id]` or cross-navigate reports via `onSelectReport`.
- **States:** `Suspense`; each report handles its own loading/error/empty.

---

### 8.9 Bookkeeping (per-transaction invoice viewer)

#### Bookkeeping index — `/bookkeeping`

- **File:** `apps/web/app/(dashboard)/bookkeeping/page.tsx` — **redirect** to `/finance/reports?report=ledger`. There is no standalone bookkeeping list; the "ledger" is the reports-page Transactions Ledger.

#### Transaction detail — `/bookkeeping/[transactionId]`

- **File:** `apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx`
- **Purpose:** View one order-linked transaction as an invoice + record payments against it. **Not a double-entry GL / debit-credit view** — it's a simplified invoice+payment-history card (the "double-entry ledger / GL account / reconciliation / audit trail" the prompt described does not exist here).
- **Shows:** header (order number + **PaymentStatusBadge** UNPAID/PARTIAL/PAID computed locally from `totalOwed`/`totalPaid`); **invoice card** with a **hardcoded RouteFlow letterhead** (`/logo.svg` + "RouteFlow · Austin, TX · routeflow.io" — _not_ tenant-branded, unlike `DocumentLetterhead`); Bill-To, date/due, Total / Amount Paid / Balance Due; **Payment History** sidebar; balance summary.
- **Actions:** **Download PDF** (`useDownloadInvoice` → `fetchPdfBlob` auth'd same-origin blob; 202/null → "PDF generating"); **Record Payment** modal (react-hook-form + zod; method CASH/CHECK/ACH/OTHER default ACH, amount pre-filled to remaining balance, reference) → `useRecordPayment`; hidden when PAID.
- **States:** loading / not-found → "Back to Bookkeeping".

---

### 8.10 Shipments (legacy / derived view)

#### Shipments — `/shipments`

- **File:** `apps/web/app/(dashboard)/shipments/page.tsx`
- **Purpose:** **Not its own entity** — a read-only invoice list filtered to `useInvoices({shipped: true})` (invoices that carry a carrier + tracking number, set on the invoice detail's ShipmentCard).
- **Shows:** search (tracking# / invoice# / customer); table — Customer · Invoice # · Carrier (`carrierLabel`) · Tracking # (external `getTrackingUrl` link) · Shipped date · Status (`renderStatus`) · view; pagination.
- **Actions:** row/eye → `/invoices/[id]`; tracking link opens the carrier site.
- **States:** loading / error / empty ("Add a carrier and tracking number to an invoice to see it here"). **Legacy verdict:** thin, derived, no create/edit — a candidate to fold into the invoices list as a filter/column.

---

### Key flows (end-to-end)

- **Order → invoice → payment (the core AR loop):** an order detail's "Split into invoice" or `/invoices/new` builder creates the invoice (documented in `04`) → invoice detail **Send** (email or Mark-as-Sent if no email) → customer pays → **Record Payment** (or `/finance/payments` multi-invoice) → status advances SENT→PARTIAL→PAID server-side, balance recomputes.
- **Apply a credit note:** `/credit-notes` New (customer + amount + reason) → detail **Issue** → **Apply to Invoice** (pick open invoice) → posts a CREDIT_NOTE payment reducing the invoice balance; CN → APPLIED.
- **Estimate → invoice:** `/estimates` New (tier-priced quote) → Send → customer accepts → **Convert to Invoice** → lands on the new invoice.
- **Recurring billing:** `/invoices/recurring/new` template (freq + auto-send) → cron/`Run Now` generates invoices → they appear in `/invoices` (auto-sent if flagged).
- **AP capture:** `/finance/expenses?tab=inventory` **Scan Invoice** (OCR) or **New Purchase** → vendor bill → "Mark received" posts stock + weighted-avg cost (detail in `07`); or `?tab=other` **New Expense** / mileage / bulk, attach receipt, **AI-extract** line items.
- **Month-end reporting:** `/finance/reports` → pick AR Aging / P&L / Cash Flow / Expenses-by-Category → set date range → Export CSV / Print.

### Use cases

- As an operator I want to send an invoice and record the payment so AR reflects reality. (invoice detail → Send → Record Payment)
- As an operator I want to receive one lump payment and split it across several open invoices so a customer's account clears, with the excess held as advance. (`/finance/payments` → Record Payment → allocations)
- As an operator I want to give a one-time negotiated line price so the invoice honors it without corrupting the catalog. (edit draft, or Adjust Prices on a sent invoice)
- As an operator I want to credit a customer for a return/dispute and apply it to an open invoice. (`/credit-notes` → Issue → Apply)
- As an operator I want to quote before committing and convert the accepted quote to an invoice. (`/estimates` → Convert)
- As an operator I want standing weekly/monthly invoices generated automatically. (`/invoices/recurring`)
- As an operator I want to snap a receipt and have line items extracted, and track mileage. (`/finance/expenses` receipt OCR; `/finance/expenses/new` mileage tab)
- As an operator I want AR-aging, P&L and cash-flow reports I can export for my accountant. (`/finance/reports`)
- As an operator I want to write off a truly uncollectible invoice as bad debt. (invoice detail → Record Payment ▸ Write Off)

### Business rules & edge cases

- **Money invariants:** all totals via `pricing.ts` (`computeLineSubtotal` prorates boxed lines; `roundMoney` cents); invoice **total = subtotal + tax** ±$0.01 (CP-01/03/04/07). The invoice-detail Amount column renders `qty × unitPrice` — safe **only because** boxed proration is already baked into the stored `unitPrice`/qty; never re-derive a boxed line as `qty × catalogUnitPrice`.
- **Line-override convention:** an overridden line carries a net `unitPrice` + strikethrough `originalPrice` + `priceType` SPECIAL/DISCOUNTED and `discount: 0` — the detail view renders the strikethrough from `originalPrice`; never re-derive a discount from it (double-counts). The edit form's per-line `discount $` is the _invoice-editor_ path (separate from the override convention).
- **Invoice status machine & gating:** DRAFT (editable, sendable) → SENT/VIEWED → PARTIAL/OVERDUE → PAID; side states VOID, WRITTEN_OFF. Edit only from DRAFT; Send only from DRAFT; Record Payment only SENT/VIEWED/PARTIAL/OVERDUE; Write-off same set; Void unless PAID/VOID/WRITTEN_OFF; Reopen only from PAID; Revert-to-Draft only SENT/VIEWED/OVERDUE with zero payments; Unvoid only from VOID. **Overdue is contextual** (computed from dueDate), shown in the list even when stored status differs.
- **Pending-mirror invoices:** an order-linked DRAFT for an undelivered order auto-syncs to the order and can't be edited/sent — edit the order.
- **Void vs delete vs write-off:** list **Delete** removes an invoice (server rejects with payments); **Void** cancels (reversible via Unvoid → DRAFT); **Write-off** marks remaining balance uncollectible (bad debt, needs reason, irreversible). Payment **Void** reverses a receipt's effect on its invoice.
- **Credit-note / estimate machines:** CN DRAFT→ISSUED→APPLIED (or VOID); applying posts a CREDIT_NOTE payment. Estimate DRAFT→SENT→ACCEPTED/DECLINED/EXPIRED(+VOID); convert produces an invoice (no CONVERTED status).
- **Advance payments:** a standalone payment exceeding allocations parks the excess as an **advance balance** (surfaced on `/finance/payments` summary + as an ADVANCE-method payment). CREDIT_NOTE/ADVANCE payments are **not** inline-editable on the invoice.
- **PDF is auth'd & sometimes async:** downloads fetch bytes via the auth'd client into a same-origin blob (never `window.open`, which 401s — see `fetch-pdf-blob.ts`); a 202/null response means "PDF still generating."
- **No-email customers:** Send offers Print / Download / Mark-as-Sent; the `no-email+<uuid>@placeholder.local` sentinel is never displayed.
- **Vendor-bill receiving:** DRAFT bills with no items / unmapped lines are flagged "needs items"; receiving updates stock + weighted-avg cost; only DRAFT/VOID bills are bulk-deletable.
- **Payment-receipt fragility:** `/finance/payments/[id]` has no single-fetch endpoint — it scans the first 200 payments; a payment beyond that 404s in the UI.
- **Bookkeeping letterhead drift:** `/bookkeeping/[transactionId]` uses a **hardcoded RouteFlow** letterhead (not tenant-branded `DocumentLetterhead`), a visible inconsistency vs invoices/credit-notes/estimates.
- **Reports date default:** Jan-1 of current year → today; export scrapes the rendered DOM table (Cash Flow has no table → "nothing to export").

### Relevant files (all absolute)

- Pages: `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\finance\{page,dashboard\page,customers\page,expenses\page,expenses\new\page,payments\page,payments\[id]\page,reports\page}.tsx`
- Invoices: `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\invoices\{page,create\page,[id]\page,[id]\edit\page,recurring\page,recurring\new\page,payments\page}.tsx`
- Credit notes / estimates: `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\credit-notes\{page,[id]\page}.tsx`, `...\estimates\{page,[id]\page}.tsx`
- Bookkeeping / shipments: `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\bookkeeping\{page,[transactionId]\page}.tsx`, `...\shipments\page.tsx`
- Libs/components: `C:\ClaudeCode\routeflow\apps\web\lib\{pricing,report-export,fetch-pdf-blob,formatting,export}.ts`, `...\components\{DocumentLetterhead,ShipmentCard,ScanInvoiceModal,SupplierSelect,InlineCreateProductModal,BarcodeScannerButton,ReportToolbar,TenantLogo}.tsx`
- API hooks: `C:\ClaudeCode\routeflow\apps\web\lib\api\{invoices,credit-notes,estimates,finance,bookkeeping,vendor-bills,customers,products}.ts`
- Specs: `C:\ClaudeCode\routeflow\apps\web\e2e\02-operator.spec.ts` (OP-11/14/15/16), `...\06-critical-paths.spec.ts` (CP-01/03/04/07)

---

### 💡 Faster ways (redesign suggestions — NOT current behavior)

1. **Collapse the finance-index sprawl.** Four routes exist only to redirect (`/finance`, `/finance/customers`, `/invoices/payments`, `/bookkeeping`). The redesign should retire these URLs (or keep only as aliases) and present one clear IA: Dashboard · Invoices · Payments · Credit Notes · Estimates · Expenses · Reports. The Finance Dashboard AR-aging and the `customer-balance` report overlap heavily — merge into one "Receivables" view.
2. **One-click Order → Invoice → Send.** Today it's split-invoice/builder → Send is a second trip to the detail. A single "Bill & send" action (with the no-email fallback baked in) would remove a step operators repeat dozens of times a day.
3. **Batch AR reminders.** "Send Reminder" is per-invoice only. A bulk "Remind all overdue" from the OVERDUE filter (or the dashboard's Overdue tile) — using the same `useSendInvoiceReminder` — would be the single highest-value AR-chasing feature.
4. **Fix the payment-receipt fetch.** `/finance/payments/[id]` scanning the first 200 payments is a latent 404 bug — needs a real `GET /payments/:id`. Flag for the redesign's data layer.
5. **Unify document letterhead.** Make `/bookkeeping/[transactionId]` use `DocumentLetterhead` so every printable doc is tenant-branded — one of the concrete "different apps" inconsistencies.
6. **Fold Shipments into Invoices.** It's just `invoices?shipped=true`; a "Shipped" filter + Carrier/Tracking columns on the invoices list removes a whole legacy route.
7. **Reconcile the two payment-recording modals.** Invoice-detail, `/finance/payments`, reports-ledger, and bookkeeping each ship their _own_ Record-Payment modal with slightly different fields (bank charges, allocations, method sets). One shared component would kill drift.
