# Order Handling & Order Intake

_From five uncoordinated ways of taking an order to one record that carries the right price,
the right split, and the right history all the way to the invoice._

## The problem

A wholesale distributor takes orders in five places at once — a phone call scribbled in a
notebook, a WhatsApp voice note, a rep keying it into a spreadsheet in the van, a standing "same
as usual every Tuesday", and a walk-in at the counter. Nobody knows the true open-order book
until someone reconciles it by hand, the same customer's three separate calls become three
separate deliveries on the same day, and prices are whatever the rep remembers. Cases versus
loose pieces get muddled, so the invoice bills a case price on a piece quantity (or vice versa)
and the money is wrong before it ever reaches the accounting package. Then the order is re-keyed
a second time into that package as an invoice, where a typo becomes an under-collection nobody
ever finds.

## Why it matters to a tenant

One order record carries the customer's agreed price, the case/piece split, and the
regulated-category snapshot from the moment it is taken through to the invoice, so the goods are
billed exactly once at the price that was agreed and no one re-keys anything. RouteFlow collapses
a customer's separate calls into a single open order automatically (`mergeAllPendingForCustomer`
plus an hourly sweep), so one delivery goes out instead of three. Boxed money is computed once by
a shared, spec-pinned helper (`computeLineSubtotal` with box proration) in all three apps, which
removes the single most expensive recurring error in this trade: a `unitsPerBox`-multiple over-
or under-charge on every case line. Every post-placement edit writes an immutable `OrderRevision`
(line edits) or a plain note (status changes), so "who changed this order and when" is mostly
answerable without an argument — though not for every field, see ORD-M12 below.

## Core use cases

1. **Capture an order against a customer, priced correctly.** Staff key or scan an order (web
   CreateOrderModal, mobile NewOrderScreen, driver at a stop) or a buyer submits one from the
   portal/app; each line resolves the customer's tier or remembered price, splits cases vs pieces
   against the product's snapshot pack size, and lands as an Order + OrderItem rows whose totals
   reconcile to the sum of stored line subtotals.
2. **Move that order through its life without losing money or history.** The order steps
   DRAFT → PENDING → CONFIRMED → OUT_FOR_DELIVERY → (PARTIALLY_)DELIVERED, can step one stage back
   with a reason, or be cancelled; lines can be added, re-quantified, substituted or struck off at
   any live stage.
3. **Hand the order off to fulfilment and billing exactly once.** Reaching DELIVERED (or the
   at-door completion of its route stop) generates or reconciles the invoice from the stored line
   money on the delivered quantities, so goods are billed once, at the agreed price, with the
   regulated-category split intact.

## Must have (P0)

| ID      | Capability                                                            | Status     | What it does                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORD-M1  | Multi-surface keyed order entry                                       | SHIPPED ✅ | Operator, driver, or buyer creates an order with catalog/ad-hoc lines, notes, urgency, requested date                                                        | `POST /api/v1/orders` → `OrdersService.create`; `CreateOrderDto`; web `CreateOrderModal.tsx`; mobile `NewOrderScreen.tsx`; buyer `POST /api/v1/buyer/orders`                                                                                                                                                                                                                                      |
| ORD-M2  | Order lifecycle and guarded status transitions                        | SHIPPED ✅ | Explicit legal-transition map, one-step-back demotions with reason, role limits                                                                              | `OrdersService.changeStatus`; `allowed` map; mirrored in `apps/mobile/lib/order-status-flow.ts`                                                                                                                                                                                                                                                                                                   |
| ORD-M3  | Post-placement line editing (add / re-quantify / cancel / substitute) | SHIPPED ✅ | Lines added, edited, struck off, substituted at every live stage                                                                                             | `PATCH /orders/:id/items` → `updateOrderItems`; `UpdateOrderItemsDto`; buyer twin `PATCH /buyer/orders/:id/items`                                                                                                                                                                                                                                                                                 |
| ORD-M4  | Case / piece quantities with correct boxed money                      | SHIPPED ✅ | Boxed lines price by proration against the pack size in force at sale time                                                                                   | `computeLineSubtotal`/`normalizeBoxesPieces`/`roundMoney` mirrored in api/web/mobile `pricing.ts`; `pricing.spec.ts`; Playwright BOXED-01                                                                                                                                                                                                                                                         |
| ORD-M5  | Customer-specific pricing resolved at line time                       | SHIPPED ✅ | Each line prices from tier/per-customer/last-given price with strikethrough original                                                                         | `resolveBuyerLinePrice`; `CustomerPrice`; `getCustomerPriceHistory` excludes PROMO                                                                                                                                                                                                                                                                                                                |
| ORD-M6  | Order → invoice handoff, billed once                                  | SHIPPED ✅ | Delivery generates/reconciles the invoice from stored line money; a manual "Generate Invoice" control also exists                                            | `createInvoiceFromOrderWithTenant`; `reconcileOrderDraftInvoice`; `recomputeOrderFromInvoices`; `OrderItem.invoicedQty`; verified: manual full-order invoice route `POST /invoices/from-order/:orderId` (`invoices.controller.ts:54`) and its web "Generate Invoice (full order)" button are also part of this shipped surface — createSale's own error text points staff at it                   |
| ORD-M7  | Cancel an order and unwind the money                                  | PARTIAL 🟡 | Cancelling voids invoices and releases credit/wallet money, but decremented stock is never restored                                                          | `changeStatus` CANCELLED branch; `assertCancellableOrThrow`; `GET /orders/:id/cancel-impact`; no `currentStock: { increment }` on cancel or delete                                                                                                                                                                                                                                                |
| ORD-M8  | Duplicate-order prevention and consolidation                          | PARTIAL 🟡 | Merge-choice gate, buyer auto-merge, hourly sweep fold stray PENDING orders; no idempotency key on create                                                    | `409 MERGE_CHOICE_REQUIRED`; `mergeAllPendingForCustomer`; `cronSweepPendingOrders`; no `Idempotency-Key` support on `POST /orders`; verified: the STAFF merge branch (`orders.controller.ts:87-112`) rebuilds lines as bare `{productId, qty}` with no `id`/`replaceAll`, so it also falls into the destructive replace path, not just the buyer merge                                           |
| ORD-M9  | Find an order (list, filter, look up by number)                       | BROKEN 🔴  | Staff can filter by customer/status/product/date, but cannot find an order by its own order number                                                           | `GET /orders` → `findAll`; `search` maps only to `customer.businessName`; web list never sends `search` and filters client-side over the loaded page; mobile sends it to a param the API can't use for order numbers                                                                                                                                                                              |
| ORD-M10 | Stock is committed when the order is taken                            | PARTIAL 🟡 | Non-draft orders check/decrement stock under a row lock; DRAFT orders never commit stock at all, even after promotion                                        | `orders.service.ts:1857-1902` FOR UPDATE + decrement, staff warn-and-proceed vs hard 409 for others; no `StockMovement` written; verified: the `if (!isDraft && stockLines.length > 0)` guard means DRAFT orders — including the park/resume flow and buyer drafts — never decrement stock even after promoting to PENDING/DELIVERED (`settleStockForEdit` also short-circuits on DRAFT, `:3739`) |
| ORD-M11 | Tenant isolation and role authority on every order route              | SHIPPED ✅ | Every read/write scoped to caller's tenant; explicit role gates per route                                                                                    | `PrismaService.forTenant()`; `@Roles` per route; `orders.security.spec.ts`; buyer routes behind `BuyerSellerContextGuard`                                                                                                                                                                                                                                                                         |
| ORD-M12 | Immutable order edit history                                          | PARTIAL 🟡 | Line edits write an append-only `OrderRevision`, but status changes, urgency, shipment, fulfilment path and commission-rate changes write no revision at all | verified: `appendOrderRevision` has exactly two call sites — `updateOrderItems` (`:3581`) and `approveChangeRequestAtStop` (`:4515`); `changeStatus` demotions/cancels only append a free-text `Order.notes` line; `toggleUrgent`, `updateShipment`, `updateFulfillPath`, `setCommissionRate` write no revision and there is no separate `AuditService` coverage for orders                       |
| ORD-M13 | Split / partial invoicing of an order                                 | SHIPPED ✅ | Staff or driver can bill only chosen lines/quantities of an order now, and cannot over-bill the remainder                                                    | `POST /invoices/from-order/:orderId` and `/partial` (`invoices.controller.ts:54,65`) → `createInvoiceFromOrder`/`createPartialFromOrder`; `CreatePartialInvoiceDto`; increments `OrderItem.invoicedQty`; web `SplitInvoiceModal.tsx`; mobile operator + driver split-invoice screens                                                                                                              |

