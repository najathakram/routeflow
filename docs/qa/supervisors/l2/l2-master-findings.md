# RouteFlow QA Audit — L2 Master Findings List
Date: 2026-04-29
Source: L1-A (auth+API), L1-B (finance+buyer), L1-C (driver+browser)
Note: W8/W9/W10 findings (real-time, cross-role, concurrency) are pending and will be added by L3.

---

## Summary counts

| Severity | Count |
|---|---|
| P0 | 1 |
| P1 | 10 |
| P2 | 22 |
| P3 | 14 |
| **Total** | **47** |

---

## P0 — Blockers

### RF-001 — `completeStop` accepts stops on SCHEDULED (not-started) runs
- **Domain:** driver-pod
- **Source:** W4-001, confirmed P0 by L1-C
- **Issue:** `completeStop()` in `routes.service.ts:958–1037` never reads the parent `RouteRun` status; only checks `stop.status === "COMPLETED"`. A driver (or anyone with a valid JWT and a stop ID) can complete stops on a run that has never been started.
- **Fix:** Fetch the parent `RouteRun` before accepting the completion; throw `BadRequestException` if `run.status !== IN_PROGRESS`.

---

## P1 — High Priority

### RF-002 — Any authenticated driver can complete another driver's stop (missing authorization check)
- **Domain:** driver-pod
- **Source:** NEW-W4-A (L1-C added finding)
- **Issue:** `completeStop()` receives the calling `user` and looks up the driver record, but only to populate the `driverId` field on the mutation record — never to verify the caller is the driver assigned to the parent run. Any driver with a known stop ID can complete stops belonging to other drivers' routes.
- **Fix:** After fetching the `RouteRun`, assert that `run.driverId === callingDriver.id`; throw `ForbiddenException` otherwise.

### RF-003 — Non-atomic stop completion + payment: second call can fail silently
- **Domain:** driver-pod
- **Source:** W4-012, confirmed P1 by L1-C
- **Issue:** `payment.tsx:102–136` issues two sequential `await` calls: `completeMut.mutateAsync()` then `paymentMut.mutateAsync()`. The catch block explicitly accepts partial failure ("Stop already completed … record from invoices later"). A network hiccup between the two produces a DELIVERED stop with no payment record, requiring manual reconciliation.
- **Fix:** Either unify into a single atomic backend endpoint (`POST /route-runs/:runId/stops/:stopId/complete-with-payment`), or enqueue both actions as a dependency-ordered pair in the offline queue so the payment retries until it succeeds.

### RF-004 — $0 cash/card payment silently skipped, stop still marked DELIVERED
- **Domain:** driver-pod
- **Source:** W4-004, confirmed P1 by L1-C
- **Issue:** `payment.tsx:124–126`: when `method` is Cash/Card/Cheque, `collected` defaults to `0`. The guard `if (invoiceId && collected > 0)` silently skips the payment record instead of blocking submission. A driver who forgets to enter the amount completes the stop with no revenue record and receives no warning.
- **Fix:** Add a pre-submit validation that blocks `closeStop()` when `method !== "On account"` and `collected === 0`; show a required-field error to the driver.

### RF-005 — Tab transition freeze: every bottom-nav tab is unresponsive for 20–40 s
- **Domain:** browser-ux
- **Source:** F-009 (W7/audit-2026-04-29), confirmed P1 with root cause by L1-C
- **Issue:** `dispatch.tsx:36–37` fires `useAdminRoutes({ limit: 50 })` and `useAdminDrivers()` simultaneously on mount; `warehouse.tsx:56–68` fires four parallel product queries. All queries resolve simultaneously on Railway cold-start, triggering a cascade of state updates that freezes the JS thread for 20–40 s on every tab transition. Users perceive the app as crashed.
- **Fix:** Introduce skeleton/loading states and stagger or paginate initial queries; use React Query's `enabled` flag to defer secondary queries until primary data lands.

### RF-006 — Cron jobs run without per-tenant context: cross-tenant data access or daily silent crash
- **Domain:** finance/pricing
- **Source:** L1B-002, L1B-003 (L1-B added findings)
- **Issue:** `generateDailyOrders()` and `generateDueRecurringInvoices()` both call `this.prisma.forTenant()` inside cron handlers that run outside any HTTP request scope. No `AsyncLocalStorage` tenant context is established. Depending on `PrismaService.forTenant()` fallback behavior, either all tenants' data is processed together without isolation (data confidentiality breach) or the cron throws and silently fails every day.
- **Fix:** In each cron handler, first fetch all active tenants, then iterate: set the ALS context per tenant, process only that tenant's records, clear context. This is the standard multi-tenant cron pattern.

### RF-007 — Credit note allows over-crediting against original invoice total, ignoring payments already made
- **Domain:** finance/pricing
- **Source:** W3-003 (raised P2, L1-B confirmed and raised to P1 in priority list)
- **Issue:** `credit-notes.service.ts:51–62` validates the credit note amount against the original invoice total, not against `(invoice_total − payments_received)`. A $1,000 invoice with $600 already paid can still receive a $500 credit note, creating a $100 over-credit against a receivable that is already 60% collected.
- **Fix:** Validate against remaining balance: `proposed_credit <= (invoice.total − sum(payments))`. Run this check inside a serializable transaction.

