# web — Routes (part 3 of 3): (platform-admin), buyer, (marketing), Top-level

> Split from `.claude/code-map/web.md` (verbatim, lines 797-902) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

### `(platform-admin)/` — super-admin panel (role-guarded)

- `admin/dashboard/page.tsx` — platform stats (tenants, users, plans, MRR).
  - **MRR ledger-reconciled card (2026-09-16, house-tenant MRR verify):** `PlatformStats` drops
    `estMrrUsd` for `mrr`/`ledgerMrr` (two figures from one server computation, not a client
    estimate); `usd()` now renders 2 decimal places (was 0). New `MrrCard` renders `mrr` as the
    headline (`data-testid="dashboard-mrr"`) with "Reconciled to ledger: {ledgerMrr}"
    (`data-testid="dashboard-ledger-mrr"`) underneath, plus an amber "differs by {gap}" note
    when the two round to different cents — mirrors `admin/billing/page.tsx`'s MRR-unavailable
    discipline (never show a client-estimated number). The old "Plan Distribution" card's
    "Est. MRR" chip is removed (MrrCard is now the one MRR surface on this page). Test:
    `page.test.tsx` (new). E2E: `e2e/47-house-tenant-mrr-verify.spec.ts` (new, post-deploy —
    verifies the house/demo tenant's MRR reconciles against the ledger in prod).
- `admin/tenants/page.tsx`, `new/page.tsx`, `[id]/page.tsx` (edit plan, trial, suspend, impersonate, audit). **B525 (#902, 2026-09-19) — the entire legacy `AVAILABLE_ADDONS` toggle UI is DELETED** from `AddonsTab` (the `Addon` interface, `fetchAddons`/`toggleAddon`/`toggleError` state, the enable-modal JSX, the whole `activeKeys`-driven card grid) — `EnableAddonModal.tsx`'s "Enable as add-on" action (below) is now the ONLY way to create a real `TenantAddon` row; `AVAILABLE_ADDONS` itself was already emptied to `[]` (B508, prior batch) so this just removes the now-dead scaffolding around an array that could never render a card.
  - **`_features/EnableAddonModal.tsx` — Feature Console "Enable as add-on" action (B2b, 2026-09-17):**
    the console's per-row "Customise" button (`FeatureConsole.tsx`, opens `FeatureOverridesSection`)
    only ever writes an unbilled COMP `TenantFeatureOverride` — this modal is the ONE UI that can create a real, Stripe-billed
    `TenantAddon` row via `POST .../addons/enable` (the legacy `AVAILABLE_ADDONS` toggle grid that used to be the other one is deleted, B525 above). A new "Enable as add-on" button appears beside
    "Customise" on rows in `FeatureConsole.tsx`'s exported `ADDON_ROW_KEY_BY_REGISTRY_KEY` map
    (registry key -> the legacy `addonKey` the endpoint expects — NOT always the same string):
    `tobacco_dealer`/`driver_payments`/`recurring_routes`/`order_delivery`/`ocr`/`developer_mode`
    (identity mapping) plus `flag.msrp` -> `msrp` and `flag.sales_agents` -> `sales_agents` (review
    catch: those two `RequirePlanFlag` rows' SERVER gate would be satisfied by a feature-override,
    but their web UI reads `useHasAddon()` — `apps/web/lib/api/tobacco.ts`, backed by
    `TenantAddon.addonKey` rows only — so an override alone leaves the MSRP price field / sales-agents
    nav hidden). Mirrors `LEGACY_ADDON_KEY_TO_SKU` in `apps/api/src/billing/plan-catalog.constants.ts`
    — update both together; pinned exact-contents test in `FeatureConsole.test.tsx`. The modal
    (`EnableAddonModal.tsx`) always posts to `/addons/enable`, never `/feature-overrides`: it reads
    `GET .../billing`'s `stripeConfigured` flag (`fetchTenantBillingInfo`, `lib/platform-admin/
features.ts`) to offer a Stripe-price-or-free-grant choice (no silent default — Continue stays
    disabled until one is picked) when configured, or states a free grant when not; two-step
    confirm names the tenant and states whether a Stripe subscription item will be created.
    `enableTenantAddon` (`lib/platform-admin/features.ts`) is the same `EnableAddonDto` shape the
    legacy toggle posted. No new endpoint/model. Tests: `EnableAddonModal.test.tsx`,
    `FeatureConsole.test.tsx`, `features.test.ts`.
    **B519 (#899/#910, 2026-09-19):** `FeatureConsole.tsx` gained a local `checkRequires(requires, effectiveKeys)`/`describeUnmetRequirement()` pair (hand-kept web twin of `feature-registry.ts`'s server pair, B524) computing an `unmetRequirement?: string` per row, passed into `EnableAddonModal`'s new `unmetRequirement?` prop; when set, the modal shows an amber warning + a required "I understand and want to enable it anyway" checkbox gating Confirm, and sends `acknowledgeUnmetRequires` through `enableTenantAddon()` to the same DTO field B524 enforces server-side (see `feature-modules-4/billing.md`).
  - **`new/page.tsx`'s Plan `<select>` is catalog-driven, filtered to `PLAN_KEYS` (Phase 0 T14, REG-743-F1, 2026-09-15)** — options come from `fetchPlanCatalog()` (sorted by `sortOrder`, labeled via `planLabel`), but only rows whose `planKey` is a `PLAN_KEYS` member (`@routeflow/types`) are offered: the server's `create-tenant.dto.ts` validates `@IsIn(PLAN_KEYS)`, so an unfiltered legacy/off-catalog row (e.g. a future `TEAM`/`BUSINESS`) would 400 on submit. A failed fetch or a catalog with zero `PLAN_KEYS`-eligible rows falls back to rendering all of `PLAN_KEYS` (not a single option) so every plan the server accepts stays reachable; `form.plan` resets to the first eligible catalog row when the default (`STARTER`) isn't in it. Spec: `page.test.tsx`'s T14 describe + its `REG-743-F1` cases (extra non-`PLAN_KEYS` catalog row excluded; catalog with no eligible row falls back to exactly `PLAN_KEYS`).
- **`_components/AdminTabs.tsx` — B559 (#925, 2026-09-19), mobile overflow.** A plain `flex` row of 5 tabs has no room at 390px — no wrap + the browser default `min-width:auto` on each flex-item button refuses to shrink below combined min-content width (~621px), blowing out `(platform-admin)/layout.tsx`'s `<main className="flex-1 overflow-y-auto">` shell into a second, invisible-until-scrolled horizontal scroll container. Fixed by scrolling the strip itself: `overflow-x-auto` on the row + `shrink-0 whitespace-nowrap` on each trigger (house pattern, same as `customers/[id]/page.tsx`'s `Tabs.List`). Same fix applied to `admin/buyers/[id]/page.tsx`'s inline profile/sellers tab strip (identical defect class, not componentized).
- **`_components/AdminBadge.tsx` — GROWTH/SCALE plan colors (2026-09-16):** `PLAN_COLORS`/
  `PLAN_LABELS` gain `GROWTH` (teal, "Growth") and `SCALE` (indigo, "Scale") entries alongside
  existing STARTER/PROFESSIONAL/ENTERPRISE — the two mid-tier plans the catalog-driven
  `tenants/new/page.tsx` picker (above) can now offer. Test: `AdminBadge.test.tsx` (new).
- **`_components/AdminModal.tsx` — dialog a11y (2026-09-17, PR #836 review follow-up):** the
  shared modal used across every platform-admin surface (tenant detail, feature console,
  override drawers) gains `role="dialog"`/`aria-modal="true"` on the panel (`panelRef`,
  `tabIndex={-1}` fallback focus target), a Tab/Shift-Tab focus trap scoped to
  `FOCUSABLE_SELECTOR` matches inside the panel, initial focus to the panel's first focusable
  element (its own close button, since header renders first) on open, and focus restoration to
  the pre-open `document.activeElement` (`triggerRef`) on close/unmount — all inside the existing
  `open`-gated `useEffect` alongside the prior Escape handler; `open`/`onClose`/`title`/`children`/
  `footer` props and visuals unchanged. Test: `AdminModal.test.tsx` (new — role/aria-modal,
  initial focus, Tab/Shift-Tab wrap, focus-restore-on-close).
- `admin/buyers/page.tsx` + `[id]/page.tsx`; `admin/buyers/merge-requests/page.tsx` + `[id]/page.tsx`.
- `admin/plans/page.tsx`, `admin/billing/page.tsx`, `admin/audit-logs/page.tsx`, `admin/{profile,settings}/page.tsx` — settings' AI usage panel (`AiUsage` type off `GET /platform-admin/ai-config/usage`) shows OCR scans / Forecast runs / **Route insights (`insightRuns`, 2026-08-28 — populated now that `recordAiUsage` is wired server-side)** / tokens / est. spend / error rate.
  - **`admin/billing/page.tsx`'s MRR card (REG-743-F1, review round #3, 2026-09-15)** — fetches `GET /billing/admin/mrr` (`MrrService.computeOverview()`, `mrr.service.ts`) as its ONE MRR source; on failure the card shows **"MRR unavailable"**, never a number. A prior client-side `PLAN_PRICES` fallback estimate (a second pricing engine) is DELETED — it could show a free pilot at full list price. Three warning chips (`unpricedActiveTenants`/`zeroPricedActiveTenants`/`activeWithoutSubscription`) render when nonzero; "Active Subscriptions" shows `payingTenants` as its subtext so the two figures are never side by side unexplained. Test: `page.test.tsx` (asserts no dollar figure renders on API error).

### `buyer/` — buyer portal (multi-seller B2B)

- **Auth:** `login/page.tsx`, `register/page.tsx`, `change-password/page.tsx`, `invite/[token]/page.tsx` (**2026-08-26:** `handleAccept` awaits `refreshSellers()` after a successful accept — register→accept→portal is all soft navigation under ONE BuyerAuthProvider whose sellers list was seeded `[]` at registration, so without the refetch a freshly-linked buyer landed on "No sellers connected yet" until a hard reload; e2e BSD-01 caught it), `verify-merge/page.tsx`, `forgot-password/page.tsx`,
  `reset-password/page.tsx`, `verify-email/page.tsx`. **Sign-in redesign (2026-09-08, PR #663):**
  all 8 buyer auth pages now render through the shared `AuthShell` (`components/auth/`, see
  "Components & shared"), on the SAME link utility the operator `/login` "Forgot password?" link
  uses (`#0b6e6b`, 6.07:1 — the old buyer pages used a separate emerald palette at 3.77:1);
  `invite/[token]/page.tsx` and `verify-merge/page.tsx` gained state-derived `AuthShell` titles
  (invalid/accepted/idle, and verifying/verified/failed respectively) — logic byte-identical,
  chrome only.
- **Portal (`portal/[seller]/`):** `page.tsx` (landing), `shop/page.tsx` (browse/cart), `cart/page.tsx` (checkout → order), `dashboard/page.tsx`, `orders/page.tsx` + `[id]/page.tsx` (**WP2, R5.9:** per-line `li.notes` rendered under the qty/price line when present) (+ **P5-10** "Request a change" modal on dispatched orders (run `IN_PROGRESS`; no prices shown by design) → `POST /buyer/orders/:id/change-requests`; CR status chips PENDING/APPROVED/DECLINED from `order.changeRequests`; buyer `canEdit` now honors `editWindow`), `invoices/page.tsx` + `[id]/page.tsx` (PDF; **WP2, R5.8:** per-line `item.notes` rendered under the description cell when present; **check lifecycle (P5-12)**: badge rendering now imports the shared **`lib/check-badge.ts`** `checkBadgeFor` helper [extracted verbatim in P5-14 — was local to this file; CHECK-only, manually-voided-not-bounced ⇒ no badge, Bounced ⇒ danger + struck amount + optional NSF line; also consumed by `payments/page.tsx`; **post-dated check payments PR-1 (2026-09-15)**: `status==="PENDING"` now short-circuits BEFORE the checkStatus switch to a `{label:"Post-dated · pending", variant:"warning"}` badge — both buyer-portal pages inherit it for free since they call this shared function, not a local copy; test: `lib/check-badge.test.ts` (new)], Balance Due (B421 fix, 2026-09-15: was `status!=="VOID"` with no method filter — a DRAFT row counted as paid AND a CREDIT_NOTE/ADVANCE application counted as cash; now prefers the server's own `paidAmount`/`balanceDue`/`creditApplied`/`advanceApplied` [`findOne` already returned these, only this page's type/usage was stale] via the shared `@routeflow/pricing` `resolveConfirmedAmounts`, falling back to a correct PAID-only split; RTL-tested in `page.b421-balance.test.tsx`), payment date now reads `p.paidAt ?? p.createdAt` [fixes a prior always-"N/A" bug from a never-returned `recordedAt` field]; `lib/api/buyer.ts` `BuyerInvoiceDetail.payments[]` += `status?/checkStatus?/nsfFeeAmount?/paidAt?/createdAt?`, dropped `recordedAt`; `useBuyerNotifications.ts` now also invalidates `["buyer","invoice"]` on `invoice.updated` so the badge/balance goes live, not just a notification), `templates/page.tsx`, `favorites/page.tsx`, `finances/page.tsx` (**P5-13 wallet**: `lib/api/buyer.ts` += `BuyerStatement`/`BuyerStatementTransaction` types + `useBuyerStatement()` (`GET /buyer/statement`); fifth `StatCard` "Store Credit" (`icon=Wallet`, `value=statement?.availableCredit`) + a lean "Active Credits" card listing `transactions.filter(type==="CREDIT_NOTE" && runningBalance>0)` w/ remaining + expiry, capped at 6 — the page's own load/error state is NOT gated on this hook), **`payments/page.tsx`** (P5-14 — Payments & credits: `useBuyerPayments({page,limit:20})` paginated payment table [Date/Invoice #/Method/Status via shared `checkBadgeFor`/Amount, VOID struck] + a "Store Credit" `StatCard` reading the SAME `useBuyerStatement().availableCredit` P5-13 hook [never recomputed — same cache entry as `finances/page.tsx`] + a how-to-pay card off `useBuyerRemittance()` [hides empty fields, friendly empty state when no field is set]; nav "Payments" (CreditCard icon) inserted between Invoices and Finances in `portal/layout.tsx`; `useBuyerNotifications.ts` `onInvoiceUpdated` also invalidates `["buyer","payments"]`+`["buyer","statement"]`; **Monthly statement (P5-15)**: a "Monthly statement" `Card` between the wallet grid and the payments table — `useBuyerStatementMonths()` feeds a native month `<select>` (options via a module-scope `monthLabel(bucket)`, default = `months[0]`) + a Download button; handler mirrors the invoice-detail `handleDownloadPdf` exactly — `fetchStatementPdfUrl(month)` → `fetchPdfBlob(url, buyerApiClient)` → programmatic `<a download="statement-${month}.pdf">` (blob URL revoked after 60s, error toast on failure, `finally` clears a `statementDownloading` spinner state); empty-months state "Statements become available after your first invoice."), `licenses/page.tsx` (W6b — self-serve license submit/renew), `account/page.tsx`; `portal/settings/page.tsx`.
- **Your Shelf + running-low strip/chips (P5-06/07):** `portal/[seller]/shelf/page.tsx` — Running low / Due soon / Snoozed / Everything else sections off `useBuyerShelf()` (`GET /buyer/shelf` — THE single payload the shelf, the shop strip and the dashboard chips all read, so low lists + suggested qtys can't drift). Rows: presigned thumbnail (`imageUrl`), cadence line, days-left bar (`estDaysLeft/cadenceDays` clamped 0..1), suggested qty (no prices — estimates carry none by design), **Add** (server create/merge via `useBuyerCreateOrder` at `suggestedQty`), **Snooze/Unsnooze** (`useSnoozeReplenishment`/`useUnsnoozeReplenishment`; one cycle server-side). Header: **Add all low to cart** (`useAddAllLow` → `POST /buyer/shelf/add-all-low`) + open-order card (number/items/total → order detail; route-day/cutoff calendar deferred — needs a delivery-schedule model). Shop strip `shop/_components/RunningLowStrip.tsx` (low && !snoozed, quick-add to the LOCAL shop cart at suggestedQty, `QtyStepper` when already carted, hidden when empty; rendered above the shop grid). Dashboard chips "N running low"/"N due soon" → `./shelf`. Nav "Your Shelf" (Boxes) after Shop in `portal/layout.tsx`. `lib/api/buyer.ts` += `ShelfEstimate`/`ShelfResponse`/`ShelfActiveOrder`, `useBuyerShelf`, `useSnoozeReplenishment`, `useUnsnoozeReplenishment`, `useAddAllLow`.
- **Shop grid density control (2026-08-20):** `shop/page.tsx` exports `type ShopDensity = "sm"|"md"|"lg"`; state initializes to default `"md"` (one notch denser than the old hardcoded grid — that IS the "cards are too big" fix) and a mount-time `useEffect` reads localStorage key `rf:buyer:shop:density` (view mode likewise persisted at `rf:buyer:shop:view`, `"grid"|"list"`) — hydration-safe, no SSR mismatch. `GRID_CLASS_BY_DENSITY` is a static full-string map (`lg`=today's `grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`, `md`=`…gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`, `sm`=`…gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7`) — Tailwind can't see interpolated classes, so it's always a keyed lookup, never templated. A 3-button segmented control (`data-testid="density-toggle"` + `density-sm`/`density-md`/`density-lg`) sits next to the Grid/List toggle, grid-view only. Grid container carries `data-testid="product-grid"`; each `ProductTile` gets a `size?: ShopDensity` prop (`"lg"`/`"md"` = today's visuals, only `"sm"` trims body/type-scale) and the card root/nav link carry `data-testid="product-tile"`/`product-tile-link` respectively — clicking the image or name navigates to the product detail route below (dots/favorite/Add/stepper stay outside the Link or `preventDefault`+`stopPropagation`). Plan: `.claude/pipeline/plans/2026-08-20-buyer-shop-density-and-detail.md`.
- **Buyer product detail page (2026-08-20, WP2):** NEW route `portal/[seller]/shop/[productId]/page.tsx` (`data-testid="product-detail-page"`) — first UI consumer of `useBuyerProduct(productId)` (`lib/api/buyer.ts:196`, `GET /buyer/products/:id` → `BuyerProductDetail`; previously zero consumers). Gallery (main image + thumbnail strip, focal via `objectPositionForUrl`) | info column: name (`product-detail-name`), stock line, price (`product-detail-price`) via the SAME `deriveTilePrice` the tile/cart use (cent parity — never `qty × unitPrice`), full `description`, favorite toggle. Action slot mirrors the tile: QtyStepper if already carted, Notify-me if OOS (`alertSubscribed` from the payload), else Add (`product-detail-add`, boxed = 1 box = `unitsPerBox` qty exactly like the tile). Variant rows price through `deriveTilePrice` too (never the raw `buyerPrice`) — `BuyerProductDetail.variants[]` gained `category`+`unitsPerBox` for it. 404/403 → "Product not available" card (never leaks existence — the endpoint already gates). **The plan's "no API changes" assumption did NOT hold** — `getProductDetail` had to start returning the listing's `unitsPerBox`/`thumbnailUrl`/stock/merch fields (see api.md "Detail↔listing payload parity") or the boxed Add and the OOS branch were both silently wrong.

### `(marketing)/` — public site (marketing-port, PR #657, 2026-09-07)

- **Routes** (`lib/marketing-routes.ts#MARKETING_PAGE_PATHS`, single source — see middleware note
  below): `page.tsx` (home), `product/`, `wholesalers/`, `retailers/`, `pricing/`, `company/`,
  `contact/`, `privacy/`, `terms/`. `/distributors` (the original design's URL for the wholesaler
  page) is a `next.config.mjs` **`redirects()`** entry to `/wholesalers` (307) — **PR #665
  follow-through**: it used to be `distributors/page.tsx`, a prerendered `redirect()` page, which
  lost its `Location` header served from the ISR cache on the standalone server (307, no
  `Location`, production-only — `next dev` masked it; the deployment E2E's spec 36 T1 caught it).
  A `next.config` redirect is evaluated before middleware and always carries `Location`; the page
  is gone. Pinned by `distributors-redirect.static.test.ts` (below) — [[L-093]].
  ⚠️ **`book-a-demo/` and `sign-in/` (2026-09-16, glass-design port, not yet in
  `MARKETING_PAGE_PATHS`)** — add them there + `lib/site.ts#routes` before merge, or the
  mobile-UA proxy carve-out and the sitemap miss both pages ([[L-072]] shape).
- **`book-a-demo/page.tsx`** (2026-09-16) — real Google-Calendar-backed booking, replaces the
  design study's simulated calendar. Renders `components/demo-scheduler.tsx#DemoScheduler`
  (`"use client"`) against `lib/demo-booking.ts` (plain `fetch` to
  `NEXT_PUBLIC_API_URL/public/demo-bookings/*` — deliberately NOT `lib/api-client.ts`, which
  attaches the operator JWT + tenant header this public, tenant-less surface must not send).
  `DemoScheduler`: month-grid calendar → time-slot grid → contact-detail form → confirmation,
  each step re-fetching `getAvailability` on a 409/503 rather than dead-ending. See api.md
  `demo-booking/` for the endpoints, fail-closed contract (no Google config ⇒ no slots, never
  invented), and the 9+4 review-finding fixes.
  **Availability-load errors show a fixed generic message only, never `error.message`**
  (found + fixed during Playwright visual verification, 2026-09-16): the service never throws
  with a curated message on this path, so a raw framework body (a route-mismatch 404's literal
  `Cannot GET /api/v1/...`, a bare 500) would otherwise leak straight into an unauthenticated
  public page. The booking-submit path (create/reschedule/cancel) is unaffected — its real
  message sources (class-validator field errors, the service's own 409/503 text) are safe to
  show. Spec: `demo-scheduler.test.tsx`.
  **B502 fix (#857, 0a365054):** `getAvailability()` returned `{days: []}` identically whether
  Google Calendar was unconfigured/unreachable or genuinely fully booked, so `DemoScheduler`
  showed the same "no times this month" message either way. New `AvailabilityStatus` (`"ok" |
  "unavailable"`) on the response; the client now shows a distinct "temporarily unavailable,
  email us" message for the unconfigured/unreachable case. Also throttles the not-configured warn
  log on this public, unauthenticated, 20/min-throttled endpoint. Specs:
  `demo-booking.service.spec.ts`, `demo-scheduler.test.tsx`.
- **`sign-in/page.tsx`** (2026-09-16) — the wholesaler/retailer account chooser (glass design),
  links straight to the unchanged `/login` and `/buyer/login` — collects nothing itself.
- **Glass design system (2026-09-16, Codex study port)** — `glass.css` (tokens: `--g-*` custom
  properties, `.glass`/`.g-btn`/`.g-tile`/`.g-input` etc.) + `glass-pages.css` (booking/auth page
  layouts: `.booking-layout`, `.calendar-grid`, `.signin-grid`, `.login-choice`, `.auth-*`), both
  scoped under `.rf-marketing` like `marketing.css`, loaded AFTER it from `app/layout.tsx` so glass
  wins where the two overlap. Only `book-a-demo/`, `sign-in/`, and `components/auth/auth-shell.css`
  (see "Top-level" below) consume the glass classes so far — the other 8 marketing pages are still
  on the pre-port `marketing.css` look (full-port tracked as follow-up work, not yet started).
- **B549 (#914, 2026-09-19)** — `glass-pages.css`'s `.booking-copy`/`.booking-panel` (grid items of `.booking-layout`) defaulted to `min-width:auto` at the ≤950px single-column breakpoint, refusing to shrink below their own content's min-content width (scrollWidth 396 vs a 390px viewport — invisible in a screenshot, felt as horizontal rubber-banding on a phone). Fixed with `min-width:0` on both. **B550 filed, NOT fixed** — a related but structurally different overflow on `/company` at 761-950px (nested `min-width:auto` two levels deep + a breakpoint mismatch between `.company-principles` and its child `.feature-grid`); a scoped attempt reduced but did not eliminate it.
- **CTA rewire (2026-09-16)** — every "Book a demo" CTA site-wide now points at `/book-a-demo`
  instead of `/contact` (`site-header.tsx` ×2, `site-footer.tsx`, `page.tsx`, `pricing/page.tsx`,
  `product/page.tsx`, `wholesalers/page.tsx`, `components/{ai-spotlight,conversion-sections,
feature-catalog,marketing,workflow-tour}.tsx`); `contact/page.tsx`'s own "Talk to the team" link
  and the footer's new separate "Contact us" entry still go to `/contact`, which is unchanged
  (still the `DemoForm` mailto draft below).
- **`layout.tsx`** wraps every route in a `.rf-marketing`-classed shell (the scope every rule in
  `marketing.css` — ~10,092 lines, ported near-verbatim from the redesign — hangs off) plus
  `SiteHeader` + `EditorialMotion` + a footer; `app/globals.css` and
  `packages/config/tailwind.config.ts` stay byte-identical to the pre-port baseline (MKT-PIN, see
  `marketing-port.static.test.ts` below) — marketing ships its own token/utility layer instead
  (registry B247, consolidation deferred).
- **Copy rewrite, grounded in shipped behavior (#871, 2026-09-19)** — `company/page.tsx`, `wholesalers/page.tsx`, `retailers/page.tsx` copy rewritten off actually-shipped product behavior (boxed pricing/unit conversion, per-customer tier pricing + product overrides, standing orders that re-price, window-aware route optimization, POD capture, driver-side returns at the stop, delivered-quantity invoicing, cash/check collection with driver settlement, buyer multi-seller single login, buyer card payment via the seller's Stripe Connect with the "seller must enable it" caveat, status-based delivery tracking — driver + stops-ahead + window, never a live map since none exists), not aspirational claims. New `components/order-lifecycle.tsx` (order-lifecycle steps + capability cards) gives `wholesalers/page.tsx` its own page-specific content instead of reusing the product page's capability grid. `company/page.tsx` gains How We Build / The Facts / Data & Security sections. `faq.tsx` questions/answers updated to match. Tests: `marketing-port.static.test.ts` (updated), new `nav-consistency.test.tsx` (below), `cache-headers.static.test.ts` (A6, see `app-shell-lib.md`).
- **A7 (#909, 2026-09-19) — nav dead-CSS + a drift guard.** `marketing.css` declared `.rf-marketing .desktop-nav [aria-current="page"]` FOUR times (B537, identical specificity, unqualified by any page-specific ancestor — always resolved to the same last-declared winner regardless of page, confirmed byte-identical live on `/pricing` and `/wholesalers`); three superseded duplicates removed, the one actually winning kept. `glass-site.css`'s `.glass-page .desktop-nav a`/`:hover`/`[aria-current="page"]` block assumed `.desktop-nav` is a descendant of `.glass-page` (B538) — it never is (`(marketing)/layout.tsx` renders `SiteHeader` outside any `.glass-page` wrapper on every route, incl. `book-a-demo`/`sign-in`) — corrected to the actual DOM shape. New **`nav-consistency.test.tsx`** is a static drift guard: parses both CSS files and fails if a future edit reintroduces either defect class (duplicate unqualified nav-active selectors, or a glass-scoped nav rule assuming a DOM nesting that doesn't exist).
- **`components/site-header.tsx`** — `SiteHeader()`; nav from `../lib/site.ts#routes`/`NAV_SLUGS`
  (never hand-mirror labels/hrefs — [[L-072]]). Desktop "Sign in" is a Radix `DropdownMenu`
  (Distributor → `/login`, Retailer → `/buyer/login`) — each `DropdownMenu.Item asChild` anchor
  (`role="menuitem"`, icon + label + `ArrowUpRight` glyph) is styled by
  `.rf-marketing .signin-menu [role="menuitem"]` in `marketing.css`: `display: flex; align-items:
center; width: 100%; white-space: nowrap`, its own `:focus-visible` ring (`outline` +
  `outline-offset`) on the anchor, `> * { outline: none }` on its children — was `inline`,
  fragmenting the ring per line box and wrapping the arrow, PR #673 [[L-098]]; mobile is a Radix
  `Dialog` sheet (adds Contact + both sign-ins + Book a demo). Both portals re-stamp the
  `.rf-marketing` scope class via a `display:contents` carrier div — Radix portals mount into
  `document.body`, OUTSIDE the layout's scoped wrapper, and every marketing rule/token is a
  `.rf-marketing` descendant selector.
- **`components/editorial-motion.tsx`** — `EditorialMotion()`, renders `null`. Scroll-reveal via one
  shared `IntersectionObserver` over a fixed selector list (section headings, cards, CTA blocks,
  …): adds `.editorial-reveal`, adds `.reveal-pending` only to nodes starting below the fold, then
  removes `.reveal-pending` on intersect. No-ops under `prefers-reduced-motion: reduce` (content
  stays visible with no JS either way). **B504 fix (#861, e95af7e2) + landing incident (#862/#863):**
  `marketing.css` never declared an explicit revealed-opacity rule for `.editorial-reveal` — only
  `.reveal-pending` (opacity 0) existed, relying on an implicit cascade fallback that failed live
  (9 capability cards, section headings, wholesale-extras stuck invisible on `/`, `/product`,
  `/wholesalers`). #861 added the missing rule plus 4 AA contrast fixes. **#862 (legal pages,
  53de9d3d) then silently reverted #861's rule** — its branch was cut before #861 merged and never
  rebased, so landing it via a raw diff against current master read #861's own hunk as a removal
  belonging to #862 (see [[L-195]]). Restored via #863 (3c97ca63, 7-line reinstatement) — that is
  master's current, correct state. Registry: B504.
- **`privacy/page.tsx` + `terms/page.tsx` (#862, 53de9d3d) — real legal copy**, replacing
  placeholder stubs; plus a new top-level **`SECURITY.md`** (vulnerability-disclosure contact +
  scope). `lib/site.ts`'s `routes` table gained both pages' entries, kept parity-tested against
  `middleware.marketing.test.ts` as usual (see `lib/site.ts` bullet below). Docs-only content
  change to `apps/web/app/(marketing)/marketing.css` in the same commit is what triggered the
  B504 landing incident above — see that bullet and [[L-195]] for the mechanism, not this one.
- **`contact/page.tsx`** — `DemoForm` (`components/demo-form.tsx`) builds a
  `mailto:hello@routeflow.info` draft client-side; no POST, nothing stored server-side (deliberate
  v1 scope cut per the pipeline spec's R8 — registry B250 tracks adding a real lead-capture
  endpoint).
- **`lib/site.ts`** — the `routes` table (slug/label/href) `NAV_SLUGS` and `site-header.tsx` read
  from; kept set-equal to `lib/marketing-routes.ts#MARKETING_PAGE_PATHS` by the parity test in
  `middleware.marketing.test.ts`.
- **`components/auth-links.ts`** — the four auth CTAs the chrome links (`/login`, `/signup`,
  `/buyer/login`, `/buyer/register`).

#### Middleware marketing carve-out (`middleware.ts`, `lib/marketing-routes.ts`)

- **`MARKETING_PAGE_PATHS` / `MARKETING_AUTH_PATHS` / `MARKETING_ASSET_PREFIXES` /
  `MARKETING_ASSET_FILES`** (`lib/marketing-routes.ts`, dependency-free — runs on the edge
  runtime) are the SINGLE source for "is this URL a public marketing page/asset" ([[L-072]] — the
  `/privacy`+`/terms` miss shipped from a hand-typed second copy). `middleware.ts` unions the page
  paths with `/robots.txt`/`/sitemap.xml` into `MARKETING_PATHS`. **Exact-path match only, no
  prefix matching** — a typo'd or retired marketing path is NOT exempt (registry B249).
- **Mobile-web proxy carve-out**: a phone UA hitting a non-exempt path is rewritten
  (`NextResponse.rewrite`) to the `@routeflow/mobile` Railway build so the address bar stays on
  `www.routeflow.info`. Exempt (never proxied): `/api/`, `/_next/`, marketing assets, marketing
  auth paths, and every marketing page EXCEPT `/` when the visitor is signed in
  (`rf-op-auth`/`rf-buyer-auth`) or already marked `rf-mobile-app` — those go to the mobile build
  too, since the marketing home isn't useful to a returning app user.
  **B505 fix (#860, eec29265):** `/admin-login`, every `/admin/*` path, and `/verify-email` were
  NOT on the exempt list and have no Expo screen at all — a real phone hitting any of them got
  "Unmatched Route" from the mobile build instead of the platform-admin login/screens or the
  email-verify page (the reason the owner couldn't use the backoffice on their phone). New
  `isWebOnlyPath()` (`lib/marketing-routes.ts`, exported as `WEB_ONLY_EXACT_PATHS`) exempts these
  — prefix match on `/admin` only (`/administration` still proxies, correctly). `/forgot-password`
  and `/reset-password` deliberately still proxy — those DO have Expo screens. Specs:
  `middleware.marketing.test.ts` (`R-B505`).
- **`MOBILE_APP_COOKIE` (`rf-mobile-app`)** — httpOnly marker set on every proxied DOCUMENT request
  (never on subresource/API proxying, so the SPA's own asset fetches don't re-stamp it), 30-day
  ROLLING max-age (re-stamped on each proxied load). Marks "this browser has been served the
  mobile-web build" so a returning visit to `/` skips the marketing home even with no presence
  cookie (the Expo session lives in AsyncStorage, invisible to this middleware). `?desktop=1` /
  the `prefer-desktop` cookie always win over both signals, at any age.

### Top-level

- `change-password/page.tsx`, `contact/page.tsx`, `verify-email/page.tsx`. **Sign-in redesign
  (2026-09-08, PR #663):** both `change-password/page.tsx` and `verify-email/page.tsx` render
  through the shared `AuthShell`; `verify-email/page.tsx` gained a state-derived title
  (`Verifying your email…` / `Email verified!` / `Verification failed`) — logic byte-identical.
  **Glass restyle (2026-09-16):** `components/auth/auth-shell.css` (the ONE file `AuthShell`
  imports, `.rf-auth`-scoped) repainted navy/white flat → the marketing glass palette — every
  class name, prop, and accessibility note (contrast-floor, reduced-motion, the
  Tailwind-longhand-only rule on `.rf-auth input`) preserved verbatim. Zero changes to
  `AuthShell.tsx` or to any of the 6 pages that use it (`(auth)/login`, `(auth)/signup`, and the
  4 buyer auth pages above + `change-password`/`verify-email` here) — pure CSS, so validation,
  Google OAuth, and the tenant-cookie flow are untouched. Verified visually (screenshot) on
  `(auth)/login`, `(auth)/signup`, `buyer/login`, `buyer/register`, desktop + mobile.
- **`app/api/health/route.ts`** (2026-08-29) — the web app's ONLY route handler. Deploy-readiness
  probe returning `{status, sha, branch, timestamp}`, where `sha` = `RAILWAY_GIT_COMMIT_SHA`.
  ⚠️ **`export const dynamic = "force-dynamic"` + `revalidate = 0` are load-bearing** — a statically
  prerendered copy would freeze whatever the BUILD saw and Railway's edge would keep serving it,
  which is exactly the staleness this endpoint exists to detect. Consumed by ci.yml's E2E
  deploy-readiness gate. ⚠️ Railway injects `RAILWAY_GIT_COMMIT_SHA`/`RAILWAY_GIT_BRANCH` into the
  RUNNING container of a GitHub-connected service — they do NOT appear in
  `railway variables --service @routeflow/web` (that lists only service-scoped vars), so absence
  there is NOT absence at runtime. Verify with
  `railway ssh --service @routeflow/web 'printf "%s" "$RAILWAY_GIT_COMMIT_SHA"'`.
  Middleware does not interfere: `/api/` skips the mobile-UA rewrite, the landing 307 is scoped to
  `pathname === "/"`, and the buyer guard's prefixes exclude `/api`.
