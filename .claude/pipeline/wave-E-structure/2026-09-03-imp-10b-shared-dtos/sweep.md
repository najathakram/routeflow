# RouteFlow `lib/api` DTO Duplication Sweep (read-only)

## 1–2. Inventory + name sets

**`apps/web/lib/api/`** — 48 files, 10,585 lines, 348 exported type/interface/enum statements (346 unique names — `OrderTemplate`, `PriceType` each declared twice).

**`apps/mobile/lib/api/`** — 35 files, 8,684 lines, 268 exported statements (261 unique names — `ChangeRequestType/Status/Resolution/ChangeRequest`, `ExpiringAuthorization`, `SalesByCustomerRow`, `SalesByItemRow` each declared twice).

| Web file             | Lines         | Web file               | Lines |
| -------------------- | ------------- | ---------------------- | ----- |
| addons.ts            | 79 (no types) | numbering.ts           | 55    |
| authorizations.ts    | 199           | order-templates.ts     | 127   |
| batch-import.ts      | 165           | orders.ts              | 556   |
| billing.ts           | 222           | payment-requests.ts    | 89    |
| bookkeeping.ts       | 100           | platform-pricing.ts    | 130   |
| buyer-payments.ts    | 142           | portal-approvals.ts    | 81    |
| buyer.ts             | 859           | product-demand.ts      | 55    |
| cost-history.ts      | 25            | product-sales.ts       | 75    |
| credit-notes.ts      | 191           | products.ts            | 305   |
| customers.ts         | 803           | promotions.ts          | 145   |
| drafts.ts            | 71            | remittance.ts          | 37    |
| drivers.ts           | 133           | returns.ts             | 197   |
| estimates.ts         | 150           | routes.ts              | 731   |
| finance.ts           | 501           | sales-agents.ts        | 446   |
| import-resolution.ts | 86            | stock-count.ts         | 275   |
| inventory.ts         | 307           | stripe-connect.ts      | 47    |
| invoice-scan.ts      | 72            | supplier-payments.ts   | 183   |
| invoices.ts          | 989           | supplier-statements.ts | 244   |
| margin.ts            | 39            | suppliers.ts           | 119   |
| messaging.ts         | 137           | tier-labels.ts         | 47    |
| migration.ts         | 90            | tobacco.ts             | 185   |
| notifications.ts     | 26            | tracked-categories.ts  | 467   |
|                      |               | trips.ts               | 61    |
|                      |               | users.ts               | 92    |
|                      |               | variant-assign.ts      | 65    |
|                      |               | vendor-bills.ts        | 385   |

| Mobile file        | Lines          | Mobile file            | Lines |
| ------------------ | -------------- | ---------------------- | ----- |
| addons.ts          | 145 (no types) | payments.ts            | 291   |
| admin.ts           | 1231           | product-sales.ts       | 60    |
| authorizations.ts  | 124            | products.ts            | 266   |
| buyer.ts           | 919            | purchase-orders.ts     | 169   |
| change-requests.ts | 100            | recurring-invoices.ts  | 139   |
| cost-history.ts    | 24             | regulated.ts           | 202   |
| credit-notes.ts    | 177            | reports.ts             | 114   |
| customers.ts       | 623            | returns.ts             | 186   |
| drafts.ts          | 80             | routes.ts              | 694   |
| drivers.ts         | 150            | stock-count.ts         | 166   |
| estimates.ts       | 125            | supplier-payments.ts   | 132   |
| expenses.ts        | 101            | supplier-statements.ts | 159   |
| inventory.ts       | 207            | tier-labels.ts         | 19    |
| invoices.ts        | 521            | tobacco.ts             | 103   |
| margin.ts          | 29             | tracked-categories.ts  | 268   |
| messages.ts        | 45             | variant-assign.ts      | 44    |
| order-templates.ts | 151            | vendor-bills.ts        | 288   |
| orders.ts          | 632            |                        |       |