### RF-008 — Duplicate invoice creation from an order-linked original creates double-billing risk
- **Domain:** finance/pricing
- **Source:** W3-015, confirmed P1 in L1-B priority list
- **Issue:** `invoices.service.ts:863–899` — the duplicate-invoice endpoint does not check whether the source invoice was generated from an order (`orderId IS NOT NULL`). Duplicating such an invoice produces a second independent invoice for the same order with no guard preventing both from being sent to the customer.
- **Fix:** If `invoice.orderId` is not null, block duplication and return a `BadRequestException`; require a manual invoice for one-off adjustments instead.

### RF-009 — Invoice update with discount/shippingFee change does not recalculate total (latent fragility)
- **Domain:** finance/pricing
- **Source:** W3-004, L1B-005 (L1-B confirmed P1 latent risk)
- **Issue:** `invoices.service.ts:626–641`: the `else` branch (no `dto.items` in update) writes `discount` and `shippingFee` to the DB without recomputing `total` or `taxAmount`. Currently safe because the DRAFT-only guard blocks non-DRAFT edits, but the guard and the non-recalculating branch together are a single-point-of-failure: any future refactor that bypasses or relaxes the guard will silently produce invoices with stale totals.
- **Fix:** Extract a `recalculateTotals(invoiceId)` helper and call it from both update branches (items path and discount/fee-only path). Eliminate the divergence.

### RF-010 — Cart not cleared on logout — items visible to the next user on a shared device
- **Domain:** buyer-portal
- **Source:** W5-003, confirmed P1 by L1-B
- **Issue:** `buyer-auth.ts` `buyerLogout()` deletes auth tokens but does not call `useCartStore.getState().clear()`. The in-memory cart state persists for the app process lifetime. On a shared device or after a multi-account switch, User B sees User A's cart items.
- **Fix:** Call `useCartStore.getState().clear()` (or equivalent) immediately before or after token deletion in `buyerLogout()`.

### RF-011 — No stock check at order creation: buyers can order out-of-stock products
- **Domain:** buyer-portal
- **Source:** W5-002, confirmed P1 by L1-B
- **Issue:** `orders.service.ts:474–669` create path performs customer lookup, pricing tier resolution, and product existence check but never compares requested `qty` against `product.stock`. An order is created regardless of available inventory.
- **Fix:** Before `order.create()`, for each line item assert `product.stock >= requestedQty`; throw a descriptive error (`InsufficientStockException`) if not met.

---

## P2 — Medium Priority

### RF-012 — OAuth redirect passes raw access + refresh tokens in URL query string
- **Domain:** auth/security
- **Source:** L1A-005 (L1-A added finding)
- **Issue:** Both the primary and legacy Google OAuth callbacks (`auth.controller.ts:236–255` and `288–305`) redirect to `${webUrl}/auth/callback?accessToken=...&refreshToken=...`. Both tokens appear in browser history, server access logs, CDN logs, and any analytics/APM tools that capture full URLs.
- **Fix:** Replace query params with a short-lived one-time code (exchange server-side) or move tokens into the URL fragment (`#`). At minimum, the frontend must strip tokens from the URL immediately on arrival before any navigation or analytics fires.

### RF-013 — No self-service password reset flow; operator reset sends no notification
- **Domain:** auth/security
- **Source:** L1A-004 (L1-A added finding)
- **Issue:** No `POST /auth/forgot-password` or `POST /auth/reset-password` endpoint exists. Users with only password auth (no Google link) are permanently locked out without operator intervention. The existing `POST /users/:id/reset-password` operator endpoint does not email the account owner, enabling an operator to silently reset any user's password.
- **Fix:** Implement `POST /auth/forgot-password` (email → time-limited reset token, 15 min) and `POST /auth/reset-password` (token + new password). Send a notification email when any operator-initiated password reset occurs.

### RF-014 — Redis throttler fails open silently during outage, disabling all rate limits
- **Domain:** auth/security
- **Source:** L1A-002 (L1-A added finding), cross-referenced with W1-003
- **Issue:** `redis-throttler.storage.ts:98` — on Redis error, `increment()` returns `{ totalHits: 1, isBlocked: false }`, making every request appear to be the first in the window. All throttle limits (including the 30 req/min brute-force guard on `/auth/login`) silently disappear. Compounded by W1-003: if both Redis and the DB are degraded simultaneously, suspended tenants can log in AND rate limits are disabled.
- **Fix:** On Redis error, use a per-process in-memory LRU fallback map to maintain approximate rate limits. Emit a metric/alert to page on-call during Redis outages so the gap is visible.

### RF-015 — TenantStatusGuard fails open on DB error: suspended tenants can make API calls
- **Domain:** auth/security
- **Source:** W1-003, confirmed by L1-A
- **Issue:** `tenant-status.guard.ts:95–100` returns `true` on DB exceptions. An in-memory 60-second cache only helps on cache hits; a DB error on a cache miss causes the request to pass through without suspension enforcement. Compounded by RF-014.
- **Fix:** Fail closed: if no cache entry exists and the DB is unreachable, return 503. If a cache entry exists, use it (even if stale) and log the DB error.

