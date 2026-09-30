# Suppliers, Purchasing & Accounts Payable

_Turning a paper supplier invoice into stock, cost, and what's owed — in one transaction._

## The problem

A wholesale distributor buys from a dozen suppliers who each hand over a paper invoice on the
truck, then post a monthly statement that never quite agrees with the pile in the shoebox. Nobody
knows what is genuinely owed today, the same invoice gets keyed twice (or paid twice), and
case-versus-piece confusion means the cost of goods on the shelf is guesswork — so margins are
fiction. Meanwhile the goods that physically arrived are reconciled against the invoice only by
memory, and the accounting package sees the purchase weeks later, if at all.

## Why it matters to a tenant

RouteFlow turns the paper invoice into the single event that updates three things at once: what
is owed, what is in stock, and what each piece cost. Photographing a supplier invoice produces a
draft bill with lines already matched to catalogue products, and the match is remembered per
supplier so the same invoice gets faster every month. Receiving it writes a stock movement and
re-blends average cost per PIECE, not per case — the exact place hand-kept books over-state cost
by `unitsPerBox`. Duplicate detection blocks re-keying the same document (which would double both
stock and payables), one lump sum allocates across many bills in a single transaction with any
overspill held as on-account credit, and a supplier's monthly statement can be scanned and matched
line-by-line against your own bills before a cent moves.

## Core use cases

1. **Record a supplier invoice and receive the goods against it** — the invoice that came off the
   truck becomes a bill with lines linked to catalogue products; receiving it increments stock and
   recomputes per-piece average cost in one transaction. Without this the domain is just an
   address book.
2. **Know and settle what you owe each supplier** — a per-supplier running balance built from
   bills, payments and credits, and a way to pay one bill or spread one lump sum across many, with
   overpayment held as on-account credit rather than lost.
3. **Never record or pay the same document twice** — detect that a supplier invoice has already
   been entered (by number, by identical line fingerprint, by file hash) before it doubles stock
   and payables, and make every settlement write idempotent.

## Must have (P0)

