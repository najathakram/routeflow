# Refresh 2026-11-22: purchase orders, vendor bills, counter sale, order drafts, payment receipts, billing catch-up

> Path:line pointers are checked against `origin/master` a07da9102d (2026-11-22). Lines are the
> declaration line of each symbol (for a route, its HTTP decorator line). Trust the code over this part;
> re-grep the symbol before you edit.
> Older prose for these areas stays in `api/feature-modules-4/vendor-bills.md`, `api/feature-modules-4/inventory.md`,
> `api/feature-modules-3/drafts.md` and `api/feature-modules-3/invoices.md`. This part is the where-to-find layer.

## Purchase orders and inventory PO paths {#purchase-orders-inventory}

- **`apps/api/src/inventory/inventory.controller.ts`** (295 L) — REST surface, `@Controller("inventory")` L51.
  - PO routes: `POST purchase-orders` `createPO` L230; `GET purchase-orders` `listPOs` L235; `GET purchase-orders/:id` `getPO` L241; `PATCH purchase-orders/:id` `updatePO` L252; `POST purchase-orders/:id/send` `sendPO` L261; `POST purchase-orders/:id/receive` `receivePO` L266; `POST purchase-orders/:id/close` `closePO` L275.
  - Thin: every PO handler delegates to `InventoryService`. callers: web `lib/api/inventory.ts` hooks (`usePurchaseOrders` L185 to `useClosePurchaseOrder` L336).
- **`apps/api/src/inventory/inventory.service.ts`** (3,844 L) — `InventoryService` L148. PO paths:
  - Create: `nextPoNumber` L1391 → `createDraftPurchaseOrderInTx` L1413 → `createPurchaseOrder` L1486.
  - Read: `listPurchaseOrders` L1545; `getPurchaseOrder` L1564; `loadPoForResponse` L2539.
  - Send: `sendPurchaseOrder` L1659.
  - Receive: `receivePurchaseOrder` L1669 → `lockPurchaseOrder` L1797 → `lockProducts` L1822, `readLockedStockRows` L1832 → `postPoReceipt` L1848 (receipt lots, StockMovement, product stock).
  - Reverse (bill void or edit): `reversePoReceipts` L1976 (compensating movements; refuses when goods were used, L2012).
  - Edit: `updatePurchaseOrder` L2218 (reverses, applies, re-posts the receipt at its original date).
  - Close: `closePurchaseOrder` L2551.
  - side effects: PurchaseOrder/PurchaseOrderItem, StockLot, StockMovement, Product stock and averageCost; `fireStockAlerts` L175.
  - importers: `orders/orders.service.ts`, `vendor-bills/vendor-bills.service.ts`.
- **`apps/api/src/inventory/po-line-input.ts`** (39 L) — `poLineFromInput` L12. One PO line as the client sends it → stored amounts through `buildPOLine` (`packages/pricing`). Case-entered lines (`caseCost`) are recomputed server-side.
- **`apps/api/src/inventory/po-use-since-receipt.ts`** (125 L) — "were received goods used since the receipt?" Reads decreasing StockMovement after the live receipt.
  - exports: `LiveReceipt` L21, `productsUsedSinceReceipt` L60, `qtyUsedSinceReceipt` L80, `poGoodsUsedConflict` L110.
  - callers: `inventory.service.ts` L2056 (update), `vendor-bills.service.ts` L2191 (bill reversal).
- **`apps/api/src/inventory/bill-revert.ts`** (94 L) — receipt/reversal note text and pairing: `billReceiptNote` L16, `billReversalNote` L23, `poReversalNote` L49, `poReversalOf` L57, `pairedReceiptIds` L72.
- **`apps/api/src/inventory/dto/create-purchase-order.dto.ts`** (125 L) — `PurchaseOrderItemDto` L29, `CreatePurchaseOrderDto` L59, `ReceivePurchaseOrderItemDto` L95, `ReceivePurchaseOrderDto` L118.
- **`apps/api/src/inventory/dto/update-purchase-order.dto.ts`** (100 L) — `UpdatePurchaseOrderItemDto` L30, `UpdatePurchaseOrderDto` L67.
- **`apps/api/src/inventory/dto/list-purchase-orders.dto.ts`** (18 L) — `ListPurchaseOrdersDto` L5 (typed query; raw `query: any` was the cause of a string `take` in prod).
- **Web PO list (inventory tab)** — `apps/web/app/(dashboard)/inventory/_components/PurchaseOrdersTab.tsx` (495 L): `poStatusBadge` L23, `PurchaseOrdersTab` L127; row links to `/purchase-orders/:id` L349.
  - `PurchaseOrdersCreateModal.tsx` (302 L) `CreatePOModal` L21.
  - `PurchaseOrdersEditModal.tsx` (378 L) `PurchaseOrdersEditModal` L328.
  - `PurchaseOrdersReceiveModal.tsx` (203 L) `ReceivePOModal` L11.
  - `PurchaseOrderLinesTable.tsx` (248 L) `PurchaseOrderLinesTable` L46 (shared by create and edit); `PurchaseOrderReadOnlyLines.tsx` (74 L) L14.