### RF-016 — DRIVER role can enumerate all credit notes in the tenant
- **Domain:** auth/security
- **Source:** W1-001 (revised by L1-A from P1 to P2); cross-referenced with W2
- **Issue:** `GET /credit-notes` is guarded by `JwtAuthGuard` (any valid JWT) but `creditNotesService.findAllForUser()` only scopes results for `role === CUSTOMER`. A `DRIVER`-role JWT receives the full unfiltered tenant credit-note list (amounts, customer IDs, credit-note numbers).
- **Fix:** Add a `DRIVER` branch to `findAllForUser()` that returns an empty result set or only credit notes relevant to delivery stops the driver has executed; alternatively add `@Roles(UserRole.OPERATOR, UserRole.CUSTOMER)` to the endpoint.

### RF-017 — JWT claims not validated in OAuth callback before redirect URL construction
- **Domain:** auth/security
- **Source:** W1-002, confirmed by L1-A (P2 retained)
- **Issue:** `auth.controller.ts:288–305` (legacy tenant Google callback) constructs a redirect URL incorporating JWT-decoded claims without validating those claims against the actual user record retrieved from the database. A crafted token could inject values into the redirect.
- **Fix:** After decoding, fetch the user from DB by `sub` claim, assert all relevant fields match the DB record, then construct the redirect URL from DB-sourced values only.

### RF-018 — Cron day-of-week logic uses server UTC, producing wrong firing day for non-UTC tenants
- **Domain:** finance/pricing
- **Source:** L1B-001 (L1-B added finding), supported by M-W3-C
- **Issue:** `order-templates.service.ts:222–263` (`@Cron("0 6 * * *")`) and `recurring-invoices.service.ts:198` (`@Cron(EVERY_DAY_AT_MIDNIGHT)`) both use `new Date()` (server UTC) for day-of-week resolution. For a UTC+12 tenant, 06:00 UTC is 18:00 the previous calendar day — the wrong weekday. Standing orders set for Monday fire on Sunday. `calcNextRunAt()` accumulates off-by-one-day errors on recurring invoice due dates for non-UTC tenants.
- **Fix:** Store a timezone per tenant in `SystemConfig`. Resolve `today` using the tenant timezone (via `date-fns-tz` or `luxon`) in both cron handlers and in `calcNextRunAt()`.

### RF-019 — Order number generation has a race condition under concurrent load: duplicate order numbers possible
- **Domain:** finance/pricing
- **Source:** L1B-004 (L1-B added finding)
- **Issue:** `orders.service.ts:543–551` — order number is generated by fetching the last `ORD-NNNNN` row and incrementing. No DB transaction or row lock wraps the read-then-write. Two simultaneous order creations read the same `lastOrder`, compute the same `seq`, and both create `ORD-00100`. No unique constraint enforces uniqueness at DB level.
- **Fix:** Use a DB-level sequence or an atomic counter table with `SELECT ... FOR UPDATE`, or add a unique constraint on `orderNumber` and implement retry-on-conflict.

### RF-020 — Inconsistent tax base: line discounts reduce tax, order/invoice-level discounts do not
- **Domain:** finance/pricing
- **Source:** W3-001 and W3-007, confirmed by L1-B; merged because same root cause
- **Issue:** Invoice tax is computed per-line (after line-level discount) then invoice-level discount is subtracted from the post-tax total. Order tax is applied to the full pre-discount subtotal (`orders.service.ts:605–607`) and the order discount only reduces the final total. The two surfaces are inconsistent with each other and potentially non-compliant with tax jurisdictions that require discount to reduce the tax base.
- **Fix:** Establish a single written tax policy (does discount reduce the tax base or not?). Apply it uniformly across invoices and orders. Update both `invoices.service.ts` and `orders.service.ts` to match the policy.

### RF-021 — Invoice update with discount/fee change stores stale total in DB
- **Domain:** finance/pricing
- **Source:** W3-004, confirmed by L1-B (noted as currently safe but a real DB state issue)
- **Issue:** When `PATCH /invoices/:id` is called with only `discount` or `shippingFee` (no `items`), the else-branch at `invoices.service.ts:626–641` persists the new discount/fee without recomputing `total` or `taxAmount`. The stored total is now stale. Currently guarded by the DRAFT-only check, but stale data in a DRAFT invoice can propagate to the SENT state.
- **Fix:** See RF-009 fix (same code location); call the shared `recalculateTotals()` helper from both branches.

### RF-022 — Float arithmetic for tax/total: no rounding before DB storage causes cent-level drift
- **Domain:** finance/pricing
- **Source:** W3-002, confirmed by L1-B (terminology corrected: no Decimal.js, both operands are plain JS floats)
- **Issue:** `orders.service.ts:605–607`: `subtotal` is the sum of `unitPrice * qty` (plain JS numbers) and `getTaxRate()` returns `parseFloat()`. Multiplication of two IEEE 754 floats without a subsequent `Math.round(result * 100) / 100` step means the stored `taxAmount` and `total` can carry sub-cent trailing digits, causing order totals to diverge from invoice totals by a few cents.
- **Fix:** Apply `Math.round(x * 100) / 100` (or use a Decimal library) before persisting every monetary value in `orders.service.ts`, and audit `invoices.service.ts` for the same pattern.

