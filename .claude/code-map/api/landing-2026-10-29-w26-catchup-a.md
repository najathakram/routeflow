# Api landing 2026-10-29, W26 catch-up A (master `b1a2fc3d1` exclusive .. `4be950fdf` inclusive, 74 first-parent commits)

Paths under `apps/api/src/` unless noted. Tests not indexed (test-only: #3828 spec half, #3886 `common/testing/blocked-wait.ts`). Web, docs, ops/registry/tooling PRs are not listed. Size-ratchet: only `invoices/invoices.service.ts` moved, 5695 -> 5634 (in #3726); nothing raised.

## #3789 `87b717057` a counter sale payment must be one object (W-887)
- `orders/counter-sale/counter-sale.dto.ts`, `pickup-complete.dto.ts`: `@IsDefined() @IsObject()` on `payment`; a list or empty list is a 400 (it used to save the sale unpaid).

## #3795 `478ad5930` operator permission guard, shadow mode (741 PR3a)
- New `auth/permissions/permission.decorators.ts`: `RequirePermission(...groups)` (any-of), `PermissionBase(reason)`, `PERMISSION_KEY`, `PERMISSION_BASE_KEY`. `OperatorPermissionsService.mode()`, `hasAny(user, groups)`.
- `auth/guards/roles.guard.ts`: `permissions` is `@Optional()`; only an OPERATOR on a handler naming groups is checked (`checkGroups`). Shadow logs `would-deny` and allows, a failed lookup logs name+code and allows; live (not on) throws `permissionDeniedException` and fails closed.

## #3752 `fb01ab1a9` price history, three lines with legend toggles (SA-954, SA-1004)
- New `customers/price-history-comparison.ts` (pure): `comparisonFor`, `plotUnitsOf`, `mostCommonPack`, `comparisonLines`, `ComparisonSale`, `PlotUnit`; a month needs `minBuyers` distinct OTHER buyers, an unknown pack is left out.
- `customers/customer-price-history.service.ts`: one compare read, `COMPARE_INVOICE_CAP = 2000` exported; rows carry `salePack`. `packages/pricing`: `pricePerBaseUnit`, `priceInUnit`. `packages/types/api/price-history.ts`: `PriceHistoryAveragePoint`, `PriceHistoryComparisonLine`.

## #3762 `22adfde42` send 0 to clear the deposit default (652)
- `system-config/dto/update-invoice-settings.dto.ts` `@IsOptionalNotNull()` (null is a 400); `settings.controller.ts` stores `String(n)`; stored `""` and `"0"` both read as no default.

## #3766 `f3d7d3f1a` feature-registry rows classified by purpose and category (SA-950 A)
- New `billing/feature-registry-row.ts` `toFeatureRegistryRow(f)` (moved out of `platform-admin.controller.ts`); `FeatureDef.nature` (`business | commercial | release`).
- `packages/types/api/features.ts`: `FEATURE_PURPOSE_VALUES`, `FEATURE_BUSINESS_CATEGORY_VALUES`, `FEATURE_COMMERCIAL_CATEGORY_VALUES`, `FEATURE_RELEASE_STAGE_VALUES`, `FeatureNature`, `FeatureIncomplete`.

## #3776 `12eadef9e` unit ladder takes no price on variants, families, recipes (749)
- New `products/product-units-price-guard.ts` `assertUnitPriceWritable(product, dto, mode)`: a price key on a governed product is the coded 409 `FAMILY_PRICE_AUTHORITY`; called from `product-units.service.ts`.

## #3809 `5ddd8db46` overdue cron names its suspension (W-664)
- `billing/dunning-config.ts` `OVERDUE_SUSPENDED_REASON`; `paymentReinstatable` still lifts reason-less rows. The cron stops suspending in #3747.

## #3839 `d87ee8a1d` / #3848 `5500753a0` custom order lines through computeLineSubtotal; line-ambiguity warn census (139, SA-982)
- #3839 `orders/orders.service.ts`: unlisted merge lines store `computeLineSubtotal({ unitPrice, qty })`.
- #3848 new `common/line-ambiguity-warn.ts`: `LINE_GUARD_SITES`, `LineGuardSite`, `RawPackLine`, `warnLineAmbiguity`, `lineGuardCtx`; new `orders/order-line-ambiguity.ts` `orderLineRaw`, `warnOrderLine`. Logs `line-ambiguity site= reason=` and never changes the write. `packages/pricing/src/pricing.ts`: `AMBIGUOUS_LINE_REASONS`, `AmbiguousLineReason`, `lineAmbiguityDetail`, `AmbiguousLineError.reason`. `InvoicesService.create(dto, actor?, opts?: { warnSite })`.

## #3836 `723241cdc` read-only Order.taxRate census (T15 D2)
- `apps/api/scripts/report-order-taxrate-census.mjs` only.

## #3853 `10d777d8b` reduced hold approval re-freezes the Return split (SA-980)
- New `packages/pricing/src/scale-frozen-split.ts` `FrozenSplit`, `scaleFrozenSplit(split, approvedGross)` (parts sum to the cent, remainder in net). `returns/inline-returns.service.ts` passes `refrozenSplit` into the guarded write.

## #3867 `c018adae7` family-import no-op lookup in one query (700)
- `import/product-family-import.service.ts`: one `findMany` per key kind (id, sku, barcode, bare name), same precedence.

## #3807 `5abbefe6f` one option text and derived split (513)
- `packages/pricing/src/unit-options.ts`: `ladderOptionDetail`, `ladderOptionText`, `derivedPackSplit`, `packPiecesSplit`. API: `products/line-units.ts` uses `packPiecesSplit`.

## #3872 `8610870e7` business name saves via branding (B1231)
- `system-config/settings.controller.ts` `PATCH /settings`: `businessName` or `email` in the body is a 400 pointing at `PUT /tenants/me/config/branding`.

## #3871 `5e5d4d275` overdue sweep locks before testing the balance (CM2a)
- `invoices/invoice-balance-sql.ts` `markInvoicesOverdue(tx, ...)`: `SELECT id ... ORDER BY id FOR UPDATE`, then `UPDATE ... WHERE id = ANY(ids) AND <balanceDueSql>`; `db` must be a tx client. `invoices/overdue-sweep.service.ts` wraps it in `tenantTransaction`.

## #3726 `9eab5fec4` excise filing lock, changed-only ledger re-sync (row 632; B297 PR4/PR5, SA-995, SA-997; includes #3782)
- New `regulated/filed-periods.ts` (`lockedFilingsCovering`, `lockFilingRowsCovering` FOR SHARE, `isLockedFiling`, `anyLockedFiling`, `claimFilingLock`, `updateFilingUnlessLocked`, `filedThroughOf`, `findFiledPeriod`); `inventory/stock-write-date.ts` delegates to it. New `regulated/filing-lock.ts`: `assertLedgerRowsNotLocked` (409 `LEDGER_PERIOD_LOCKED`, in every ledger writer), `assertSalesNotLockedForEdit`, `assertOrderEditNotLocked` (409 `FILED_PERIOD_LOCKED`). `regulated/period.ts` `periodEndedForTenant`. `orders/order-edit-payload.ts`: `isDiffPayloadOf`, `takesBuyerDriverReplace`, `editReplacesLines`.
- `POST regulated/filings/:id/lock` (TENANT_ADMIN, addon `tobacco_dealer`, `LockFilingDto`, no unlock) -> `RegulatedFilingService.lockFiling`, `buildFilingFigures`, `prepareFiling`; refusals `FILING_STALE`, `FILING_PERIOD_RUNNING`, `FILING_NOT_LOCKABLE`, `FILING_ALREADY_LOCKED`. `regulated/filing-lock-ready.ts` `FILING_LOCK_READY = false` (409 `FILING_LOCK_NOT_READY`, hard off until W-965). Codes in `common/api-error-codes.ts` and `packages/types/api/error-codes.ts`.
- `regulated/regulated-ledger.service.ts`: `syncInvoiceEntries` writes only what changed (net per item and category); `netHeldByLine`, `deadSaleIdsOf` shared with `reverseInvoiceEntries`. New `invoices/kept-invoice-lines.ts` (`rebuildKeptItems`, `splitKeptItems`) and `invoices/invoice-reminder-email.ts` (`sendReminder`, `resolveRecipientEmail`; #3782 prefactor).

## #3797 `b291c7195` the base row is the factor-1 row (621, SA-971)
- `packages/pricing/src/unit-levels.ts` `baseRow` ignores the name; `namesBase` is the one predicate in `orders/unit-line-edit.ts`, `products/line-units.ts`, `product-units.service.ts`.

## #3870 `b65e46233` a walk-in customer cannot receive store credit (W-913)
- New `credit-notes/walk-in-credit-guard.ts` (`assertCreditCustomerNotWalkIn`, `walkInStoreCreditRefusal`) and `returns/walk-in-return-guard.ts` (`assertWalkInCaptureRefused`): 409 `WALK_IN_STORE_CREDIT_REFUSED`, called first in every credit-note writer, inline capture and auto-apply. `customers/walk-in-protected.ts` `NOT_WALK_IN_WHERE`.

## #3873 `f54a11a98` taxRate over 6 decimals rejected (SA-979)
- New `common/is-tax-rate-fraction.validator.ts` `IsTaxRateFraction` on the invoice and recurring-invoice create DTOs.

## #3779 `e53ba17e5` a standing order is stamped with its target day (B326)
- `order-templates/order-templates.service.ts`: required `targetDay`; a manual run uses the tenant's calendar day; `requestedDeliveryDate = targetDay`.

## #3770 `3a784b137` / #3829 `50cbe2813` / #3841 `e8ba9d062` / #3787 `06df2a5f4`
- #3770 (W-748) `orders/fulfil-path-restrictions.ts`: dead `assertFulfilPathSwitchAllowed` removed.
- #3829 (607) `customers/customer-price-history.service.ts` price summary: fixed `orderBy`, `packFromOwnSplit` recovery, unknown-pack lines skipped.
- #3841 (259, SA-1000) new `orders/order-invoice-delete.ts` `deleteOrderInvoice(tx, invoiceId, tenantId)`: refuses unspent sourced credits, unlinks sourced credit notes, then deletes.
- #3787 (747) `credit-notes/line-credit-headroom.ts`: legacy return term filters `kind: { not: "INLINE" }`.

## #3747 `da919917b` overdue cron cancels through cancelFromStripe (335, SA-934)
- `billing/billing.service.ts`: `suspendOverdueTenants` is now `reconcileCanceledSubscriptions` (`@LeaderCron "billing.reconcileCanceledSubscriptions"`); a Stripe-`canceled` subscription goes through `cancelFromStripe`. Skip kind `"stripe_cancelled"`; `"overdue_suspended"` kept only so old records read.

## #3781 `5871c0dc0` persisted OVERDUE judged in the tenant zone (SA-964)
- `import/import-payment-status.ts` `importPaymentStatus(..., zone)` and `customers/customers.service.ts` credit apply (`statusFromPayments`, zone read before the lock) use `isOverdue(due, now, zone)`.

## #3883 `d2ae41db7` price history last3 carries the sale pack (W-986)
- `customers/customer-price-history.service.ts` `last3[].salePack`; `packages/types/api/price-history.ts` optional `salePack`.

## #3707 `41a998c6e` pre-judge the counter's restriction before the claim (W-774, W-773, W-776)
- `orders/counter-sale/pickup-complete.service.ts`: `judgeFulfilSwitch` runs read-only before the claim; `PickupCompleteDto extends RestrictionAckDto`; `OrdersService.staffSellable`. Closed day found by the pre-check is 409 `COUNTER_COMPLETE_DAY_CLOSED` (nothing changed). Copy in `packages/types/counter-copy.ts`.

## #3761 `d9d40f90c` template orders record Order.source from the author's channel (478)
- `orders/line-author-channel.ts` `orderSourceForChannel` (STAFF is `PHONE`, else `APP`), used by `order-templates.service.ts`.

## #3773 `b32caa759` import: per-row confirm isolation, strict prices (B334, B205)
- `import/migration.service.ts`: `normalizedPrice` (comma-grouped thousands, max 2 decimals), `unitsPerBoxOf` (whole number >= 1); flags `bad-price`, `bad-units-per-box`; a row-level Prisma error (`ROW_LEVEL_PRISMA_CODES`) skips that record with `commit-failed`, the job still confirms.

## #3826 `ccf353b41` stated Item Total 0.00 imports at 0.00 (W-924)
- `import/import.service.ts`: `itemTotal` is `number | null`; `line.itemTotal ?? qty * unitPrice - itemDiscount`.

## #3824 `a73a608d9` refund slip names who made the refund (257)
- `returns/returns.service.ts`: private `refundActorName` (newest refund audit row, then the tenant's user); `findOne(id, viewer?)` adds `refundedBy`, never for a CUSTOMER viewer.

## #3893 `f4380d60c` card reads an unset tenant's real ticks, keeps its model unset (SA-1028)
- `billing/business-capabilities.ts`: `capabilitiesFromInputs` always returns real ticks; `CurrentCapabilities`, `assertCapabilitiesRequested` (400 `BUSINESS_CAPABILITIES_EMPTY` before any read); `ticksToProfileDef` keep rule writes no `fulfilment_model` when Delivery, Shipping, Opens-as are unchanged.
- `billing/feature-config.service.ts` `getState(...)` (hypothetical "after"), `billing/feature-fixtures.ts` `featureConfigOver`; `FeaturePreviewService` reads through them.

## #3834 `c93658333` batched count seeder, progress read, reserved refs (row 562 S1; SA-990, SA-999, B640)
- New `inventory/stock-count-seed.ts` (the one batched `StockCountLine` writer, `COUNT_SEED_BATCH` per short tx under the shared count lock), `inventory/stock-count-progress.ts` `readStockCountProgress` (`GET inventory/stock-counts/:id/progress`), `common/stock-count-seed-state.ts` `stockCountSeedState`; a seeding count cannot commit (409 `STOCK_COUNT_SEEDING`). `common/db-locks.ts` `advisoryXactLocks(tx, family, keys)`.
- New `inventory/reserved-reference.ts` (`isReservedStockReference`, `assertStockReferenceFree`, `IsNotReservedStockReference`): the `STOCK_COUNT-` head is refused on adjustment and purchase references (400 `STOCK_REFERENCE_RESERVED`); legacy one-shot commit with a saved sessionId is 409 `STOCK_COUNT_ID_TAKEN`. New `common/global-validation-pipe.ts` `buildGlobalValidationPipe()` (used by `main.ts`).
- Migration `20261026090000_stock_count_seed_state` (additive): `StockCount.seedPlannedLines`, `seedCompletedAt` + CHECKs. `packages/types/api/stock-count.ts`, `stock-count-commit-copy.ts`.

## #3885 `a7d8c6d76` a card or check retry clears a crashed cash attempt's tendered (638)
- `orders/counter-sale/counter-sale.service.ts`: private `clearStaleCashTendered(orderId)` before any money moves; a failed clear takes no money (`COUNTER_PAYMENT_NOT_RECORDED`).

## Scripts and wording-only
- `apps/api/scripts/`: #3790 `backfill-b294-order-line-taxrate.mjs` (selects by emptiness, holds post-fix lines, SA-960), #3786 `backfill-b297-rate-snapshot.mjs` (refuses a guard sha older than pr3, 360), #3717 `stock-ledger-gap.mjs` (host-TZ `lastMovementAt`, W-781).
- #3877/#3882: `packages/pricing/src/counter-day-close.ts` label "Paid outside the till" (W-862). #3828 `products/tripwire-scan.ts`: receiver-call regex tolerant of `?.` and `!`.