## 3. Duplicates (name in both apps) — 134 pairs. **I**=identical, **N**=near-identical, **D**=divergent

**Orders**

| Name                 | web / mobile loc              | Class | Note                                                                                                                                                                                                       |
| -------------------- | ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ActiveOrderSummary   | orders.ts:156 / orders.ts:215 | I     |                                                                                                                                                                                                            |
| CancelImpact         | orders.ts:201 / orders.ts:244 | N     | field order/comment only                                                                                                                                                                                   |
| CreateSaleDto        | orders.ts:282 / orders.ts:342 | D     | web: deliveredOn/dueDate/terms/appliedCreditNotes/send extra; items inline vs `CreateSaleItemInput[]`                                                                                                      |
| CustomerPriceHistory | orders.ts:363 / orders.ts:579 | I     |                                                                                                                                                                                                            |
| Order                | orders.ts:9 / orders.ts:67    | D     | web nests `customer`, inline status literal (6 values, no `PARTIALLY_DELIVERED`); mobile: named `OrderStatus` (7 values incl. DRAFT+PARTIALLY_DELIVERED), driverNote/shippingCarrier/deliveredAt web lacks |
| OrderItem            | orders.ts:111 / orders.ts:7   | D     | mobile adds `name`; priceType named (web) vs string (mobile); trackedCategoryId only on web                                                                                                                |
| OptimizeResult       | routes.ts:422 / routes.ts:573 | D     | entirely different field names (stopOrder/reorderedCount vs success/stops/message)                                                                                                                         |

**Customers / Authorizations**

| Name                          | web / mobile loc                                                 | Class | Note                                                                            |
| ----------------------------- | ---------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| AdvancePayment                | customers.ts:247 / customers.ts:114                              | D     | mobile: method:string, extra receivedAt, looser nullability                     |
| ContactPerson                 | customers.ts:48 / customers.ts:526                               | D     | web-only required customerId; nullability flips on 4 fields                     |
| CustomerAuthorization         | authorizations.ts:9 / authorizations.ts:20                       | I     |                                                                                 |
| CustomerComment               | customers.ts:68 / customers.ts:591                               | N     | web extra customerId/userId (mobile subset)                                     |
| CustomerDocument              | customers.ts:434 / customers.ts:457                              | N     | comment only                                                                    |
| CustomerPrice                 | customers.ts:309 / customers.ts:197                              | D     | web nested product carries averageCost/unitsPerBox/msrp mobile lacks            |
| CustomerStatement             | customers.ts:228 / customers.ts:68                               | D     | web refs `StatementTransaction[]`; mobile inlines a different transaction shape |
| ExpiringAuthorization         | authorizations.ts:176 / authorizations.ts:105 **&** buyer.ts:345 | I     | also an internal-mobile dup (§5)                                                |
| SubmitBuyerAuthorizationInput | buyer.ts:836 / buyer.ts:382                                      | N     | comment only                                                                    |

**Products / Inventory / Stock-count**

| Name                            | web / mobile loc                            | Class | Note                                                   |
| ------------------------------- | ------------------------------------------- | ----- | ------------------------------------------------------ |
| InventoryValuation              | inventory.ts:76 / inventory.ts:73           | I     |                                                        |
| RecomputeCostsResult            | inventory.ts:124 / inventory.ts:120         | I     |                                                        |
| CommitStockCountPayload         | stock-count.ts:19 / stock-count.ts:18       | I     |                                                        |
| CommitStockCountResponse        | stock-count.ts:26 / stock-count.ts:25       | I     |                                                        |
| CommitStockCountSessionResponse | stock-count.ts:217 / stock-count.ts:131     | N     | `reference` nullable(web) vs required                  |
| VariantAssignResult             | variant-assign.ts:39 / variant-assign.ts:17 | N     | `assignments` refs differently-named sibling item type |

**Invoices / Payments / Finance**