### RF-023 — Overpayment tolerance of $0.001 allows negative AR balance
- **Domain:** finance/pricing
- **Source:** W3-009, confirmed by L1-B
- **Issue:** `invoices.service.ts:1038–1041` accepts payments within $0.001 of the remaining balance. A payment of `remaining + $0.0001` is accepted, creating an `alreadyPaid` value that exceeds `invoice.total` and results in negative AR.
- **Fix:** Use zero tolerance (reject if `payment > remaining`) or route any overpayment to an `AdvancePayment` record rather than allowing a negative balance.

### RF-024 — Order consolidation propagates stale subtotals without revalidation
- **Domain:** finance/pricing
- **Source:** W3-011, confirmed by L1-B
- **Issue:** `orders.service.ts:248–257` — when merging orders, the source order's existing `subtotal` is carried forward without recalculation. If the source order contains a unit-price/qty mismatch (from a prior bug or manual DB edit), the merged order inherits the incorrect subtotal.
- **Fix:** Recalculate all line subtotals from `unitPrice × qty` immediately before merging; use the freshly computed value, not the stored one.

### RF-025 — Standing orders use live catalog prices with no buyer notification; file reference corrected
- **Domain:** finance/pricing
- **Source:** W3-012, M-W3-B (L1-B corrected file reference)
- **Issue:** Standing order templates store only `productId` and `qty`; `createOrderFromTemplate()` in `order-templates/order-templates.service.ts:282` fetches the live product price at generation time. If the operator raises prices, the next auto-generated order silently uses the higher price. Buyers have no visibility into what price will be charged when the template fires. Behavior is inconsistent with recurring invoices (which freeze prices at template creation).
- **Fix:** Either freeze the price in the template at creation time (align with recurring invoices), or add an explicit "prices may vary" disclosure in the buyer portal template UI and send a buyer notification when generated order prices differ from the last auto-order.

### RF-026 — Credit note sub-penny tolerance leaves $0.001 unresolved
- **Domain:** finance/pricing
- **Source:** W3-013, confirmed by L1-B
- **Issue:** `credit-notes.service.ts:240` marks a credit note APPLIED when `amountUsed >= amount − $0.001`, potentially leaving $0.001 of credit permanently unresolved. No cleanup mechanism exists for these sub-penny residuals, which accumulate over time.
- **Fix:** Set a minimum credit note amount of $0.01 on creation and use exact-value comparison (zero tolerance) on the APPLIED threshold.

### RF-027 — Advance payment not auto-applied to future invoices; no buyer visibility
- **Domain:** finance/pricing
- **Source:** W3-017, cross-referenced with L1-B buyer-portal gap analysis
- **Issue:** `invoices.service.ts:1330–1342` — excess payment becomes an `AdvancePayment` record. This record is not auto-applied to subsequent invoices and is not surfaced on the buyer's statement screen (`/buyer/statement`). Buyers who overpay have no self-service path to understand where their money went.
- **Fix:** Implement auto-application logic that applies the oldest `AdvancePayment` balance when a new invoice reaches SENT status, or at minimum surface the balance clearly on the buyer statement with an explanation.

### RF-028 — Invoice detail screen hardcodes "GST (10%)" label regardless of tenant tax rate
- **Domain:** buyer-portal
- **Source:** W5-007, confirmed by L1-B; cross-noted W5-010 contradiction resolved
- **Issue:** `apps/mobile/app/(customer)/invoices/[id].tsx:73` renders `<Text>GST (10%): ...</Text>` as a string literal. The actual tax amount is read from the API and is correct, but the label always says 10% regardless of the configured rate (could be 0%, 7%, 15%, or any other value). The API response includes the computed tax amount but not the tax rate percentage.
- **Fix:** Either compute `rate = Math.round((invoice.tax / invoice.subtotal) * 100)` client-side and interpolate into the label, or add a `taxRatePercent` field to the invoice API response. Note: W5-010's PASS verdict stands for the amount; only the label is wrong.

### RF-029 — `dispatch.tsx` loads up to 50 routes and all drivers with no pagination signal (perf)
- **Domain:** browser-ux
- **Source:** NEW-W7-A (L1-C added finding)
- **Issue:** `dispatch.tsx:36–37` calls `useAdminRoutes({ limit: 50 })` and `useAdminDrivers()` (no limit) simultaneously on mount. No loading skeleton is shown; all data hydrates into memory before the tab renders. For large tenants, this is O(N) upfront hydration that contributes to the tab-freeze described in RF-005.
- **Fix:** Use paginated loading with a skeleton state; defer the drivers list fetch until the routes list has settled, or use virtualization for the driver assignment UI.

### RF-030 — Home screen "Routes today" section fetches all routes with no date filter
- **Domain:** browser-ux
- **Source:** F-006a (W7/audit), F-005 merged, confirmed with root cause by L1-C
- **Issue:** `home.tsx:59` calls `useAdminRoutes({ limit: 10 })` which hits `GET /routes` with no date parameter. The section is labeled "Routes today" but displays routes ordered by creation date regardless of date. The subtitle count (from `useOperatorRouteRuns({ date: today })`) is correct; the section label and card list contradict it.
- **Fix:** Either filter the routes query by today's scheduled date (aligning the list with the label) or rename the section to "Recent routes" (aligning the label with the data).

