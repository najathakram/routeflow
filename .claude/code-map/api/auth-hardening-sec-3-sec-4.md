# api — Auth hardening SEC-3/SEC-4 + batch log

> Split from `.claude/code-map/api.md` (verbatim, lines 2257-2482) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Auth hardening — SEC-3/SEC-4 (2026-07-16, branch deferred-items-validation)

- **F5-003** — staff refresh tokens carry `type:"staff"` (auth.service login/refresh/mintSessionForUser + google-oauth issueUserTokenPair), buyer `type:"buyer"` (buyer-auth + google-oauth issueBuyerTokenPair). Each refresh handler rejects a present-but-wrong `type` BEFORE the per-table hash lookup; an ABSENT type (legacy pre-change token) is allowed (grace) so live sessions aren't force-logged-out.
- **SEC-4 (F11-002 safe-partial)** — staff login + refresh ALSO set an `httpOnly, Secure, SameSite=Lax, Path=/api/v1/auth` `rf_refresh` cookie (maxAge from token exp); `/auth/refresh` reads the cookie first, falls back to the body (mobile), `RefreshDto.refreshToken` now optional; logout clears it. Purely additive (body token still returned) — currently STAGED/inert (the web client is a separate origin without `credentials:'include'`, so the browser won't send it yet); no cookie-parser (hand-parsed from `req.headers.cookie`). Buyer flow unchanged.
- **F12-005** — mobile Google deep-link binds a 256-bit device nonce (SecureStore `rf:oauth:pendingState`) threaded through the OAuth `state` blob and echoed on the `routeflow://` redirect; `google-callback.tsx` rejects a callback whose `state` doesn't match, and (review fix) clears the one-time nonce ONLY on a successful match so an unsolicited link can't wipe a pending login's nonce. Runtime-unvalidated (no mobile Google flow in post-deploy-check) — logic/unit-tested only.
- **RF-4 review refinements** — `recomputeLineCategoryTaxes` fetches product `unitsPerBox` (fallback for selling-unit boxed lines that snapshot `unitsPerBox:null`) to keep per-unit category tax stable across edits; `tracked-categories.service` rejects `priceIncludesTax=true` + rate>0 (tax-inclusive pricing not yet folded correctly).

### Batch 2026-07-23 (PRs #308–#311)

- **Image compression everywhere (#308)** — `storage/compress.util.ts` now the single choke point; alpha-aware image branch (opaque→JPEG q80, transparent PNG/WebP→preserve alpha) + PDF passthrough, resize ≤1600px. Applied at the 3 previously-raw upload paths: `products.service.ts` `uploadImage`, `customers.service.ts` `uploadTaxDocument`, `tenants.service.ts` `uploadLogo`; `bookkeeping.service.ts` `uploadExpenseReceipt` refactored off its inline sharp block onto the util. Vendor-bill/batch scans unchanged (OCR-in-memory, never stored).
- **Payment image attachment (#309, migration `add_payment_image`)** — `InvoicePayment` gains `imageKey/imageOriginalName/imageMimeType` (String?). New `InvoicesController` routes `POST|GET|DELETE /invoices/payments/:paymentId/image` (OPERATOR, `FileInterceptor`, 10MB), service `uploadPaymentImage`/`getPaymentImageUrl`/`deletePaymentImage` (StorageService injected; compress util; **group anchor** `paymentGroupId ?? id` → key `payments/<anchor>/image.jpg`, `updateMany` across the group so every allocation row sees it). `recordPayment` returns `createdPaymentId` (deferred client upload). `deletePayment` best-effort `storage.delete` post-commit only when no sibling still references the key. Driver `complete-with-payment` returns `paymentIds` so the at-door screen can attach.
- **Case/Unit dual SKU (#310, migration `add_product_unit_sku`)** — `Product.unitSku String?` (nullable, `@@unique([tenantId, unitSku])` + `@@index`; NULL = "same as case sku", read-time fallback). `findByBarcode` widened to OR-match barcode/sku/unitSku with deterministic rank (barcode>sku>unitSku) — all `/products/barcode/:code` callers resolve either code, no client change. `findAll` search OR + create/update collision checks include unitSku. Invoice PDF prints the unit code via new pure `invoices/invoice-item-code.ts` `invoiceItemCode(p)=unitSku??barcode??sku`. Vendor-bill matcher + catalog select include unitSku. Tobacco/statement docs unchanged.

### Batch 2026-08-10 — forgiving scanned-code matching

- **`common/barcode-normalize.ts` (new, mirrored to `apps/mobile/lib/barcode-normalize.ts`)** —
  `normalizeScanCode(raw): string[]` returns an ORDERED candidate list (literal → uppercase →
  alnum-stripped → for all-digit codes: UPC-E→UPC-A, UPC-A→EAN-13, EAN-13→UPC-A, GTIN-14 unwrap,
  leading-zero strip, and check-digit-stripped LAST because an 11-digit prefix can collide with an
  unrelated SKU). Deduped, capped at `MAX_SCAN_CANDIDATES = 10` (typical 3-6). Also exports
  `upcEToUpcA` (4-branch expansion, number systems 0/1 only) and `pickBestScanMatch(rows,
candidates)` — earlier candidate wins, then barcode > sku > unitSku, ties on `id` so the answer
  never flips. Spec `common/barcode-normalize.spec.ts`.
  **Why:** iOS AVFoundation has no UPC-A symbology, so an iPhone reports a UPC-A label as a
  13-digit EAN-13 with a leading zero while the web decoders report 12 digits — a catalogue seeded
  from one source never matched a scan from the other. That was a large share of the field's
  "item not found" reports.
- **`products.service.ts` `findByBarcode` — now two tiers.** Tier 1 is
  `OR: [{barcode:{in:candidates}}, {sku:{in}}, {unitSku:{in}}]`, riding
  `@@unique([tenantId, barcode|sku|unitSku])` as a BitmapOr of index scans (≤30 probes). Tier 2
  runs **only on a miss**: the same query with `mode: "insensitive"` and `take: 25`. ILIKE can't
  use the btree, so tier 2 seq-scans within the tenant — acceptable because it only runs where we
  used to return a hard 404, and digit-only camera scans never reach it (it exists for typed or
  lowercased alpha SKUs). Blank code throws without querying. Winner via `pickBestScanMatch`.
  Fixes every client at once — mobile web, native and desktop — with no client change.
  Escape hatch if tier 2 ever shows up in profiling: a raw-SQL `UPPER()` expression index (the
  repo already ships raw-SQL partial indexes).

### Backfill — PR #422 payment-terms model (map predated it; entries missing until now)

- **`Invoice.paymentTermsLabel`** (structured Net-N label — NEVER `Invoice.terms`, which stays
  free-text T&C) **+ `depositPercent`/`depositDueDate`**, **`Customer.defaultPaymentTerms`**,
  `Supplier.defaultTerms`, `VendorBill.termsLabel` — migration `20260902000000_payment_terms`
  (additive). **THE INVARIANT:** every path that derives a `dueDate` from a terms string persists
  that string as `paymentTermsLabel` — label and arithmetic can never disagree; a hand-edited due
  date clears the label (falls to the server's null branch) on the create page, the sale flow,
  order-generated invoices, and both web + mobile split screens.
- **Invoice settings KV (`system-config/settings.controller.ts` `GET/PATCH /settings/invoice`)** —
  `invoice.defaultTerms` (see resolveDefaultTerms below) + **`invoice.hideOriginalPrice`
  (2026-08-26, client request)**: boolean stored as `"true"`/`"false"` in SystemConfig,
  returned as a real boolean; when true the WEB invoice document renders only the net unit
  price on SPECIAL/DISCOUNTED/PROMO lines (no strike/badge — display-only, server PDF never
  showed the struck price anyway). DTO `UpdateInvoiceSettingsDto.hideOriginalPrice`.
- **`invoices.service.ts` `resolveDefaultTerms(customerId?): {terms, dueDays}`** — the customer's
  own `defaultPaymentTerms` (when set) wins over the tenant `SystemConfig` default
  (`invoice.defaultTerms`, falls back to "Net 30"); `TERM_DAYS[terms] ?? 30` maps the label to a
  day count. Called by every from-order invoice path (`createInvoiceFromOrder`,
  `createInvoiceFromOrderWithTenant`, `createPartialFromOrder`) and by the "New sale" flow.
- **Deposit v1 (50% up front / 50% on terms)** — `depositAmount` is DERIVED at read time
  (`roundMoney(total * depositPercent / 100)`), never stored; `depositOverdue` is a derived flag.
  `recomputeStatus`/AR-aging are BYTE-UNTOUCHED by the deposit fields. **2026-08-26 batch-d
  (deposit v2 — "X% at order placement"):** tenant policy keys
  `invoice.depositDefaultPercent` + `invoice.depositCollectAtOrder` (SystemConfig, via
  GET/PATCH /settings/invoice); `resolveDefaultTerms` returns `effectiveDepositPercent`
  (customer SET wins — >0 = theirs, 0 = explicit opt-out; null inherits tenant);
  `createInvoiceFromOrder` uses the effective percent and, when the collect-at-order flag is
  on + order not DELIVERED, ISSUES the fresh mirror via `send(id, {allowPreDelivery:true})`
  — a NARROW escape hatch on `assertOrderInvoiceUnlocked` used ONLY there (every other send
  path still blocks pre-delivery mirrors); `reconcileOrderDraftInvoice` now also syncs a
  SENT/VIEWED/PARTIAL/OVERDUE deposit-mirror (guards: sole non-void invoice of the order,
  `depositPercent != null`, order not DELIVERED/CANCELLED; payments + dueDate/depositDueDate
  preserved, status recomputed) — ⚠️ regulated SEPARATE_INVOICE split + deposit deliberately
  NO-OPs on edit-reconcile (delivery-time rebuild trues up). PDF renders "Deposit due"/
  "Remainder due" rows after Total; the send-email path adds a deposit banner
  (`email.service.ts buildInvoiceEmail` `depositAmount/depositDueDate` optional params —
  reminder path intentionally without). All render-paths null-guarded: no deposit ⇒
  byte-identical output. **Review-fix pass:** `revertLinkedInvoicesForOrderEdit` EXEMPTS a
  deposit mirror (deposit + sole-non-void + order not DELIVERED/CANCELLED — the exact set the
  widened reconcile rebuilds) so a pre-delivery edit can never un-issue it; delivery with no
  open draft runs `rebuildSiblingDrafts(…,"delivered",{preserveStatus:true})` against a sole
  deposit invoice (incl. PAID — short-delivery restates, overpayment → credit notes) via
  `rebuildIssuedDepositMirrorOnDelivery`; widened reconcile re-syncs commission + emits
  invoice-updated; issuance gated `created.length===1 && !txClient`;
  `createInvoiceFromOrderWithTenant` (fire-and-forget regular orders) resolves the tenant
  percent by captured tenantId and issues via an INLINE `status:SENT,sentAt` flip
  (notification-less by design — no request context); `createPartialFromOrder` resolves
  effective percent, never issues.
- **Narrow `PATCH /invoices/:id/terms`** — corrects `dueDate`/`paymentTermsLabel`/`reference`/
  `subject` on any status except VOID/WRITTEN_OFF, re-runs `recomputeStatus`, leaves an
  `internalNotes` breadcrumb (same convention as `applyPriceAdjustment`); spec pins that it never
  back-syncs the linked order.
- Renders on: web invoice detail/edit, `CreateBillModal` terms dropdown (prefilled from the
  supplier's `defaultTerms`), the invoice PDF, the invoice email, the buyer portal, and both
  mobile invoice-detail screens. Null label renders nothing (historical invoices predate the
  column).

### 2026-08-25 — customer-feedback batch (deposit defaults, due-soon chips, dead reopen, shipment gating)

- **`Customer.defaultDepositPercent Decimal? @db.Decimal(5,2)`** (migration
  `20260905000000_customer_deposit_default`, additive) — a per-customer default deposit percent
  ("50% upfront, remainder on terms"); `null` = no default. Read/write via
  `create`/`updateCustomer` (`customers.service.ts`) same `!== undefined` spread pattern as
  `defaultPaymentTerms`; `null` clears it.
- **`resolveDefaultTerms(customerId?)` now also returns `customerDepositPercent: number | null`**
  (off the SAME customer row — no extra query) — signature is now
  `Promise<{terms, dueDays, customerDepositPercent}>`. All three from-order invoice paths
  (`createInvoiceFromOrder`, `createInvoiceFromOrderWithTenant`, `createPartialFromOrder`) build a
  `depositFields` object: an explicit caller-supplied `overrides.depositPercent` (or, on
  `createPartialFromOrder`, `dto.depositPercent`) always wins and is never clobbered; otherwise a
  positive `customerDepositPercent` auto-applies `{depositPercent, depositDueDate: issueDate}`. A
  customer with no default leaves `depositFields` an empty object, so `extraInvoiceData` is
  byte-identical to before this change (spec-pinned in `invoices.service.spec.ts`).
  `computeDepositFields`/`recomputeStatus` are untouched — nothing derived is stored here.
- **`ListInvoicesDto` gained `dueFrom?`/`dueTo?` (`@IsDateString`)** — server-side due-date window
  filter for the web "Due today / Due tomorrow / Next 7 days" chips; composes with the existing
  `statuses` (plural) param so a due-window query only surfaces unissued/unpaid invoices
  (SENT/VIEWED/PARTIAL/OVERDUE), reusing the list's pre-existing status-filtering mechanism rather
  than inventing a new one. `findAll`'s where-builder translates it into `where.dueDate`
  (`gte`/`lte`) beside the `dateFrom`/`dateTo` → `issueDate` block: `dueTo` widens to end-of-day
  (`setHours(23,59,59,999)`) exactly like `dateTo`, and the clause **merges into** any `dueDate`
  the `isOverdue` branch already set (`{lt: now}`) so the two intersect instead of clobbering.
- **`customers.service.ts deleteAddress(id, addrId)`** (new, `DELETE :id/addresses/:addrId`,
  OPERATOR) — 404s if the address isn't found under that customer; 409s
  (`ConflictException`) if a **`RouteStop`** or **`RouteRunStop`** references it
  (`customerAddressId`) — both checked, both tenant-scoped via `forTenant()` — so deleting doesn't
  orphan a live route stop. On delete, if the removed address was `isDefault`, promotes the
  oldest remaining address (`orderBy: createdAt asc`) to `isDefault: true` inside the same
  `tenantTransaction`, so exactly one address (or zero) is ever primary.
- **BUG-ORD-01, web parity** — DELIVERED orders never had a legal reopen transition server-side
  (`DELIVERED: []` in the status transition map always 400'd); web's order-detail page used to
  still render a "Reopen Order" button here anyway (dead affordance). Removed — mirrors mobile's
  `order-actions.ts`, which never showed it. Only a CANCELLED order can be reopened, via the
  dedicated `/reopen` endpoint; `OUT_FOR_DELIVERY`'s "Return to Confirmed" demotion is untouched.
- **Shipment card gating (web + mobile, orders + invoices)** — the carrier-shipment card/section
  now renders ONLY when `order.fulfillPath === "SHIP"` or the row already carries
  `shippingCarrier`/`shippingTrackingNumber` (historical data), instead of unconditionally on
  every order/invoice. `/shipments` list itself is unchanged.
- **Stale comment fixed** in `findAll`: it claimed `@Min(1)` blocks external `limit=0`; the DTO is
  `@Min(0)`. Bounding that for external callers is a separate hardening change (web pickers pass
  500/1000 and `BuyerCatalogService` uses 0 internally).

### 2026-09-09 — Train 2 push-preference gate + archived-product guard (B04/B142, #682, `7d8141e0`)

- **`notifications.service.ts`** — new private `isPushEnabled(userId): Promise<boolean>` reads
  `UserPreference` (`userId_key: {userId, key: "pushEnabled"}`); missing row reads as ENABLED
  (opt-out), only an explicit `"false"` disables. `registerToken(userId, token, platform)` no-ops
  (skips the `deviceToken.upsert`) when disabled, so a stale client can't re-enable delivery just
  by re-registering (B04/REG-B04-D). `sendToUser(userId, payload): Promise<number>` checks the
  gate BEFORE the token lookup — a disabled user's tokens are never even read (REG-B04-C).
  Mirrors mobile's `lib/notification-prefs.ts` (see [`mobile.md`](mobile.md)), which is the
  client-side convenience only; this gate is the authoritative one.
- **`orders.service.ts`** — `create(dto, options?: { skipAutoMerge?, allowArchived? })` (`:1678`)
  rejects a NEW order carrying an archived product line (`isActive === false`) UNLESS
  `options.allowArchived` is set; staff create and buyer `createOrder` both reject
  (REG-B142-E/F), the one exemption is the driver change-request draft path
  (`ChangeRequestsService.approve` → `create(..., { allowArchived: true })`, which drafts a
  NEXT_DELIVERY order for a product the customer already has on an existing — possibly since
  archived — line). `updateOrderItems(orderId, dto, user?)` (`:3069`) applies the same guard only
  to `addProductIds` (a NEW line, no `item.id`) — a qty/price edit or removal of a line already on
  the order never reaches `addProductIds`, so an already-archived line already on the order keeps
  working. Both throw `BadRequestException` naming the SKU/name.
- **`recurring-invoices.service.ts`** — deliberately the OPPOSITE policy: private
  `buildArchivedItemsNote(productIds): Promise<string | null>` (`:206`) NEVER blocks generation —
  a rejection inside `invoicesService.create()` here would silently stall a scheduled billing
  cycle — it instead appends a one-line note (`"Note: <sku(s)> {is|are} archived; billed as
scheduled."`) to the generated invoice when the template references an archived product. Same
  batch-paths-bill-regardless carve-out applies to estimate→invoice convert and templates apply
  (not individually mapped here) — only the interactive create/edit edges above reject.
- Registry: F20 (B04, B142; B151 already proven via #555) proved on #682 and discharged to done
  in this follow-up — see [`mobile.md`](mobile.md) for the client-side train-1/train-2 pieces and
  F19's discharge (#681).

### 2026-09-11/12 — CRM: GoHighLevel lead-handoff connector (new module, `crm_gohighlevel` add-on, dark)

- **`crm/crm.types.ts`** — re-exports `CrmConnectionStatus`/`CrmTriggerMode`/`CrmHandoffStatus`
  from `@prisma/client` for the module's internal type-only imports.
- **`crm/crm-identity.ts`** — pure matching/normalization helpers: `normalizeEmail(raw)`,
  `normalizePhoneE164(raw, region)` (never returns a raw phone — E.164 or `null`),
  `slugUsername(name)` (3-30 char slug for a new customer's username).
- **`crm/gohighlevel/gohighlevel.client.ts`** — `CrmAuthError`/`CrmRateLimitError`/`CrmHttpError`;
  request/response interfaces (`GoHighLevelClientCreds`, `SearchOpportunitiesParams`,
  `GhlOpportunity`, `GhlOpportunitySearchResponse`, `GhlContact`, `GhlCustomField`, `GhlTag`,
  `GhlPipelineStage`, `GhlPipeline`); every request carries the GHL API `Version` header (T6).
- **`crm/crm.module.ts`** (#703, 2026-09-12) — `imports` now carries `BillingModule` (provider/exporter of `AddonService`+`AddonGuard`); without it the per-handler `@UseGuards(AddonGuard)` in `crm.controller.ts` threw `UnknownDependenciesException` at boot (prod 502, W16). Guard: **`common/addon-guard-module-import.spec.ts`** — repo-truth: every `*.controller.ts` referencing `AddonGuard` must be registered by a module whose `imports` include `BillingModule` (walks `src/`, matches `controllers: [...]`; L-115).
- **`crm/crm-connection.service.ts`** — `CrmConnectionService`: `getStatus(tenantId)` (never
  selects `secretCipher` — T41), `saveConnection(tenantId, dto, userId)` (AES-256-GCM-encrypts
  the token — never stores raw, R1), `testConnection(tenantId, userId)` (R2),
  `disconnect(tenantId, userId)`, `updateConfig(tenantId, dto, userId)`,
  `listPipelines(tenantId)`, `listHandoffs(tenantId, dto)`.
- **`crm/dto/{save-crm-connection,update-crm-config,list-handoffs}.dto.ts`** —
  `SaveCrmConnectionDto` (`token`, `locationId`), `UpdateCrmConfigDto` (`enabled`, `dryRun`,
  `triggerMode`, `pipelineId`, `stageId`, `stageName`, `startFrom`, `writeBackFields`,
  `writeBackTag`, …), `ListHandoffsDto` (status/pagination filters for `GET .../handoffs`).
- **`crm/crm.controller.ts`** — `CrmController` (`@Controller("crm/gohighlevel")`, JWT + OPERATOR
  role + per-handler `@UseGuards(AddonGuard) @RequireAddon("crm_gohighlevel")`): `GET /`,
  `PATCH /connection`, `POST /connection/test`, `DELETE /connection`, `PATCH /config`,
  `GET /pipelines`, `GET /handoffs`. (Note: `addon-gate-registry.ts`'s `crm_gohighlevel.routes`
  and `apps/web/lib/api/crm.ts` also reference `POST /sync`,
  `POST/GET /handoffs/:id/{retry,dismiss}`, and `POST /import-existing{,/preview}` — those are
  NOT yet routes on this controller as of WP5; `gohighlevel-poll.service.ts` has the
  `retryHandoff`/`dismissHandoff`/`pollTenant` service methods a future controller pass would
  wire up.)
- **`crm/gohighlevel/gohighlevel-poll.service.ts`** — `GoHighLevelPollService`: `pollAll()` (the
  `@LeaderCron("*/3 * * * *", "crm.pollAll")` entry point, one tenant's failure never blocks
  another — see `crm.module.ts`), `pollTenant(tenantId, opts)` (50-page/120s budget, 10s
  per-call timeout, cutoff enforced unless `opts.ignoreCutoff` — R11, T15),
  `retryHandoff(id)`, `dismissHandoff(id)`; `CrmSyncCounts`/`ImportPreviewResult` result shapes.
- **`crm/gohighlevel/gohighlevel-handoff.service.ts`** — `GoHighLevelHandoffService`:
  `matchExistingCustomer(contact, region)` (precedence ref \u2192 email \u2192 phone \u2192 name,
  T22-T25), `handle(...)` (create-or-link + write-back orchestration, `dryRun` short-circuits
  before any customer or GHL write \u2014 R21).
- **`crm/gohighlevel/gohighlevel-writeback.service.ts`** — `GoHighLevelWritebackService`:
  `ensureCustomFields(connection)`, `writeBack(...)` (idempotent: full-overwrite custom-field
  PUT \u2014 T34 \u2014 idempotent tag assignment, `noteWritten` guard), `nextAttemptAt(attempts, now)`
  (retry backoff schedule, R20).
- **`crm/crm.module.ts`** — `CrmModule`; wires the controller + services, registers the
  `crm.pollAll` `@LeaderCron` job (see `common/no-bare-cron.spec.ts` for the bare-`@Cron` ban this
  must satisfy) and the once-per-transition `NEEDS_ATTENTION` operator email (R12).
- **`billing/addon-gate-registry.ts`** — new `crm_gohighlevel` entry, `state: "dark"`, `added:
"2026-09-11"`, `reviewBy: "2027-03-11"`; grant path is Platform Admin → Tenants → add-ons.
- **`scripts/crm-gohighlevel-check.mjs`** (repo-root `apps/api/scripts/`, WP5) — manual-only
  sandbox check, never in a gate: logs in, saves+tests a connection against
  `GHL_SANDBOX_TOKEN`/`GHL_SANDBOX_LOCATION_ID`, lists pipelines, then polls
  `GET /handoffs` for up to `CRM_CHECK_POLL_TIMEOUT_MS` waiting for the cron poller to record a
  row. `assertTestTenant()`-gated (`SMOKE_TENANT_SLUG` default `test`); prints the resolved host
  before any call (L-074).