### Testing criteria

#### ORD-M1

- [ ] Creating an order with two catalog lines persists `Order.subtotal === roundMoney(Σ OrderItem.subtotal)` and total matches the full formula. `Jest (api)`
- [ ] A line whose resolved qty is ≤ 0 throws `BadRequestException` and no order row is written. `Jest (api)`
- [ ] A CUSTOMER caller supplying an unlisted line is rejected; a CUSTOMER cannot create an order for another customerId. `Jest (api)`
- [ ] The builder's persisted total equals the previewed total, to the cent. `Playwright (web)`
- [ ] An order created under tenant A is absent (not 403) from a tenant B token's list. `Jest (api)`

#### ORD-M2

- [ ] PENDING → OUT_FOR_DELIVERY is rejected 400 and the row is unchanged. `Jest (api)`
- [ ] DELIVERED → CONFIRMED without `reason` is rejected; with a reason it succeeds and nulls `deliveredAt`. `Jest (api)`
- [ ] Demoting DELIVERED on a COMPLETED route-run stop throws `ConflictException` and writes nothing. `Jest (api)`
- [ ] A DRIVER token cannot advance CONFIRMED → OUT_FOR_DELIVERY; a CUSTOMER can only cancel their own PENDING/DRAFT order. `Jest (api)`
- [ ] Mobile's `ORDER_STATUS_TRANSITIONS` deep-equals the API's `allowed` map. `Jest (mobile)`

#### ORD-M3

- [ ] An add-only diff with `replaceAll:false` leaves untouched lines byte-identical. `Jest (api)`
- [ ] A DRIVER's diff routes through MERGE and strips `unitPrice`/`overrideReason` on catalog lines. `Jest (api)`
- [ ] Substituting a case-packed product re-splits boxes/pieces against the substitute's `unitsPerBox`. `Jest (api)`
- [ ] Editing a CANCELLED order throws; the CANCEL action keeps the row rather than deleting it. `Jest (api)`
- [ ] Every successful edit appends exactly one `OrderRevision` with a copied (not recomputed) snapshot. `Jest (api)`

#### ORD-M4

- [ ] `unitsPerBox=12`, box price $35: 1 box + 6 pieces stores subtotal $52.50, not qty(18)×35. `Jest (api)`
- [ ] Changing a product's `unitsPerBox` afterwards does not re-interpret an existing order line. `Jest (api)`
- [ ] Every stored monetary write equals `roundMoney(...)` to two decimals. `Jest (api)`
- [ ] The scraped live box price/pack size in the builder matches the persisted row amount. `Playwright (web, BOXED-01)`
- [ ] A boxed product added by a buyer is split and prorated, never stored as a raw box count. `Jest (api)`

#### ORD-M5

- [ ] A tier-2 customer's line stores the tier-2 price on both the create and buyer-merge branches. `Jest (api)`
- [ ] `getCustomerPriceHistory` never returns a PriceType.PROMO price. `Jest (api)`
- [ ] A staff override stores net unitPrice + `originalPrice = catalog list` + `discount: 0`. `Jest (api)`
- [ ] A CUSTOMER-role read of an upsell line has `originalPrice → null` and cost fields dropped. `Jest (api, upsell-redaction.spec)`

#### ORD-M6

- [ ] Delivering an order with a full-qty DRAFT mirror invoice does not create a second one. `Jest (api)`
- [ ] The generated invoice's subtotals are copied/prorated from stored `OrderItem` subtotals. `Jest (api)`
- [ ] Partial-invoice subtotals sum exactly to the order line's stored subtotal. `Jest (api)`
- [ ] Editing a DELIVERED order rebuilds its invoice in place, preserving payments. `Jest (api)`

#### ORD-M7

- [ ] Cancelling with a SENT invoice voids it and releases applied credit notes in the same transaction. `Jest (api)`
- [ ] Cancelling an order with a non-wallet payment throws `ConflictException` naming the amount. `Jest (api)`
- [ ] Creating a 10-unit order at stock 100 then cancelling it must return `currentStock` to 100 — currently fails, stays at 90. `Jest (api)`
- [ ] `GET /orders/:id/cancel-impact` is read-only across repeated calls. `Jest (api)`

#### ORD-M8