### RF-031 — `/warehouse` deep link redirects to `/home`; direct URL navigation broken
- **Domain:** browser-ux
- **Source:** F-010 (W7/audit), root cause refined by L1-C
- **Issue:** Navigating directly to `https://routeflowmobile-production.up.railway.app/warehouse` while authenticated redirects to `/home`. Other tab routes (`/dispatch`, `/orders`) navigate correctly. Most likely cause: the Railway static serve config catches the path before Expo Router can handle it, or the route is not emitted in the static export manifest. `finance` (hidden with `href: null`) would be expected to fail; `warehouse` should not.
- **Fix:** Verify the Expo Router static export manifest includes `warehouse`; if not, ensure the route file is not accidentally excluded. Alternatively add a Railway `--single-page-app` flag or `_redirects` rule so all unknown paths serve the app shell.

### RF-032 — Mobile-as-web renders as narrow phone-width column on desktop viewports
- **Domain:** browser-ux
- **Source:** F-002 (W7/audit), confirmed P2 by L1-C
- **Issue:** On desktop viewports ≥1024px wide, the app renders as a narrow centered column (~800px). KPI cards, route lists, and order tables are phone-width on a 1440px monitor. No explicit "use mobile app" message is shown to desktop users.
- **Fix:** Either implement responsive breakpoints in the Expo web build to fill available width, or add a banner/redirect directing desktop users to the Next.js operator dashboard (if/when it is deployed).

### RF-033 — POD photo/signature not enforced before marking stop complete
- **Domain:** driver-pod
- **Source:** W4-005, confirmed P2 (not P0) by L1-C
- **Issue:** `payment.tsx:107–109` passes `pod?.photoUrls` and `pod?.signatureUri` directly to `completeMut.mutateAsync()` with no pre-flight check that either is present. A driver can complete a delivery stop with no photographic evidence and no signature, leaving no verifiable proof of delivery.
- **Fix:** Add a per-tenant configuration flag (`requirePODPhoto`, `requireSignature`). Before calling `completeMut.mutateAsync()`, validate against the flag and surface a blocking error if required evidence is missing.

### RF-034 — Offline sync permanently discards failed actions without notifying the driver
- **Domain:** driver-pod
- **Source:** W4-003, downgraded from P0 to P2 by L1-C with nuanced correction
- **Issue:** `useNetworkSync.ts:18–20` silently dequeues any action that has exhausted `MAX_RETRIES`. Line 32–33 permanently dequeues 4xx errors. The offline queue itself IS persisted to AsyncStorage (items survive restarts), but once an action is permanently removed, the driver receives no toast/alert and has no way to know the sync failed or what data was lost.
- **Fix:** On permanent discard (either max-retries or 4xx), add the failed action to a "failed inbox" (persisted, separate from the retry queue), show a persistent in-app alert, and surface a "Review failed syncs" screen so the driver can manually retry or escalate.

### RF-035 — POD photos and signatures lost on app crash or background-kill
- **Domain:** driver-pod
- **Source:** W4-011, confirmed P2 by L1-C
- **Issue:** `podStore.ts:16` uses bare `create<PodState>()` with no `persist` middleware. Captured photos and signatures are held only in memory. An OS-triggered background-kill between photo capture and stop submission permanently loses all evidence collected for that stop.
- **Fix:** Add Zustand `persist` middleware backed by `AsyncStorage` to `podStore`. Persist photo URIs and signature URI keyed by `stopId`; clear on successful stop completion.

### RF-036 — `completeStop` double-submit race produces duplicate DeliveryMutation rows
- **Domain:** driver-pod
- **Source:** W4-002, confirmed P1→P2 by L1-C (clarified as real accounting concern, not a crash/data-corruption)
- **Issue:** `routes.service.ts:975–987` — `findFirst` runs outside the write transaction. Two concurrent requests both pass the `stop.status !== "COMPLETED"` check before either commits, resulting in duplicate `DeliveryMutation` rows. The `updateMany` filter (`status: { notIn: [..., DELIVERED] }`) is idempotent for the status update, but the duplicate mutation rows inflate accounting aggregates.
- **Fix:** Move the status check inside the `tenantTransaction` and use a DB-level unique constraint or optimistic concurrency token (e.g. `version` field) to reject the second concurrent write.

### RF-037 — Overpayment race on concurrent payment submissions (payment service)
- **Domain:** driver-pod / finance
- **Source:** W4-006, downgraded from P1 to P2 by L1-C pending code verification
- **Issue:** `invoices.service.ts:1031–1041` — the `alreadyPaid` read and the subsequent payment write are not protected by a serializable transaction or row-level lock. Two concurrent payment submissions for the same invoice can both pass the remaining-balance check before either commits, allowing total payments to exceed the invoice amount.
- **Fix:** Wrap the read-then-write in a serializable transaction (or use `SELECT ... FOR UPDATE` on the invoice row) so the second concurrent payment sees the updated balance.