| ID     | Capability                                                            | Status     | What it does                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-M1  | Supplier master record                                                | SHIPPED ✅ | Create, edit, search, deactivate and delete suppliers with contact details, geocoded address, default terms and optional regulated licence number.         | `suppliers.controller.ts`/`suppliers.service.ts`; Prisma `Supplier`; web `suppliers/*`; mobile `(operator)/suppliers/*`. A second create/update path also exists at `/inventory/suppliers`.                                                                                                                                                                                                                                                                                                                                                   |
| AP-M2  | Record a supplier bill with line items                                | SHIPPED ✅ | Enter (or accept from scan/import) a supplier invoice as a bill: supplier, dates, terms, invoice number, lines, tax.                                       | `vendor-bills.controller.ts`, `vendor-bills.service.ts:183`; Prisma `VendorBill`/`VendorBillItem`; web/mobile bill forms.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AP-M3  | Receive goods against a bill — stock and cost in one transaction      | SHIPPED ✅ | Marking a bill received increments stock, writes a PURCHASE movement + stock lot, and re-blends per-piece average cost; case lines convert via `packSize`. | `receive()` `vendor-bills.service.ts:710`; `lineInventoryDelta()` `:139`; spec `vendor-bills.receive-units.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AP-M4  | Duplicate supplier-invoice protection                                 | SHIPPED ✅ | Blocks re-recording the same invoice by number, line fingerprint, or file hash before it doubles stock and payables.                                       | `POST /vendor-bills/check-duplicate`; `duplicate-match.service.ts`; `@@index([tenantId, supplierInvoiceNumber])`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AP-M5  | Pay a bill, or pay a supplier across many bills                       | SHIPPED ✅ | Record a payment against one bill, or one lump sum allocated across several bills; overpayment becomes on-account supplier credit.                         | `recordPayment()`/`recordSupplierPayment()` `vendor-bills.service.ts:1846,1911`; `SupplierCredit`; `BillPayment.paymentGroupId`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| AP-M6  | Supplier statement — what you owe, with a running balance             | PARTIAL 🟡 | Per-supplier timeline of bills, payments and credits with a running balance, totals, and current credit balance.                                           | `getSupplierStatement()` `vendor-bills.service.ts:2045-2136`. No date range/pagination/as-of date; filters bills `status != VOID`, which also drops cash payments made against a bill later voided.                                                                                                                                                                                                                                                                                                                                           |
| AP-M7  | Map supplier line descriptions to catalogue products, and remember it | SHIPPED ✅ | A supplier's free-text line is matched to a product; the correction is remembered per (supplier, raw description) for next time.                           | `saveProductMapping()` `:1251`; `product-matcher.ts`; Prisma `ProductMapping`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AP-M8  | Correct a mistake — revert to draft, void with full reversal, delete  | SHIPPED ✅ | A wrongly received bill can be reverted or voided; voiding reverses the exact stock/cost effect, reverses lots, and hands back any drawn credit.           | `voidBill()` `:1049-1138`; `delete()` `:2138` refuses RECEIVED/PAID/PARTIAL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AP-M9  | Tenant isolation on every AP read, write and document                 | BROKEN 🔴  | One tenant should never see or touch another tenant's suppliers, bills, payments, credits, mappings or scanned documents.                                  | Rows are safe via `prisma.forTenant()`. Files are NOT: `uploads.controller.ts` `OWNER_LOOKUPS` (:61-101) has no entry for `supplier-statements/<scanId>/…`, and the tenant-prefix regex (:155) doesn't cover it, so the check at :170-178 is skipped and the file is served to any authenticated caller. Bug register B52, Critical, Open. verified: files are 1-indexed (`supplier-statements/${scanId}/${i+1}.${ext}`, `supplier-statements.service.ts:500`) — a test must probe `1.pdf`, not `0.pdf`, or it can pass for the wrong reason. |
| AP-M10 | Entitlement gate — which tenants get accounts payable at all          | PARTIAL 🟡 | AP bills are a paid capability; tenants without it should not see the surface, and the API should refuse.                                                  | `@RequirePlanFlag("flag.ap_bills")` is class-level on `VendorBillsController`, granted from GROWTH up, but sits in `DARK_PLAN_FLAGS` so it's muted unless `PLAN_FLAG_ENFORCEMENT=on`. No client gate — nav renders unconditionally. verified: `SupplierStatementsController` carries no gate, AND `suppliers.controller.ts:21-23` (`@UseGuards(JwtAuthGuard, RolesGuard)`) has no `PlanFlagGuard`/`@RequirePlanFlag` at all — two of the three AP controllers are entirely ungated server-side, not one.                                      |
| AP-M11 | See what is due, and what is late                                     | PARTIAL 🟡 | Know which bills are due this week and which are overdue, so payment runs are date-driven.                                                                 | `VendorBillStatus.OVERDUE` exists but nothing writes it; `findAll` has no `dueBefore` filter, orders by `createdAt`; overdue is a client-only helper; every aging report is AR-only.                                                                                                                                                                                                                                                                                                                                                          |
| AP-M12 | Who is allowed to move money owed and cost basis                      | PARTIAL 🟡 | Bills, payments and receiving are office functions; a driver shouldn't move payables or rewrite cost basis.                                                | Correct on bills (`@Roles(OPERATOR)`). Not on purchase orders: `POST /inventory/purchase-orders` and `/:id/receive` carry `@Roles(OPERATOR, DRIVER)`, as do purchase/adjustment movements. Bug register B168, Medium, Open.                                                                                                                                                                                                                                                                                                                   |
| AP-M13 | Record a stock purchase with no bill and no purchase order            | SHIPPED ✅ | A third, supplier-linked write path directly into stock/cost, with no bill or PO — the only purchasing write a driver has on mobile.                       | `POST /inventory/movements/purchase` — `inventory.controller.ts:57`, `@Roles(OPERATOR, DRIVER)`; `InventoryService.recordPurchase`; web hook `lib/api/inventory.ts:54`; mobile `(operator)/purchase-orders/record.tsx` (notes at :78 that qty means PIECES).                                                                                                                                                                                                                                                                                  |

### Testing criteria

#### AP-M1

- [ ] `Jest (api)`: DELETE /suppliers/:id for a supplier holding one VendorBill returns 400 naming the blocking counts and the row still exists; deleting one referenced only by a nullable Expense/StockMovement succeeds and those rows get `supplierId: null`. `Jest`
- [ ] `Jest (api)`: PATCH changing only `notes` must not call the geocoder or touch lat/lng; changing `zip` to an unresolvable value must null lat/lng. `Jest`
- [ ] `Playwright (web)`: a supplier created in tenant A is absent from tenant B's list and 404s (not 403) when fetched directly by id. `Playwright`
- [ ] `Playwright (web)`: zero suppliers renders an empty state with a create affordance. `Playwright`

#### AP-M2

- [ ] `Jest (api)` MONEY INVARIANT: `totalOwed == roundMoney(Σ(qty × unitCost) + taxAmount)` in bill denomination — a case line must NOT be divided here. `Jest`
- [ ] `Jest (api)`: create with `taxAmount 7.13`, PATCH one line — `totalOwed` still includes 7.13 (regression for B26, cleared). `Jest`
- [ ] `Jest (api)`: create with no `supplierId` over HTTP returns 400; internal call with `requireSupplier:false` succeeds. `Jest`
- [ ] `Jest (api)`: PATCH on a RECEIVED/PAID bill is rejected and writes nothing. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: `VendorBillItem` rows are only reachable through the tenant-scoped parent. `Jest`

#### AP-M3

- [ ] `Jest (api)` STOCK INVARIANT: receiving 5 cases of a packSize-12 line raises stock by exactly 60 with one movement (`unitCost = lineUnitCost/12`); Σ movements == currentStock. `Jest`
- [ ] `Jest (api)` IDEMPOTENCY: receiving twice on a fully-received bill throws 409 and changes nothing — the guard must key on `receivedDate`/`qtyReceived`, not status. `Jest`
- [ ] `Jest (api)`: a STANDARD-costed product keeps its set `averageCost`, while the movement still records actual `unitCost`. `Jest`
- [ ] `Jest (api)` NEGATIVE: receiving with an unlinked line and no `acknowledgeUnlinked` throws 409 `UNLINKED_ITEMS` and moves no stock; retry with the flag skips only those lines. `Jest`
- [ ] `Jest (api)`: a backdated bill triggers `recomputeProductInTx` so later movements' snapshots replay. `Jest`

#### AP-M4

- [ ] `Jest (api)`: a second bill with the same normalized invoice number for the same supplier returns 409 `DUPLICATE_VENDOR_BILL` and creates no row. `Jest`
- [ ] `Jest (api)`: a NUMBER match blocks; a fuzzy match (same supplier/day/total, no number) does not block create but IS reported by `/check-duplicate`. `Jest`
- [ ] `Jest (api)`: a VOID bill carrying that number never blocks a re-record. `Jest`
- [ ] `Jest (api)`: `allowDuplicate:true` bypasses the guard once; the resulting bill still persists the number so the next attempt is caught. `Jest`
- [ ] `Jest (api)`: normalization is symmetric — "inv 1234" and "INV1234" resolve to the same key. `Jest`

#### AP-M5

- [ ] `Jest (api)` MONEY INVARIANT: a 500 lump sum across three bills writes three `BillPayment` rows sharing one `paymentGroupId` summing to 500 to the cent. `Jest`
- [ ] `Jest (api)`: an allocation exceeding a bill's outstanding by 0.01 is rejected 400 and the whole transaction rolls back. `Jest`
- [ ] `Jest (api)` NEGATIVE: allocating against a VOID bill is rejected 400. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: a `supplierId` from another tenant 404s before any write. `Jest`
- [ ] `Jest (api)`: paying 260 against 250 owed mints one `SupplierCredit` of 10; the next bill auto-draws it, leaving the credit at 0 and the bill DRAFT. `Jest`

#### AP-M6

- [ ] `Jest (api)` MONEY INVARIANT: `outstanding == roundMoney(Σ non-void totalOwed − Σ payments)`, matching the last timeline row's `balance`. `Jest`
- [ ] `Jest (api)`: a `BillPayment` carrying `supplierCreditId` is excluded from PAYMENT rows (not double-counted with the CREDIT row). `Jest`
- [ ] `Jest (api)` REGRESSION (expected to fail today): voiding a bill with a 100.00 cash payment must still show that 100.00 in the statement. `Jest`
- [ ] `Playwright (web)`: the supplier page's Outstanding tile matches the API figure; zero bills shows 0 with an empty timeline. `Playwright`

#### AP-M7

- [ ] `Jest (api)` TENANT ISOLATION: `ProductMapping`'s unique key carries no `tenantId` — tenant B saving the same pair must not overwrite tenant A's mapping or 500. `Jest`
- [ ] `Jest (api)` NEGATIVE: saving with no `rawDescription` must not match an arbitrary row. `Jest`
- [ ] `Jest (api)`: a learned mapping outranks the fuzzy matcher. `Jest`
- [ ] `Jest (api)`: a fuzzy score between 0.35 and 0.6 returns `matchedProductId: null` with ranked candidates, never an auto-assignment. `Jest`

#### AP-M8

- [ ] `Jest (api)` STOCK INVARIANT: receive 5 cases of a packSize-12 line then void — stock and `averageCost` return exactly to pre-receive values, with a compensating −60 movement. `Jest`
- [ ] `Jest (api)`: voiding a PAID-but-never-received bill (`receivedDate: null`) writes no stock reversal. `Jest`
- [ ] `Jest (api)`: voiding a bill that drew `SupplierCredit` restores that credit and reduces `totalPaid` in the same transaction. `Jest`
- [ ] `Jest (api)` NEGATIVE: DELETE on a RECEIVED bill returns 400; DELETE on a DRAFT bill with auto-applied credit refunds the credit before destroying its payments. `Jest`
- [ ] `Jest (api)`: voiding an already-VOID bill is a stock no-op. `Jest`

#### AP-M9

- [ ] `Jest (api)` NEGATIVE — closes B52: GET `/uploads/supplier-statements/<tenantA-scanId>/1.pdf` with a tenant-B JWT must return 403 (currently returns the file). `Jest`
- [ ] `Jest (api)`: the same request with `SUPER_ADMIN` or a valid signed URL is allowed. `Jest`
- [ ] `Jest (api)`: a missing/unknown owner-lookup prefix must fail closed (403), never fall through to serve. `Jest`
- [ ] `Jest (api)`: `GET /vendor-bills/:id`, payment endpoints each 404/400 (never data, never a write) for another tenant's id. `Jest`

#### AP-M10

- [ ] `Jest (api)`: with `PLAN_FLAG_ENFORCEMENT=on` and a STARTER tenant, `GET /vendor-bills` returns a structured `PLAN_GATE` 403; with it off, 200. `Jest`
- [ ] `Playwright (web)`: a STARTER tenant must not see the "Bills & Purchasing" nav item (fails today). `Playwright`
- [ ] `Jest (api)`: `GET /supplier-statements` and `GET/POST /suppliers` for a tenant without `flag.ap_bills` currently succeed — assert intended behaviour so the inconsistency becomes a decision. `Jest`
- [ ] `Jest (api)`: the gate re-resolves from `EntitlementsService`, not JWT claims. `Jest`

#### AP-M11

- [ ] `Jest (api)`: `GET /vendor-bills?dueBefore=<date>` returns only unpaid bills with `dueDate <= date` (parameter doesn't exist today). `Jest`
- [ ] `Jest (api)`: a past-`dueDate`, not-fully-paid bill is server-classified overdue; fully paid is not. `Jest`
- [ ] `Playwright (web)`: due-date sort across two pages orders correctly (today it's client-side, current page only). `Playwright`
- [ ] `Jest (api)`: a bill with `dueDate: null` is never classified overdue and never silently dropped. `Jest`

#### AP-M12

- [ ] `Jest (api)` NEGATIVE: a DRIVER token calling bill create/payment/statement-apply routes each returns 403 and writes nothing. `Jest`
- [ ] `Jest (api)`: a DRIVER token calling PO receive currently succeeds and moves `averageCost` — pin the intended role matrix (B168). `Jest`
- [ ] `Jest (api)` NEGATIVE: a CUSTOMER/buyer token gets 403, not an empty list, on every supplier/bill route. `Jest`
- [ ] `Jest (api)`: SUPER_ADMIN with no `tenantId` cannot read a specific tenant's bills without impersonation context. `Jest`

#### AP-M13

- [ ] `Jest (api)` STOCK INVARIANT: `recordPurchase` with a supplier and PIECES quantity raises stock by exactly that quantity and blends `averageCost` identically to a bill receive. `Jest`
- [ ] `Jest (api)` NEGATIVE: a DRIVER token can call it; a CUSTOMER token 403s. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: `supplierId` from another tenant is rejected before any write. `Jest`

## Nice to have (P1)

| ID     | Capability                                                                     | Status     | What it does                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-N1  | AI scan a supplier invoice into a draft bill                                   | SHIPPED ✅ | Photograph/upload an invoice and get a draft bill with lines matched to products.                                                                                                                                      | `POST /vendor-bills/scan-invoice`, `@RequireAddon("ocr")`; `scanInvoice()` `:1441`.                                                                                                                             |
| AP-N2  | Batch scan a stack of invoices in one pass                                     | SHIPPED ✅ | Upload a pile of invoices, review each extraction, resolve unmatched lines, post them all as bills.                                                                                                                    | `import/batch.controller.ts`; `batch-import.service.ts`.                                                                                                                                                        |
| AP-N3  | Scan history — the document survives an abandoned review                       | SHIPPED ✅ | Every scan stores the file and the model's extraction, so an abandoned review is recoverable.                                                                                                                          | `GET /vendor-bills/scans`; Prisma `InvoiceScan`.                                                                                                                                                                |
| AP-N4  | Partial receipt and top-up receiving                                           | SHIPPED ✅ | Receive part of a delivery and top up later; per-line receipt is tracked cumulatively.                                                                                                                                 | `ReceiveVendorBillDto`; `VendorBillItem.qtyReceived`; `lineReceivedQty()` `:161`.                                                                                                                               |
| AP-N5  | Case vs piece — invoice speaks cases, catalogue speaks pieces                  | SHIPPED ✅ | The pack size on the line converts quantity and cost exactly once, in one place.                                                                                                                                       | `lineInventoryDelta()` `:139-151`; `pricing.ts`.                                                                                                                                                                |
| AP-N6  | Supplier statement reconciliation (AI-read, human-applied)                     | SHIPPED ✅ | Upload a statement, match its lines to your bills (exact/fuzzy/unmatched), apply only what's confirmed in one transaction.                                                                                             | `supplier-statements.controller.ts`; `statement-matcher.ts`; `statement-apply.service.ts`.                                                                                                                      |
| AP-N7  | On-account supplier credit, auto-applied to the next bill                      | SHIPPED ✅ | Overpaying leaves a drawable balance applied automatically, oldest first, to the next bill.                                                                                                                            | `applySupplierCreditToBill()` `:325-390`; `refundDrawnSupplierCredits()` `:392`.                                                                                                                                |
| AP-N8  | Bulk mark bills paid                                                           | SHIPPED ✅ | Select several bills (or bill-linked expenses) and settle them in one action.                                                                                                                                          | `POST /bookkeeping/bills/bulk-mark-paid`; `bulkMarkPaid()` `:568`.                                                                                                                                              |
| AP-N9  | Needs-mapping work queue                                                       | SHIPPED ✅ | A filtered queue of draft bills whose lines aren't yet linked to products, with a live count badge.                                                                                                                    | `GET /vendor-bills?needsMapping=true`; `findAll()` `:1146-1200`.                                                                                                                                                |
| AP-N10 | Purchase orders — raise, send, receive, close                                  | PARTIAL 🟡 | Commit to a supplier before goods arrive: raise, mark sent, receive (partial/full), close.                                                                                                                             | `inventory.controller.ts:170-204`. `send` only flips status, no PDF/email; the Bills-hub PO tab sends an invalid status value and 400s (B27); date filters accepted but ignored; receive notes discarded (B88). |
| AP-N11 | Per-supplier default payment terms prefilled onto bills                        | PARTIAL 🟡 | Set "Net 30" once on the supplier and new bills open with that term and a derived due date.                                                                                                                            | `Supplier.defaultTerms`/`VendorBill.termsLabel` persisted verbatim; due-date derivation is client-only; terms option list hardcoded in the web form.                                                            |
| AP-N12 | Non-inventory payables — expenses, receipts, and promotion to bills            | SHIPPED ✅ | Rent/fuel/packaging as expenses with a receipt; inventory-purchase expenses auto-promote to a vendor bill.                                                                                                             | `maybeConvertToVendorBill()` `:877-907`; `Expense.vendorBillId`.                                                                                                                                                |
| AP-N13 | Find a bill by the supplier's own invoice number                               | MISSING ⬜ | When a supplier calls about invoice 88231, search 88231 and land on the bill.                                                                                                                                          | `findAll()`'s search covers `billNumber`/supplier name/notes only — `supplierInvoiceNumber` is indexed but never searched.                                                                                      |
| AP-N14 | Open the original scanned invoice from the bill                                | MISSING ⬜ | From a bill, view the supplier's original document.                                                                                                                                                                    | `findOne()` doesn't include `scans`; no document viewer on the bill detail page.                                                                                                                                |
| AP-N15 | Bring existing suppliers and purchase history in from spreadsheets             | SHIPPED ✅ | Import a supplier list and historical expenses/purchase records without hand-keying.                                                                                                                                   | `import.controller.ts:54-137`.                                                                                                                                                                                  |
| AP-N16 | Barcode / SKU scan-to-add line entry on the bill form                          | SHIPPED ✅ | A focused scan input resolves a scanned code to a product, prefills unit cost from average cost, and increments quantity if already on the bill — a hardware-scanner entry path distinct from hand-keying and AI scan. | `apps/web/app/(dashboard)/vendor-bills/page.tsx:480-520`; resolves via `GET /products/barcode/:code` then a SKU search fallback.                                                                                |
| AP-N17 | Create a catalogue product, or split a generic into variants, from a bill line | SHIPPED ✅ | Resolve an unmapped line by creating a new product inline, or splitting a generic into variants, without leaving the bill.                                                                                             | `InlineCreateProductModal` (`vendor-bills/page.tsx:901-906`, `[id]/page.tsx:667`); `VariantSplitModal` (`[id]/page.tsx:1552`) backed by `POST /inventory/variant-assign`.                                       |
| AP-N18 | Mobile purchase-order receiving flow                                           | SHIPPED ✅ | A full mobile screen to receive against a PO, including a product picker — the operand behind the DRIVER-permitted receive route.                                                                                      | `apps/mobile/app/(operator)/purchase-orders/[id]/receive.tsx`, `pick-product.tsx`, `[id].tsx`.                                                                                                                  |
| AP-N19 | Expense bulk status change, and batch-queue listing                            | SHIPPED ✅ | Change several expenses' status in one action, and list in-progress scan batches so they're findable.                                                                                                                  | `POST /bookkeeping/expenses/batch-status`; `POST /bookkeeping/expenses/bulk`; `GET /import/batch`.                                                                                                              |
| AP-N20 | Supplier list fetch-all sentinel and active-only filtering                     | SHIPPED ✅ | `limit=0` fetches every supplier (documented sentinel, not pagination); `isActive` filters active-only.                                                                                                                | `list-suppliers.dto.ts`; `SuppliersService.findAll` `fetchAll = limitRaw === 0`. Same trap class as `reference_limit0_fetchall_sentinel_trap` — tighten the DTO bound carefully.                                |

### Testing criteria

#### AP-N1

- [ ] `Jest (api)`: Anthropic 401 → 400 `AI_KEY_INVALID`; 429/5xx → 503 `AI_UNAVAILABLE`; unparseable output → 422 `AI_PARSE_FAILED`. `Jest`
- [ ] `Jest (api)`: re-uploading identical bytes short-circuits on `fileHash` without a model call, but still re-runs the matcher. `Jest`
- [ ] `Jest (api)` NEGATIVE: an 11th file, one file over 25MB, or an aggregate over 60MB is rejected before any model call. `Jest`
- [ ] `Playwright (web)`: a low-confidence line renders a candidate picker; the bill can't post without resolving it. `Playwright`

#### AP-N2

- [ ] `Jest (api)`: a duplicate invoice in a batch is reported as such while the rest post — the batch doesn't abort wholesale. `Jest`
- [ ] `Jest (api)` IDEMPOTENCY: re-posting the same batch id creates no second bills/receive. `Jest`
- [ ] `Jest (api)`: two invoices from two suppliers produce two distinct bills, never merged. `Jest`
- [ ] `Playwright (web)`: stepping back/forward between queued invoices swaps both form and data with no bleed. `Playwright`

#### AP-N3

- [ ] `Jest (api)`: creating a bill with `scanId` flips that scan to POSTED and stores `vendorBillId`. `Jest`
- [ ] `Jest (api)`: a DISCARDED scan is excluded from the `fileHash` short-circuit. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: `GET /vendor-bills/scans` never returns another tenant's scans. `Jest`

#### AP-N4

- [ ] `Jest (api)`: receiving 3 of 10 sets PARTIAL and `qtyReceived: 3`; a later receive of 7 sets RECEIVED and keeps the original `receivedDate`. `Jest`
- [ ] `Jest (api)` NEGATIVE: requesting 8 when 7 remain is rejected 400, no stock moves. `Jest`
- [ ] `Jest (api)` NEGATIVE: the same `itemId` twice in one request is rejected 400. `Jest`
- [ ] `Jest (api)` LEGACY: a bill with `receivedDate` set and every line `qtyReceived: null` reads as fully received. `Jest`

#### AP-N5

- [ ] `Jest (api)` MONEY INVARIANT: packSize 24, unitCost 48.00 → `averageCost` 2.00/piece into empty stock; bill money never divides. `Jest`
- [ ] `Jest (api)`: receive-then-void of a case line returns `averageCost` exactly to its pre-receive value. `Jest`
- [ ] `Jest (api)`: a line with `packSize` null/1 passes through unconverted. `Jest`
- [ ] `Jest (api)`: two lines of the same product on one bill compound correctly inside the transaction. `Jest`

#### AP-N6

- [ ] `Jest (api)` IDEMPOTENCY: applying the same scan twice writes one payment set. `Jest`
- [ ] `Jest (api)` MONEY INVARIANT: a confirmed amount above the statement line or bill outstanding is rejected 400; excess is always 0, no credit minted from a discrepancy. `Jest`
- [ ] `Jest (api)`: when opening + Σ signed(lines) doesn't reconcile to `closingBalance`, every row is demoted out of `preChecked`. `Jest`
- [ ] `Jest (api)`: `BillPayment.paidAt` uses now(), never the statement line's date. `Jest`
- [ ] `Jest (api)` SCALE: with 600+ bills for one supplier, `fetchMatchableBills` finds a matchable bill beyond the first 500, deterministically (B117). `Jest`

#### AP-N7

- [ ] `Jest (api)` MONEY INVARIANT: 40 credit + 25 bill draws exactly 25; 10 credit + 25 bill draws 10 (never more than outstanding). `Jest`
- [ ] `Jest (api)`: the bill stays DRAFT after an auto-draw. `Jest`
- [ ] `Jest (api)`: 5 edit cycles never drift the credit balance. `Jest`
- [ ] `Jest (api)` NEGATIVE: a bill with no `supplierId` is untouched, no Prisma error. `Jest`

#### AP-N8

- [ ] `Jest (api)` MONEY INVARIANT: each selected bill gets one payment for exactly its remaining balance; status becomes PAID. `Jest`
- [ ] `Jest (api)` NEGATIVE: a VOID bill in the selection is `skipped` with a reason; the rest process. `Jest`
- [ ] `Jest (api)`: an Expense id whose `vendorBillId` points at a bill pays the bill, no double-booking. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: another tenant's id lands in `skipped`, never throws. `Jest`

#### AP-N9

- [ ] `Jest (api)`: `needsMapping=true` returns only DRAFT bills with zero items or an unmapped line. `Jest`
- [ ] `Jest (api)`: `meta.needsMappingCount` is correct even with other filters applied. `Jest`
- [ ] `Playwright (web)`: mapping the last unlinked line removes the bill from the queue and decrements the badge live. `Playwright`

#### AP-N10

- [ ] `Playwright (web)` REGRESSION: the "Partial" chip must list partially received POs (today it 400s). `Playwright`
- [ ] `Jest (api)`: `from`/`to` date filters actually narrow the result set. `Jest`
- [ ] `Jest (api)` STOCK INVARIANT: receiving 5 of 10 raises stock by 5 and sets PARTIAL; receiving 6 when 5 remain throws 400. `Jest`
- [ ] `Jest (api)`: a STANDARD-costed product's `averageCost` is unchanged by a PO receive. `Jest`
- [ ] `Manual`: pressing Send produces something the supplier can actually receive — today it does not. `manual`

#### AP-N11

- [ ] `Playwright (web)`: "Net 30" on a bill dated the 1st prefills a due date of the 31st; a manual edit isn't overwritten by a later supplier change. `Playwright`
- [ ] `Jest (api)`: posting `termsLabel` with no `dueDate` stores the label and leaves `dueDate` null. `Jest`
- [ ] `Jest (api)` NEGATIVE: a `termsLabel` over 40 characters is rejected. `Jest`
- [ ] `Manual`: a tenant using "Net 7" or "COD" has no way to add that option — hardcoded client list. `manual`

#### AP-N12

- [ ] `Jest (api)`: an INVENTORY_PURCHASE expense creates exactly one bill; re-saving creates no second. `Jest`
- [ ] `Jest (api)` MONEY INVARIANT: the created bill's `totalOwed` equals the expense amount to the cent. `Jest`
- [ ] `Jest (api)`: a non-inventory-category expense creates no bill. `Jest`
- [ ] `Jest (api)`: a null-`tenantId` Expense resolves its receipt owner through the parent bill. `Jest`

#### AP-N13

- [ ] `Jest (api)`: `search=88231` returns a bill whose `supplierInvoiceNumber` is "88231" even when notes don't contain it. `Jest`
- [ ] `Jest (api)`: search is normalization-aware ("inv 88231" finds "INV88231"). `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: an identical number in another tenant is never returned. `Jest`