- [ ] Staff `POST /orders` for a customer with an open PENDING order and no `mergeChoice` returns 409 and creates nothing. `Jest (api)`
- [ ] `mergeChoice:'merge'` folds quantities per productId and preserves unlisted lines. `Jest (api)`
- [ ] `mergeChoice:'merge'` with an `orderDate` is rejected 400. `Jest (api)`
- [ ] A merged BOGO line re-derives `promoFreeUnits` for the combined quantity. `Jest (api)`
- [ ] Posting the identical order body twice with the same `Idempotency-Key` returns the first order — to be written, no guard exists today. `Jest (api)`
- [ ] A staff merge preserves per-line notes, price overrides, and boxes/pieces split rather than rebuilding lines from scratch — currently fails, the merge path replaces lines wholesale. `Jest (api)`

#### ORD-M9

- [ ] `GET /orders?search=ORD-00042` returns that order — currently fails, matches customer name only. `Jest (api)`
- [ ] Typing a known order number from page 3 surfaces that order — currently fails, filters only loaded rows. `Playwright (web)`
- [ ] `customerId`+`status`+`productId` filters compose (AND), not replace. `Jest (api)`
- [ ] A CUSTOMER token's list is forced to their own customerId. `Jest (api)`
- [ ] Omitting `fulfillPath` adds no where-clause key at all. `Jest (api)`

#### ORD-M10

- [ ] A CUSTOMER ordering more than available stock gets 409 naming available/requested; nothing is written. `Jest (api)`
- [ ] An OPERATOR ordering the same amount creates the order and lets stock go negative. `Jest (api)`
- [ ] `settleStockForEdit` credits back exactly the undelivered remainder on a qty reduction. `Jest (api)`
- [ ] Σ `StockMovement` for a product equals its `currentStock` after an order — to be written, currently fails since the reservation writes no movement. `Jest (api)`
- [ ] Two concurrent creates for the last unit serialize on the row lock; exactly one non-staff caller succeeds. `Jest (api)`
- [ ] A DRAFT order promoted to DELIVERED still never decrements stock — pins the known gap. `Jest (api)`

#### ORD-M11

- [ ] `GET /orders/:id` for another tenant's order returns 404, never a confirming 403. `Jest (api, orders.security.spec)`
- [ ] `GET /orders/:id/tracking` as another customer is Forbidden. `Jest (api)`
- [ ] A CUSTOMER/DRIVER supplying `orderDate` is rejected; only staff may backdate within the allowed window. `Jest (api)`
- [ ] `PATCH /orders/:id/urgent` is unreachable by a DRIVER. `Jest (api)`

#### ORD-M12

- [ ] Two sequential line edits produce revision 1 then 2; a concurrent duplicate number fails. `Jest (api)`
- [ ] A revision snapshot copies stored subtotal/unitPrice verbatim, unaffected by later product price changes. `Jest (api)`
- [ ] A revision records `editedByRole` and, for change-request approval, `source: 'CHANGE_REQUEST'`. `Jest (api)`
- [ ] A rolled-back edit (credit, stock, regulated guard failure) appends no revision. `Jest (api)`
- [ ] A cancel, a `toggleUrgent`, an `updateShipment` and a `setCommissionRate` call each write no `OrderRevision` — pins the known gap. `Jest (api)`

#### ORD-M13

- [ ] Partial-invoicing a subset of lines/quantities increments `OrderItem.invoicedQty` and never lets it exceed the line qty. `Jest (api)`
- [ ] A fully split-invoiced order is skipped by the automatic delivery-triggered invoice generation. `Jest (api)`
- [ ] The split-invoice picker on web, mobile operator, and mobile driver each produce an invoice whose totals match the picked lines/quantities. `Playwright (web) / manual (mobile)`

## Nice to have (P1)

