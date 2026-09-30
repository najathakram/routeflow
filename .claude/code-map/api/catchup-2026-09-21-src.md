# api — catch-up 2026-09-21: src/ changes since c19cb81

> Added + modified `apps/api/src/**` non-test files, c19cb81..b8765689. Signatures only; trust the code over this file. Callers are 1-hop non-spec importers.

### `billing/`
- `config-snapshot-audit.constants.ts` — audit-action strings for config restore + Stripe checkout hook; exports `CONFIG_SNAPSHOT_RESTORED_ACTION`, `CONFIG_SNAPSHOT_RESTORE_FAILED_ACTION`, `STRIPE_CHECKOUT_{APPLIED,STALE,REFUSED,HOOK_FAILED}_ACTION`, `STRIPE_CHECKOUT_ENTITY`.
- `config-snapshot-flag.service.ts` — LIVE platform on/off for snapshot/restore (PlatformConfig row, raw SQL, cached); `ConfigSnapshotFlagService{isEnabled(),setEnabled(b),invalidate()}`; deps PrismaService; used by plan-transition-config.
- `feature-override-audit.constants.ts` — shared audit identity between review job (writer) and `revokeExpired` (reader); `FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION`, `FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE`.
- `feature-override-expiry.job.ts` — nightly sweep revoking expired tenant feature overrides (B569/B589); `FeatureOverrideExpiryJob.revokeExpiredOverrides(): {revoked}`, `FEATURE_OVERRIDE_EXPIRY_REVOKED_ACTION`, `EXPIRED_REVOKE_REASON`; dep FeatureOverrideService; wired in billing.module.
- `plan-transition-config.service.ts` — plan-change hook: snapshot on downgrade, auto-restore on re-upgrade inside the plan tx; `PlanTransitionConfigService{prepare,onPlanChange,transactionOptions,invalidateCaches,planAllowsFor}`, `SnapshotFailedError`, `HOOK_TX_OPTIONS`.
- `tenant-config-snapshot.ts` — PURE snapshot rules (no Prisma/clock/IO); `buildSnapshotPayload(..)`, `parseSnapshotPayload(raw): SnapshotPayload|null`, `planRestore(..): RestorePlan`, `SNAPSHOT_PAYLOAD_VERSION`; types `SnapshotPayload`, `RestoreReport`.
- `tenant-config-snapshot.service.ts` — Prisma shell over the pure rules; `TenantConfigSnapshotService{snapshot,restoreLatest,list,previewRestore,restoreSnapshot}`, `RestoreBudgetExceededError`, `AUTO_RESTORE_{MAX_AGE_DAYS=90,MAX_ROWS,TIME_BUDGET_MS}`, `beyondAutoRestoreHorizon(takenAt,now)`.
- `tenant-config-snapshot-admin.service.ts` — super-admin snapshot list/preview/"Restore now"; `TenantConfigSnapshotAdminService{list(tenantId),preview(tenantId,snapshotId),restoreNow(..)}`, `ADMIN_RESTORE_TX_OPTIONS`; caller platform-admin.controller.
- **Modified:** `billing.service.ts` (+305: checkout runs plan-transition hook, CAS + session dedupe, alarms, bounded tx; #1038/#1063/#1081/#1105/#1110/#1111)
- **Modified:** `billing-webhook.controller.ts` (checkout hook #1038), `billing-notification.service.ts` + `.templates.ts` (checkout-hook alarm mails, B593 #1081)
- **Modified:** `billing-cron.service.ts` (plan hooks, cache invalidation; #1056/#1110), `subscription-mutation.service.ts` (snapshot hook, lock order, tx budget; #1056/#1110)
- **Modified:** `billing.module.ts` (registers snapshot/flag/transition/admin/expiry providers), `feature-config.store.ts` (invalidate after auto-restore commit #1110)
- **Modified:** `feature-override.service.ts` (+157: `revokeExpired` sweep, atomic expiry audit; B569/B578/B589 #965/#987/#998), `feature-override-review.job.ts` (flags review before sweep, stable order #998), `feature-registry.ts` (`flag.units_v1` registered, #947)

### `orders/`
- `buyer-cart-price-check.ts` — RF-198 price-race check lifted verbatim from create(); `assertBuyerCartPricesCurrent({...})` throws 409 with `changedItems`; caller orders.service (#1086).
- `buyer-merge-pricing.ts` — buyer-line pricing/boxed-merge helpers lifted from OrdersService (B585); `isSpecialTier`, `rescaleBogoFreeUnits`, `isBuyerPricedLine`, `mergeBoxedContributions`, `resolveBuyerLinePrice`.
- `credit-limit-guard.ts` — credit-limit guard lifted from OrdersService (B585); `assertWithinCreditLimit(..)`, `isCreditLimitCheckEnabled(deps)`, `creditEnforcementMode(..): OFF|DARK|ENFORCED`, `CREDIT_LIMIT_{ENFORCE,DELIVERY_ENFORCE}_KEY`; deps invoices/credit-exposure, common/ambient-tenant.
- `edit-window.ts` — B63 buyer edit-window rule; `BUYER_EDIT_CLOSED_STATUSES`, `computeEditWindow(..)` (read descriptor + write gate share the list); caller orders.service.
- `line-piece-qty.ts` — RF-4 piece count a per-unit category tax multiplies; `linePieceQty(..)` (boxed selling-unit lines expand by snapshot unitsPerBox).
- `order-cancel-impact.ts` — read-only preview of what cancel does to money (invoice void / credit); `cancelImpact(deps: CancelImpactDeps, id)`.
- `order-edit-restrictions.ts` — selling-restrictions planning around `updateOrderItems` (lane R 2a-7); `orderEditMode(..)`, `planOrderEditRestrictions(..): OrderEditRestrictionPlan`, `EXISTING_LINE_SELECT`; service keeps the `assertLinesSellable` call.
- `order-number.ts` — B587 tenant-sequential `ORD-#####` generator (numeric max, not lexicographic); `parseOrderSeq`, `nextOrderNumber(maxSeq)`, `nextOrderNumberFor(tx, tenantId)`, `ORDER_NUMBER_PREFIX`.
- `order-parsers.ts` — staff-supplied order date/commission parsing; `parseOrderDate(raw, role): Date|undefined` (upper bound = end of current UTC day), `parseCommissionRatePct(..)`.
- `order-stock.ts` — stock bookkeeping lifted verbatim from OrdersService (B585); `decrementStockForSale(deps: OrderStockDeps, ..)`, `settleStockForEdit(..)`; service keeps thin delegators.
- `order-tracking.ts` — order tracking read moved out of the service (#1108); `getOrderTracking(deps:{prisma}, orderId, user: JwtPayload)`; caller orders.service.
- `testing/orders-service-harness.ts` — shared spec harness for OrdersService with permissive mocks; `buildOrdersService()`, `operatorPayload`, `customerPayload`, `buyerPseudoUser`.
- `unit-aware-guard.ts` — units_v1 fail-closed net on paths that rewrite existing lines; `isUnitAwareLine`, `assertNoUnitAwareLines`, `assertOrderEditAllowed`, `assertChangeTargetAllowed`, `assertInvoiceRewriteAllowed`, `UNIT_AWARE_LINE`; callers orders/invoices/change-requests.
- `unit-line-build.ts` — pure builder for one order line sold by a non-pack unit (4b-2); `requestsUnit`, `isUnitAware`, `assertMayUseUnits`, `loadUnitLadders`, `prepareUnitLadders`, `replayLineKey`, `categoryTaxForLine`, `MAX_LINE_QTY`; dep products/line-units.
- **Modified:** `orders.service.ts` (-1089/+249 net: helpers lifted to new files; unit-aware create behind units_v1 #1090; selling-restrictions on live-order edits, dark #1102; delivery credit key split #1099; price history ignores unit lines B606 #1123; tracking move #1108)
- **Modified:** `orders.module.ts` (restrictions choke point in DI, 2a-4 #1041), `orders.controller.ts` (unit guard #970), `change-requests.service.ts` (unit guard + BUYER type #970/#1044)
- **Modified:** `dto/create-order.dto.ts` (optional `unitLabel` per item, staff-only behind units_v1 #1090)

### `product-categories/`
- `product-categories.module.ts` — Nest module for tenant restriction-label categories + per-product label writes; `ProductCategoriesModule`.
- `product-categories.controller.ts` — routes `GET/POST /product-categories`, `PATCH /product-categories/:id`, `GET /products/:productId/labels`, `PUT/DELETE /products/:productId/labels/:categoryId`; reads OPERATOR, writes admin.
- `product-categories.service.ts` — tenant-defined label vocabulary ("Alcohol"-style), separate from TrackedCategory; `ProductCategoriesService{list(includeArchived),create(dto,user),update(..)}`; dep selling-restrictions.core.
- `product-labels-admin.service.ts` — label write side with pinned opt-outs (EXCLUDE needs a reason); `ProductLabelsAdminService{getForProduct(productId),setLabel(..),removeLabel(..)}`; uses product-labels/effective-labels.
- `dto/create-product-category.dto.ts` — `CreateProductCategoryDto`.
- `dto/update-product-category.dto.ts` — `UpdateProductCategoryDto` (archive flag true=hide, false=restore).
- `dto/set-product-label.dto.ts` — `SetProductLabelDto` (mode INCLUDE/EXCLUDE; reason required for EXCLUDE, enforced in service).
- `testing/label-fake-db.ts` — in-memory fake of the four label-side Prisma models that honours real `where` filters incl. tenantId; `LabelFakeDb`, `FakeProduct`, `FakeLabel`, `FakeCategory`.

### `product-labels/`
- `effective-labels.ts` — PURE effective product-label rule shared by read side and the restrictions engine; `computeEffectiveCategoryIds(chain: LabelChainLink[]): Set<string>`, `LabelAssignment`.
- `product-labels.module.ts` — READ-side module; import it to reach `ProductLabelsService.effectiveLabels`.
- `product-labels.service.ts` — batched ancestor-chain label resolution with hop cap; `ProductLabelsService.effectiveLabels(..): EffectiveLabels`, `labelSelect(scalarFields)`; deps PrismaService, common/ambient-tenant.

### `products/`
- `dto/product-unit.dto.ts` — units_v1 level DTOs (explicit null rejected on NOT NULL cols); `CreateProductUnitDto`, `UpdateProductUnitDto`.
- `line-units.ts` — THE one place a line's pack factor is decided (snapshot vs live product); `resolveLineUnits(..): ResolvedLineUnits`, `lineUnitsPerBoxSnapshot(..)`; callers orders.service, unit-line-build.
- `product-units.controller.ts` — `/products/:productId/units` GET/POST/PATCH/DELETE behind `@RequirePlanFlag("flag.units_v1")`; `ProductUnitsController`.
- `product-units.service.ts` — product unit-ladder CRUD, never returns tenantId/audit cols; `ProductUnitsService{list,create,update,remove}`; dep PrismaService.
- `unit-pack-rules.ts` — refuses pack edits (unit/unitsPerBox/section) that would invalidate existing levels; `assertPackKeepsLevelsValid(..)`; caller products.service.
- **Modified:** `products.module.ts` (registers ProductUnits controller/service #947), `products.service.ts` (pack-edit check via unit-pack-rules #947)

### `restrictions-settings/`
- `restrictions-settings.module.ts` — tenant selling-restrictions settings module; Redis-backed per-tenant throttler for the readiness sweep; `RestrictionsSettingsModule`.
- `restrictions-settings.controller.ts` — `GET /settings/restrictions`, `GET .../readiness`, `PATCH /settings/restrictions`; reads OPERATOR, switch/policy/readiness TENANT_ADMIN.
- `restrictions-settings.service.ts` — `RestrictionsSettingsService{get(),readiness(),update(..)}`; `SETTINGS_ENABLE_AND_POLICY_TOGETHER`, `READINESS_LIMITER`, `READINESS_THROTTLE` (5/60s); dep SellingRestrictionsService.
- `update-restrictions-settings.dto.ts` — `UpdateRestrictionsSettingsDto`.

### `selling-restrictions/`
- `selling-restrictions.core.ts` — PURE decision core (no Prisma/Nest/clock); `restrictionChannelForPrincipal(..)`, `offEvaluation()`, `restrictedSummary(lines)`, `UNRESOLVED_STATE`, facts types `RestrictionRuleFacts`, `CustomerAddressFacts`, `ProductFacts`.
- `selling-restrictions.module.ts` — lane R module; line-writing modules import it to reach the choke point (orders wired #1041); `SellingRestrictionsModule`.
- `selling-restrictions.service.ts` — loads facts, applies core; `SellingRestrictionsService{getPolicy,getEnableReadiness,assertReadyToEnable,evaluate,checkLinesSellable,assertLinesSellable(params)}`, `SELLING_RESTRICTIONS_NOT_READY`.
- `order-edit-lines.ts` — PURE: which lines of an order edit need the choke point; `sellableLinesForMergeEdit`, `sellableLinesForReplaceEdit`, `sellableLinesForChangeRequest`, `ReplaceActor`; caller orders/order-edit-restrictions.

### `selling-restrictions-admin/`
- `selling-restrictions-admin.module.ts` — rule admin (list/create/lift); `SellingRestrictionsAdminModule`.
- `selling-restrictions-admin.controller.ts` — `GET /selling-restrictions`, `POST /selling-restrictions`, `POST /selling-restrictions/:id/lift`; reads OPERATOR, writes TENANT_ADMIN.
- `selling-restrictions-admin.service.ts` — `SellingRestrictionsAdminService{list(status?),create(..),lift(..)}`, `restrictionStatus(row, now)`, `statusWhere(..)`, `RESTRICTION_STATUSES`; uses selling-restrictions.core.
- `dto/create-restriction.dto.ts` — `CreateRestrictionDto` (exactly one of categoryId/productId; states required for STATE, absent for FEDERAL).
- `dto/lift-restriction.dto.ts` — `LiftRestrictionDto`.

### `invoices/`
- `credit-exposure.ts` — one credit-exposure derivation (D6/B462); status sets `OPEN_/BACKING_ORDER_STATUSES`, `UNSETTLED_INVOICE_STATUSES`; `orderPaidAmount`, `orderUnsettledOutstanding`, `editedOrderContribution`; callers credit-limit-guard, customers, run-credit-observation.
- `invoice-attachment.ts` — PDF attachment helpers for invoice emails, kept out of invoices.service (size ratchet); `buildInvoiceEmailAttachment(..)`, `invoiceAttachmentFilename(no)`, `MAX_INVOICE_EMAIL_ATTACHMENT_BYTES` (10 MB), `InvoiceEmailAttachment`.
- `manual-invoice-lines.ts` — manual-invoice line builder lifted verbatim from `InvoicesService.create()` (units_v1 4c-1 prefactor, #1095); `buildManualInvoiceLines(..)`.
- `delivered-basis-by-line.ts` — (#1185 rounds 6-7, SA-093a/SA-113b) the ONE evidence-keyed delivered basis for coverage/billing, never `order.status`/`OrderItem.deliveredQty`. `deliveredBasisByLine(db: Prisma.TransactionClient, orderId)` → `DeliveredBasis {hasMutations, byLineId: Map<orderItemId,number>}` from QUALIFYING `DeliveryMutation` rows only — a row qualifies iff `quantityDelivered != null` AND type ∈ DELIVERED/PARTIAL/SUBSTITUTED/REFUSED (REFUSED always contributes 0); ADD_ON rows and any row with a null `quantityDelivered` (incl. the at-door change-request approval's REFUSED-typed REMOVE_ITEM rows, whose `qty` is a signed CR delta, not an absolute amount) are order-change provenance, never evidence. `billableQtyFromBasis(li, basis)` = `min(qty, Σ own evidence)` when `hasMutations`, else unconstrained `qty`. Consumed by `finalize-order-recompute.ts`'s `checkOrderCoverage` + `finalizeOrderRecompute`; B760/B785 (paused) will share it too.
- `order-item-provenance.ts` — provenance validation for an invoice item's `orderItemId`/`productId` against the invoice's own order. `assertOrderItemIdsBelongToOrder(db, orderId, items)` — throws `BadRequestException` on a foreign-order id, a CANCELLED order line, or a client `productId` that disagrees with the order line's stored `productId` (round 7 finding 3, MED). `logSkippedMatches(..)` (round 6) logs a warn, never silent, when a fallback match is skipped (ambiguous product or free-text item).
- **Modified:** `invoices.service.ts` (attachment + line-builder helpers, unit guard; #1008/#1095/#970/#976); `finalize-order-recompute.ts` — `checkOrderCoverage`/`finalizeOrderRecompute` now take `db: Prisma.TransactionClient` (was `any`) and derive billable qty from the shared `DeliveredBasis` above, never order status.
- **Modified:** `invoice-pdf.service.ts` (exports `invoicePdfStorageKey(invoiceId)` so email attach re-reads the rendered PDF #1008), `invoice-status-sets.ts` (standalone drafts out of credit block, D6/B462 #968)

### `customers/`
- `address-state.ts` — derives `stateCode` (+ state) from free-text state and zip at the WRITE boundary; `addressStateFields(..)`; wraps common/us-address-state; callers customers.service, import.service.
- **Modified:** `customers.service.ts` (derive stateCode at every address write #1073; zip-aware resolution, hand copy dropped #1103; credit exposure hardening #968/#994), `customers.controller.ts` (standalone drafts out of credit block #968)

### `common/`
- `ambient-tenant.ts` — refuses acting for a tenant other than the ambient one (no ambient = cron/system OK, L-124); `assertAmbientTenant(..)`; callers product-labels, selling-restrictions, credit-limit-guard.
- `us-states.ts` — API-local MIRROR of `packages/types/api/us-states.ts` (parity-pinned; API can't value-import workspace pkgs); `US_STATES`, `normalizeUsState(input): string|null`.
- `us-state-resolver.ts` — TEXT half of free-text state -> code; port of backfill rules, parity-pinned; `resolveStateText(raw): StateTextResolution|null`, `foldState`, `splitTrailingZipCountry`, `US_STATE_ALIASES`, `AMBIGUOUS_STATE_TEXTS`.
- `us-zip3.ts` — USPS ZIP3 -> state(s) table (multi-state ZIP3 lists all; false conflict OK, false agreement not); `zip3Prefix(zip)`, `zip3States(zip)`, `ZIP3_RANGES`.
- `us-address-state.ts` — address-level resolution combining state text + zip; `resolveAddressState(..): AddressStateVerdict`, `AddressStateReason` (EMPTY|UNPARSEABLE|ZIP_CONFLICT|AMBIGUOUS_NEEDS_ZIP); deps us-state-resolver, us-zip3.
- `testing/smtp-spec.ts` — guards for the SMTP integration lane (`*.smtp.spec.ts`, compose mailpit; fails, never skips, if unreachable); `requireLocalSmtp(env)`, `describeSmtp(name, fn)`, `SmtpTestTarget`.
- **Modified:** `sentry-exception.filter.ts` (lint/format-only change, Lane B step 0 #957)

### `routes/`
- `delivery-lines.util.ts` — refuses a delivery payload before any write: each line must belong to an order on THIS stop and fit ordered qty (#1067); `assertDeliveriesFitStop(..)`; caller routes.service.
- `routes.constants.ts` — shared run/stop select shapes + constants moved from routes.service (#1077); `RUN_LINE_ITEMS_SELECT`, `RUN_STOP_INCLUDE`, `NON_ROUTABLE_ORDER_STATUSES`, `RELEASED_CHANGE_REQUEST_REASON`.
- `run-credit-observation.ts` — background, observation-only log of over-limit customers at run start (B585 #1039); `observeRunCredit(deps: RunCreditObservationDeps, ..)`, `RUN_CREDIT_LOG_CAP` (20); dep invoices/credit-exposure.
- **Modified:** `routes.service.ts` (-117/+38: DRAFT never routable/notified/completed #1069/#1078, reopen never revives cancelled line #1070, delivery-fit check #1067, credit observation #1039, select shapes to constants #1077), `dto/complete-stop.dto.ts` (`quantityDelivered` gets `@Min(0)` #1067)

### `vendor-bills/`
- `po-bill-match.ts` — bill-vs-PO HARD gate (units/PO step 7): a bill may not bill more than the PO; `findPoMatchViolations(..): PoMatchViolation[]`, `assertBillWithinPo(..)`, `PO_LINE_TOLERANCE` (0.01), `PoMatchReason`; caller vendor-bills.service.
- **Modified:** `vendor-bills.service.ts` (+283: link bills to purchase orders, over-billing hard gate #978), `dto/create-vendor-bill.dto.ts` (`purchaseOrderId` link + `createPurchaseOrder` draft-PO-from-bill flag #978)

### `inventory/`
- `dto/update-purchase-order.dto.ts` — edited-PO payload (qty in base pieces, unitCost per piece, item `id` for existing lines); `UpdatePurchaseOrderDto`, `UpdatePurchaseOrderItemDto`.
- **Modified:** `inventory.service.ts` (+666: purchase-order edit with inventory re-apply #966, compensating movements + refuse consumed lots B583 #975, bill-to-PO linkage #978), `inventory.controller.ts` (PO edit endpoint #966)

### `platform-admin/`
- **Modified:** `platform-admin.controller.ts` (+37: config-snapshot admin endpoints via TenantConfigSnapshotAdminService, A2c), `platform-admin.service.ts` (plan-change hook/cache invalidation, snapshot flag; #1056/#1110), `audit-actions.constant.ts` (`CONFIG_SNAPSHOT_RESTORED` action + label)

### `email/`, `import/`, `bookkeeping/`, `buyer/`, `auth/`, `testing/`, root
- **Modified:** `email/email.service.ts` + `email/mailbox/mailbox-send.service.ts` (invoice PDF attached to invoice emails, #1008)
- **Modified:** `import/import.service.ts` (state via customers/address-state #1073/#1103; nested creates carry tenant id, T6 #1128)
- **Modified:** `bookkeeping/bookkeeping.service.ts` (nested creates carry tenantId #1128), `bookkeeping/dto/create-expense.dto.ts` (format-only #957)
- **Modified:** `buyer/buyer.controller.ts` + `auth/jwt-payload.interface.ts` (buyer pseudo-users carry `type: "BUYER"` for the restrictions channel, #1044)
- **Modified:** `app.module.ts` (imports RestrictionsSettings, ProductCategories, SellingRestrictionsAdmin, SellingRestrictions modules; #956/#990/#995/#1000), `instrument.ts` (Sentry release tagged with deployed git sha #1007), `testing/prisma-mock.ts` (`productUnit` model mock #947)