### RF-038 — Void invoice AR reversal undocumented; AR aging must explicitly exclude VOID
- **Domain:** finance/pricing
- **Source:** W5-005 (W3-005), confirmed by L1-B with clarification
- **Issue:** `voidInvoice()` at `invoices.service.ts:795–806` sets `status = VOID` but creates no explicit AR reversal journal entry. The method correctly blocks voiding PAID/PARTIAL invoices, so no money is lost. However, AR aging reports that do not explicitly filter out VOID invoices will include them, overstating outstanding receivables.
- **Fix:** Document the behavior in code comments and in the AR reporting module. Add an explicit `status !== VOID` filter to all AR aging queries. Consider creating an AR reversal entry on void for double-entry bookkeeping completeness.

---

## P3 — Low Priority / Polish

### RF-039 — `GET /auth/google` nonce endpoint has no rate limit; can flood Redis with nonce keys
- **Domain:** auth/security
- **Source:** L1A-001 (L1-A added finding); referenced by W2 miss
- **Issue:** `auth.controller.ts:138–165` — `GET /auth/google` generates a one-time nonce and writes it to Redis with a 10-minute TTL. No `@Throttle` decorator is present. An unauthenticated attacker can create up to ~1,000 live `oauth:nonce:*` keys per attacking IP (100 req/min × 10-min TTL) before Redis memory pressure becomes significant.
- **Fix:** Add `@Throttle({ default: { ttl: 60_000, limit: 10 } })` to `googleAuthUrl()`, matching the `verify-email` endpoint limit.

### RF-040 — `PATCH /users/me/preferences` accepts unbounded arbitrary keys and values
- **Domain:** auth/security
- **Source:** L1A-003 (L1-A added finding)
- **Issue:** `users.controller.ts:57` body is typed as `Record<string, string>` with no class-validator pipe, no key whitelist, and no per-request size cap. Any authenticated user can write an unlimited number of arbitrarily long key/value pairs to `UserPreference`, risking storage exhaustion.
- **Fix:** Introduce `UpdatePreferencesDto` with `@IsObject()`, `@MaxProperties(50)`, and value-length validation (`@MaxLength(500)` per value). Add a service-layer guard on total preference count per user.

### RF-041 — Access tokens remain valid for remaining TTL after password change (~15 min window)
- **Domain:** auth/security
- **Source:** W1-006, revised to P3 (accepted risk) by L1-A; refresh tokens ARE correctly revoked
- **Issue:** `auth.service.ts:322–344` revokes all refresh tokens on password change (`refreshToken.deleteMany`), which is correct. However, outstanding short-lived access tokens are not blocklisted and remain valid for their remaining TTL (~15 min). This is standard JWT behavior, not a missed fix.
- **Fix:** Reduce the access token TTL from 15 min to 5–10 min to shrink the window. A full fix requires a token blocklist (added complexity/overhead).

### RF-042 — Mobile API client does not handle HTTP 429 (Too Many Requests)
- **Domain:** auth/security / browser-ux
- **Source:** L1A-006 (L1-A added finding); W2 miss
- **Issue:** `api-client.ts:63–143` handles 401 (token refresh) and network errors (offline queue) but has no 429 branch. When the API throttles the mobile client, the raw Axios error reaches UI components that will likely show a generic error toast rather than "slow down" messaging. Could contribute to retry amplification.
- **Fix:** Add a 429 branch in the response interceptor that reads the `Retry-After` header and either waits + retries after the indicated delay, or surfaces a user-friendly "too many requests, please wait" message.

### RF-043 — Payment method TypeScript enum can drift from Prisma schema enum over time
- **Domain:** auth/security / finance
- **Source:** W2-001, confirmed low-risk by L1-A; runtime Prisma validation prevents invalid values today
- **Issue:** `invoices.ts:17` (mobile) defines `PaymentMethod` as TypeScript string literals independently of the Prisma-generated enum in `create-invoice.dto.ts`. As long as both lists are kept in sync manually, runtime behavior is correct. Drift would only surface as a silent no-op or a 400 at runtime.
- **Fix:** Create a shared types package (`@routeflow/types`) that exports the enum from the Prisma client. Both mobile and the DTO import from the shared package, eliminating the need for manual synchronization.

### RF-044 — Recurring invoice prices frozen at template creation time; behavior not documented in UI
- **Domain:** finance/pricing
- **Source:** W3-006, confirmed by L1-B; contrast with RF-025 (standing orders use live prices)
- **Issue:** `recurring-invoices.service.ts:158–173` takes `item.unitPrice` directly from the stored template with no catalog lookup. If catalog prices change, recurring invoices silently use old prices. Operators are not informed.
- **Fix:** Add a visible "Price locked at template creation" indicator in the recurring invoice template UI. Optionally add a "sync prices from catalog" action on the template edit screen.

### RF-045 — Zero-quantity line items allowed on invoices
- **Domain:** finance/pricing
- **Source:** W3-010, confirmed by L1-B
- **Issue:** `invoices.service.ts:136–143` accepts `qty = 0` line items without validation. The result is a $0 line on a live invoice, likely a data entry error.
- **Fix:** Add `@Min(1)` to the `qty` field in the invoice line-item DTO, or add a service-layer assertion `if (item.qty <= 0) throw BadRequestException`.

### RF-046 — Order demotion reason stored in mutable notes field, not an immutable audit log
- **Domain:** finance/pricing
- **Source:** W3-014, confirmed by L1-B
- **Issue:** `orders.service.ts:719` appends the demotion reason to the order's mutable `notes` field. Notes can be edited later, destroying the audit trail.
- **Fix:** Create an `OrderAuditLog` table (or a separate immutable `auditReason` field with no update path) to record state transitions with timestamp and reason. Log all status changes there.