| ID      | Capability                                                         | Status     | What it does                                                                                                                                            | Evidence                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORD-N1  | Buyer self-service ordering (portal + mobile)                      | SHIPPED ✅ | Buyer browses catalog, builds a cart at own prices, submits/tracks/edits/cancels                                                                        | `POST /buyer/orders`; buyer portal + mobile customer screens; Playwright 04-buyer-portal                                                                                                                          |
| ORD-N2  | Standing orders / order templates with daily auto-generation       | PARTIAL 🟡 | Recurring basket auto-generates each morning, but prices at list only with no tax fold or stock check                                                   | `OrderTemplate`; `@Cron('0 6 * * *') generateDailyOrders`; `createOrderFromTemplate` prices at `pricePerUnit` only, hardcodes `categoryTaxAmount: 0`                                                              |
| ORD-N3  | One-tap reorder from history or a template                         | PARTIAL 🟡 | Buyer can re-place a previous basket in one action; no operator-side equivalent                                                                         | `POST /buyer/templates/:id/reorder`; `CreateOrderModal.tsx` has no template/previous-order load                                                                                                                   |
| ORD-N4  | Park and resume a half-built order                                 | SHIPPED ✅ | An interrupted order can be minimised and resumed later, per user, on any device                                                                        | `SaleDraft` model; `/drafts` CRUD with per-user ownership; web `DraftDock.tsx`                                                                                                                                    |
| ORD-N5  | Scan-to-order (barcode / wedge scanner)                            | SHIPPED ✅ | Operator/driver scans barcodes with a forgiving matching ladder and auto-scroll                                                                         | web barcode handler ladder; `buildScanSearchOr`; mobile `ScanOrderSheet.tsx`/`ScanTray.tsx`                                                                                                                       |
| ORD-N6  | Credit-limit gating on order value                                 | PARTIAL 🟡 | Edits are gated against the same exposure formula the statement shows; creation is not gated at all                                                     | `assertWithinCreditLimit` called only from `updateOrderItems`, `approveChangeRequestAtStop`, change-requests; `create`/`createSale` contain no credit call                                                        |
| ORD-N7  | Post-dispatch change requests with first-resolution-wins           | SHIPPED ✅ | ADD_ITEM/CHANGE_QTY/REMOVE_ITEM/NOTE requests approved/deferred/declined at the stop                                                                    | `ChangeRequest` model; atomic claim via `updateMany(status:PENDING)`; `approveChangeRequestAtStop`                                                                                                                |
| ORD-N8  | One-step sale (order + invoice) with a delivery-date picker        | SHIPPED ✅ | Van/counter sale bills in one action, or dates forward as a deliver-later order                                                                         | `POST /orders/sell` → `createSale`; `CreateSaleDto`                                                                                                                                                               |
| ORD-N9  | Price overrides, discounts and upsell with audit + buyer redaction | SHIPPED ✅ | Staff sell above/below list with a recorded reason; buyer never sees an above-list markup                                                               | net unitPrice + originalPrice convention; `redactUpsellForCustomer`                                                                                                                                               |
| ORD-N10 | Backdated order entry (business date ≠ entry date)                 | SHIPPED ✅ | An order that happened earlier can be entered against its real business date                                                                            | `Order.orderDate`; staff-only `parseOrderDate`; forces `skipAutoMerge`                                                                                                                                            |
| ORD-N11 | Fulfilment path (own route vs carrier) and shipment tracking       | SHIPPED ✅ | Order marked ROUTE or SHIP; carrier tracking mirrors onto invoices                                                                                      | `Order.fulfillPath`; `PATCH /orders/:id/fulfill-path`; `updateShipment`                                                                                                                                           |
| ORD-N12 | Urgency flag and an exceptions view                                | SHIPPED ✅ | An order can be marked urgent, floating to the top and into an exceptions surface                                                                       | `Order.urgent`; `PATCH /orders/:id/urgent`; mobile `exceptions.tsx`                                                                                                                                               |
| ORD-N13 | Order-level shipping fee, discount and credit-note application     | SHIPPED ✅ | Flat shipping fee (never taxed), order-level discount, credit notes earmarked from the order                                                            | `Order.shippingFee`/`discountAmount`; `AppliedCreditNoteDto`; `settleOrderCreditsInTx`                                                                                                                            |
| ORD-N14 | Export the filtered order book                                     | PARTIAL 🟡 | CSV export of the current filtered list, capped at 1000 rows, with client-side text filtering                                                           | web `handleExport`; `downloadCsv`; order-number filter re-applied client-side                                                                                                                                     |
| ORD-N15 | Licence gating for regulated goods at order time                   | SHIPPED ✅ | Orders with licence-required categories are refused unless the customer is verified; category tax snapshotted                                           | `authGuard.assertAuthorizedOrThrow`; `OrderItem.trackedCategoryId`/`categoryTaxAmount`; `computeCategoryTax`                                                                                                      |
| ORD-N16 | Reopen a cancelled order                                           | SHIPPED ✅ | Un-cancels a CANCELLED order back to PENDING, refusing if any linked invoice is paid/partial/written-off                                                | `POST /orders/:id/reopen` → `reopenOrder`; flips CANCELLED items back to PENDING inside one transaction; note: inherits the same un-restored-stock gap as ORD-M7, so cancel-then-reopen double-decrements on-hand |
| ORD-N17 | Delete an order (single + bulk), and bulk cancel from the list     | SHIPPED ✅ | Deletes an order with money unwind (credit/wallet release, commission removal, cascaded invoices), plus bulk delete and bulk cancel from the order list | `DELETE /orders/:id` → `deleteOrder`; `DELETE /orders/bulk` → `bulkDeleteOrders`; web bulk-select `handleBulkCancel`/`handleBulkDelete`                                                                           |
| ORD-N18 | Per-order commission-rate override                                 | SHIPPED ✅ | Staff can override the commission rate on an individual order, including at sale time                                                                   | `PATCH /orders/:id/commission-rate` → `setCommissionRate`; `Order.commissionRatePct`; threaded through `CreateOrderDto`/`CreateSaleDto`                                                                           |
| ORD-N19 | Buyer-managed standing orders                                      | SHIPPED ✅ | A buyer can maintain their own recurring template end-to-end, not just reorder from it                                                                  | `PATCH /buyer/templates/:id`; `GET /buyer/templates`, `/buyer/standing-orders`; customer-role CRUD on `order-templates.controller.ts`                                                                             |

### Testing criteria

#### ORD-N1

- [ ] A buyer's checkout total equals the cart total shown at checkout. `Playwright (web, 04-buyer-portal)`
- [ ] A buyer submitting a cart with an existing open order merges into it, preserving operator-added unlisted lines. `Jest (api)`
- [ ] A buyer cancelling an already-CONFIRMED order is Forbidden. `Jest (api)`
- [ ] Buyer order reads redact upsell markers and cost fields. `Jest (api)`

#### ORD-N2

- [ ] The cron creates at most one order per template per day. `Jest (api, order-templates.service.spec)`
- [ ] Generated-order tax uses the tenant's `settings.taxRate`, not a flat 0.1. `Jest (api)`
- [ ] A template line for an unverified regulated category is skipped, not a hard failure; a fully-blocked template returns null/400. `Jest (api)`
- [ ] A tier-2 customer's standing order prices at tier-2 — currently fails, prices at list. `Jest (api)`
- [ ] A regulated line in a standing order writes non-zero `categoryTaxAmount` — currently fails, writes 0. `Jest (api)`

#### ORD-N3

- [ ] A buyer reorder produces the same line set as a cart checkout of the same items. `Jest (api)`
- [ ] Reordering another buyer's template is Forbidden. `Jest (api)`
- [ ] An operator can start a new order from a customer's last delivered order — to be written, no such control exists. `Playwright (web)`

#### ORD-N4

- [ ] User A cannot read/update/delete user B's draft in the same tenant. `Jest (api)`
- [ ] Autosave upserts the same draft row rather than accumulating one per keystroke. `Jest (api)`
- [ ] Minimising and resuming a 3-line draft with shipping fee and fulfillPath preserves all three; submitting deletes the draft. `Playwright (web)`
- [ ] A draft is tenant-scoped. `Jest (api)`

#### ORD-N5

- [ ] A 12-digit and 13-digit barcode variant both resolve to the same product, capped at 5 candidates. `Jest (api, scan-search.spec)`
- [ ] Scanning the same code twice increments the existing line rather than duplicating it. `Playwright (web)`
- [ ] Scanning an unknown code opens the create-product modal pre-filled with the scanned SKU. `Playwright (web)`
- [ ] A wedge scanner in paste mode still adds the line. `Manual (mobile)`

#### ORD-N6

- [ ] An edit that pushes exposure one cent over the limit throws 409 and rolls back entirely. `Jest (api)`
- [ ] `creditLimit: null` short-circuits with zero exposure queries. `Jest (api)`
- [ ] A VOID payment does not reduce exposure. `Jest (api)`
- [ ] An order with a mirror draft invoice is counted once, not twice. `Jest (api)`
- [ ] `POST /orders` for a customer already at their limit is rejected — currently fails, creation is entirely ungated. `Jest (api)`

#### ORD-N7

