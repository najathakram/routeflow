# Web landing 2026-10-29, w26 catch-up (master `b1a2fc3d1` exclusive .. `75f433f56`; trains W21-W25 = #3965 #3966 #3968 #3970 #3971)

Paths under `apps/web/`. Tests not indexed. Newest first; trains are split into member PRs. Shared packages, mobile and control: `packages/landing-2026-10-29-w26-catchup.md`. Api parts: the api landing files. No web size-ratchet baseline changed (both ratchet moves are api files). Docs, ops, registry and test-only PRs are omitted (#3957 is Playwright config only).

## W25 #3971 and W23 #3968
- No web code (api: delivery evidence, credit-note bound, census, commission). Only `packages/types` gains codes.

## W24 #3970 / #3849 `e60c16e6e` regulated-type name, palette products, reduced motion (W-926, W-927, W-928)
- `products/_components/SectionEditCell.tsx`: regulated-type select named for the product. `components/CommandPalette.tsx` lists matching products (fed by `products/page.tsx`). `app/globals.css`: one `prefers-reduced-motion` rule switches off Tailwind enter/exit animations for every overlay.

## W22 #3966 / #3743 `859468f97` counter receipt names the check, offers Void, fits a phone (W-713, W-715, W-716)
- `orders/_components/{CounterReceiptActions,CounterReceiptView,CounterVoidSaleDialog,CounterTodaysSales,CounterReturnAction}.tsx`, `lib/counter-receipt.ts`, `lib/api/counter-sale-today.ts` (optional `checkReference`).
- Receipt and reprint read "Check #1042" (decorated once in pricing); Change is a headline only when owed; actions are one row from `sm`, 2x2 on a phone; Void reuses the void dialog behind VOID_SALE, shows how the sale was paid, marks the reason required.

## W22 #3966 / #3842 `171e20170` one licence-validity day rule (B330)
- `lib/api/authorizations.ts`, `customers/_components/AuthorizationsTab.tsx`, `compliance/[categoryId]/_components/CompliancePackPanel.tsx` call `displayLicenceStatus` / `isLicenceExpired` from `@routeflow/types` with the business zone: good through the printed day; unknown zone reads UTC.

## W22 #3966 / #3830 `75dadbc6b` Dispatch form keeps typed input when the zone resolves
- New `lib/use-reset-on-open.ts`: `useResetOnOpen(...)`; `routes/page.tsx` resets on open only, the tenant day fills an empty date.

## W22 #3966 / #3932 `d0cd10bd3` one product create per attempt on double-click (I-79)
- `components/InlineCreateProductModal.tsx`, `products/[id]/page.tsx` (Create Variant): a ref drops a second submit until `onSettled`; a failed create can be retried.
- #3946, #3798, #3814, factory bundle: no web code.

## W21 #3965 / #3847 `12b08c0a9` bulk product delete returns softDeletedIds (493)
- `lib/api/products.ts`: result gains `softDeletedIds: string[]`. Other W21 members (#3800 refund tax, #3955, #3953, #3919, #3910, #3788, #3894, #3947): no web code.

## #3942 `5c843a679` Write off moves to the invoice More menu (SA-1050 PR-A)
- `invoices/[id]/page.tsx`: danger item beside Void invoice (open invoice only, disabled read-only); the confirm states the amount; quick reasons fill the required text.

## #3940 `eadc1542c` typed records for the 4 enum-mirror drifts (SA-1049 PR-1)
- `dashboard/page.tsx` (`PIPELINE_TILES: Record<PipelineStatus, ...>` over `ORDER_STATUS_VALUES`; Partly delivered tile), `inventory/movements/page.tsx` (COST_BASIS), `returns/[id]/page.tsx` (PROCESSED step), `(platform-admin)/_components/AdminBadge.tsx` become exhaustive Records. Mirrors in `packages/types/api/enums.ts`.

## #3745 `accbfbf33` counter dialogs ease out; Change price; key hints; 2*code (W-783, W-710)
- `orders/_components/CounterLinePriceEdit.tsx` ("Change price"), `CounterCustomerMatches.tsx` (key hint, `aria-describedby`), `useCounterSaleScan.ts` (`QTY_PREFIX`: `2*code`, `2 x code`; a name like `2 x 4 stud` stays whole), `lib/counter-sale.ts`. `packages/ui` `Modal` eases 200 ms in, 150 ms out.

## #3898 `9db072946` counter lists matching items as you type (W-852)
- New `orders/_components/CounterLiveMatches.tsx`: `LIVE_MATCH_DEBOUNCE_MS = 300`, `useCounterLiveMatches({ text, enabled, onPick })`, `CounterLiveMatches`; `CounterSaleScreen.tsx` mounts it, `useCounterSaleScan.ts` gains `pick`.
- Up to 10 sellable matches (debounced `useProducts`); arrows + Enter or click add one selling unit times the typed quantity; a bare quantity or scan-shaped entry keeps the scan path.

## #3891 `52b61ca9d` one Print invoice button (SA-1026 B)
- New `lib/use-print-invoice.ts`: `usePrintInvoice()` -> `print(ids, { variant })`; fetches every PDF before printing any (failure prints nothing, one toast), then an "Open PDF" toast action. `lib/print-pdf-blob.ts` reworked. Callers: `invoices/[id]/page.tsx`, `invoices/page.tsx`, `orders/[id]/_components/{PosOrderActions,PickupCompleteDialog,SendInvoiceModal}.tsx`, `CounterReceiptActions.tsx`, `CounterSaleScreen.tsx`. `packages/ui` gains `useOptionalToast`.

## #3900 `d960391b0` a named customer's return rides the counter sale (W-863 PR-1)
- New `orders/_components/useCounterInlineReturn.tsx`: `netOfReturn`, `useCounterInlineReturn(total, namedCustomer, setError)`, `CounterReturnsMount`. `CounterSaleScreen.tsx` mounts Returns for a named customer, waits for a quote, nets credit against the amount due; a walk-in is told returns are refunded. Request field `inlineReturn` in `packages/types/api/counter-sale.ts`.

## #3902 `2b2112b14` invoice display units: pieces layout (SA-827 T1)
- New `components/InvoiceDisplayRows.tsx` (`InvoiceDisplayRows`, `displayQtyText`, `formatUnitPrice4`), `customers/[id]/CustomerInvoiceUnitControl.tsx`. `invoices/[id]/page.tsx`, `InvoiceLinePrice.tsx` and the buyer invoice page render `invoiceDisplayLines(...)`; `lib/api/{customers,invoices}.ts` carry the preference and `displayUnit`. Builder: `packages/pricing/src/invoice-display-lines.ts`.

## #3763 `3b57419e0` "account admin" on restrictions and category settings (518)
- Copy only: `settings/restrictions/page.tsx`, `settings/product-categories/page.tsx`.

## #3890 `d65a1574f` To collect: check not received yet (SA-1026 A)
- New `components/ToCollectChip.tsx`, `customers/[id]/_components/CustomerToCollectChip.tsx`, `orders/[id]/_components/OrderStaffFlags.tsx`, `orders/_components/CheckNotReceivedChoice.tsx`. `lib/counter-sale.ts`: `CHECK_NOT_RECEIVED_LABEL`, `resolveTender(method, checkNotReceived)` (On account + `expectedMethod: "CHECK"`, not a fifth method). `lib/ar-aging-rows.ts`: `toCollectLookup`.
- Surfaces: Counter Check tender, `PickupCompleteDialog.tsx` hand-over, invoices list `toCollect` filter, invoice and customer pages, AR aging. State is server-derived, never computed here.

## #3834 `c93658333` stock-count seeding progress (row 562 S1)
- `lib/api/stock-count.ts`: `useStockCountProgress`. `components/inventory/StockCountTab.tsx` and `StockCountReviewModal.tsx` show "Preparing count" and keep Commit disabled while seeding (`preparingCopy`); `lib/generic-toast-copy.ts` maps `STOCK_COUNT_SEEDING`.

## #3893 `f4380d60c` capabilities card reads an unset tenant (SA-1028)
- `(platform-admin)/admin/tenants/[id]/_features/`: `CapabilitiesCard.tsx` ("not set up" line, `keepOpensAs`), `CapabilityChoices.tsx`, `capability-ticks.ts` (`toggleCapability(ticks, key, on, keepOpensAs)`), `PreviewDrawer.tsx` (`modeName`), `preview-groups.ts`; `lib/platform-admin/capabilities-contract.ts`.

## #3824 `a73a608d9` refund slip names who made the refund (257)
- `returns/_components/RefundSlipView.tsx`, `lib/refund-slip.ts` (`refundedBy`, settled refunds only), `lib/api/returns.ts`.

## #3773 `b32caa759` migration import: per-row isolation, comma-safe prices (B334, B205)
- New `lib/parse-products-csv.ts`: `UNCLOSED_QUOTE_PRICE`, `splitCsvChecked`, `splitCsv`, `parseProductsCsv` (quote-aware, BOM, strict price shape). Used by `settings/migration/page.tsx`.

## Small fixes
- #3805 `98826ce57` buyer order edit row hides Unit Price cell at 390px (B1266): `buyer/portal/[seller]/orders/[id]/page.tsx`.
- #3775 `aab29fd32` `invoices/new/page.tsx`: delivery, issue and due dates seed from `useTenantToday()`, empty until the zone resolves (750).
- #3707 `41a998c6e` `lib/counter-sale.ts`: `COUNTER_COMPLETE_DAY_CLOSED` is a handled pickup code (W-774); `PickupCompleteRequest` extends `RestrictionAck`.
- #3883 `d2ae41db7` `components/PriceHistory.tsx`: a row with unknown `salePack` is never usable (W-986).
- #3857 `4d93e09ad` `products/[id]/OpenOrdersCard.tsx`: total splits on the lines' common pack, else plain pieces (748).
- #3759 `bcc0f5448` `settings/billing/PaidReturnNotice.tsx`: polls only on `?paid=1`, 5 min cap (706).
- #3728 `2f36f4c36` `lib/barcode-resolve.ts`: `SCAN_LOOKUP_TIMEOUT_MS`, `resolveProductByCode(code, { timeoutMs })`; scan handlers fail a stuck lookup and free the queue (541).
- #3879 `8087cd980`, #3863 `78ef9b703` buyer order page and `lib/buyer-fulfilment.ts`: `BuyerOrderTravelView` gains `"pickup"`, `PICKUP_STEP_LABELS`, `pickupStepIndex`; "Pickup requested".
- #3864 `a31d0e03d` `orders/[id]/edit-line-controls.ts`: `EDIT_CONTROL_H = "h-9 max-lg:h-11"`, `EDIT_TAP_BELOW_LG`; applied across the line edit row, `OrderLineUnitPicker.tsx`, `PriceHistory.tsx`.
- #3877 `d0c41b65a` `CounterDayClose.tsx`: "Paid outside the till" (W-862; label in pricing).
- #3840 `b225b2bb4` `CreateOrderModal.tsx`: line `prefillCustomerId`; a price pre-filled from another customer's history is dropped on customer switch (B755).
- #3870 `b65e46233` `returns/[id]/page.tsx`: resolve dialog takes `walkIn`, defaults `EXTERNAL_REFUND`, hides store credit (W-913).
- #3835 `48e301036` `products/[id]/page.tsx`: variant dialog keeps its text while fading out (535).
- #3762 `c70d92b3f` `settings/page.tsx`, `lib/api/invoices.ts`: send `0` to clear the deposit default (652).
- #3766 `f5a023da1` only `registry.fixtures.ts` follows the new feature-registry shape (SA-950 A).
- #3853, #3848: no web code.

## #3816 `6a670d48c` Settings regrouped into eight groups (376)
- `settings/_components/settings-groups.ts` (Orders & delivery, Counter, Pricing & products, Notifications & email, Compliance & restrictions, ...; `entryCrumb`), `settings-index.ts` (`withLegacyGroupWords`: old labels stay searchable), `SettingsFinder.tsx`, `settings/page.tsx`.

## #3778 `e3a511a52` customer invoice badge counts on the tenant's day (325)
- New `customers/[id]/invoice-status-badge.tsx`: `renderInvoiceStatus(status, dueDate, { isOverdue, tenantDay })`; no day count while the zone is unknown.

## #3726 `9eab5fec4` regulated filing lock (row 632, B297 PR4/5)
- `components/RegulatedFilingsTable.tsx`: Lock action with a reason (min 3 chars) for TENANT_ADMIN only; `lib/api/tracked-categories.ts`: `useLockRegulatedFiling()`; `compliance/[categoryId]/page.tsx`; filing codes mapped in `generic-toast-copy.ts`. `FILING_LOCK_READY = false` (types) keeps it dark. Mobile: `lib/filing-status.ts`.

## #3846 `69dcf543c` buyer views refresh on credit-note void and issue (B546)
- `lib/hooks/useBuyerNotifications.ts`: `BUYER_CREDIT_VIEW_KEYS` (statement, statement-months, dashboard, invoice, payments, payment-preview, remittance) invalidated on `creditNote.created` and `.voided`; voided adds a bell entry.

## #3872 `8610870e7` business name saves via branding (B1231)
- New `settings/_components/BusinessIdentityFields.tsx`: `splitProfileIdentity`, `useSaveBusinessName`, `BusinessIdentityFields`, `NAME_ADMIN_ONLY_COPY`, `NAME_SAVE_FAILED_COPY`, `EMAIL_READ_ONLY_COPY`. A tenant admin's name goes to `PUT /tenants/me/config/branding`; operators see it read-only; email read-only; success toast only when saved.

## #3807 `8bc734be2` one option text and derived split for web and mobile (row 513)
- `lib/unit-options.ts`, `default-unit-line.ts`, `edit-line-derived-unit.ts`, `order-line-unit.ts` use `ladderOptionText`, `ladderOptionDetail`, `derivedPackSplit`, `packPiecesSplit` from `@routeflow/pricing`.

## #3752 `a84c5d8ab` price history: three lines with legend toggles (SA-954, SA-1004 N1)
- New `components/price-history/chart-model.ts` (`LineId` own|like|conv, `ComparisonState`, `ChartModel`, `NOTE_COPY`, `buildChartModel`, `monthLabel`, `unitPhrase`) and `PriceHistoryChart.tsx`; `PriceHistory.tsx` slimmed to host it; `lib/api/price-history.ts` reads `comparison`.
- This customer solid, other customers like-for-like dashed, all customers converted dotted; one price scale; chips disabled with a reason; unknown pack is its own state.

## #3748 `0f8597da0` counter return form: judge passes, walk-in refusal, copy (W-783, SA-959)
- New `returns/_components/quote-guards.ts` (`walkInStoreCreditRefused`, `confirmRefusal`), `quote-failure.ts` (`QUOTE_FAILED_COPY`, `isQuoteFailure`). `returns/_components/{InlineReturnSection,RecordInlineReturnDialog,refund-copy}`, `orders/_components/{CounterReturnAction,OrderInlineReturnsSection}.tsx`, `lib/api/inline-returns.ts`: lines name the product and say where the money goes, outcome words from the server, refusal is the main message, no store credit offered to a walk-in after a failed refund, 44 px targets, one error message per state.