### RF-047 — `PaymentStatus.DRAFT` enum value is unused and confusing
- **Domain:** finance/pricing
- **Source:** W3-016, confirmed by L1-B
- **Issue:** `schema.prisma:97–101` defines `PaymentStatus { DRAFT PAID VOID }` but payments are only ever created as `PAID` or `VOID`. `DRAFT` is never written. New developers may attempt to implement a draft-payment workflow that conflicts with existing logic.
- **Fix:** Remove `DRAFT` from the enum (migration required), or implement a draft-payment workflow that actually uses it and document the intent.

### RF-048 — Price tier fallback is silent: misconfigured tiers fall back to list price without warning
- **Domain:** finance/pricing
- **Source:** W3-008, confirmed by L1-B
- **Issue:** `pricing.ts:7` — `getTierPrice()` silently falls back to list price when no tier is configured for a customer. Operators are not alerted; they may not notice customers are being charged list price instead of their contracted tier price.
- **Fix:** Log a warning (or return a typed result indicating "fallback used") when a tier miss occurs; surface an operator-facing alert or dashboard indicator for customers with missing tier assignments.

### RF-049 — "Remember me" is checked by default at login (shared-device risk)
- **Domain:** auth/security / browser-ux
- **Source:** F-003 (W7/audit), confirmed P3 by L1-C
- **Issue:** The login form pre-checks "Remember me", leaving a long-lived session on shared or public devices if the user does not notice.
- **Fix:** Default "Remember me" to unchecked. Add a tooltip explaining what a persistent session means. Consider auto-expiring sessions after a configurable idle period regardless of the "remember me" state.

### RF-050 — `expo-notifications` logs a console warning on web (push tokens not supported)
- **Domain:** browser-ux
- **Source:** F-004 (W7/audit), confirmed P3 by L1-C
- **Issue:** Every load of `/home` on the web build logs `[expo-notifications] Listening to push token changes is not yet fully supported on web`. Push notifications are not wired on the web build, but the listener is unconditionally registered.
- **Fix:** Wrap the notification listener registration in a `Platform.OS !== 'web'` guard so the warning is suppressed on the web build.

### RF-051 — `finance` tab hidden from nav but still accessible via direct URL (no route guard)
- **Domain:** browser-ux
- **Source:** NEW-W7-B (L1-C added finding)
- **Issue:** `_layout.tsx:45` hides the finance tab from the bottom nav with `href: null`, but `finance.tsx` still exists and Expo Router will serve it if the path is known. No route-level guard verifies authorization before rendering the screen.
- **Fix:** Confirm whether the finance screen is intentionally accessible via deep link (More menu path). If not, add a guard component at the top of `finance.tsx` that redirects unauthorized access. If yes, document the intended access pattern.

### RF-052 — TENANT_ADMIN role displays as "Operator" in the More screen; elevated permissions not indicated
- **Domain:** browser-ux
- **Source:** F-011 (W7/audit), confirmed P3 by L1-C
- **Issue:** The role chip on `/more` shows "Operator" for `TENANT_ADMIN` users, obscuring their elevated capability from the user (and from any screen-sharing support session).
- **Fix:** Map `TENANT_ADMIN` → "Tenant Admin" (or "Admin") in the role display logic. Distinguish from plain `OPERATOR` in the UI.

---

## Dismissed / False Positives