- [ ] Two concurrent resolves of the same request — exactly one succeeds, the loser gets 409 and its writes roll back. `Jest (api)`
- [ ] Approving an ADD_ITEM at the stop re-runs the regulated/stock/credit guards on the recomputed set. `Jest (api)`
- [ ] Declining without a reason is rejected 400. `Jest (api)`
- [ ] An approved qty increase decrements stock by exactly the delta. `Jest (api)`

#### ORD-N8

- [ ] A future `deliveredOn` leaves the order PENDING with a DRAFT mirror invoice; past/today marks DELIVERED and issues the invoice. `Jest (api)`
- [ ] A non-staff caller supplying a past `deliveredOn` is rejected. `Jest (api)`
- [ ] Explicit `dueDate`/`terms`/`paymentTermsLabel` reach the invoice; omitting them uses tenant defaults. `Jest (api)`
- [ ] Lines arriving as `boxes:0, pieces:0` still generate a non-empty invoice. `Jest (api)`

#### ORD-N9

- [ ] Selling above list stores `priceType MANUAL` with `originalPrice = catalog list`. `Jest (api)`
- [ ] A DRIVER/CUSTOMER payload with `unitPrice`/`overrideReason` on a catalog line has those fields stripped. `Jest (api)`
- [ ] Every customer-facing read path redacts upsell markers. `Jest (api, upsell-redaction.spec)`
- [ ] The order total never double-counts an override. `Jest (api)`

#### ORD-N10

- [ ] For an operator east of UTC, today's date is accepted (bound is end-of-UTC-day). `Jest (api)`
- [ ] A backdated order gets `skipAutoMerge: true` and is never selected by merge/sweep. `Jest (api)`
- [ ] The invoice from a backdated order takes its issue date from `orderDate`. `Jest (api)`
- [ ] A date older than 2 years, or from a CUSTOMER/DRIVER, is rejected. `Jest (api)`

#### ORD-N11

- [ ] Switching a dispatched order to SHIP is rejected, naming the driver. `Jest (api)`
- [ ] A SHIP order's DELIVERED invoicing deep-equals a ROUTE order's. `Jest (api)`
- [ ] Setting tracking mirrors carrier + number onto every non-VOID invoice; clearing clears both. `Jest (api)`
- [ ] Ad-hoc trip eligibility requires `fulfillPath ROUTE`. `Jest (api)`

#### ORD-N12

- [ ] A DRIVER cannot toggle urgency; a CUSTOMER can only toggle their own order. `Jest (api)`
- [ ] An urgent order sorts above non-urgent rows regardless of active sort column. `Playwright (web)`
- [ ] The Urgent saved-view pill is hidden at count 0 unless active. `Playwright (web)`

#### ORD-N13

- [ ] An item edit omitting `shippingFee` preserves the stored fee. `Jest (api)`
- [ ] The shipping fee is added after tax and never taxed. `Jest (api)`
- [ ] Applying a credit note from another customer, or a VOID/expired one, is rejected before any write. `Jest (api)`
- [ ] `appliedCreditNotes: []` removes every applied credit; `undefined` leaves them untouched. `Jest (api)`

#### ORD-N14

- [ ] Exporting with a status filter produces a row count equal to the filtered total (or 1000, with an overflow toast). `Playwright (web)`
- [ ] Money columns in the CSV match on-screen totals to the cent. `Playwright (web)`
- [ ] The export respects the same filters as the visible list. `Playwright (web)`

#### ORD-N15

- [ ] A non-draft order with a licence-gated line for an unverified customer throws before the stock transaction. `Jest (api)`
- [ ] A DRAFT order bypasses the guard but promoting it re-runs it. `Jest (api)`
- [ ] Σ `categoryTaxAmount` folds into `Order.total` while `Order.tax` stays regular-tax-only. `Jest (api)`
- [ ] After an edit/merge, `recomputeLineCategoryTaxes` re-derives and persists each line's tax. `Jest (api)`

#### ORD-N16

- [ ] Reopening a CANCELLED order with a PAID/PARTIAL/WRITTEN_OFF invoice is refused, naming the invoice. `Jest (api)`
- [ ] Reopening flips every CANCELLED item back to PENDING and the order to PENDING in one transaction. `Jest (api)`
- [ ] A cancel-then-reopen cycle is stock-neutral — to be written, currently double-decrements. `Jest (api)`

#### ORD-N17

- [ ] Deleting an order with Returns attached is blocked. `Jest (api)`
- [ ] Deleting an order with external (non-wallet) payments is blocked via the same `cancelImpact` check as cancel. `Jest (api)`
- [ ] Bulk delete returns a per-id `{ deleted, errors }` result. `Jest (api)`
- [ ] Bulk cancel from the order list flips every selected order to CANCELLED. `Playwright (web)`

#### ORD-N18

- [ ] A non-staff caller is forbidden from setting `commission-rate`. `Jest (api)`
- [ ] A rate outside 0-100 (and non-null) is rejected. `Jest (api)`
- [ ] Setting a rate resyncs the commission engine inside the same transaction. `Jest (api)`

#### ORD-N19

- [ ] A buyer can create, patch, and delete their own template end-to-end via the buyer/customer-role routes. `Jest (api)`
- [ ] A buyer cannot patch or delete another buyer's template. `Jest (api)`
- [ ] `GET /buyer/standing-orders` reflects a patch made through `PATCH /buyer/templates/:id`. `Jest (api)`

## Advanced / future (P2)