#### AP-N14

- [ ] `Jest (api)`: `GET /vendor-bills/:id` for a scan-created bill returns at least one scan reference with a fetchable key. `Jest`
- [ ] `Playwright (web)`: "View original invoice" shows for scan-created bills, hidden for hand-keyed ones. `Playwright`
- [ ] `Jest (api)`: the document is served only via signed URL or to the owning tenant (see AP-M9). `Jest`

#### AP-N16

- [ ] `Jest (api)`: a barcode scan resolves via `GET /products/barcode/:code` and prefills `unitCost` from `averageCost`. `Jest`
- [ ] `Playwright (web)`: scanning an already-added SKU increments its quantity rather than adding a duplicate line. `Playwright`
- [ ] `Playwright (web)`: an unresolvable code toasts "Item not found" without adding a blank line. `Playwright`

#### AP-N17

- [ ] `Playwright (web)`: creating a product inline from a bill line writes the new `productId` back onto that line. `Playwright`
- [ ] `Jest (api)`: `POST /inventory/variant-assign` is OPERATOR-only; a DRIVER token 403s. `Jest`
- [ ] `Playwright (web)`: splitting a generic into variants removes it from the needs-mapping queue once every line resolves. `Playwright`

#### AP-N18

- [ ] `Jest (api)`: PO receive is reachable and behaves identically whether called from the mobile receive screen or the API directly. `Jest`
- [ ] `Manual`: the mobile pick-product flow lets a driver find and confirm the correct product without web access. `manual`