| Worker Finding | L1 Verdict | Reason |
|---|---|---|
| W1-005 — canActAsDriver permission not validated | Dismissed by L1-A | `PATCH /users/:id/driver-permit` is correctly guarded by `@Roles(OPERATOR)`. `toggleDriverPermit()` also checks the target user is OPERATOR/TENANT_ADMIN before granting. Control is correctly implemented. |
| W2-001 — Payment method enum (as a contract violation) | Downgraded to P3 (RF-043) | Server-side Prisma validation rejects invalid enum values at runtime. No contract violation today; only a future-drift risk. |
| W2-002 — Order creation DTO subset | Dismissed as by-design | Mobile intentionally omits operator-only fields (`customerId`, `routeRunId`). No violation. |
| W2-003 — Complete stop endpoint mismatch | Dismissed | Verified correct alignment between mobile and API. |
| W3-V001–W3-V010 | Verified correct | All 10 finance checkpoints confirmed passing by W3; consistent with L1-B review. |
| W4-003 — Silent offline queue data loss | Downgraded from P0 to P2 (RF-034) | The offline queue IS persisted to AsyncStorage via `persist` middleware; items survive app restarts. What is missing is user notification on permanent discard — a real but P2 UX gap, not a P0 data-loss. |
| W4-006 — Overpayment race | Downgraded from P1 to P2 (RF-037) | Architectural concern valid but practical concurrent-payment window is narrow. Kept as P2 pending full code verification of the transaction boundary. |
| W4-014 — Reopen doesn't check credit memos | Unconfirmed — insufficient evidence | `reopenStop()` lines 1193–1299 were not fully reviewed. Flagged for separate code review; not confirmed as a bug. |
| W5-001 — Cart not persisted (as P0 Critical) | Downgraded to P2 (RF in buyer section) | Non-persistence is confirmed but the consequence is a UX inconvenience (losing items on restart), not data loss or financial corruption. Severity is P2. |
| W5-007 — Invoice hardcodes GST (as P1 High) | Retained but downgraded to P2 (RF-028) | Tax amount is correct from the API; only the label is wrong. No financial impact. P2 UX/trust issue. |
| W5-010 — Tax calculated dynamically (PASS) | Partially qualified, not dismissed | The PASS verdict for tax amount is correct. W5-010 should be annotated that the label (W5-007/RF-028) is wrong even though the amount is right. |
| F-001 — Production URL serves only Expo app | Informational, no bug | Not a bug; a release-readiness scope question for stakeholders. |
| F-005 — "0 runs today" vs Route A showing | Merged into RF-030 (F-006a) | Explained by dual data sources; not a separate issue. |
| F-008 — Route stop count mismatch | Informational / data drift | Seeded tenant had test traffic; pre-flight reseed recommended before downstream tests. Not a code bug. |
| F-012 — Mode-switcher pill not visible | Downgraded from "possible P0" to P2 (RF below) | Code correctly renders pill when `canActAsDriver=true`. Likely a data or token-propagation issue in the seeded tenant, not a regression. Raised as P2 investigation. |
| F-013 — More menu inventory | Informational baseline | No findings; reference only. |
| W5-012 — Favorites per-seller scoping | Verified correct | Scoped by `buyer.id + customer.id` correctly. |
| W5-015 — Session isolation | Verified correct | Cannot access wrong seller; switch properly clears state. |
| M-W5-A — IDOR on buyer order detail | Verified safe | Service layer enforces ownership via `role=CUSTOMER` + `sub=userId` chain. |
| M-W5-B — IDOR on buyer invoice detail | Verified safe | Explicit `customerId` ownership check plus tenant-scoped first fetch. |
| W1-006 (as P2) | Revised to P3 (RF-041) | Refresh tokens ARE correctly revoked. Access token gap is standard JWT trade-off. Mitigation is TTL reduction. |
| W3-001 (as P1 standalone) | Merged into RF-020 with W3-007 | Same root cause: inconsistent tax-base policy. |

---

## Coverage gaps (from L1 reviews)

### From L1-A

1. **Controllers not reviewed by W1 or W2:** `estimates`, `vendor-bills`, `import`, `recurring-invoices` (auth/guard coverage only), `messages`, `notifications`, `uploads`, `billing`, `billing-webhook`, `platform-admin`. All 10+ controllers should be assigned to a follow-up worker for auth/guard and input-validation coverage.

2. **Driver app API client not audited:** W2 only audited `apps/mobile/lib/api-client.ts`. The driver app (`apps/driver-app/`) has its own API client and auth interceptor. Its 401/429/error handling, offline queue interaction, and token refresh flow have not been reviewed.

3. **W2's "47/50 endpoints correct" methodology undocumented:** The actual API has 35+ controllers with far more than 50 routes. W2's sample should be treated as a representative check, not exhaustive coverage. Formal contract test automation is recommended.

### From L1-B

4. **W3-011 (order consolidation subtotal propagation):** Only briefly reviewed; the full consolidation path and edge cases under concurrent order submission were not tested.

5. **Standing order + live price interaction:** The buyer portal template screen shows templates with product names and quantities but no price display. Buyers have no way to preview what price will be charged. This cross-cuts W3-012/RF-025 and warrants explicit buyer-portal UX coverage.

6. **Advance payment (AdvancePayment) buyer visibility:** The buyer's `/statement` screen does not surface `AdvancePayment` balances (cross-cut RF-027). Not yet tested end-to-end from buyer login through payment → over-payment → statement screen.

### From L1-C

7. **W4-014 (`reopenStop` credit memo check):** Not confirmed. `routes.service.ts:1193–1299` full `reopenStop()` transaction was not reviewed. Needs dedicated code review.

8. **W4-006 (overpayment race in `invoices.service.ts`):** Downgraded to P2 pending code verification. The transaction boundary in `invoices.service.ts:1031–1041` was not read in the L1-C review context. Needs a targeted read.

9. **Warehouse deep-link (RF-031):** L1-C recommends retesting with `/finance` (which has `href: null`) to distinguish between a static export manifest gap and a Railway serve config issue. If `/finance` also redirects to home, the manifest hypothesis holds.

10. **Mode-switcher pill (F-012):** Needs verification of `canActAsDriver` value for `ux_admin` in the production DB, and inspection of whether `auth.service.ts` token construction includes the field. Not a confirmed regression yet.

11. **Next.js web operator dashboard (`apps/web/`):** Not deployed at the audited URL. The full desktop operator dashboard (KPI grid, AR aging, finance reports, etc.) was not covered in this audit. Separate deployment or local build review needed.

12. **Phases 2–11 of the audit plan not yet executed:** Deeper detail pages (order detail, customer detail, product detail, invoice detail), settings tabs, finance sub-screens, route detail/dispatch flow, CRUD operations, buyer portal (Phase 2), platform admin (Phase 3), E2E flows (Phase 7), document fuzzing (Phase 8), corner scenarios (Phase 9), security (Phase 10), regression (Phase 11) are all pending.