| ID      | Capability                                                                          | Status     | What it does                                                                                                                    | Evidence                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORD-A1  | Offline-first order capture with idempotent replay                                  | PARTIAL 🟡 | Mobile queues failed mutations and replays on reconnect, but no idempotency key protects against duplicate orders               | `offlineQueue.ts`; `api-client.ts:131-160`; `POST /orders` sets no `Idempotency-Key` (only route-run stop completion has one)                                                                                                                                               |
| ORD-A2  | Promotions applied at order time, including buy-N-get-M                             | SHIPPED ✅ | Live promotions price customer lines automatically, including free-unit BOGO mechanics                                          | `applyBestPromotion`; `OrderItem.promoFreeUnits`; `rescaleBogoFreeUnits`; `orders-promo-bogo.spec.ts`                                                                                                                                                                       |
| ORD-A3  | Order approval / hold-for-review queue                                              | MISSING ⬜ | No pre-stock-consumption review gate for new/high-value/first-time orders exists                                                | No `PENDING_APPROVAL`/`ON_HOLD` status member; buyer orders land straight at PENDING and decrement stock immediately                                                                                                                                                        |
| ORD-A4  | Backorder tracking and auto-fulfil on restock                                       | MISSING ⬜ | No shortfall ledger or restock-release mechanism, though the billing half of partial fulfilment is shipped                      | No backorder model/column; verified: `POST /invoices/from-order/:orderId/partial` (ORD-M13) already ensures an order is billed only for what shipped — the missing piece is specifically the outstanding-quantity ledger and its restock-triggered release, not the billing |
| ORD-A5  | Commercial ordering rules — minimum order value, cutoff times, delivery-day windows | MISSING ⬜ | No such rule exists anywhere in the codebase                                                                                    | No `minimumOrder`/`orderCutoff`/`cutoffTime` hits; `Customer.deliveryWindowStart/End` are routing strings, not order-acceptance rules                                                                                                                                       |
| ORD-A6  | Bulk / machine order intake (CSV upload, EDI 850, partner API)                      | MISSING ⬜ | No file/feed-based order intake exists                                                                                          | `ImportEntityType` has no ORDER member; no `poNumber` field on Order                                                                                                                                                                                                        |
| ORD-A7  | Conversational order intake (WhatsApp / SMS / email)                                | MISSING ⬜ | No message-to-order path exists, and even `Order.source` is never written by application code                                   | No `OrdersService` usage in the messages module; `Order.source` written only in seed/spec fixtures                                                                                                                                                                          |
| ORD-A8  | Suggested / predicted reorder                                                       | PARTIAL 🟡 | Buyer-side replenishment/shelf prompts exist; no equivalent on the operator's order-entry surface                               | `GET /buyer/replenishment`, `/buyer/shelf`, `add-all-low`; `CreateOrderModal` has no due-to-reorder list                                                                                                                                                                    |
| ORD-A9  | Order acknowledgement document (PDF / email confirmation)                           | MISSING ⬜ | No written confirmation exists — push notification only, unreachable without the app                                            | No order-PDF template; no `sendOrderConfirmation`; `changeStatus` notifMap is push-only                                                                                                                                                                                     |
| ORD-A10 | Concurrent-edit conflict detection                                                  | MISSING ⬜ | No version/precondition on order edits — a stale save can silently overwrite another edit                                       | `UpdateOrderItemsDto` carries no version field; row lock serializes writes, not stale client payloads                                                                                                                                                                       |
| ORD-A11 | Configurable order numbering                                                        | MISSING ⬜ | Order numbers are hardcoded `ORD-`+5-digit sequence, and the standing-order generator writes a colliding timestamp-based number | verified: `createOrderFromTemplate` writing `ORD-${Date.now()}` deterministically wins the lexicographic `orderBy: desc` max on the very first standing-order run in any tenant, not merely "may drift"                                                                     |
| ORD-A12 | Stop-supply / overdue hold on a customer                                            | MISSING ⬜ | No mechanism stops an overdue customer from ordering again                                                                      | No `ON_HOLD`/`isOnHold` field on Customer; aged debt is computed for statements but never consulted at order time                                                                                                                                                           |

### Testing criteria

#### ORD-A1

- [ ] A `POST /orders` failing with a network error is enqueued and rejected with `isOfflineQueued`; going online replays it once. `Jest (mobile)`
- [ ] `POST /orders` with a repeated `Idempotency-Key` returns the original order — to be written, no guard exists. `Jest (api)`
- [ ] Airplane-mode a create, restore signal, confirm exactly one order results — to be written, today can yield two. `Manual (mobile)`
- [ ] A queued action replays with the current, not stale, auth token. `Jest (mobile)`

#### ORD-A2

- [ ] 12 units at $35 buy-5-get-1 stores subtotal exactly $350.00, `priceType PROMO`. `Jest (api, orders-promo-bogo)`
- [ ] A merge of 12+6 boxes re-derives free units for the combined count. `Jest (api)`
- [ ] Promos apply on the CUSTOMER path only, never silently on staff-priced lines. `Jest (api)`
- [ ] Loose pieces never count toward a BOGO threshold. `Jest (api)`
- [ ] A rule that would sell for $0.00 is refused unless `allowZeroPrice` is passed, and that flag is never persisted. `Jest (api, promotions.service.spec)`

#### ORD-A3

- [ ] With approval required, a buyer order lands in a non-stock-consuming review state — to be written. `Jest (api)`
- [ ] Rejecting a held order records reviewer, reason, and notifies the buyer — to be written. `Jest (api)`
- [ ] An operator sees a review queue with counts and can bulk-approve — to be written. `Playwright (web)`

#### ORD-A4

- [ ] An order for 100 with 40 on hand records a 60-unit backorder rather than negative stock — to be written. `Jest (api)`
- [ ] Receiving stock releases backorders FIFO and notifies the customer — to be written. `Jest (api)`
- [ ] A PARTIALLY_DELIVERED order's undelivered remainder is visible as an outstanding quantity — to be written. `Jest (api)`

#### ORD-A5

- [ ] A cart below the tenant's minimum order value is refused at checkout, naming the shortfall — to be written. `Jest (api)`
- [ ] An order placed after cutoff auto-dates to the next eligible day — to be written. `Jest (api)`
- [ ] `requestedDeliveryDate` on a non-served day is rejected with valid alternatives — to be written. `Jest (api)`

#### ORD-A6

- [ ] Uploading a customer order CSV creates one order per block, resolving products by SKU/barcode, reporting unmatched rows — to be written. `Jest (api)`
- [ ] Re-uploading the same file is idempotent by external reference — to be written. `Jest (api)`
- [ ] An imported order carries the customer's own PO number onto the invoice — to be written. `Jest (api)`

#### ORD-A7

- [ ] An inbound message from a known customer produces a DRAFT order with matched lines, unmatched text as unlisted lines — to be written. `Jest (api)`
- [ ] The created order records the correct intake `source`, and a report breaks volume down by channel — to be written. `Jest (api)`
- [ ] A photographed order sheet becomes a one-screen-confirm draft order — to be written. `Manual`

#### ORD-A8

- [ ] A product bought every 14 days, last bought 16 days ago, is flagged overdue; unknown cadence yields null. `Jest (api, replenishment.service.spec)`
- [ ] `add-all-low` adds only below-threshold products and never duplicates an existing cart line. `Jest (api)`
- [ ] An operator sees due-to-reorder items while building a customer's order — to be written, no such view exists. `Playwright (web)`

#### ORD-A9

- [ ] Confirming an order emails an acknowledgement whose totals match the stored order to the cent — to be written. `Jest (api)`
- [ ] A customer with the no-email placeholder sentinel is skipped silently, never blocking the status change — to be written. `Jest (api)`
- [ ] The acknowledgement PDF renders dates in tenant terms, not shifted by viewer timezone — to be written. `Manual`