- **Web PO pure logic** — `purchase-orders-edit.ts` (224 L): `validateEditLines` L98, `buildUpdateItems` L128, `linesChanged` L182, `isEditable` L208, `explainEditError` L211. Mirrors the PATCH rules.
  - `purchase-orders-shared.ts` (226 L): types `POItem` L33, `PurchaseOrder` L46, `POStatus` L23; line money `resolveStoredPOLineAmounts` L149, `resolvePOLine` L196, `toCreateItem` L212.
- **Web PO routes** — `apps/web/app/(dashboard)/purchase-orders/`:
  - `page.tsx` (55 L) `PurchaseOrdersPage` L15; `ScanPoButton.tsx` (68 L) `ScanPoButton` L14 (routes to the PO detail).
  - `[id]/page.tsx` (12 L) `PurchaseOrderPage` L8; `[id]/PurchaseOrderDetail.tsx` (296 L) `PurchaseOrderDetail` L38; `[id]/po-detail-logic.ts` (19 L) `poActions` L11.

## Vendor bills {#vendor-bills}

- **`apps/api/src/vendor-bills/vendor-bills.controller.ts`** (219 L) — `@Controller("vendor-bills")` L39.
  - `POST /` L46; `GET /` L50; `POST scan-invoice` `scanInvoice` L74; `POST check-duplicate` L122; `GET scans` L127; `GET scans/:id` L135.
  - `POST product-mappings` `saveProductMapping` L141; `GET product-mappings` L150; `POST payments/record` L157; `GET suppliers/:supplierId/statement` L162.
  - per id: `GET :id` L168; `PATCH :id` L172; `POST :id/receive` L176; `POST :id/revert-to-draft` L184; `POST :id/void` L191; `POST :id/payments` L195; `POST :id/payments/:paymentId/move-to-credit` L203; `DELETE :id` L211; bulk `DELETE /` L215.
  - callers: web `lib/api/vendor-bills.ts` hooks (`useVendorBills` L166, `useCreateVendorBill` L242, `useReceiveVendorBill` L407, `useRevertVendorBillToDraft` L437, `useVoidVendorBill` L451, `useRecordVendorBillPayment` L476, `useDeleteVendorBill` L510, `useBulkDeleteVendorBills` L518). Scan upload: `lib/api/invoice-scan.ts` L57.
- **`apps/api/src/vendor-bills/vendor-bills.service.ts`** (3,662 L) — `VendorBillsService` L216. Methods:
  - Create and link: `create` L492; `applySupplierCreditToBill` L749; `linkExistingPurchaseOrder` L309; `checkDuplicate` L1009.
  - Edit and receive: `update` L1087; `receive` L1268; `loadLiveBillReceipts` L1595.
  - Reverse: `revertToDraft` L1972 → `reverseBillLots` L2053; `voidBill` L2228.
  - Read: `findAll` L2359; `findOne` L2416; `listScans` L3044; `getScan` L3067; `getSupplierStatement` L3456.
  - Scan: `scanInvoice` L2671; `claimScanInTx` L969.
  - Money: `recordPayment` L3083; `movePaymentToSupplierCredit` L3168; `recordSupplierPayment` L3297.
  - Delete: `delete` L3549; `bulkDelete` L3578.
  - callers: `vendor-bills.controller.ts`; importers `bookkeeping/bookkeeping.service.ts`, `import/import.service.ts`, `import/batch-import.service.ts`, `inventory/inventory.service.ts`.
  - side effects: VendorBill, payments, supplier credits, PO receipts through `InventoryService`.