| Name                           | web / mobile loc                                   | Class | Note                                                                                                                  |
| ------------------------------ | -------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| Invoice                        | invoices.ts:78 / invoices.ts:58                    | D     | web: customer/dueDate/issueDate/deposit-schedule/pdfUrl/orderId; taxAmount/discount required(mobile) vs optional(web) |
| InvoiceItem                    | invoices.ts:16 / invoices.ts:18                    | D     | web: product/priceType(named)/trackedCategoryId/boxes/orderItemId/taxable; mobile priceType:string, subtotal required |
| InvoicePayment                 | invoices.ts:53 / invoices.ts:39                    | D     | method:AnyPaymentMethod vs PaymentMethod; web typed checkStatus block, mobile has bankCharges                         |
| InvoiceScanStatus              | vendor-bills.ts:125 / vendor-bills.ts:60           | N     | comment only, values identical                                                                                        |
| InvoiceStatus                  | invoices.ts:8 / invoices.ts:8                      | N     | same 8 values, OVERDUE/VOID order swapped                                                                             |
| InvoiceTreatment               | tracked-categories.ts:8 / tracked-categories.ts:12 | I     |                                                                                                                       |
| CreateInvoiceDto               | invoices.ts:276 / invoices.ts:166                  | D     | web-only depositPercent/paymentTermsLabel/autoSend fields                                                             |
| CreateInvoiceItem              | invoices.ts:261 / invoices.ts:146                  | N     | same field set, reordered/commented                                                                                   |
| CreatePartialInvoiceDto / Item | invoices.ts:907,902 / invoices.ts:432,427          | I     |                                                                                                                       |
| CreateRecurringInvoiceDto      | invoices.ts:773 / recurring-invoices.ts:68         | N     | named refs (RecurringFrequency/CreateRecurringInvoiceItem), same values                                               |
| RecurringInvoice               | invoices.ts:754 / recurring-invoices.ts:18         | N     | web has 2 extra optional fields (discount/shippingFee)                                                                |
| RecurringInvoiceItem           | invoices.ts:745 / recurring-invoices.ts:8          | N     | id/description order only                                                                                             |
| SendInvoiceEmailResult         | invoices.ts:399 / invoices.ts:207                  | N     | mobile subset (no smtp-fallback fields)                                                                               |
| SetCheckStatusDto              | invoices.ts:688 / payments.ts:257                  | N     | status named(web)/inline(mobile), same 4 values; mobile adds settledAt                                                |
| StandalonePaymentDto           | invoices.ts:647 / payments.ts:209                  | N     | method/allocations ref differently-named equivalent sibling types                                                     |
| AllPayment                     | invoices.ts:207 / payments.ts:11                   | D     | mobile carries full check-lifecycle block; method/status types differ                                                 |
| PaymentListParams              | invoices.ts:233 / payments.ts:48                   | N     | sortDir: string vs literal union                                                                                      |
| PaymentListResponse            | invoices.ts:246 / payments.ts:61                   | I     |                                                                                                                       |
| FinanceDashboard               | finance.ts:6 / admin.ts:794                        | D     | totally different shapes (nested aging/summary tables vs flat totals) — same name, unrelated payloads                 |
| CreateExpenseDto               | finance.ts:303 / expenses.ts:27                    | D     | web-only mileage/itemized/billable/lineItems block                                                                    |
| Expense                        | finance.ts:63 / expenses.ts:13                     | D     | web has full itemized/mileage/receipt/status block mobile lacks entirely                                              |
| ExpenseCategory                | finance.ts:41 / expenses.ts:8                      | N     | mobile lacks code/isCustom                                                                                            |
| ExpenseStatus                  | finance.ts:366 / expenses.ts:6                     | I     |                                                                                                                       |

**Returns / Credit notes**