#### ORD-A10

- [ ] An edit whose `expectedRevision` is behind current is rejected 409 with the current snapshot — to be written. `Jest (api)`
- [ ] Pinned known gap: operator A adds a line, operator B's stale replace-all save removes it with only a revision as evidence. `Jest (api)`
- [ ] Two browser contexts editing the same order — the second save surfaces a reconciliation prompt — to be written. `Playwright (web)`

#### ORD-A11

- [ ] After the standing-order cron runs, the next manual order number is the previous padded sequence + 1, not a timestamp+1 — currently fails. `Jest (api)`
- [ ] Two concurrent creates never share an order number; after 3 P2002 retries the error surfaces. `Jest (api)`
- [ ] A tenant configured with prefix `SO-` and 6 digits produces `SO-000001`, scoped per tenant — to be written. `Jest (api)`

#### ORD-A12

- [ ] A customer past the tenant's hold threshold cannot have a new order created, naming the overdue amount — to be written. `Jest (api)`
- [ ] A staff override releases the hold for one order, recording who and why — to be written. `Jest (api)`
- [ ] Paying the overdue invoice lifts the hold with no manual step — to be written. `Jest (api)`

## How this varies by tenant

| Variation                                                              | Mechanism                                                                                                                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether credit limits are enforced at all on order edits               | Plan flag `flag.credit_limits` behind the `PLAN_FLAG_ENFORCEMENT` env kill switch; enforcement point is edits only, not creation                                                        |
| Per-customer credit ceiling                                            | `Customer.creditLimit` (nullable = no limit), editable via `PATCH /customers/:id`                                                                                                       |
| Per-customer price level                                               | `Customer.pricingTier` + `CustomerPrice` rows; tier CRUD gated by plan flag `flag.pricing_tiers`                                                                                        |
| Whether an order is delivered on our own route or shipped by a carrier | `Customer.fulfillPath` default, overridable per order via `PATCH /orders/:id/fulfill-path`                                                                                              |
| Whether the tenant has route dispatch / ad-hoc delivery trips at all   | Per-tenant addons `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON`, enforced by class-level `@RequireAddon`                                                                              |
| Sales-tax rate applied to order lines                                  | Tenant setting `settings.taxRate` via `taxRateFractionFrom`. **NOT CONFIGURABLE** per product, state, or jurisdiction — single flat rate only                                           |
| Tax exemption for a customer                                           | `Customer.isTaxExempt` — honoured by the invoice but not by the order itself, so the mechanism is only half-wired                                                                       |
| Regulated / licensed product handling and per-category tax             | `TrackedCategory`/`TrackedSubcategory` per tenant driving the auth guard and `categoryTaxAmount`; addon-gated                                                                           |
| Whether commissions accrue from orders                                 | Addon/flag `flag.sales_agents`; per-order override via `PATCH /orders/:id/commission-rate`                                                                                              |
| Promotional pricing rules                                              | Per-tenant `Promotion` rows (PERCENT/FIXED/QTY_BREAK/BUY_N_GET_M × scope), applied to CUSTOMER-priced lines only                                                                        |
| Invoice payment terms and deposit the order hands off                  | `Customer.defaultPaymentTerms`/`defaultDepositPercent`, overridable per sale                                                                                                            |
| Standing-order delivery days                                           | `OrderTemplate.daysOfWeek` per template. Generation TIME is **NOT CONFIGURABLE** — hardcoded `@Cron('0 6 * * *')` in server time, wrong for any tenant outside the container's timezone |
| Order numbering scheme                                                 | **NOT CONFIGURABLE** — hardcoded `ORD-` + 5-digit pad, with a conflicting `ORD-${Date.now()}` from the standing-order generator                                                         |
| Minimum order value, order cutoff time, serviceable delivery days      | **NOT CONFIGURABLE** — no such setting, column, or check exists anywhere                                                                                                                |
| Whether staff may oversell into negative stock                         | **NOT CONFIGURABLE** — hardcoded by role; a tenant wanting hard stock discipline for its own staff cannot get it                                                                        |

## Gaps for a great UX

| Severity | Gap                                                                                                                  | Impact                                                                                                                                       | Suggested direction                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | No credit-limit check when an order is CREATED — only when one is edited                                             | A customer at their limit can place unlimited new orders through any surface; the limit only bites on a later edit                           | Call `assertWithinCreditLimit` inside `create()`'s and `createSale`'s transaction on the projected total                               |
| CRITICAL | Stock decremented at order creation is never restored on cancel or delete                                            | Every cancelled order permanently destroys that quantity of on-hand stock; on-hand drifts steadily below reality                             | Mirror `settleStockForEdit`'s credit-back logic on cancel and delete, inside the same transaction that voids invoices                  |
| HIGH     | The order-time stock reservation writes no `StockMovement` row                                                       | The inventory ledger cannot explain on-hand; Σ movements ≠ currentStock for any tenant that takes orders                                     | Write a RESERVATION/ORDER_COMMIT movement at create and its reversal at cancel/edit-down                                               |
| HIGH     | An order cannot be found by its order number                                                                         | The one identifier a customer will ever give you is unsearchable server-side; the web list filters only the loaded page                      | Widen `findAll`'s search to an OR over business name and order number; send `search` from the web list and drop the client-side filter |
| HIGH     | The standing-order generator poisons the order-number sequence                                                       | A 13-digit timestamp wins the lexicographic max on the first standing-order run in any tenant, permanently breaking human-readable numbering | Extract the padded-sequence generator into a shared helper and call it from the template path too                                      |
| HIGH     | Standing orders price and tax differently from every other order path                                                | No tier/CustomerPrice/promotion pricing, no boxes/pieces split, hardcoded zero category tax, no stock check                                  | Route template generation through the same pricing/tax/stock path `create()` uses                                                      |
| HIGH     | `Customer.isTaxExempt` is honoured by invoices but not by orders                                                     | An exempt customer's order total (and the credit-exposure figure computed from it) is overstated versus the eventual invoice                 | Read `isTaxExempt` in the order's tax fold — the customer row is already loaded there                                                  |
| HIGH     | `POST /orders` has no idempotency key while the mobile client auto-replays failed mutations                          | A lost response on an order create during a real network failure replays as a second order                                                   | Accept an `Idempotency-Key` header on order-create routes and reuse the existing `routes.service` machinery                            |
| MEDIUM   | No conflict detection when two people edit the same order                                                            | A stale merge diff silently reverts another operator's price edit; an old client's replace-all payload deletes an added line                 | Add an optional `expectedRevision` to the update DTO and 409 with the current snapshot when it is behind                               |
| MEDIUM   | Order intake channel is never recorded                                                                               | `Order.source` exists but no code writes it, so a tenant cannot answer how much volume still comes by phone                                  | Set `source` at each entry point and surface a channel breakdown in analytics                                                          |
| MEDIUM   | The merge path collapses lines and drops per-line notes and price overrides — on both the buyer AND the staff branch | A customer's or operator's per-line instruction, price override, and boxes/pieces split are silently lost whenever orders merge              | Carry notes, overrides, and boxes/pieces through the merged map keyed by productId instead of rebuilding bare `{productId, qty}` lines |
| MEDIUM   | No written order confirmation — push notification only                                                               | A customer without the app receives no confirmation of what they ordered, at what price, for what date                                       | Add an order acknowledgement email with a small PDF, sent on confirmation and buyer self-service submission                            |
| MEDIUM   | No commercial ordering rules — minimum order value, cutoff time, serviceable days                                    | Any customer can place a trivial order for a delivery time the business cannot economically serve                                            | Add tenant settings for minimum order value, per-day cutoff, and per-customer serviceable days, checked before the stock transaction   |
| MEDIUM   | An operator cannot start an order from a template or a previous order                                                | The highest-frequency intake event — the weekly regular's phone order — is keyed from scratch every time                                     | Add a "Start from…" control in `CreateOrderModal` offering templates and recent delivered orders                                       |
| LOW      | The standing-order cron runs on a hardcoded server-clock schedule                                                    | A tenant in another timezone gets "Tuesday" orders generated on the wrong local day or hour, with no per-tenant control                      | Store a per-tenant generation hour/timezone and resolve the weekday inside the existing per-tenant scope                               |