#### AP-N19

- [ ] `Jest (api)`: `batch-status` updates only the selected expense ids. `Jest`
- [ ] `Jest (api)`: `GET /import/batch` lists in-progress batches so an abandoned scan session is findable. `Jest`

#### AP-N20

- [ ] `Jest (api)`: `limit=0` returns every supplier, bypassing pagination. `Jest`
- [ ] `Jest (api)`: `isActive=true` excludes deactivated suppliers. `Jest`
- [ ] `Jest (api)` REGRESSION: `@Min(1)` must never be reapplied to `limit` without also fixing the fetch-all caller — this previously 400'd the web Suppliers page. `Jest`

## Advanced / future (P2)

| ID     | Capability                                                             | Status     | What it does                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-A1  | Three-way match: PO ↔ goods receipt ↔ supplier bill                    | MISSING ⬜ | Check the bill against what was ordered and received, surfacing variances before payment.                                              | `CreateVendorBillDto.purchaseOrderId` is declared but `VendorBill` has no such column and `create()` never reads it — silently dropped. PO receipt and bill receipt are independent stock paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AP-A2  | AP aging and cash-requirements forecast                                | MISSING ⬜ | Current/1-30/31-60/61-90/90+ buckets of what's owed, per supplier and in total.                                                        | Every aging endpoint on `bookkeeping.controller.ts` is AR-only; no endpoint aggregates `VendorBill` by due-date bucket.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AP-A3  | Payment runs with remittance advice                                    | MISSING ⬜ | Build a proposed payment batch, approve it, execute as one event, send suppliers a remittance.                                         | `recordSupplierPayment` already stamps one `paymentGroupId` across N payments, but there's no proposal step, approval, scheduling, or supplier-facing remittance template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AP-A4  | Landed cost — freight, duty, deposits allocated onto unit cost         | MISSING ⬜ | Non-product charges spread across received goods so per-piece cost reflects true landed cost.                                          | Freight/deposit lines are explicitly skipped for inventory and cost (`vendor-bills.service.ts:739-763`); `averageCost` blends from line `unitCost` alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AP-A5  | Supplier price lists and cost-change alerts                            | MISSING ⬜ | Know each supplier's quoted cost per product; flag invoice lines above last cost; compare suppliers.                                   | No Supplier↔Product relationship exists on the `Product` model; `receive()` performs no cost-variance check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AP-A6  | Supplier performance scorecard                                         | MISSING ⬜ | Per supplier: lead time, fill rate, short/over deliveries, price stability, dispute frequency.                                         | `Supplier.leadTimeDays` is captured but never used in a calculation; nothing aggregates `qtyOrdered` vs `qtyReceived`. Supplier-dimension EXPENSE spend is reportable (`GET /bookkeeping/reports/expense-details` includes/projects `supplier`), but that covers Expense rows only, not the fill-rate/lead-time metrics this capability needs — the scorecard itself remains unbuilt.                                                                                                                                                                                                                                                                                                                                                         |
| AP-A7  | Reorder suggestions that become a draft purchase order                 | PARTIAL 🟡 | Products below reorder point, weighted by lead time and velocity, grouped by supplier into a one-click draft PO.                       | `GET /inventory/forecasting` returns per-product reorder data and thresholds are settable, but nothing turns the list into a PO, and nothing groups by supplier (no Product↔Supplier link).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AP-A8  | Debit notes / return-to-supplier credits                               | MISSING ⬜ | Send damaged/short-shipped goods back and raise a claim that reduces what's owed and removes the stock.                                | `SupplierCredit` is minted only from an overpayment; no supplier-direction return exists; `MovementType` has no supplier-return member.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AP-A9  | Bill approval workflow with an audit trail                             | MISSING ⬜ | Bills above a threshold, or from a new supplier, need a second approval; who approved what is recorded.                                | No approval state on `VendorBill`; no audit trail anywhere in the AP module — void/payment/receive/delete leave no actor record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AP-A10 | Supplier-side ingestion — invoices by email, EDI, or a supplier portal | MISSING ⬜ | Supplier invoices arrive as data instead of being photographed one at a time.                                                          | Every ingestion path is an operator-initiated multipart upload; the email module is outbound only; no inbound purchase-document feed exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AP-A11 | Scan consumption metered against an OCR pack                           | MISSING ⬜ | Each AI document read counts against an included scan allowance, shown in a usage bar, with a soft-cap grace window.                   | The metered SKU this would run on, `OCR_PACK_250`, is deliberately RETIRED in the live catalog (`publish-plan-catalog-v11.ts:86-92`, `RETIRED_SKUS`; header comment: "have no cap-check wired to their meter... Selling a SKU with no enforcement behind it is the bug this retires") and omitted from published SKU rows (:212). `PlanDefinition.scansIncluded` is still published per plan, and nothing increments the SCANS meter — the only production `MeterService.increment` caller is messaging (`MSGS`). Separately, real and unresolved: `AddonGuard`/`addon.service.ts:54-60` reads `TenantAddon` rows only, so a SCALE plan's `addon.ocr` feature flag cannot satisfy the guard — only the platform-admin toggle grants scanning. |
| AP-A12 | Duplicate-payment protection across settlement routes                  | PARTIAL 🟡 | The same invoice can't be paid twice through two different routes — bill payment, statement apply, bulk mark-paid.                     | Each route caps individually against the ledger, but nothing cross-checks: the same supplier invoice number settled twice under two bill numbers (via `allowDuplicate`) raises no warning, nor does a near-identical repeat payment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AP-A13 | Regulated purchases register and statutory filing export               | SHIPPED ✅ | A statutory purchase register for regulated goods, built from PURCHASE movements, with a monthly trend view and CSV/PDF filing export. | `GET /tobacco/purchases`, `GET /tobacco/monthly`, `POST /tobacco/reports/generate`, `GET /tobacco/reports/:id/{csv,pdf}` — `tobacco.controller.ts:36-68`; `tobacco-report.service.ts:137-256` builds per-product purchase value from PURCHASE stock movements; `tobacco.service.ts:174-215` buckets 12 months for the trend chart. Gated by the `tobacco_dealer` addon.                                                                                                                                                                                                                                                                                                                                                                       |