| Name                | web / mobile loc                       | Class | Note                                                                                      |
| ------------------- | -------------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| Return              | returns.ts:44 / returns.ts:37          | D     | web: returnNumber/customerId required, has `logs`; mobile customerId optional             |
| ReturnItem          | returns.ts:23 / returns.ts:23          | D     | web: condition/notes fields; mobile: typed `reason` field instead                         |
| ReturnReason        | returns.ts:16 / returns.ts:6           | N     | same 5 values, reordered                                                                  |
| ReturnStatus        | returns.ts:6 / returns.ts:13           | N     | same 8 values, 2 reordered                                                                |
| RefundMethod        | returns.ts:42 / returns.ts:35          | I     |                                                                                           |
| CreateReturnDto     | returns.ts:109 / returns.ts:101        | D     | web-only customerId; mobile-only photoUrls                                                |
| CreateReturnItemDto | returns.ts:102 / returns.ts:92         | N     | mobile adds optional reason/restock (superset)                                            |
| CreditNote          | credit-notes.ts:8 / credit-notes.ts:10 | D     | web: amountUsed/reason required + appliedAt/autoApplied; mobile optional, lacks those two |
| CreditNoteStatus    | credit-notes.ts:6 / credit-notes.ts:8  | I     |                                                                                           |

**Vendor bills / Supplier**

| Name                                                                                             | web / mobile loc                            | Class | Note                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| VendorBill                                                                                       | vendor-bills.ts:37 / vendor-bills.ts:18     | D     | web-only purchaseOrder linkage; totalOwed/totalPaid required(web) vs optional |
| VendorBillItem                                                                                   | vendor-bills.ts:9 / vendor-bills.ts:8       | D     | web-only sku/packSize/qtyReceived; lineTotal required(mobile) vs optional     |
| VendorBillStatus                                                                                 | vendor-bills.ts:7 / vendor-bills.ts:6       | D     | **value-set conflict**: web has `PAID`, mobile has `FULL` — see §6            |
| CreateVendorBillDto                                                                              | vendor-bills.ts:208 / vendor-bills.ts:191   | D     | supplierId/billDate/dueDate required(web) vs optional(mobile)                 |
| CheckVendorBillDuplicateDto, DuplicateVendorBillInfo/Error, UnlinkedItemsError, PriorScanSummary | vendor-bills.ts / vendor-bills.ts           | I     |                                                                               |
| ScanCandidate                                                                                    | invoice-scan.ts:4 / vendor-bills.ts:34      | N     | mobile drops 2 comments only                                                  |
| ScannedItem                                                                                      | invoice-scan.ts:13 / vendor-bills.ts:42     | D     | web required fields all optional on mobile + mobile-only matchSource          |
| ScanResult                                                                                       | invoice-scan.ts:35 / vendor-bills.ts:81     | D     | web required fields optional on mobile; mobile adds scanId/priorScan          |
| Supplier                                                                                         | suppliers.ts:16 / purchase-orders.ts:84     | D     | mobile is a ~7-field stub vs web's ~25-field full entity                      |
| SupplierStatement, SupplierStatementRow                                                          | supplier-payments.ts / supplier-payments.ts | N     | comment-only diffs                                                            |
| SupplierStatementRowType                                                                         | supplier-payments.ts:83 / :83               | N     | mobile adds doc-comment only                                                  |
| SupplierStatementScanStatus                                                                      | supplier-statements.ts:16 / :9              | N     | mobile adds doc-comment only                                                  |
| RecordSupplierPaymentDto                                                                         | supplier-payments.ts:25 / :27               | N     | method/allocations reference differently-named equivalent sibling types       |
| RecordSupplierPaymentResult                                                                      | supplier-payments.ts:46 / :51               | N     | payments type renamed; bills.status: VendorBillStatus(web) vs string(mobile)  |
| StatementAiError, StatementAiErrorCode                                                           | supplier-statements.ts                      | N/I   | comment-only                                                                  |

**Tracked categories / Regulated / Tobacco**