- **`bill-locks.ts`** (49 L) — `lockBillRows` L11 (sorted id order, row locks for the caller's tx); `lockSupplierCredits` L36. Every bill money or receipt writer takes these first.
- **`bill-cash-guard.ts`** (52 L) — `isCashBillPayment` L24, `billCashPaid` L29, `billCashPaidRefusal` L44.
- **`po-bill-match.ts`** (228 L) — the bill-vs-PO hard gate. `PO_LINE_TOLERANCE` L38, `findPoMatchViolations` L102, `assertBillWithinPo` L196.
- **`pack-size-gate.ts`** (130 L) — `isPackSizeGateEnforced` L30, `findPackSizeUnknownLines` L60, `assertPackSizeKnownOrLog` L99.
- **`bill-line-pack.ts`** (85 L) — `productHasPackLadder` L41, `knownPackHint` L52, `classifyBillLinePack` L72.
- **`bill-lines-total.ts`** (24 L) — `billLinesTotal` L16.
- **`product-matcher.ts`** (198 L) — `normalizeForMatch` L49, `buildTokenWeights` L64, `matchLine` L82.
- **`invoice-scan.fingerprint.ts`** (90 L) — `hashFile` L36, `lineFingerprint` L55.
- **`vendor-bills.module.ts`** (37 L) — `VendorBillsModule` L36.
- **DTOs** (`dto/`): `CreateVendorBillDto` L55 (`VendorBillItemDto` L21); `UpdateVendorBillDto` L20; `ReceiveVendorBillDto` L28 (`ReceiveVendorBillLineDto` L17); `RecordVendorBillPaymentDto` L10; `RecordSupplierPaymentDto` L36 (`SupplierAllocationDto` L23); `BulkMarkPaidDto` L22; `SaveProductMappingDto` L9; `CheckVendorBillDuplicateDto` L10.

## Counter sale and pickup {#counter-sale-pickup}

Till sale, park, void, pickup hand-over, day close and drawer, all under `apps/api/src/orders/counter-sale/`.

- **`counter-sale.controller.ts`** (117 L) — `@Controller("orders")` L39. `GET counter-sale/today` L59; `GET counter-sale/quick-keys` L71; `GET counter-sale/by-key/:key` L84 (did a sale land under this Idempotency-Key); `POST counter-sale` L105.
- **`counter-sale.service.ts`** (771 L) — `CounterSaleService` L94. `ring` L107 (the sale write); `creditRecheck` L347; `auditPriceEdits` L394; `tender` L451; `clearStaleCashTendered` L583; `byKey` L609; `tenderSplit` L677; `assertProductsExist` L724.
  - callers: `counter-sale.controller.ts`.
- **`counter-sale.dto.ts`** (100 L) — `COUNTER_SALE_METHODS` L29, `CounterSaleItemDto` L35, `CounterSalePaymentDto` L49, `CounterSaleDto` L67.
- **`counter-sale-payment.ts`** (179 L) — `assertPaymentShape` L34, `assertCheckNotPostdated` L62, `assertWalkInTenderCoversTotal` L94, `planCounterPayment` L119, `allocateOldestFirst` L137.
- **`counter-sale-readback.ts`** (280 L) — `buildCounterSaleResponse` L172 (the response the till shows).
- **`counter-sale-today.ts`** (1,167 L) — window and row helpers: `TODAYS_SALES_DEFAULT_LIMIT` L56, `counterSalesWhere` L81, `salePaymentsWhere` L111, `handOverCandidatesWhere` L134, `toHandOverRows` L266.
  - **`counter-sale-today.service.ts`** (231 L) — `CounterSaleTodayService` L75; `effectiveZone` L49.
- **`counter-park.controller.ts`** (74 L) — `@Controller("orders/counter-sale/parked")` L41: `POST` L46, `GET` L52, `POST :id/resume` L58, `DELETE :id` L68.
  - **`counter-park.service.ts`** (344 L) — `CounterParkService` L92; `park` L123, `list` L236, `resume` L284, `discard` L335.
  - **`counter-park.sweep.ts`** (52 L) — `CounterParkSweepService` L17 (hourly sweep that deletes parked rows in batches).
  - **`counter-park.ts`** (111 L) — `COUNTER_PARK_SWEEP_BATCH` L13 (rows per sweep statement), `defaultParkLabel` L37, `ParkedRow` L43, `itemSummaryOf` L101.
- **`counter-sale-void.controller.ts`** (40 L) — `@Controller("orders")` L24; `POST counter-sale/:orderId/void` L28.
  - **`counter-sale-void.service.ts`** (328 L) — `CounterSaleVoidService` L60; `voidSale` L70, `voidLocked` L119, `voidInTx` L139.
  - **`counter-sale-void-window.ts`** (21 L) `tenantDayWindow` L15; **`counter-sale-void-errors.ts`** (36 L) `counterVoidBusy` L9, `counterVoidNotToday` L30.
- **`pickup-complete.controller.ts`** (52 L) — `@Controller("orders")` L34; `POST :id/pickup-complete` L38.
  - **`pickup-complete.service.ts`** (909 L) — `PickupCompleteService` L120; `complete` L132 (the hand-over); `completionEmail` L492; `claimHandOver` L553; `tender` L694; `owedBalance` L817.
  - **`pickup-complete-claim.ts`** (134 L) — the hand-over claim (AuditLog row, action PICKUP_COMPLETE_CLAIM). `stampCompletion` L41, `reserveCompletionEmail` L57, `finishCompletionEmail` L81, `releaseCompletionEmail` L95. Every meta write is an atomic jsonb merge (`mergeClaimMeta` L23).
  - **`pickup-tender.ts`** (92 L) `tenderFigures` L55; **`pickup-tender-group.ts`** (17 L) `pickupTenderGroupId` L14.
  - **`complete-at-counter-run.ts`** (152 L) — `completeAtCounterRunRefusal` L56, `takeOrderOffRun` L108.
- **`counter-tender-window.ts`** (70 L) — `counterTenderPaidAt` L58; `counterCloseShared` L37 (a tender takes the shared counter-close lock; day close takes it exclusive).
- **Day close** — `day-close/day-close.controller.ts` (88 L) `@Controller("orders")` L34: `GET counter-sale/day-close` L39, `GET .../latest` L47, `GET .../:id` L55, `POST counter-sale/day-close` L63, `POST .../:id/reopen` L71, `POST .../:id/report` L80.
  - `day-close.service.ts` (604 L) — `CounterDayCloseService` L104; `latestClose` L214, `closeById` L237, `close` L291, `closeInTx` L350, `reopen` L431, `sendReport` L521.
  - `day-close-fold.ts` (97 L) `foldDayClose` L51, `expectedCashOf` L91; `day-close-facts.ts` (118 L) `readWindowFacts` L23; `day-close-lock.ts` (30 L) `lockCounterCloseExclusive` L8; `z-report-email.ts` (168 L) `buildZReportEmail` L91.
- **Drawer** — `drawer/counter-drawer.controller.ts` (52 L): `GET counter-sale/drawer/opening-float` L31, `POST` L38, `PATCH` L45.
  - `drawer/counter-drawer.service.ts` (392 L) — `CounterDrawerService` L87; `record` L246, `correct` L314.
- **Quick keys** — `quick-keys.service.ts` (96 L) `QuickKeysService` L24; `quick-keys-rank.ts` (61 L) `rankCounterProducts` L29; `quick-keys-grid.ts` (40 L) `composeGridIds` L14.
- **Guards and gates** — `till-permission.guard.ts` (84 L): `assertMayUseTill` L31, `TillPermissionGuard` L72. `counter-sale-gate.ts` (23 L) `assertCounterSalesEnabled` L11. `required-idempotency-key.ts` (39 L) `requireIdempotencyKey` L10. `walk-in-customer.ts` (85 L) `WalkInCustomerService` L23; `walk-in-sale-lock.ts` (62 L) `assertWalkInSaleEditable` L37.
- **Duplicate tender ref** — `counter-duplicate-ref.ts` (37 L) `duplicateCause` L32; uses `invoices/payment-ref-dedupe.ts`.
- **Web till** — `apps/web/app/(dashboard)/orders/counter-sale/page.tsx`; `orders/_components/CounterSaleScreen.tsx` (2,571 L) `CounterSaleScreen` L214 (the screen, largest single file); `CounterReceiptView.tsx` (282 L) `CounterReceiptView` L16; `CounterDayClose.tsx` (711 L) `CounterDayClose` L615; `CounterTodaysSales.tsx` (691 L) `CounterTodaysSales` L528; `CounterVoidSaleDialog.tsx` (240 L) `CounterVoidSaleDialog` L27; `CounterPartPay.tsx` `CounterPartPaySplit` L51; `CounterLinePriceEdit.tsx` `CounterLinePriceEdit` L115; `CounterDateChip.tsx` `CounterDateChip` L40; `CounterCustomerMatches.tsx` `CounterCustomerMatches` L83.
- **Web counter lib** — `apps/web/lib/counter-sale.ts` (855 L): `counterSaleGate` L65, `newOrderEntry` L98, `cartTotals` L180. `counter-receipt.ts` (637 L) `buildCounterReceipt` L205. `counter-live-cart.ts` (100 L): `writeLiveCart` L21, `readLiveCart` L55, `clearLiveCart` L92. `counter-price-edit.ts` (190 L) `resolveCounterPriceEdit` L95. `counter-park.ts` (139 L), `counter-part-pay.ts` (156 L), `counter-void-copy.ts` (76 L) `COUNTER_VOID_ERROR_COPY` L25, `counter-day-close-draft.ts` (87 L), `counter-week.ts` (143 L).
- **Web API client** — `apps/web/lib/api/counter-sale.ts` (209 L): `useCounterSaleGate` L26, `useCreateCounterSale` L75, `useCounterSaleByKey` L116, `usePickupComplete` L147, `useVoidCounterSale` L193. `counter-park.ts`: `usePark` L67, `useResume` L98. `counter-day-close.ts`: `useCounterDayClose` L12, `useCloseCounterDay` L22.

## Order drafts {#order-drafts}

- **`apps/api/src/drafts/drafts.controller.ts`** (48 L) — `@Controller("drafts")` L16: `GET /` L23 (list), `POST /` L28, `GET :id` L33, `PATCH :id` L38, `DELETE :id` L43. callers: web `lib/api/drafts.ts` (`useDrafts` L6, `useDraft` L19, `useCreateDraft` L28, `useUpdateDraft` L37, `useDeleteDraft` L46) and `orders/_components/use-unsent-order-resume.ts` L40.
- **`drafts.service.ts`** (165 L) — `DraftsService` L36. `DRAFT_SUBMIT_KEY_FIELD` L26: one Idempotency-Key per draft in `payload._submitKey` (a reload plus resubmit replays the same key). Copy of the constant in `packages/types`; the spec pins the two equal.
- **`dto/save-draft.dto.ts`** (40 L) — `SaveDraftDto` L7. **`drafts.module.ts`** (12 L) — `DraftsModule` L11.
- **Web autosave engine** — `apps/web/lib/order-draft/engine.ts` (468 L): `DRAFT_AUTOSAVE_MS` L16 (900 ms debounce), `OrderDraftEngine` L100, `DraftConflictError` L51, `createOrderDraftEngine` L132. Mirrors the mobile engine rules (single-flight create, JSON-unchanged skip, discard is final).
  - `mirror.ts` (144 L): `LOCAL_MIRROR_MS` L14 (300 ms local write), `createDraftMirror` L38, `attachMirrorFlush` L128 (flush on hide or unload).
  - `storage.ts` (142 L): `createIndexedDbDraftStorage` L103, `setDraftMirrorStorage` L132.
  - `resume.ts` (149 L): `findResumable` L48, `repriceResumedLines` L116. `fresh-prices.ts` (87 L): `withFreshTierPrices` L68. `sign-out.ts` (41 L): `signOutDecision` L19. `payload-hash.ts` (29 L): `payloadHash` L16.
- **Web hook** — `apps/web/app/(dashboard)/orders/_components/use-order-draft-autosave.ts` (315 L): `useOrderDraftAutosave` L93, `draftMetaOf` L78, `SUBMIT_FLUSH_BUDGET_MS` L63. callers: `CreateOrderModal.tsx` (the `useOrderDraftAutosave({` call at L1629; `DraftConflictDialog.tsx` imports the conflict type).

## Invoice payment receipts {#payment-receipts}

Money-in writers under `apps/api/src/invoices/payment-*.ts`.

- **`payment-idempotency.ts`** (431 L) — the claim-in-transaction helper for money-in writers. `paymentRequestHash` L143, `withPaymentKey` L256, `keyedPayment` L324, `standalonePaymentKey` L376, `invoicePaymentKey` L398, `advancePaymentKey` L418. callers: `invoices/invoices.service.ts` L4209 and L4959, `customers/customers.service.ts` L975.
- **`payment-ref-dedupe.ts`** (555 L) — the ONE payment-reference dedupe predicate, normaliser and lock. `normalizePaymentRef` L52, `isPaymentAlreadyRecorded` L112, `duplicatePaymentRefConflict` L155, `createPaymentRefGuard` L298, `withPaymentRefLock` L527. callers: `bookkeeping/bookkeeping.service.ts` L76-77 and L228, `customers/customers.service.ts`, `payment-requests/payment-requests.service.ts`, `invoices/payment-edit-ref.ts`, `orders/counter-sale/counter-duplicate-ref.ts`.
- **`payment-edit-ref.ts`** (168 L) — `editDedupeKey` L61, `editLockKey` L77, `withPaymentEditRef` L103.
- **`payment-edit-dates.ts`** (38 L) — `resolveEditedPaymentDates` L9.
- **`payment-void-tx.ts`** (129 L) — `voidPaymentInTx` L27 (void inside the caller's tx; `PaymentVoidTxDeps` L9).
- **`payment-list-query.ts`** (175 L) — `listAllPayments` L74, `findPaymentById` L136, `exportPayments` L154.
- **`payment-image.ts`** (94 L) — `uploadPaymentImage` L32, `getPaymentImageUrl` L67, `deletePaymentImage` L76.
- **`payment-key-status.controller.ts`** (44 L) — `@Controller("invoices")` L20: `GET payments/by-key/:key` L26, `POST payments/by-key/:key/resolve` L32. **`payment-key-status.service.ts`** (178 L) — `PaymentKeyStatusService` L56.
- **`payment-predicates.ts`** (40 L) — re-export block only (L9, L35).

## Billing catch-up {#billing-catchup}

October catch-up checkout for manual tenants, `apps/api/src/billing/catchup-*.ts`. The claim freezes RouteFlow-side invoicing while a Stripe catch-up session is open (SA-733r3 N2), so a customer cannot be charged twice.

- **`catchup-claim.ts`** (155 L) — `CATCHUP_STATES` L17, `CatchupState` L18, `CATCHUP_ORPHAN_AFTER_MS` L24, `claimRefusal` L74, `activationClaimRefusal` L98, `isCatchupSubscription` L145, `isCatchupSession` L152.
- **`catchup-claim.service.ts`** (1,283 L) — `CatchupClaimService` L108; `ReleaseOutcome` L74. callers: `platform-admin/rf-invoices.service.ts`.
- **`catchup-checkout.service.ts`** (510 L) — `CatchupCheckoutService` L161; `CatchupReport` L55, `CatchupCensus` L90, `catchupReportJson` L99. callers: `platform-admin/catchup-admin.controller.ts`.
- **`catchup-plan.ts`** (586 L) — `planCatchup` L485, `catchupShape` L398, `trialEndFor` L392, `chargeNowCents` L410, `CatchupPlan` L415, `paidCoverage` L65, `paidThroughOf` L99, `activationClusters` L237, `stubLines` L304. `CATCHUP_GO_LIVE` L27.
- **`catchup-markers.ts`** (173 L) — `readCatchupMarkers` L135, `validateBillingStart` L85, `voidedMarkerIds` L115; `CATCHUP_MARKERS_VERSION` L25.
- **`catchup-refusal.ts`** (66 L) — `CATCHUP_REFUSAL` L12, `refusalCodeOf` L46, `planRefusalException` L58.
- **`catchup-session-params.ts`** (236 L) — `assertCheckoutAcceptable` L45, `catchupTermsSignature` L198, `assertSignedSession` L213, `buildCatchupSessionParams` L220.
- **`catchup-session-terms.ts`** (119 L) — `SIGNING_SINCE` L10, `expectedSessionTerms` L54, `checkSessionTerms` L86.
- importers of the catch-up family: `billing/billing.service.ts`, `billing/stripe.service.ts`, `billing/payment-due.service.ts`, `billing/dunning-core.ts`, `billing/checkout-anchor.ts`, `platform-admin/platform-admin.service.ts`.