### Testing criteria

#### AP-A1

- [ ] `Jest (api)`: `purchaseOrderId` on create must either persist the link or reject the field — never silently drop it (current defect). `Jest`
- [ ] `Jest (api)` STOCK INVARIANT: receiving a PO then a bill raised from that PO increases stock once. `Jest`
- [ ] `Jest (api)`: a bill line priced above its PO line beyond tolerance is flagged and blocks payment per policy. `Jest`
- [ ] `Jest (api)`: a bill for more than received is flagged as an over-billing variance. `Jest`

#### AP-A2

- [ ] `Jest (api)` MONEY INVARIANT: Σ all AP aging buckets == Σ(totalOwed − totalPaid) over non-VOID bills. `Jest`
- [ ] `Jest (api)`: a bill with `dueDate: null` lands in a defined bucket, never dropped or double-counted. `Jest`
- [ ] `Jest (api)`: VOID bills and credit draws are excluded. `Jest`
- [ ] `Playwright (web)`: the finance dashboard shows payables beside receivables. `Playwright`

#### AP-A3

- [ ] `Jest (api)`: a proposed run for a date window contains exactly the unpaid non-VOID bills due by that date. `Jest`
- [ ] `Jest (api)` IDEMPOTENCY: executing the same run twice writes one payment set. `Jest`
- [ ] `Jest (api)`: removing one bill from a proposal reduces the executed total by exactly its outstanding. `Jest`
- [ ] `Manual`: the remittance a supplier receives lists both our bill numbers and their invoice numbers. `manual`