## Cross-domain handoffs

- **Customers → Orders**: `creditLimit`, `pricingTier`+`CustomerPrice`, `fulfillPath`, `isTaxExempt`
  (currently ignored by the order — see gaps), `defaultPaymentTerms`/`defaultDepositPercent` and
  delivery window all feed order creation; the credit-limit exposure formula must stay identical
  to the customer statement's — never a second balance formula.
- **Regulated / tracked categories → Orders**: the auth guard gates create, DRAFT promotion,
  edits, at-stop approvals and standing-order generation; `OrderItem.trackedCategoryId` +
  `categoryTaxAmount` snapshots flow onward to the invoice split and the regulated ledger's period
  bucket (which `orderDate` can move into a past month).
- **Products / Inventory → Orders**: `pricePerUnit` and `unitsPerBox` are snapshotted onto the
  line at sale time; `create()` locks and decrements `currentStock`; delivery hands off to
  inventory's `recordSale` for the SALE movement. The un-restored cancel and the missing
  reservation movement are open breaks in this handoff.
- **Orders → Invoices**: automatic generation on DELIVERED, forward/back sync on every edit
  (including the shipping-fee invariant), post-delivery resync, `OrderItem.invoicedQty` as the
  bill-once ledger, `InvoiceItem.promoFreeUnits` carrying the BOGO snapshot, and the full/partial
  manual invoice routes (ORD-M6, ORD-M13) as the staff-driven alternative to the automatic path.
- **Orders → Routes / Deliveries / Trips**: `routeRunId`/`routeRunStopId` attach an order to a
  stop; route completion does the at-door delivery, partial and refusal handling; trip eligibility
  requires `fulfillPath ROUTE` and no active-run attachment, the same predicate that guards the
  fulfilment-path switch.
- **Promotions → Orders**: `applyBestPromotion` prices CUSTOMER-path lines and returns free units;
  `promoFreeUnits` must be re-derived at every path that re-quantifies a line (merges, qty edits,
  at-door approvals) or the column contradicts the subtotal.
- **Credit notes / payments → Orders**: credit-note selections are validated and settled at
  create/edit; cancel, delete, and reopen release wallet money and refuse when external cash was
  taken (`cancel-impact` is the read-only preview of that decision).
- **Returns → Orders**: `Return` is the one RESTRICT-linked child — an order with returns cannot
  be deleted until they are.
- **Sales agents → Orders**: `Order.commissionRatePct` (settable per order, ORD-N18) resolves
  ahead of customer/agent defaults; the commission engine hooks on invoice creation, credit notes
  and order deletion.
- **Notifications / realtime → Orders**: a realtime status-change event plus push notifications
  fire on every transition and change-request outcome; all failures are swallowed so a
  notification outage never blocks an order write.
- **Analytics / bookkeeping → Orders**: several reports still key on `createdAt` (entry timestamp)
  while `orderDate` is the business date — the two must not be confused when backdating;
  `deliveredAt` drives delivered-on-date reporting and is nulled on a reopen.
- **Billing / entitlements → Orders**: `flag.credit_limits`, `flag.pricing_tiers`,
  `flag.sales_agents`, and the routes/delivery addons decide whether a credit check runs, tier
  CRUD is available, commission surfaces show, and an order can be dispatched or trip-planned at
  all.

## What we could not verify

This domain's analysis was read-only static review of `master` at `6c8f1401` — nothing was
executed (no Jest run, no Playwright run, no API call, no database read); every status above is
inferred from source. `orders.service.ts` is 220KB and was read selectively rather than in full,
supplemented by `.claude/code-map/api.md`'s orders entry, which was spot-checked but not verified
line by line. A second, independent pass (this reconciliation) confirmed the analysis's core
findings, corrected one status (ORD-M12: order-history coverage is partial, not complete — status
changes and several other order fields write no revision), narrowed or extended the evidence on
three items (ORD-M8's merge damage, ORD-M10's DRAFT-order stock gap, ORD-A11's numbering
collision — all confirmed more serious than first written), credited two shipped surfaces the
first pass missed entirely on their own item (ORD-M6's manual invoice route, ORD-A4's partial
billing), and added five capabilities the first pass missed outright: split/partial invoicing
(now ORD-M13, promoted to Must-have since it is load-bearing for billing correctness), reopening
a cancelled order, order deletion (single + bulk) and bulk cancel, per-order commission-rate
override, and buyer-managed standing-order templates. The remaining low-confidence areas — whether
production order numbers have already drifted from the timestamp collision, and whether any of
these gaps already carry a bug-register entry and a decided disposition — were not checked against
the live database or the existing bug register in this pass either, and are still worth a look
before treating this document as final.