| Name                                                                                                    | web / mobile loc                             | Class | Note                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| TrackedCategory                                                                                         | tracked-categories.ts:11 / :15               | D     | web-only `appliesScope`; wholesalerLicenseNo/txItemType/txUom required(web) vs optional                 |
| TrackedCategoryInput                                                                                    | tracked-categories.ts:39 / :51               | D     | web-only `appliesScope`                                                                                 |
| TrackedCategoryTaxType, ReportCadence, TemplateColumn/ItemType/UomOption, ReportTemplateDef             | tracked-categories.ts                        | I/N   | values/shape identical, formatting only                                                                 |
| RegulatedFiling(Status), RegulatedLedgerRow/Response, RegulatedReportColumn, RegulatedReportWarningCode | tracked-categories.ts / regulated.ts         | I     |                                                                                                         |
| RegulatedReportParams                                                                                   | tracked-categories.ts:383 / regulated.ts:166 | D     | mobile entirely lacks the `columns` field                                                               |
| RegulatedReportPreview, RegulatedReportWarning                                                          | —                                            | N     | comment-only                                                                                            |
| TobaccoOverview                                                                                         | tobacco.ts:25 / tobacco.ts:32                | I     |                                                                                                         |
| TobaccoReport                                                                                           | tobacco.ts:82 / tobacco.ts:40                | D     | web has 6 extra required fields (totalQtyPurchased/Sold, endingStockQty, generatedById, csvKey, pdfKey) |

**Routes / Drivers / Trips**

| Name                   | web / mobile loc             | Class | Note                                                                                                           |
| ---------------------- | ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| RouteSettings, StopETA | routes.ts                    | I     |                                                                                                                |
| RouteAnalysisResult    | routes.ts:673 / :630         | N     | formatting only                                                                                                |
| RouteRun               | routes.ts:68 / :83           | D     | mobile's `route` sub-object carries endKind/endLat/endLng; mobile adds collectedPayments                       |
| RouteRunStop           | routes.ts:97 / :43           | D     | mobile customer/customerAddress far richer; mobile adds POD/regulated-check fields entirely                    |
| Driver                 | drivers.ts:4 / drivers.ts:6  | D     | web: contactName/phone/vehicleColour/createdAt; mobile: licenseNumber/firstName/lastName, status adds ON_LEAVE |
| TripIneligibleReason   | routes.ts:501 / admin.ts:670 | I     |                                                                                                                |
| TripEligibilityRow     | routes.ts:509 / admin.ts:678 | N     | mobile extra comment                                                                                           |
| TripOrigin             | routes.ts:519 / admin.ts:703 | N     | web extra header comment                                                                                       |

**Buyer portal**

| Name                                                                                                           | web / mobile loc                                           | Class | Note                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| BuyerAuthorizationRow, BuyerRemittance, ShelfActiveOrder, ShelfResponse, LockedCategory, ReplenishmentEstimate | buyer.ts                                                   | I     |                                                                                               |
| BuyerAnalytics, BuyerStatement, BuyerStatementTransaction, BuyerStockAlerts, ShelfEstimate                     | buyer.ts                                                   | N     | comment-only                                                                                  |
| BuyerCreateChangeRequestInput                                                                                  | buyer.ts:491 / :866                                        | N     | web inlines the union, mobile references `ChangeRequestType` (same values)                    |
| BuyerPayment                                                                                                   | buyer.ts:764 / :751                                        | N     | checkStatus: literal(web) vs named `BuyerCheckStatus`(mobile), same values                    |
| BuyerOrder                                                                                                     | buyer.ts:51 / :75                                          | D     | web required fields, richer nested item shape; mobile mostly optional, adds categoryTaxAmount |
| BuyerProduct                                                                                                   | buyer.ts:12 / :13                                          | D     | mobile carries legacy price/basePrice/imageUrl vs web's buyerPrice/imageUrls/imageKeys        |
| BuyerPromotion                                                                                                 | buyer.ts:360 / :317                                        | D     | **mobile's `type` union is missing `"BUY_N_GET_M"`** present on web                           |
| OrderTemplate                                                                                                  | buyer.ts:153+order-templates.ts:12 / order-templates.ts:15 | D     | web inlines item/customer shape; mobile refs `OrderTemplateItem[]`, drops customer            |
| OrderTemplateItem                                                                                              | order-templates.ts:4 / :7                                  | N     | comment only                                                                                  |