#### AP-A4

- [ ] `Jest (api)` MONEY INVARIANT: 1000 goods + 100 freight allocated by value raises inventory value by exactly 1100, no cent lost. `Jest`
- [ ] `Jest (api)`: allocation across unequal-value lines distributes the remainder cent deterministically. `Jest`
- [ ] `Jest (api)`: voiding the bill reverses allocated landed cost as precisely as goods cost. `Jest`
- [ ] `Jest (api)` NEGATIVE: a landed-cost line with no linked goods lines is rejected or held, never silently absorbed. `Jest`

#### AP-A5

- [ ] `Jest (api)`: a line priced above the supplier's last recorded cost for that product by more than a tenant threshold is flagged before receive. `Jest`
- [ ] `Jest (api)`: the flag is per (supplier, product), not global. `Jest`
- [ ] `Jest (api)`: the comparison uses per-piece cost on both sides. `Jest`
- [ ] `Playwright (web)`: a product page shows supplying suppliers and cost history. `Playwright`

#### AP-A6

- [ ] `Jest (api)`: actual lead time is `receivedDate − createdAt` per receipt, averaged per supplier; no receipts reports null, not 0. `Jest`
- [ ] `Jest (api)`: fill rate == Σ `qtyReceived` / Σ `qtyOrdered` over a window, excluding VOID/closed-short. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: excludes another tenant's bills for a same-named supplier. `Jest`
- [ ] `Playwright (web)`: the supplier page surfaces the scorecard and degrades cleanly for a one-bill supplier. `Playwright`

#### AP-A7

- [ ] `Jest (api)`: stock 4 / reorderPoint 10 / reorderQty 24 appears in suggestions with proposed qty 24. `Jest`
- [ ] `Jest (api)` MONEY INVARIANT: suggestions group into one draft PO per supplier, `totalAmount == Σ(qty × unitCost)` to the cent. `Jest`
- [ ] `Jest (api)` NEGATIVE: a product with `reorderPoint: null` is never suggested. `Jest`
- [ ] `Jest (api)`: 403s with a structured `PLAN_GATE` for a tenant without `flag.forecasting`. `Jest`

#### AP-A8

- [ ] `Jest (api)` MONEY INVARIANT: a 120 debit note reduces statement outstanding by exactly 120, its own timeline row. `Jest`
- [ ] `Jest (api)` STOCK INVARIANT: a 10-piece debit note writes one negative movement at the correct per-piece cost. `Jest`
- [ ] `Jest (api)` NEGATIVE: a debit note can't exceed quantity actually received on the referenced line. `Jest`
- [ ] `Jest (api)`: voiding a debit note reverses both money and stock exactly. `Jest`

#### AP-A9

- [ ] `Jest (api)` NEGATIVE: a bill above the approval threshold can't be paid until approved. `Jest`
- [ ] `Jest (api)`: the approver can't be the bill's creator (segregation of duties). `Jest`
- [ ] `Jest (api)`: void/payment/delete each write an audit log entry naming the actor and before/after amounts. `Jest`
- [ ] `Jest (api)`: approval state resets across a revert-to-draft/edit cycle. `Jest`

#### AP-A10

- [ ] `Jest (api)` IDEMPOTENCY: an inbound message from a known supplier domain creates exactly one scan and one draft bill; replay creates neither. `Jest`
- [ ] `Jest (api)` NEGATIVE: an unknown-sender attachment is quarantined, never auto-posted. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: ingestion routes by destination address and can't write into another tenant. `Jest`
- [ ] `Jest (api)`: ingestion respects the same OCR addon gate and duplicate guards as manual scan. `Jest`

#### AP-A11

- [ ] `Jest (api)`: a successful invoice scan increments the tenant's SCANS meter by exactly 1; a failed call by 0. `Jest`
- [ ] `Jest (api)`: a `fileHash` short-circuit consumes no scan. `Jest`
- [ ] `Jest (api)`: exceeding `scansIncluded` opens a grace window and still returns the scan. `Jest`
- [ ] `Jest (api)`: a SCALE-plan tenant with `addon.ocr` in plan flags but no `TenantAddon` row — assert the intended outcome explicitly (today it's a 403). `Jest`

#### AP-A12

- [ ] `Jest (api)` MONEY INVARIANT: three concurrent settlement attempts on one bill leave Σ payments ≤ `totalOwed`. `Jest`
- [ ] `Jest (api)`: two bills sharing a supplier invoice number (via `allowDuplicate`) that are both paid raise a duplicate-payment warning naming both. `Jest`
- [ ] `Jest (api)`: a payment identical in supplier/amount/method within 7 days requires explicit confirmation. `Jest`
- [ ] `Jest (api)` NEGATIVE: the guard never blocks two genuinely distinct same-amount payments once confirmed. `Jest`

#### AP-A13

- [ ] `Jest (api)`: the purchases register total for a period equals Σ PURCHASE movement value for regulated products in that period. `Jest`
- [ ] `Jest (api)`: CSV/PDF export is gated by the `tobacco_dealer` addon and 403s without it. `Jest`
- [ ] `Jest (api)` TENANT ISOLATION: the register never includes another tenant's movements. `Jest`

## How this varies by tenant

| Variation                                                                    | Mechanism                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the tenant gets AP at all (bills, payments, scanning)                | `flag.ap_bills`, granted from GROWTH up; class-level `@RequirePlanFlag` on `VendorBillsController` only. **Currently muted** — it sits in `DARK_PLAN_FLAGS` so it only enforces when `PLAN_FLAG_ENFORCEMENT=on`, and `SupplierStatementsController` plus `suppliers.controller.ts` carry no gate at all. |
| Whether AI document reading is available                                     | `TenantAddon` key `"ocr"`, enforced by `@RequireAddon("ocr")` + `AddonGuard`. Granted only from the platform-admin tenant page — the `addon.ocr` plan flag on SCALE does NOT satisfy the guard, and the `OCR_PACK_250` SKU it used to bridge from is retired in the live catalog.                        |
| How many AI scans are included before overage                                | `PlanDefinition.scansIncluded` per plan. **NOT ENFORCED** — no code increments the SCANS meter for AP scans; the metered pack SKU is retired.                                                                                                                                                            |
| Payment terms offered per supplier                                           | Per-supplier `Supplier.defaultTerms` copied onto `VendorBill.termsLabel`. **NOT CONFIGURABLE** — the option list is hardcoded client-side, and the server never derives a due date.                                                                                                                      |
| Whether a receipt moves the product's average cost                           | Per-product `Product.costingMethod` — STANDARD keeps the operator-set cost; every other method blends via `nextAverageCost`.                                                                                                                                                                             |
| Regulated/tobacco purchasing — licence capture and monthly filing            | `TenantAddon "tobacco_dealer"` gates `TobaccoController`, whose purchases report reads PURCHASE movements joined to `Supplier.tobaccoLicenseNo`.                                                                                                                                                         |
| Which Anthropic key pays for AP scanning                                     | Per-tenant `SystemConfig` key → platform key → env, resolved by `resolveAnthropicKey`. Missing everywhere yields a plain 400 with no error code.                                                                                                                                                         |
| Whether drivers may raise/receive purchase orders and post stock adjustments | **NOT CONFIGURABLE** — hardcoded `@Roles(OPERATOR, DRIVER)` on PO and movement routes, while stock counts are OPERATOR-only. Bug register B168.                                                                                                                                                          |
| Bill and PO document numbering format                                        | **NOT CONFIGURABLE** — `BILL-YYYY-NNNN` and the PO prefix are hardcoded; customer-invoice numbering import has no purchasing equivalent.                                                                                                                                                                 |
| Duplicate-detection and statement-matching tolerances                        | **NOT CONFIGURABLE** — amount, date, and closing-balance tolerances, plus the 500-row matchable-bill cap and scan-match thresholds, are all hardcoded constants.                                                                                                                                         |
| Which model reads statements versus invoices                                 | Deliberately separate hardcoded model constants so the two can diverge independently. **NOT tenant-configurable.**                                                                                                                                                                                       |
| Two divergent supplier CRUD surfaces                                         | **NOT CONFIGURABLE**, and a source of drift — `/suppliers` (geocodes, normalizes terms, guards delete) versus `/inventory/suppliers` (used by the web Inventory page and e2e mocks), with different behaviour depending on which door was used.                                                          |

## Gaps for a great UX

| Severity | Gap                                                                                                       | Impact                                                                                                                                                                                                                                                                            | Suggested direction                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Supplier statement PDFs are readable by any authenticated user in any tenant                              | `OWNER_LOOKUPS` has no `supplier-statements` entry and the prefix regex doesn't cover it, so the tenant check is skipped entirely and the file streams. Discloses another business's suppliers, invoice numbers, amounts and payment behaviour. Bug register B52, Critical, Open. | Add a `supplier-statements` entry to `OWNER_LOOKUPS` resolving `SupplierStatementScan → tenantId`, and make an unrecognised prefix deny by default rather than serve. Pin with a Jest spec against `1.pdf` (files are 1-indexed). |
| HIGH     | Voiding a bill erases every real payment made against it from the supplier's balance                      | `getSupplierStatement` filters bills `status != VOID` and emits payments only from inside that bill loop, so cash paid against a later-voided bill vanishes from the timeline, `totalPaid`, and `outstanding`.                                                                    | Refuse to void a bill with cash payments (offer a debit-note/refund path), or keep those payment rows in the timeline as a distinct type with a zeroed bill line.                                                                 |
| HIGH     | No AP aging, no due-date filter, no server-side overdue                                                   | `OVERDUE` is never written, `findAll` has no `dueBefore` filter and orders by `createdAt`, every aging report is receivables-only, and the web list's due-date sort is client-side over one page. Cash planning is unsupported.                                                   | Add `GET /vendor-bills/aging`, a `dueBefore`/overdue filter and server-side due-date sort, and a payables tile beside the AR one on the finance dashboard.                                                                        |
| HIGH     | Purchase orders and vendor bills are two unconnected systems that can both add the same stock             | `purchaseOrderId` on bill create is silently dropped; a PO receive and a bill receive for the same delivery can double stock with nothing to detect it; the Bills-hub PO tab sends an invalid status and 400s (B27).                                                              | Add `VendorBill.purchaseOrderId` and net bill receipts against PO receipts; warn on receive when an open PO exists for the same supplier/products; fix the status chip and wire or remove the date filters.                       |
| HIGH     | The whole AP surface is visible to tenants who aren't entitled to it                                      | "Suppliers" and "Bills & Purchasing" render unconditionally in the sidebar, and "Scan Invoice" is always offered; an un-addoned tenant gets a raw 403 toast, and enabling the enforcement kill switch would leave a STARTER tenant a dead section.                                | Gate nav entries on `flag.ap_bills` and scan affordances on the OCR addon, with an upgrade prompt instead of a 403 toast — before the `DARK_PLAN_FLAGS` kill switch is removed on 2026-10-01.                                     |
| MEDIUM   | No audit trail on any AP action                                                                           | Voiding a received bill, recording/deleting a payment, and deleting a bill leave no actor record. Makes internal fraud and honest mistakes equally uninvestigable, and any future approval workflow meaningless.                                                                  | Write audit log entries for void/payment/receive/delete/bulk-delete with actor, bill id, and before/after totals.                                                                                                                 |
| MEDIUM   | You cannot find a bill by the supplier's own invoice number, nor open the original document from the bill | The two most common AP interactions — "the supplier is on the phone about invoice 88231" and "show me what they sent us" — have no path. `supplierInvoiceNumber` is indexed but excluded from search; `findOne` omits `scans`.                                                    | Add normalized `supplierInvoiceNumber` to the search clause, include `scans` in `findOne`, and add a "View original invoice" affordance on the bill detail page.                                                                  |
| MEDIUM   | Statement matching silently loses candidates for high-volume suppliers                                    | `fetchMatchableBills` takes 500 bills with no `orderBy`; past 500 non-void bills the subset is database-arbitrary and not reproducible between runs. Bug register B117.                                                                                                           | Order by `billDate desc, id`, scope the fetch to the statement's date window plus margin, and surface a warning when the cap is hit.                                                                                              |
| MEDIUM   | Sending a purchase order sends nothing, and receive notes are thrown away                                 | `sendPurchaseOrder` only flips status — no PDF, no email — so the operator still messages the order manually; receive notes are validated in the UI then discarded (B88).                                                                                                         | Generate a PO PDF and send via the existing email service; persist receive notes on `PurchaseOrderItem` or as a movement note. If sending won't be built, rename the action to stop implying delivery.                            |
| MEDIUM   | There is no way to raise a claim against a supplier for damaged or short-shipped goods                    | `SupplierCredit` can only be created by overpaying; the customer-side Return machinery has no supplier-direction equivalent, and `MovementType` has no supplier-return member.                                                                                                    | Add a supplier debit note that reduces bill outstanding, writes a negative stock movement at received cost, and appears on the supplier statement, reusing `SupplierCredit` mechanics.                                            |
| MEDIUM   | Freight, duty and deposits never reach the cost of the goods                                              | They're explicitly skipped as unlinked lines, so per-piece average cost — driving every margin and COGS figure — understates true landed cost by the whole freight bill.                                                                                                          | Add an allocation step at receive: mark a line as landed cost, choose by-value or by-quantity, spread with largest-remainder cent distribution, reverse symmetrically on void.                                                    |
| LOW      | The supplier statement endpoint returns unbounded history with no date window or export                   | `getSupplierStatement` fetches every non-void bill with all payments and credits, sorts in memory, returns the lot — no as-of date, no pagination, no PDF/CSV.                                                                                                                    | Add `from`/`to` and as-of-balance parameters with pagination, plus a printable/exportable statement reusing the customer statement PDF pattern.                                                                                   |
| LOW      | Two divergent supplier CRUD surfaces mean behaviour depends on which door was used                        | `/suppliers` geocodes, normalizes terms and guards deletion; `/inventory/suppliers` is a separate, used-by-web-Inventory path that can leave a supplier without coordinates or with an empty-string terms value.                                                                  | Make the inventory routes thin delegates to `SuppliersService` (or deprecate them behind a redirect) so behaviour is uniform.                                                                                                     |

## Cross-domain handoffs

- **Inventory / stock**: bill receive, PO receive, and manual purchase movements (AP-M13) are the
  three write paths into `Product.currentStock`, `averageCost`, `StockMovement` and `StockLot`.
  Any change to `lineInventoryDelta`, `nextAverageCost` or `reverseAverageCost` ripples into
  valuation, forecasting and margins, and a backdated bill triggers `recomputeProductInTx` to
  replay later movement snapshots.
- **Products / catalogue**: scan matching resolves against composed "Parent - Variant" names plus
  per-line SKU, and `ProductMapping` remembers the supplier's wording. Creating or splitting a
  product from the bill detail page (AP-N17) writes back into the catalogue, and the bill line's
  `packSize` is what makes per-piece cost correct.
- **Bookkeeping / expenses**: `Expense.vendorBillId` is a bare scalar with no Prisma relation —
  inventory-purchase expenses auto-promote to bills, bulk-mark-paid resolves either kind, and the
  uploads owner lookup has to hop expense → bill to serve a receipt. Supplier-dimension spend IS
  reportable via `expense-details`/`expenses-by-category`, but only for Expense rows, not bills
  created outside that path. P&L COGS is estimated from invoiced sales at point-in-time average
  cost — downstream of every receive.
- **Invoices / AR**: the deliberate mirror — `recordSupplierPayment` mirrors
  `recordStandalonePayment`, `BillPayment.paymentGroupId` mirrors `InvoicePayment.paymentGroupId`,
  `SupplierCredit` mirrors the customer credit wallet. Fixes on one side should be considered on
  the other, but the two document sets must never be cross-matched for duplicates.
- **Regulated / tobacco**: the tobacco purchases register (AP-A13) reads PURCHASE stock movements
  joined to `Supplier.tobaccoLicenseNo`, so a mis-denominated or reversed receive changes a
  statutory filing, not just a report.
- **Import / migration**: batch invoice scanning calls `VendorBillsService.create`/`.receive`
  directly, and expense/supplier CSV imports seed the supplier master. `DuplicateMatchModule` is
  imported directly (never `ImportModule`/`VendorBillsModule`) specifically to avoid a dependency
  cycle.
- **Uploads / storage**: scanned invoices and statements live under `invoice-scans/<id>/` and
  `supplier-statements/<scanId>/` on the Railway volume, served through the HMAC-signed uploads
  endpoint — the `OWNER_LOOKUPS` table there IS the tenant boundary for AP documents (see AP-M9).
- **Billing / entitlements**: `flag.ap_bills` gates the AP controller (partially), addon `"ocr"`
  gates all scan endpoints, and `AiUsageEvent` records per-call token spend as cost telemetry —
  distinct from (and currently disconnected from) the retired `SCANS` meter. Any new gate here
  needs a UI that grants it and a story for existing tenants on deploy day.
- **Analytics**: has no dedicated supplier or payables dimension — lead time, fill rate, and
  price-variance reporting (AP-A5, AP-A6) are unbuilt. Supplier-tagged expense spend is reportable
  today through bookkeeping's expense reports, which is a narrower slice than a true purchasing
  analytics view.
- **Notifications / messaging**: entirely customer-facing. There is no supplier-directed template,
  so nothing here can chase a PO, send a remittance, or warn the operator that a bill falls due.

## What we could not verify

Everything marked SHIPPED is anchored to a route, a service symbol with a line number, a Prisma
model, or a screen file that was opened directly — not run. No claim here is runtime-verified;
statuses reflect code reading only, corrected once against an adversarial second pass.

- **B52 (cross-tenant supplier-statement files)** is asserted from the absence of a
  `supplier-statements` key in `uploads.controller.ts` `OWNER_LOOKUPS` plus the unguarded
  fall-through — not exploited live. Any regression test must target the 1-indexed file name
  (`1.pdf`, not `0.pdf`).
- The `PARTIALLY_RECEIVED` PO chip 400 is inferred from `@IsEnum(PurchaseOrderStatus)` plus the
  client passing status through verbatim — not reproduced in a browser.
- Whether `PLAN_FLAG_ENFORCEMENT` is currently `on` in production is unknown; `flag.ap_bills`'s
  live enforcement state was not checked.
- The platform-admin OCR toggle writing `TenantAddon` key `"ocr"` was confirmed in code, but the
  Stripe SKU-activation path was not traced end-to-end.
- Mobile screens (including AP-N18's receive flow) were identified by path and by their imported
  API hooks, not read in full — mobile parity claims are structural, not visual.
- Known-defect references (B26 cleared; B27, B52, B88, B117, B168 open) come from the local bug
  register; B52, B117 and B168 were re-verified against current master source, B27/B88 against the
  register only.
- OCR extraction quality and the scan prompt itself were not audited — only error mapping,
  deduplication, and gating.
- Line numbers are from the master commit reviewed and will drift with future changes.
- The AP-A11 correction (retired `OCR_PACK_250` SKU) rests on `publish-plan-catalog-v11.ts` as the
  live catalog; whether any tenant retains a legacy, pre-retirement grant of that SKU was not
  checked.