**Auth/Users & misc**

| Name                                   | web / mobile loc           | Class | Note                                                                                                                |
| -------------------------------------- | -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| AppUser                                | users.ts:4 / admin.ts:1138 | D     | web: role/status literal unions + isAdmin/canActAsDriver; mobile: firstName/lastName, role:string, isActive:boolean |
| MarginConfig                           | margin.ts                  | I     |                                                                                                                     |
| CostHistoryEntry                       | cost-history.ts            | N     | comment placement only                                                                                              |
| ProductSaleLine                        | product-sales.ts           | N     | comments only                                                                                                       |
| ProductSalesHistory                    | product-sales.ts           | N     | mobile factors `summary` into named `ProductSalesSummary` (same shape)                                              |
| SaleDraft, SaveDraftInput              | drafts.ts                  | I     |                                                                                                                     |
| Estimate, EstimateItem, EstimateStatus | estimates.ts               | I     |                                                                                                                     |

## 4. Already-shared vs. shadowed (`packages/types`)

Only **`addons.ts`** in each app imports from `@routeflow/types` (addon-key constants only). No `lib/api` file imports any of the package's `enum`s or `interface Order/User/PaginatedResponse/ApiResponse`.

- **`Order`** — `packages/types/index.ts:98` exports `interface Order`. Both `apps/web/lib/api/orders.ts:9` and `apps/mobile/lib/api/orders.ts:67` independently redeclare an unrelated, far richer `Order` shape (see divergence above) — a genuine shadow, unused by either app.
- **`PaymentMethod`** — package exports `enum PaymentMethod` (CASH/CHECK/ACH/OTHER/CREDIT_NOTE/ADVANCE/CREDIT_CARD/ZELLE). `apps/mobile/lib/api/invoices.ts:37` declares `export type PaymentMethod = AnyPaymentMethod;` (a string-union alias, same value set) — a mobile-only name collision. Web never uses this name (uses `SelectablePaymentMethod`/`AnyPaymentMethod` from `apps/web/lib/payment-methods.ts`, whose mobile mirror is `apps/mobile/lib/payment-methods.ts` — itself a near-identical, already-duplicated pair outside `lib/api`'s scope).
- No other packages/types export (`UserRole`, `UserStatus`, `OrderStatus`, `ItemStatus`, `RouteRunStatus`, `RouteRunStopStatus`, `MutationType`, `TxnStatus`, `FulfillPath`, `RouteKind`, `DriverStatus`, `User`, `PaginatedResponse`, `ApiResponse`) is redeclared under the same name in `lib/api`.

## 5. Same-name-different-file duplicates within one app

- **Web**: `OrderTemplate` (`buyer.ts:153` vs `order-templates.ts:12`, divergent shapes); `PriceType` (`orders.ts:7` vs `invoices.ts:11`, **identical** string).
- **Mobile**: `ChangeRequestType`/`ChangeRequestStatus`/`ChangeRequestResolution`/`ChangeRequest` (`buyer.ts` vs `change-requests.ts`, identical values); `ExpiringAuthorization` (`authorizations.ts:105` vs `buyer.ts:345`, identical); `SalesByCustomerRow`/`SalesByItemRow` (`admin.ts` vs `reports.ts`, **divergent** — different field names for the same concept).

## 6. Prisma-enum mirrors (string-union types, no `export enum` used anywhere in web/mobile `lib/api`)

None of these are yet exported by `@routeflow/types`. Selected notable ones (full match count ≈35 names, mostly single-app):

| Name                                                                                                                                                                                                                                                                                                                             | Prisma enum                                                   | Note                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| EstimateStatus, ExpenseStatus, InvoiceStatus, ReturnStatus, ReturnReason, CreditNoteStatus, RegulatedFilingStatus, InvoiceTreatment, ReportCadence, TrackedCategoryTaxType, InvoiceScanStatus, SupplierStatementScanStatus                                                                                                       | same-named Prisma enum                                        | values match (near-identical formatting only)                                           |
| **VendorBillStatus**                                                                                                                                                                                                                                                                                                             | `VendorBillStatus` (DRAFT/RECEIVED/PARTIAL/PAID/OVERDUE/VOID) | **mobile's `"FULL"` is not a real value at all**; both apps additionally omit `OVERDUE` |
| POStatus (mobile-only)                                                                                                                                                                                                                                                                                                           | `PurchaseOrderStatus` (DRAFT/SENT/PARTIAL/RECEIVED/CLOSED)    | mobile uses `"PARTIALLY_RECEIVED"` instead of `PARTIAL`                                 |
| PaymentStatus (mobile-only)                                                                                                                                                                                                                                                                                                      | `PaymentStatus`                                               | exact match                                                                             |
| PriceType, CheckStatus, DocumentNumberType, CostingMethod, AuthorizationStatus/Source, PromotionType/Scope, MigrationSource/JobStatus, StockCountStatus, SalesAgentStatus, CommissionRateSource/AccrualStatus/StatementStatus/StatementLineKind, ImportFileStatus/BatchStatus, RouteOriginKind/EndKind/OptimizeMetric (web-only) | matching Prisma enum                                          | not cross-app duplicates, so out of §3's table                                          |
| ChangeRequestType/Status, RecurringFrequency, MovementType (mobile-only)                                                                                                                                                                                                                                                         | matching Prisma enum                                          | not cross-app duplicates                                                                |

## 7. Counts summary & recommendation

- Web: 348 exported shapes (346 unique) · Mobile: 268 (261 unique).
- Cross-app duplicates: **134** — Identical **49**, Near-identical **46**, Divergent **39**.
- Already-shared-but-shadowed: **2** (`Order`, `PaymentMethod`), both currently unused by either app's `lib/api`.
- Prisma-enum mirrors: ~35 string-union names replicate a schema enum; none live in `@routeflow/types` yet.

**Bounded move set** (identical + near-identical only, 95 names) grouped by domain for `packages/types/<domain>.ts`:

1. **orders**: ActiveOrderSummary, CancelImpact, CustomerPriceHistory.
2. **customers**: CustomerAuthorization, ExpiringAuthorization, CustomerComment, CustomerDocument, SubmitBuyerAuthorizationInput.
3. **products/inventory**: InventoryValuation, RecomputeCostsResult, CommitStockCountPayload/Response/SessionResponse, VariantAssignResult, ProductSaleLine, ProductSalesHistory.
4. **invoices/finance**: all identical Create/Recurring/Payment DTOs above plus InvoiceTreatment, ExpenseStatus, PaymentListResponse/Params, InvoiceScanStatus, InvoiceStatus, SetCheckStatusDto, StandalonePaymentDto, SendInvoiceEmailResult, RecordSupplierPaymentDto/Result, SupplierStatement*, VendorBill duplicates that are identical (CheckVendorBillDuplicateDto, DuplicateVendorBillInfo/Error, UnlinkedItemsError, PriorScanSummary), ScanCandidate, Return/CreditNote identical members.
5. **auth/users**: (none identical besides CustomerAuthorization above).
6. **routes/drivers**: RouteSettings, StopETA, RouteAnalysisResult, TripIneligibleReason, TripEligibilityRow, TripOrigin.
7. **misc/regulated**: TrackedCategoryTaxType/ReportCadence/TemplateColumn/ItemType/UomOption/ReportTemplateDef, RegulatedFiling(Status)/LedgerRow/Response/ReportColumn/ReportWarning(Code)/ReportPreview, MarginConfig, SaleDraft/SaveDraftInput, Estimate/EstimateItem/EstimateStatus, TobaccoOverview.

**Fix first, separately from the migration**: `VendorBillStatus`'s mobile `"FULL"` value is not in the Prisma schema — flag before any shared type is authored, since a shared type would force a real decision instead of silently picking one side.
