# web — App shell & lib

> Split from `.claude/code-map/web.md` (verbatim, lines 34-496) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## App shell & lib

- **Unified "Ledger" design foundation (Phase 1).** `app/globals.css` holds the full Ledger CSS-var
  set (ink/paper/canvas/sunken/line, brand teal, per-surface `--accent`, status, radii, shadows,
  fonts, `--text-body 13.5px` density) mirroring `docs/design-package/project/unified/rf.css`; adds
  `.surface-buyer` (emerald) / `.surface-admin` (indigo) overrides + `.money`/`.mono`/`.overline`/
  `.skeleton` utilities. Tailwind semantic tokens (preset) resolve against these vars, so the whole
  app adopts the palette without per-screen edits. `app/(dashboard)/layout.tsx` operator rail/topbar
  restyled to the Ledger (ink-900 rail, active `white/10` + inset teal-300 bar, ⌘K search pill;
  **Bills & Purchasing** added under Warehouse → `/vendor-bills`). Buyer portal + platform-admin
  layouts carry the `.surface-buyer`/`.surface-admin` class. Plan + tracker:
  `docs/design-package/IMPLEMENTATION-PLAN.md`; open questions: `/QUESTIONS.md`.
- **Phase 1d behavioral UX standards.** `lib/undo.ts` — `useUndo()` (reversible act + 8s Undo toast;
  Toast now returns an id + `dismiss()` and has an `action` slot). `lib/session-expiry.ts` +
  `components/ReAuthProvider.tsx` — in-place re-auth sheet (password unlock + **Continue with Google**
  [tenant slug from cookie or expired-token payload; full-page redirect, never resolves the pending
  promise first] + **Forgot password?** link — the Google-only escape hatch); `lib/api-client.ts` 401
  handler pauses the failed request and calls `requestReauth()` before falling back to the /login
  redirect. Playwright `e2e/07-auth-password.spec.ts` (AP-01..08) covers the sheet + reset pages.
  Dev-only CSP relax in `next.config.mjs` (`connect-src http://localhost:*` in dev). **CSP fix
  2026-08-26: `script-src` now allows `maps.googleapis.com` + `maps.gstatic.com` and
  `worker-src 'self' blob:` exists — the F11-001 CSP (8aacd2d7) had silently blanked EVERY
  dashboard Google Map (trip builder, route create/detail) since 2026-06-18 by blocking the
  Maps JS script `@vis.gl/react-google-maps` injects.** **Maps post-CSP root cause (2026-08-26
  night): prod's `GOOGLE_MAPS_API_KEY` is a DEAD key — Google fires `InvalidKeyMapError` +
  `gm_authFailure` at runtime (script/module fetches still 200, so network checks look green);
  owner must mint/restore a browser key (Maps JavaScript API enabled, referer-restricted) in
  Google Cloud `routeflow-506615` and update the Railway API env. Worse, the auth-failure
  teardown made vis.gl's `AdvancedMarker.map` setter throw (`getRootNode` of undefined) inside
  React's commit — the dashboard error boundary then replaced the ENTIRE `/routes/[id]` page
  with "Something went wrong". `components/GoogleMapsGate.tsx` (`MapsApiGate` = swaps in a
  fallback on `AUTH_FAILURE`/`FAILED` load status, must sit INSIDE `APIProvider`;
  `MapErrorBoundary` = class boundary for what the gate can't pre-empt) now wraps all three map
  surfaces — `routes/[id]/RouteMap.tsx`, `routes/templates/[id]/TemplateRouteMap.tsx`,
  `routes/create/CreateRouteMap.tsx` — each rendering its own `MapPlaceholder` with a
  `maps-failed` reason, so a maps/key failure costs the map pane only. NOTE: the Claude
  browser pane can NEVER render a Google Map (document stays `hidden`, requestAnimationFrame
  never fires — Maps builds its DOM in RAF), so "no `.gm-style`" observed there is an artifact;
  verify maps in a real browser.** **Driving routes (2026-08-26 night, stacked on the gate
  branch): `components/DrivingPathLayer.tsx` replaces the straight stop-to-stop polylines on
  all three map surfaces (each `PolylineLayer` now just builds its ordered waypoints — RouteMap
  = stops by stopNumber; Template/Create = depot → stops → depot — and renders the shared
  layer). It POSTs Routes API `computeRoutes` (browser-side, same key, `TRAFFIC_UNAWARE` =
  cheapest tier, order preserved, ≤25 intermediates per request with chunking + seam dedupe),
  decodes via the `geometry` library, and draws the road polyline; a straight geodesic line
  renders instantly and stays as the fallback on any failure (failures are cached per waypoint
  set per session so a broken API can't re-bill). Requires "Routes API" enabled + in the key's
  API restrictions (done in GCloud 2026-08-26 — key now allows 4 APIs).** **Route planning
  (2026-08-27 batch):** NEW `components/RoutePlanningControls.tsx` (start TENANT/DRIVER/ADDRESS
  - end NONE/RETURN_TO_START/DRIVER_HOME/ADDRESS + avoidTolls switch + TIME|DISTANCE segmented;
    REPLACED+DELETED `deliveries/_components/TripOriginPicker.tsx`) and
    `components/RouteVariantsPanel.tsx` (Fastest/Shortest/Avoids-tolls cards). `lib/api/routes.ts`
    += planning fields on Route (+driverId), `useUpdateRoutePlanning`/`useRouteVariants`/
    `useApplyRouteVariant` (apply takes optional runId → run stops re-numbered server-side, data
    `{applied}`), `GOOGLE_MATRIX_FALLBACK` in the fallback union. `lib/gmaps-export.ts`
    `buildGoogleMapsLegs` (≤9 waypoints/leg, shared handoff) → export buttons on routes/[id] +
    dispatch. RouteMap/TemplateRouteMap take `variantOverlays` (`EncodedPolylineLayer`) and
    thread `plannedPolyline` → DrivingPathLayer `precomputedPolyline` (stored routes = zero
    Google calls per view). routes/[id] planning card snapshot-diffs EVERY field before PATCH
    (unchanged fields omitted — a no-op save must not trigger reoptimize hints or polyline
    nulls); DRIVER origin resolves the TEMPLATE's driver, never the run's. Builders
    (deliveries/new + routes/create) send planning on create; variants auto-fetch post-Build
    with FASTEST default; endReady gates Build. Full detail: code-map CHANGELOG 2026-08-27.\*\*
    `lib/i18n/`
    (`messages.ts` en/es catalog, `index.tsx` `I18nProvider`/`useI18n()`/`t()`) — per-user locale via
    `UserPreference` + localStorage; avatar-menu Language toggle. `CommandPalette.tsx` — Jump-to/Actions/
    Results sections, `? shortcuts`, localized. All mounted in `app/providers.tsx`
    (`ToastProvider > I18nProvider > ReAuthProvider > QueryProviders`). Customer delete
    (`customers/[id]/page.tsx`) is now a reversible soft-delete with Undo (`useSoftDeleteCustomer`/
    `useRestoreCustomer`).
- **Audit follow-up batch (2026-08-28, branch `fix/audit-followup-batch`).** `(dashboard)/layout.tsx`:
  addon-gated nav groups (Dispatch, Sales Agents leaf, Regulated Items) now render `.skeleton`
  placeholder rows while their queries load instead of popping in — `NavEntry` union gained
  `NavSkeleton`; the gate is the addons query's `isLoading` (NOT `resolved`/`isSuccess`, which
  strands skeletons forever on a fetch error — `useTenantAddons` is retry:false); resolved-but-
  disabled renders nothing. Notifications empty-state copy de-jargoned same file. Dashboard
  `OverdueInvoicesPanel` gained `totalCount` (badge = KPI's `meta.total`, never the page size).
  `analytics/page.tsx`: Sales-by-Category pie → vertical BarChart, top 8 + "Other", bars
  `var(--accent)`, labels via `formatMoney`. `orders/[id]/page.tsx`: "Delete order" hidden when
  DELIVERED/PARTIALLY_DELIVERED or any non-DRAFT `order.invoices` entry exists (typed, no casts).
  `orders/page.tsx`: Urgent saved-view pill hidden at count 0 UNLESS it is the active view.
  Dispatch/routes run-card grids use `auto-fill,minmax(300px,1fr)` (wrap at every width). Copy
  pass: statements AI footnote, StockCountTab helper, sales-agent rates explainer, inventory
  out-of-stock sublabel, compliance `TEMPLATE_LABELS` map in `RegulatedReportPanel.tsx`
  (TX_COMPTROLLER → "Texas Comptroller", `humanizeEnum` fallback).
- **`app/layout.tsx`** — root metadata, fonts (Spline Sans + Spline Sans Mono + Instrument Serif +
  Inter fallback), `<Providers>` + `<TenantProvider>` + SW registry.
- **`app/providers.tsx`** — QueryClient/TanStack Query, toast container. (Zustand was removed
  wave D/item 11 2026-09-03 — verified zero imports in web source; `no-dead-deps.spec.ts` in
  [`api`](api.md) pins it. Web state is TanStack Query + context.)
- **`next.config.mjs`** — standalone output (Docker), CSP headers, X-Frame-Options DENY, image domains. **CSP `frame-src 'self' blob: https:`** (2026-08-21) — without it iframes fell back to `default-src 'self'` and every blob:/API-origin PDF preview (invoice scan, invoice builder, customer docs) rendered blank while `<img>` previews worked; `data:` deliberately excluded from frames. **`Permissions-Policy: camera=(self), geolocation=(self)`** — `camera=()` previously disabled the in-browser barcode/invoice scanner on Android Chrome ("access denied"; iOS Safari ignored it). The `headers()` CSP string itself is now built by `csp.mjs` (below) — `next.config.mjs` just computes `isDev` and calls `buildContentSecurityPolicy({ isDev, apiUrl: process.env.NEXT_PUBLIC_API_URL })`. **A6 (#900, 2026-09-19)** — explicit `Cache-Control: public, max-age=60, s-maxage=3600, stale-while-revalidate=86400` added for `/` and the 10 named signed-out marketing routes (product/wholesalers/retailers/pricing/company/contact/privacy/terms/sign-in/book-a-demo): previously shipped only App Router's own `s-maxage` ISR default with no `max-age`, so a visitor's own browser (vs. a shared/CDN cache) had nothing telling it to reuse the response — every in-session nav between marketing pages re-fetched HTML. Listed one path per route on purpose — never widen to a wildcard, every other route is authenticated or tenant/session-scoped and a shared header there would leak one visitor's response to the next behind the same CDN edge.
- **`csp.mjs`** (2026-09-04) — `apiConnectSources(apiUrl)` + `buildContentSecurityPolicy({ isDev, apiUrl })`, extracted out of `next.config.mjs` so the policy is unit-testable (`lib/csp.test.ts`, pins the production string byte-identical). **Fixes a real bug**: `connect-src`'s dev-localhost relaxation was gated on `isDev = NODE_ENV !== "production"`, which is always `false` in a built image (`next build` forces production) — so the local Docker/E2E lane's browser could never reach `http://localhost:3000`, and login silently CSP-failed (no HTTP response, rendered as a bogus "Invalid username or password"). Fix: `apiConnectSources` adds the concrete `http:`/`ws:` origin pair to `connect-src` whenever the **baked** `NEXT_PUBLIC_API_URL` itself is `http:` (regardless of `isDev`); a normal `https://` prod build is unchanged. See `apps/web/e2e/LOCAL-LANE.md`.
- **`components/next-config-images.static.test.ts` (updated 2026-09-10, `chore/next-15`
  #5b3b3c4e)** — pins `next.config.mjs`'s `images: { unoptimized: true }`. Was the
  `security/audit-allowlist.json` GHSA-2xp9-vwfh-vxw4 (libheif/AVIF RCE) allowlist's basis; Next
  15.5.25 fixes that advisory upstream and the allowlist entry is retired (see [`api`](api.md)'s
  `audit-allowlist-retired.spec.ts`), so the test's own docstring now frames the same assertion as
  **defence in depth** rather than the allowlist's justification — the app still never renders
  `next/image` and the optimizer route stays disabled regardless of the installed Next version.
- **`lib/api-client.ts`** — axios instance, `getTenantSlugFromCookie()`, token+tenant interceptors, refresh queue. **`paramsSerializer: { indexes: null }`** (mirrors mobile's `buyerApiClient`) — array query params must go out as repeated keys (`?statuses=A&statuses=B`); axios's default `statuses[]=` survives Express's `simple` query parser as a literal `statuses[]` key and the global ValidationPipe (`forbidNonWhitelisted`) 400s it.
- **`lib/auth.ts`** — operator auth types, login/refresh/logout, `onCrossTabTokenChange()`. ⚠️ The
  legacy bare `accessToken`/`refreshToken` keys are STILL written by the Google OAuth callbacks
  (`(auth)/callback`, `(auth)/auth/google/callback`) and verify-email writes ONLY them (broken —
  flagged as a follow-up task), while settings' Google-link fetch reads only the legacy key —
  retire them together, never piecemeal.
- **`lib/tenant-cookie.ts`** — shared cookie util (non-httpOnly — JS-readable required).
- **`lib/tenant-host.ts`** (2026-08-29) — SINGLE SOURCE OF TRUTH for host→tenant derivation:
  `PLATFORM_HOSTS`, `HOSTING_PROVIDER_DOMAINS`, `tenantSlugFromHostname(hostname): string | null`
  (null for <3 labels, platform subdomains, and every hosting-provider domain; `"acme"` for
  `acme.routeflow.info`). Imported by BOTH `middleware.ts` and the login page's
  `getSubdomainWorkspace()`. ⚠️ **Never re-inline these rules.** They were duplicated and the copies
  DRIFTED: the login page lacked the hosting-provider guard, so on `*.up.railway.app` it derived the
  SERVICE name (`routeflowweb-production`) as a tenant slug — hiding the Workspace field and writing
  that nonexistent slug into the tenant-slug cookie on submit, making form login impossible on the
  Railway fallback host. That is why e2e AP-09 failed on every master run for weeks (it is the only
  spec that logs in through the form without `setExtraHTTPHeaders` masking the clobbered cookie).
  Knock-on by design: `useTenantBranding` is gated on the derived workspace, so tenant logo/name no
  longer render on the Railway login page — correct, that host is not a tenant subdomain.
- **`lib/socket.ts`** — Socket.io singleton, token auth, reconnect.
- **`lib/auth-keys.ts`** — `OP_KEYS`/`BUYER_KEYS`/`DRIVER_KEYS` (prevent cross-context token bleed).
- **`lib/page-title-context.tsx`** — `usePageTitle()`.
- **MSRP surfaces (2026-08-22, PR-B — ⚠️ IN FLIGHT on `feat/msrp-on-invoices`, NOT on master).**
  Suggested-retail price, **per PIECE** (`MSRP $X.XX/pc`), display-only — it never enters any
  money calculation. **Read surfaces key off `item.msrp != null`, NOT off the addon flag**, so an
  invoice issued while the feature was on keeps rendering correctly if the tenant later loses it:
  `invoices/[id]/page.tsx` (a muted sub-line under Unit Price, across every `priceType` branch)
  and `buyer/portal/[seller]/invoices/[id]/page.tsx`. **Entry surfaces are flag-gated**
  (`useHasAddon(MSRP_ADDON)`, `MSRP_ADDON = "msrp"` in `lib/api/addons.ts`):
  `products/[id]/page.tsx` (field + an amber below-wholesale warning that warns and never blocks),
  `products/page.tsx` (an MSRP column on the generic `QuickEditCell` — the primary bulk-edit path,
  same wiring as `priceTier2..5`), and the customers Special Prices tab
  (`customers/[id]/page.tsx`), where a row may now be tier-only, MSRP-only, or both — render the
  tier badge only when `pricingTier != null`. ⚠️ **Keep the "Default Pricing Tier" card at the top
  of that tab** (shipped in #408; it is the fix for operators not finding the customer-wide tier).
  Types in `lib/api/{products,invoices,customers}.ts`; `CustomerPrice.pricingTier` is now
  `number | null` — every `getTierPrice(...)` caller needs its `?? customerTier ?? 1` fallback.
  Swept 2026-08-22: `invoices/new/page.tsx` priceMap (falls back to `customer?.pricingTier`),
  `orders/[id]/page.tsx` cpMap and `orders/_components/CreateOrderModal.tsx` cpMap (both
  `Map<string, number | null>`; their `.get(id) ?? customerTier` consumption was already null-safe).
  **F06/B62 (2026-09-01):** that
  `?? customerTier ?? 1` ladder collapses _loading_, _no customer_ and _genuinely tier 1_ into tier 1,
  and the page's only loading gate covers `useOrder` — so on a DRAFT (which auto-enters edit mode the
  moment the order lands) `addProduct` can bake a LIST price and `SubstitutePicker` can SEND one.
  `orders/[id]/page.tsx` gains a `pricingReady` flag (customer + customer-prices queries settled, or
  no `customerId`; an ERRORED fetch counts as ready = today's tier-1 degraded mode, so a failure can
  never wedge the editor shut) threaded into `EditableLineItems`, gating the add-product input,
  its suggestion rows and the Substitute trigger. Proven post-deploy by e2e `24-order-edit-pricing`.
  Admin toggle: `(platform-admin)/admin/tenants/[id]/page.tsx` `AVAILABLE_ADDONS` += `msrp` (now
  removed — see below).
- **`AVAILABLE_ADDONS` emptied (2026-09-18, B508, #866 + #890):** `(platform-admin)/admin/tenants/[id]/page.tsx`'s
  legacy `AVAILABLE_ADDONS` array (`tobacco_dealer`, `msrp`, `sales_agents`, `DRIVER_PAYMENTS_ADDON`,
  `RECURRING_ROUTES_ADDON`, `ORDER_DELIVERY_ADDON`, `OCR_ADDON`, `DEVELOPER_MODE_ADDON`) is now
  `const AVAILABLE_ADDONS: Array<{key,name,description}> = []` — all eight legacy provisioning
  toggle cards removed in two sequenced PRs (same array, deliberately conflicting insertion
  points — landed #866 first, then #890 rebased onto it), superseded entirely by the Feature
  Console's per-feature grants (`fg-d-enable-addon`'s "Enable as add-on" modal). Zero remaining
  references to the removed constants; the matching `@routeflow/types` import line was trimmed to
  just `FEATURE_OVERRIDE_KIND_VALUES`/`FeatureOverrideKind`. **Does NOT close B519** (driver_payments
  has no client-side check for its `anyOf:[recurring_routes,order_delivery]` dependency) — that gap
  lived in BOTH this legacy toggle AND `EnableAddonModal.tsx`'s "Enable as add-on" action; removing
  the legacy toggle only retires one of the two unenforced paths, and `EnableAddonModal.tsx` still
  POSTs `driver_payments` unconditionally. B519 stays open/uncampaigned.
- **`products/[id]/CropModal.tsx` Pointer Events conversion (2026-09-18, #883/[[B514]]):** crop-box
  drag, corner resize, and focal-point placement were wired only to `onMouseDown` +
  `window.addEventListener("mousemove"/"mouseup")` — completely unusable on a touch device (no
  mouse events fire at all). Converted the full interaction surface to Pointer Events
  (`onPointerDown`/`pointermove`/`pointerup` via `setPointerCapture`, one code path for
  mouse/touch/pen), added `touch-none` so the browser doesn't also try to scroll/zoom the image
  under an active drag, and capped `maxWidth` so the modal fits a narrow viewport instead of
  overflowing it.
- **`lib/format.ts`** (new 2026-08-26, audit P0 batch) — display formatter: `formatMoney`
  (Intl USD, thousands separators), `formatQty` (bare integers, ≤2dp fractions), `formatDate`
  ("Aug 27, 2026", **LOCAL time — for UTC-midnight calendar dates use `lib/formatting.ts`
  `fmtCalendarDate` instead**, e.g. `RouteRun.scheduledDate` on routes/dispatch), `humanizeEnum`
  ("PARTIALLY_DELIVERED" → "Partially Delivered"). Display ONLY — money math stays in
  `@routeflow/pricing`. Never inline `toFixed(2)`/`toLocaleDateString()` for user-visible money/dates.
  First adopters: orders/[id] (line/summary money, total qty), inventory (Stock Value KPI),
  orders list (status badge via label prop), routes templates Created. ⚠️ Near-duplicate of the
  older `lib/formatting.ts` (`fmt`/`fmtDate`/`fmtCalendarDate`) — consolidation queued for the
  audit follow-up batch; until then prefer format.ts for new code EXCEPT calendar dates.
- **`lib/impersonation.ts`** (new 2026-08-26, audit P0 batch — security-relevant) — **THE single
  reader/writer of the super-admin impersonation localStorage keys** (`getImpersonation()` —
  parses base64url JWT exp → `{token, slug, username, expired}`;
  `setImpersonation(token, slug, username?)`/`clearImpersonation`; `subscribeImpersonation` —
  same-tab CHANGE_EVENT + a **key-filtered** `storage` listener (token/slug/username, or
  `key === null` for `clear()`); an unfiltered one fired on EVERY cross-tab localStorage write
  and logged idle tabs out via AuthProvider's re-read). Nothing else may touch those keys
  (grep-gated).
  Consumers: `lib/api-client.ts` (request interceptor prefers a NON-EXPIRED impersonation token,
  expired → clear + redirect `/admin/tenants?impersonation=expired`; a 401 while impersonating
  NEVER enters the operator refresh path — clear + redirect instead; the refresh catch also
  carries a concurrent-rotation race guard retrying with a raced fresh token before opening the
  ReAuth sheet), `lib/auth.ts` (`login()`/`logout()` clear impersonation; `getStoredUser` ignores
  expired tokens), `lib/auth-context.tsx` + `components/tenant-provider.tsx` (both re-read identity
  on the subscription so a soft impersonation swap updates the chip/branding — each applies only a
  NON-NULL read; a null read must never clear an established session), `(dashboard)/layout.tsx`
  `ImpersonationBanner` (live-subscribed + pathname
  re-check, expired variant; the banner renders
  `acting as {imp.username ?? "Tenant Admin"}`), platform-admin tenants list + [id]
  Impersonate actions (**both** now do the same three things — `setImpersonation` with the
  `res.data.impersonatedUser?.username` third arg, `setTenantCookie(slug)`, then a hard
  `window.location.href = "/dashboard"`; the LIST page previously did neither the cookie write nor
  a hard load [`router.push`], which is why impersonating from the list kept the PREVIOUS tenant's
  logo/name/chip. The [id] page's legacy bare `accessToken` write was REMOVED — it leaked the
  impersonation token to legacy-key readers such as settings' Google-link fetch [NOT via
  `migrateLegacyOpToken`, which was never called and was deleted 2026-08-27]; cost: realtime
  sockets read OP_KEYS directly and stay silent during impersonation). Buyer impersonation flow is
  separate and untouched.
  **`exitImpersonation()` is now THE single exit (B138, F14 2026-09-02)** — the banner's inline
  `exit()` and any future caller's copy of the same three steps (clear cookie → clear
  impersonation → hard-load `/admin/tenants`) collapse into this one exported function; the banner
  and the header avatar menu (below) both call it directly. Deliberately never POSTs
  `/auth/logout`: see `AuthController.logout`'s impersonation branch in api.md — an impersonation
  token's `sub` is the tenant's real TENANT_ADMIN, so a server logout there would revoke that
  admin's sessions on every device. **Header avatar-menu sign-out slot rule (B138):**
  `(dashboard)/layout.tsx`'s `Header` component now mirrors the banner's own
  `getImpersonation()`/`subscribeImpersonation` read (plus a pathname-keyed re-check) into local
  state, and the dropdown's LAST item is conditional on it: impersonating (expired included) →
  `t("menu.exitImpersonation"|"menu.returnToAdmin")` → `exitImpersonation()`; otherwise →
  `t("menu.signOut")` → `logout()` as before. Before this fix the avatar menu ALWAYS offered
  "Sign out", which called the normal staff `logout()` — under impersonation that is exactly the
  admin-lockout bug B138 fixes server-side, so the client control had to be closed too or the
  server fix alone would not have been reachable-safe. New i18n keys `menu.exitImpersonation`/
  `menu.returnToAdmin` (en+es) in `lib/i18n/messages.ts`. No Playwright unit proof pre-merge (D1)
  — proven post-deploy by e2e spec 31 below.
- **`lib/payment-methods.ts`** (new 2026-08-21) — **THE single source for payment-method lists in web.**
  `SELECTABLE_PAYMENT_METHODS` (`CASH,CHECK,ZELLE,ACH,CREDIT_CARD,OTHER` — pickers) vs
  `ALL_PAYMENT_METHODS` (+`CREDIT_NOTE`,`ADVANCE` — display/filters ONLY; the server rejects
  those two on `POST /invoices/:id/payments`), `PAYMENT_METHOD_LABELS`/`_COLORS`,
  `paymentMethodLabel()`, types `SelectablePaymentMethod`/`AnyPaymentMethod`. Created when
  Zelle was added: the list had been hand-rolled in ~12 web files that had already drifted
  (finance/reports + bookkeeping/[transactionId] were missing CREDIT_CARD; the three expense-side
  pickers — `finance/expenses/new/page.tsx`, `vendor-bills/page.tsx` bulk mark-paid (hub moved
  there 2026-08-28, was `finance/expenses/page.tsx`),
  `components/ScanInvoiceModal.tsx` — each had their own 4–5 option list and disagreed on the ACH
  label). **Never re-declare a method list — import from here**; mirror is
  `apps/mobile/lib/payment-methods.ts`, source of truth is the Prisma `PaymentMethod` enum.
- **`@routeflow/pricing`** (was `lib/pricing.ts`, deleted — see `packages.md`) — `getTierPrice`,
  `computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`,
  **`prorateLineSubtotal(stored, delivered, ordered, freeUnits = 0, freeUnitSize = 1)`** (F04/REG-B50,
  2026-08-31 — partial-delivery money off the STORED subtotal; the paid-basis floored cumulative
  telescope of the oracle `invoices.service.ts#buildInvoiceItemData`, **never** a linear
  `stored × delivered / ordered`. No web caller yet — it exists so api/web/mobile stay identical and
  the package's golden tests pin them),
  the margin helpers `costPerSellingUnit`/`computeMarginFraction`/`priceForMarginFloor`/`classifyMargin`
  (box-vs-piece aware; the sale-builder "negotiation floor"), **`applyBestPromotion`/`promotionMatchesProduct`**
  (P5-04), and the zero-price guard `ruleCanZeroPrice`/`promotionZeroesProduct`/`scanPromotionZeroPrice`/
  `zeroPriceWarning` (2026-08-21 — the promotions editor's live $0.00 blast-radius count). One copy —
  api and mobile import the same package, there is no mirror to keep in sync.
- **Your Shelf hooks (P5-06/07, WP3):** `lib/api/buyer.ts` += `ShelfEstimate`/`ShelfActiveOrder`/`ShelfResponse` types +
  `useBuyerShelf()` (`GET /buyer/shelf`, THE single source for the Shelf page, shop running-low strip, and dashboard
  chips — all three filter the same payload client-side so low lists/suggested qtys can't drift) +
  `useSnoozeReplenishment()`/`useUnsnoozeReplenishment()` (`POST|DELETE /buyer/replenishment/:productId/snooze`) +
  `useAddAllLow()` (`POST /buyer/shelf/add-all-low`, delegates to the server createOrder merge path). All 4 mutations
  invalidate `["buyer","shelf"]`/`["buyer","replenishment"]`; add-all-low also invalidates `activeOrder`/`orders`/`dashboard`.
- **Promotions pricing (P5-04):** `lib/api/buyer.ts` `useBuyerPromotions()` + `BuyerPromotion`; the buyer cart
  `buyer/portal/[seller]/cart/page.tsx` evaluates each line's best promo via the SAME `applyBestPromotion`
  (base = the catalog `buyerPrice`) → per-line strikethrough + a "Promotion savings" summary line (net line
  subtotals reconcile to the total). **Cart pricing fetch MUST use `useBuyerProducts({ ids: cartProductIds })`**
  (2026-08-21, #382) — a plain catalog page silently omits products outside it and the `?? 0` fallback priced
  those lines at $0; unresolvable lines now render "Price unavailable" and are EXCLUDED from the estimate,
  never counted as $0. Operator order-detail, buyer order-detail, and invoice-detail render the
  `PriceType.PROMO` strikethrough/badge (web `PriceType` unions in `lib/api/{orders,invoices}.ts` += `PROMO`).
  **BUY_N_GET_M (2026-08-21, WP3):** cart `pricedLines` computes `qtyUnits` (whole selling units — boxes for a
  boxed line via `normalizeBoxesPieces(...).boxes`, loose pieces never count; `qty` for a piece line) alongside
  `qtyPieces` and passes both into `applyBestPromotion`'s `PromoContext`; `promo.freeUnits` feeds
  `computeLineSubtotal`'s new `freeUnits` param so the subtotal — never a rounded net-unit-price — carries the
  exact saving. Line UI shows a "{freeUnits} free" pill next to the product name (unit price cell stays
  unstruck: `originalPrice` is always null for this type). `shop/_components/tile-pricing.ts` `deriveTilePrice`
  mirrors the same `qtyUnits` sourcing (1 unit default-add qty / cart item's units when present) so tile and
  cart stay cent-parity for BOGO too. Tile/detail deal chip: `tile-pricing.ts` also exports
  `bogoChipLabel(product, promotions)` + `BOGO_FALLBACK_BANNER` — the scope-matching BUY_N_GET_M promo's
  `bannerText` (else "Buy N get M free"), qty-agnostic (the chip shows before enough is carted to earn a free
  unit), lowest promo id wins on a tie. `ProductTile.tsx`/`DetailActions.tsx` `computeChip` take it as a
  `bogoLabel` arg checked FIRST (so BOGO never falls through to the `originalPrice`-derived "Deal -N%", which
  it can't produce anyway — `originalPrice` is null for this type); both components gained an optional
  `promotions?: BuyerPromotion[]` prop (chip text ONLY, never pricing) fed from `shop/page.tsx` and
  `shop/[productId]/page.tsx`'s existing `useBuyerPromotions()` data. `BuyerPromotion.type` widened with
  `"BUY_N_GET_M"`. Admin form: `(dashboard)/promotions/page.tsx` gains "Buy N get M free" with two integer
  fields (Buy qty N → `minQty`, Free qty M → `value`, same field-reuse as the rest of the pricing mirrors) +
  a live preview sentence; `lib/api/promotions.ts`'s `PromotionType` union carries `"BUY_N_GET_M"` and
  `promotionRuleLabel` renders "Buy N, get M free" for it (no local widening/wrapper in the page).
  **Invoice edit round-trip (money):** `invoices/[id]/edit/page.tsx`'s `LineItemState` carries
  `promoFreeUnits` + `promoBaseUnits` (the whole-unit count it was earned at), hydrated from
  `InvoiceItem.promoFreeUnits`; local `lineFreeUnits(it)` rescales on a qty edit (proportional at the
  earned rate, never above the snapshot, capped at `units - 1`) and feeds BOTH the `lineTotal` preview
  and the submitted `CreateInvoiceItem.promoFreeUnits`. The PATCH delete-and-recreates every line, so
  omitting the field re-prices an agreed $350 (12 × $35, 2 free) line to $420.
  **Line-type round-trip (2026-08-21):** the snapshot is declared on the edit-form line types in
  BOTH `lib/api/orders.ts` (`OrderItem.promoFreeUnits`) and `lib/api/invoices.ts` (`InvoiceItem` +
  `CreateInvoiceItem.promoFreeUnits`). Any form that PATCHes items MUST echo it back — those paths
  replace every line, so a dropped field silently re-prices a free-unit line to full.
  **Order/invoice display + edit previews (money):** `OrderItem.promoFreeUnits` (`lib/api/orders.ts`),
  `BuyerOrder.lineItems[].promoFreeUnits` + `BuyerInvoiceDetail.items[].promoFreeUnits`
  (`lib/api/buyer.ts`) surface the API's already-returned column. Both order edit previews now net it
  off — buyer `orders/[id]/page.tsx` `buyerLineSplit`/`buyerLineFreeUnits`/`buyerLineAmountFreeUnits`
  feeding `buyerLineAmount`, operator `(dashboard)/orders/[id]/page.tsx` `editLineFreeUnits` feeding
  `editLineSubtotal` (returns 0 while a substitution is pending — the snapshot belongs to the replaced
  product, and undo restores it); both rescale exactly like the invoice edit form. Same clamp is applied
  to the operator read view's `computeLineSubtotal` fallback. "{n} free" now renders on the buyer + operator
  order-detail qty cells (read + edit rows) and on the buyer + operator invoice-detail qty cells, matching
  the cart's pill — without it the reduced subtotal reads as a pricing error.
- **`lib/api/margin.ts`** — `useMarginConfig()`/`useUpdateMarginConfig()` (tenant costing method +
  margin floors via `/settings/margin`) + `floorForCategory()`. Shared **`components/MarginHint.tsx`**
  (cost·margin under a line, red below floor, Set-to-floor / Sell-anyway) is used by both the order-detail
  edit path AND `CreateOrderModal` (inline dup removed); with a `productId` the cost text opens a
  **cost-history popover** (portaled to `<body>` to clear the modal's transform+overflow) via
  **`lib/api/cost-history.ts`** `useCostHistory(productId)` (also backs products/[id] `CostHistoryCard`;
  `GET /analytics/cost-history/:id`). Analytics **Gross Margin** card caption (2026-07-31): static "COGS is estimated from each product's average cost at the time of sale" — the per-costing-method caption (and its `useMarginConfig` call) was dropped when API COGS became an invoice-sourced point-in-time average estimate (see api `common/invoiced-sales.ts`). Top Products' `{unitsSold,totalRevenue}` columns and Turnover/Forecasting/P&L populate from the same re-sourcing with zero web changes.
- **Minimize & resume drafts (Phase 2 §2, pos-cost-roles-spec).** `lib/api/drafts.ts` — `useDrafts`/
  `useDraft(id)`/`useCreateDraft`/`useUpdateDraft`/`useDeleteDraft` over `/drafts` (per-user,
  tenant-scoped; OPERATOR/DRIVER, TENANT_ADMIN satisfies OPERATOR). `lib/drafts.ts` — `OrderDraftPayload`
  (full builder state), `draftDeviceLabel()`, `parkedAgo()`, `draftSummary()`. `components/DraftDock.tsx`
  — persistent dock at the bottom-left of the content column (mounted in `(dashboard)/layout.tsx`
  right-column, non-CUSTOMER roles), lists parked drafts + Resume/Discard + a global scan-to-draft
  wedge-listener (active only while a draft is parked; bails inside any open `[role=dialog]`).
  **Scanner picker overhaul + create-from-line (2026-07-18):** `SearchableProductPicker` gained an
  **async mode** (`async` prop → 300ms-debounced server-side `useProducts({search, isActive, includeVariants, limit:50}, {enabled: open})`
  — fetches ONLY while open; kills the 1000-product static ceiling), `selectedLabel` (closed-state
  display when the selection isn't in the fetched page), `onChange(id, product?)` second arg,
  `displayProductName` composed labels, `line-clamp-2` (no more truncation), and a **fixed-position
  floating preview panel** (`ProductPreviewPanel`, private) following the highlighted option —
  name/SKU/barcode/price/thumbnail, flips at the viewport edge, `z-[300]`, default on (`preview` prop).
  `useProducts` gained `opts.enabled`. Both scan surfaces (`ScanInvoiceModal` — native select replaced;
  `BatchItemReviewModal` — 1000-fetch dropped) use the async picker + "Did you mean…" candidate chips
  (from the scan response's new `candidates[]`; picking feeds the mapping learning loop) + a **"+ Add
  product" icon button** beside the picker on unlinked lines opening the NEW shared
  `components/ProductCreateModal.tsx` — the products page's FULL AddProductModal extracted
  (variants/regulated/costing/description/images, prop-for-prop identical there) with
  `initialName/initialSku/initialPrice/initialCost` prefills from the scanned line (OCR now extracts
  per-line `sku`). `InlineCreateProductModal` untouched at its other quick-entry call sites.
  **Regulated TYPE vs Category (2026-07-19d):** terminology + one-axis consolidation — user-facing
  "Section"→"Regulated type", "Subcategory"→"Category" across products/inventory/compliance/settings
  (invoice-treatment label "Sectioned on invoice" deliberately kept — invoice layout, not the entity).
  Product forms (ProductCreateModal, products/[id] edit, SectionEditCell) show ONE Category slot:
  free-text `CategoryCombobox` when non-regulated; the type-scoped `SubcategoryCombobox` (labeled
  "Category") when a regulated type is picked — the form then does NOT send `category` (the API
  syncs `Product.category` = structured category name server-side; see api.md products entry).
  Legacy tidy: `apps/api/scripts/tidy-regulated-categories.mjs`.
  **Case code / Unit code (2026-07-23, products-dual-sku WP5):** the existing SKU field is
  relabeled "Case code (SKU / barcode)"; a new "Unit code" text input + `BarcodeScannerButton`
  (own ref, writes a sibling `unitSku` form field, helper text "printed on customer invoices…")
  sits beneath it in `ProductCreateModal.tsx` (payload `unitSku: form.unitSku.trim() || undefined`)
  and in `products/[id]/page.tsx`'s variant add/edit modal (`variantForm.unitSku`, same
  `|| undefined` convention as its `sku` sibling — including on edit, matching existing behavior).
  `products/[id]/page.tsx` main edit draft carries `unitSku: product.unitSku ?? ""` →
  PATCH `unitSku: draft.unitSku?.trim() || null`; a new `InfoRow label="Unit code"` renders
  `product.unitSku ?? "— (same as case code)"` right after "SKU / Barcode". `ApiProduct`
  (`lib/api/products.ts`) gained `unitSku?: string | null`. No local `Product` interface exists in
  `products/[id]/page.tsx` — `product` is untyped (`useProduct()`'s `useQuery` has no generic), so
  `product.unitSku` needed no separate type edit there.
  **Subcategory create-on-type + scope tabs (2026-07-19c):** subcategory fields on product surfaces become a type-ahead
  `components/SubcategoryCombobox.tsx` (ID-based — separate query vs selected id; explicit
  `+ Create "…"` row via `useCreateSubcategory`, case-insensitive pre-guard; server adds trim +
  ci-dup 409); the Section dropdowns on Products + Inventory Stock tab are REPLACED by shared
  `components/RegulatedScopeTabs.tsx` (design-system Tabs: All | Regulated(badge) | Non-regulated +
  per-section chips when Regulated; same `?section=` contract; inventory migrates to
  `useUrlFilters({section:""})`). Mobile gains `SubcategoryPickerSheet` (search+create).
  **Regulated-section isolation (2026-07-19b):** Products page (`products/page.tsx`) gained a
  toolbar **"Section"** `<select>` (All / Regulated-any / per-section / Non-regulated) bound to a
  deep-linkable `?section=` via `useUrlFilters({section:""})` → `useProducts({section})`; a Section
  **pill** column/card (name from an id→name map built off the UNFILTERED `useTrackedCategories()`
  so deactivated-but-tagged sections still resolve); Quick Edit gets new
  `_components/SectionEditCell.tsx` (dependent Section→Subcategory selects, save-on-change,
  subcategory ALWAYS clears on section change, one PATCH; `handleSectionSave` takes the full
  product row — avoids a used-before-declaration `productList` closure trap; undo/redo replays
  object patches, `QuickEditCell` EditRecord value union widened; a TYPE change also nulls the
  regulatory trio `regItemType/regUomCase/regUomUnit` in the same PATCH — matching the create
  modal/detail form, since the API 400s a section move that strands template-scoped codes — with
  the undo record capturing the prior trio so undo restores it, and save failures surfacing via
  try/catch error toast w/ server message); the multi-select bar gets a bulk
  **"Assign to section…"** `components/AssignToSectionModal.tsx` (one target select incl.
  "None — remove"; assigns all in one `useAssignProductsToCategory` call, "None" unassigns grouped
  by current section). All new UI hidden when the tenant has no sections; the legacy amber
  `isTobacco` badge + free-text Category filter are untouched separate axes. Inventory Stock tab
  (`inventory/page.tsx`) mirrors the filter CLIENT-side (its list is unpaginated, like
  `missingCostOnly`) + pills via `StockTable` props. Compliance `compliance/[categoryId]` "Regulated
  Products: N" KPI is now a `Link` to `/products?section=<id>`.
  **(2026-07-19) ScanInvoiceModal preload DELETED:** the residual `useProducts({limit:1000})` is gone —
  variant-split siblings now fetch ON DEMAND (`fetchVariantSiblings`: `GET /products/:id` parent+variants
  family via the root, + prefix-search path for standalone-flavor catalogs; `siblingCache` keyed by
  productId; `startSplit` async with loading state + error toast). `VarietySplit` entries are
  self-describing (`name`/`variantName`) so panel labels + bill descriptions need no catalog list;
  manual-add picker async. Also FIXED the latent no-op: the split button now works for products beyond
  the first 1000 (old code returned [] when the match wasn't in the preload page).
  **Credit notes on orders (2026-07-18):** new `orders/_components/CreditNotePicker.tsx`
  (customer-scoped open-credit checkboxes + optional per-credit amount input, "Credits to apply at
  invoicing −$X" + "Estimated balance due" display-only — NOT a discount, totals unchanged) used by
  `CreateOrderModal` (payload `appliedCreditNotes` when non-empty; merge-resubmit carries it — the
  controller merge branch honoring it was a review catch) and `orders/[id]` edit mode (sent only when
  touched, through BOTH save paths). Order detail read mode shows an Applied-credits block (reason via
  `orderCreditNotes[].creditNote`); `invoices/[id]` CREDIT_NOTE payment rows show the credit's reason +
  link + operator "Remove credit" (`useUnapplyCreditNote` → POST /credit-notes/:id/unapply);
  `credit-notes/[id]` has inline reason edit (`useUpdateCreditNote` PATCH). Reason always rendered from
  the relation at read time — edits propagate everywhere with no copy/sync.
  **Inline create (2026-07-30):** `CreditNotePicker` now early-returns on `!customerId` ONLY (empty
  list = "No open credits for this customer." empty state) and has a "+ New credit note" header form
  (amount/reason/optional expiry → `useCreateCreditNote`). On success it selects the credit from the
  create response and merges it into local `justCreated` (deduped by id, reset on customer change) so
  the row + running total render before the refetch. `submitCreate` re-narrows `customerId` inside the
  closure (the early return does not narrow a prop there), rejects a non-future expiry client-side
  (same predicate as `CreditNotesService.create`, mirroring the `credit-notes` page modal), and
  surfaces the server's `response.data.message` on error.
  **Shipping fee (2026-07-18):** `CreateOrderModal` has a "Shipping fee" input next to the order
  discount (display total `+ shippingAmt`, payload `...(shippingAmt>0?{shippingFee}:{})`, serialized
  into `OrderDraftPayload.shippingFee` for park/resume — `lib/drafts.ts`); `orders/[id]/page.tsx` renders
  a conditional Shipping totals row + a staff edit-mode fee input threaded through BOTH save paths
  (`handleSaveItems` AND DRAFT `saveThenPublish` — the latter with `replaceAll:false`, a caught blocker:
  fee-only publish previously sent `items:[]` which the API heuristic read as replace-all → wiped lines);
  `e2e/06-critical-paths.spec.ts` CP-03/CP-10 assert `total == subtotal − discount + shippingFee + tax`.
  `CreateOrderModal.tsx` gained a **Minimize** footer button + `resumeDraftId`/`initialScanCode` props:
  parks/hydrates/autosaves (debounced, bound to a draft only after Minimize/Resume) + auto-adds a
  scanned barcode on open + deletes the draft on successful submit. `orders/page.tsx` reads
  `?resumeDraft`/`?scan`/`?action=new` reactively to open the builder. Backend: `api/src/drafts/`.
  **WP-1 (Escape no longer discards the order):** `Modal` (packages/ui) now forwards Radix's
  `onEscapeKeyDown` (the ONLY interception point — Radix's Escape is a document-level capture-phase
  listener that runs before React handlers). `CreateOrderModal` uses it: `handleEscape` swallows Escape
  and clears ONLY the add-item sub-flow (`addItemFlowActive = !!productSearch || customFormOpen` → reset
  search / close+reset the custom-item form + refocus), keeping the order intact; when NOT mid-add,
  Escape falls through to dismiss. `parkDraft()` was extracted from `handleMinimize`; `handleDismiss`
  (wired to the Modal-level `onClose` + the Cancel button — success/merge paths keep the RAW `onClose`)
  auto-parks the in-progress order to a draft on Cancel/backdrop/X/non-sub-flow-Escape (empty session
  closes instantly; a save failure keeps the modal open). Spec: `e2e/08-create-order-escape.spec.ts`.
- **`lib/product-display.ts`** — `displayProductName(product, allProducts?)` composes `"<Parent> - <Variant>"` for variant rows (parent relation → allProducts lookup → bare variant name) + exported `PRODUCT_NAME_SEPARATOR = " - "` (the ONE separator; no hand-composed `·` anywhere). Hand-synced mirror: `apps/mobile/lib/product-display.ts`. **`lib/image-focal.ts`** — product focal-point crop (4:5), image fit.
- **`lib/change-requests.ts`** — shared web ChangeRequest type (`ChangeRequestType`/`Status`/`Resolution`/`ResolveAction`, `ChangeRequest`) + `describeChangeRequest`/`describeResolution` display helpers (pure, no HTTP client; consumed by both operator `orders/[id]/page.tsx` and buyer `orders/[id]/page.tsx`). CR 409 codes (`CHANGE_REQUEST_ALREADY_RESOLVED`, `STOP_ALREADY_COMPLETED`, `LINE_ALREADY_DELIVERED`, `CHANGE_WINDOW_CLOSED`, `EDIT_WINDOW_OPEN`) added to `providers.tsx` `HANDLED_CODES` so the generic mutation toast doesn't double-fire over the components' guided handling.
- **`lib/barcode-resolve.ts`** — `BarcodeResolveHit<T>`/`Miss` types + `ambiguous`/`matches` (aligned with the mobile lib). Fallback rung sends `scanCode=` (server candidate-expansion), not raw `search=`. NOW the ladder for CreateOrderModal + orders/[id] edit too (their inline copies swallowed 5xx as "not found" and skipped unitSku): modal keeps first-row-wins on ambiguous; edit page opens its dropdown with the input text SELECTED so the next wedge scan overwrites. Both surfaces route digit-run (8-14) dropdown terms through `scanCode`; modal's already-added suggestion click now increments qty + clears (was a silent no-op). Exact-match preference (step 2)
  now also matches `unitSku` case-insensitively alongside `sku` (2026-07-23, products-dual-sku WP5) —
  still reported as `source: "sku"` (no new union member).
  **F30 / R5 (2026-08-31) — ported from the mobile lib, keep the two in sync:** third union member
  `BarcodeResolveArchived` (`archived: true`) + exported `archivedMessage(product)`. Both rungs now
  agree about inactive products — the search rung DROPPED `isActive: true` (`limit` 10→20 to
  compensate, since archived rows now compete for the window) and a private `asHit()` classifies
  every resolved row, so the same barcode can no longer read "archived" on mobile and "added" (or a
  false "not found") here. The `ambiguous` `matches` list is SELLABLE-only. ⚠️ **Every committing
  caller branches on `archived` before it commits** — `inventory/page.tsx` restock, `orders/[id]`
  `EditableLineItems.handleScanEnter` (which gained a `useToast`), `CreateOrderModal`'s scan handler,
  `components/inventory/StockCountTab.tsx` — and none of them falls through to "create a new
  product" for a code the catalog already has.
- **`lib/formatting.ts`**, **`lib/export.ts`** (`downloadCsv()`), **`lib/report-export.ts`** — format + CSV/report export. **UTC-safe calendar dates (2026-08-23):** `fmtDate` and new `fmtCalendarDate` format the UTC components (`timeZone:"UTC"`) — invoice/order/bill `issueDate/dueDate/billDate` are stored at UTC midnight and a local-time `toLocaleDateString` showed the PREVIOUS day for any US viewer. Rule: calendar-date fields (no meaningful time-of-day) → `fmtCalendarDate`; real timestamps (`paidAt`, `createdAt`, `@default(now())` columns) keep local rendering — forcing UTC on those would CREATE a day-shift bug. `suppliers/[id]` statement timeline discriminates `row.type === "BILL"` accordingly. **(2026-08-26, WP4)** exports `calendarDaysUntil(d?: string|null): number|null` beside `fmtCalendarDate` — whole calendar days from the viewer's LOCAL today to a UTC-midnight calendar date (negative = overdue by that many days, `null` for missing/invalid). Reads the due date's day in UTC and "today" in local time; the badge variant of the −1-day bug is mixing those the other way round. Callers: `invoices/page.tsx` `renderStatus` (Overdue by Nd / Due Today / Due in Nd — rendered strings unchanged for a UTC viewer, only the day boundary moves).
- **`lib/calendar-date.ts`** (NEW, F25, 2026-09-04, B59/B118) — the shared calendar-date helper,
  mirroring `apps/api/src/common/calendar-date.ts` name-for-name: `calendarDateFromIso`,
  `isoFromCalendarDate`, `calendarDayBounds`, plus a re-export of `fmtCalendarDate` from
  `lib/formatting.ts` so callers get one import. `formatting.ts` gains one export this round,
  `fmtCalendarDateWithWeekday(d, weekday)`, re-exported here beside `fmtCalendarDate` (which stays
  the canonical formatter); this module adds the parse/round-trip/bounds helpers formatting.ts
  didn't have. Consumers: `edit-run-modal.logic.ts` (run-edit modal, via
  `EditRunModal.tsx`) uses `calendarDateFromIso`; `dashboard/page.tsx` imports `fmtCalendarDate`
  from `@/lib/formatting` directly (not from this module). `my-runs/page.tsx` and
  `routes/[id]/dispatch/page.tsx` both render `scheduledDate` through `fmtCalendarDateWithWeekday`
  from `@/lib/calendar-date` (their inline UTC-anchored `toLocaleDateString` calls are gone).
  `deliveries/page.tsx`'s Date column renders the run's `scheduledDate` with `fmtCalendarDate`
  and its `createdAt` fallback with `fmtDate` (local, but the SAME date-only style) — one column,
  one format; a bare `toLocaleDateString()` there stacked "6/10/2026" against "Jun 10, 2026".
  Tests: `lib/formatting.calendar-date.test.ts` (fmtCalendarDate pin),
  `lib/calendar-date.test.ts` (calendarDayBounds T12 mirror pin, twin of the api/mobile specs).
  See L-047.
- **`app/(dashboard)/routes/_components/edit-run-modal.logic.ts`** (NEW, F25, B59) — extracted pure
  logic for the run-edit modal's date field: `readCalendarInput(scheduledDate: string)` (renders
  the stored UTC-midnight date into the `<input type="date">` value via `calendarDateFromIso`) and
  `buildRunPatchBody(args)` sets `scheduledDate` to the raw `YYYY-MM-DD` value only when
  `date !== initialDate` and the run is not IN_PROGRESS — the B59 dirty check; it never converts to
  ISO. Tests: `edit-run-modal.logic.test.ts` (T1/T2), `EditRunModal.test.tsx` (RTL).
- **`lib/invoice-terms.ts`** (new 2026-08-26, WP4) — `getDaysForTerms(terms): number|null` ("Due on Receipt"⇒0, Net 15/30/45/60, anything else null) + `addDaysIso(iso, days)` (UTC end-to-end: `new Date(iso+"T00:00:00Z")` + `setUTCDate`, because local getters/setters lose a day across a DST start — `2026-03-01 + Net 30` returned Mar 30 in America/New_York). Extracted VERBATIM from `invoices/new/page.tsx` (which now imports them — zero behavior change there) so `invoices/[id]/page.tsx`'s `EditTermsModal` shares the same arithmetic. Mirrors mobile's `apps/mobile/lib/invoice-terms.ts` (`dueDateFor`).
- **`lib/use-sortable-data.ts`** — table sort/pagination hook.
- **`lib/stock-count-storage.ts`**, **`lib/buyer-cart.ts`**, **`lib/fetch-pdf-blob.ts`** — local state + PDF blobs. **`lib/print-pdf-blob.ts`** (NEW, WP4, 2026-09-15, R6.6) — `printPdfBlob(blob: Blob)`: `URL.createObjectURL`, hidden `<iframe>` `onload` → `contentWindow.print()`, revokes the object URL after 60s. Lifted VERBATIM out of `invoices/[id]/page.tsx`'s pre-existing `handlePrint` iframe body (zero behavior change there) so `invoices/page.tsx`'s row Print button and `orders/[id]/page.tsx`'s "Invoice Ready" modal Print button share the same print path.
- **`lib/admin-api.ts`**, **`lib/buyer-auth.ts`**, **`lib/buyer-api-client.ts`** — admin & buyer clients/types. **F4 (2026-08-22):** `BuyerSeller.customer` is now `{...} | null` — the API redacts customer identity on non-ACTIVE links, so EVERY portal render site must guard it: `app/buyer/portal/page.tsx` (`SellerCard` — both variants carry `data-testid="seller-card"` since 2026-08-26; e2e 04/17 locate it by that or by role+text, never by class) and the sidebar `app/buyer/portal/layout.tsx` (`SellerItem` shows "Pending approval" instead of a businessName, and is `disabled` unless `linkStatus === "ACTIVE"` — mirroring mobile's `canOpenSeller`, so a redacted row can never be stored as the active seller), plus the `activeSeller.customer` subtitles in `[seller]/{account,dashboard,finances,invoices,orders,payments}/page.tsx` (all switched to `activeSeller?.customer &&` / `?.`). An unguarded dereference throws inside the layout and blanks the whole portal.
- **`lib/api/portal-approvals.ts` (2026-08-20) — the SINGLE home for pending buyer-connect approvals.** Exports `PendingPortalApproval` (the raw link row + its `customer`/`buyerAccount` relations + the flattened `customerName`/`buyerName`/`buyerEmail`/`requestedAt` the API appends), the shared `pendingApprovalsKey` (`["customers", "pending-portal-approvals"]`), `usePendingPortalApprovals(options?: {enabled?})` (60s poll — server state is what makes the bell's "Action needed" rows survive mark-all-read/clear/localStorage loss), and `useApprovePortalRequest()` / `useDeclinePortalRequest()`, which each invalidate the pending list AND `["customers", id, "portal-status"]`. **B449 fix-round finding 2 (2026-09-17):** `GET /customers/pending-portal-approvals` is `@RequirePlanFlag("addon.buyer_portal")` (a dark flag every plan except LITE courtesy-allows) — the hook fired unconditionally from both call sites (header bell + customers list), so a LITE tenant 403'd here on every page load and every 60s poll regardless of route. Now gated on `usePlanFlag("addon.buyer_portal", {enabled: options?.enabled})`: `gateVisible = gate.resolved ? gate.enabled : gate.failed` (resolved → go by the flag; unresolved → don't fire yet; fetch failed → fire, fail-open, same three-valued rule used elsewhere) folds into the query's own `enabled`. The passed-through `options.enabled` ALSO gates the inner `usePlanFlag`'s `useSubscription` call, not just the final fetch — `GET /billing/subscription` is `@Roles(OPERATOR)`, so a CUSTOMER/DRIVER caller passing `enabled:false` must fire ZERO requests here, not a 403 in place of the intended no-op. **`lib/api/customers.ts` deliberately exports none of these** — it used to carry a second `usePendingPortalApprovals`/`useApprovePortalRequest` (plus `useApprovePortalFromList`) on the same cache key with a different declared row shape, so importing from the wrong module silently left the bell row on screen after an approve. Consumers: header bell (`(dashboard)/layout.tsx`), the customers-list banner, the customer-detail Buyer Portal card (approve + decline), and `useNotifications.ts` (socket invalidation).
- **Bell "Action needed" section (2026-08-20)** — `(dashboard)/layout.tsx` `Header` renders `usePendingPortalApprovals()` rows PINNED above the license-expiry section and the localStorage feed (`bellCount = unreadCount + expiring.length + pendingApprovals.length`); each row is "<buyerName> wants to connect" / "<buyerEmail> → <customerName>" and `router.push("/customers/<customerId>")` on select, where Approve/Decline live. Because the rows come from the server they are NOT part of the `AppNotification` feed and NOT cleared by "mark all read"/"clear" — they vanish only when the link is approved or declined (that is what "in the bar until addressed" means). `useNotifications.ts` gained the `"buyer"` `NotificationType` (Users icon) and subscribes to `buyer.connect.requested` (push a feed item + `invalidateQueries(pendingApprovalsKey)` so the pinned row appears without waiting for the 60s poll) and `buyer.connect.autolinked` (informational feed item only — an auto-connect leaves no pending row).
- **`components/ResponsiveSidebar.tsx` (NEW, 2026-09-17, owner build) — the collapsible-sidebar
  pattern shared across shells.** `(dashboard)/layout.tsx`'s `DashboardShell` was the only shell
  with a responsive sidebar (collapse-to-icon-rail on desktop, off-canvas drawer below `lg`) —
  the buyer portal (B479) and platform-admin (B480) shells had a fixed-width `<aside>` with no
  breakpoints at all, the owner's phone complaint. Exports: `useResponsiveSidebar(storageKey)` —
  the STATEFUL pieces extracted verbatim from `DashboardShell` (collapsed persisted to
  `localStorage[storageKey]`, auto-collapsed under a 768px initial width, mobile drawer
  open/close, Esc-to-close, body-scroll-lock while open, closes on route change) — plus four
  presentational pieces whose markup/aria-labels are meant to be byte-identical everywhere:
  `SidebarCollapseToggle` ("Collapse sidebar"/"Expand sidebar"), `MobileNavTrigger` ("Open
  navigation menu"), `MobileSidebarDrawer` (the `role="dialog" aria-modal` overlay — ALSO now
  moves focus into the panel on open and restores it to the trigger on close, a gap the
  dashboard's original implementation never had; every shell picks this up for free) and
  `MobileDrawerCloseButton` ("Close navigation menu"). Each shell keeps its OWN `<aside>` inner
  content (nav items, brand, footer) — too shell-specific to force through one rigid prop API.
  `storageKey` MUST be distinct per shell (`"rf-sidebar-collapsed"` dashboard,
  `"rf-buyer-sidebar-collapsed"` buyer portal, `"rf-admin-sidebar-collapsed"` platform-admin) or
  one shell's collapse preference leaks into another's on the same device. Test:
  `ResponsiveSidebar.test.tsx` (toggle, persistence, key isolation, drawer open/close/Esc/
  backdrop/route-change/scroll-lock, focus in-and-back-out).
  - **`app/buyer/portal/layout.tsx`** applies it: `NavLink` gained a `collapsed` prop (icon-only,
    `title` for a11y, no visible label); the "Your Sellers" dropdown — a dropdown popover doesn't
    fit a 64px rail — collapses to a single icon `NavLink` to `/buyer/portal` instead of trying to
    shrink the dropdown itself. A new mobile-only top bar (`lg:hidden`) carries the hamburger,
    since this shell has no separate header component — the sidebar's own header (brand +
    notification bell) is what the drawer now reveals on mobile.
  - **`app/(platform-admin)/layout.tsx`** applies it: `Sidebar`'s nav list factored into
    `SidebarNavItems({pathname, collapsed, onNavigate})`, rendered once for the desktop rail and
    once inside the drawer. Same new mobile-only top bar pattern as the buyer portal (no
    pre-existing header here either). **B480 carve-out:** the classifier flagged this file
    "touches tenancy" (agent may plan, must not fix unattended) — cleared by an explicit owner
    request (2026-09-17, recorded by the lead, quoted verbatim in B480's record): "we need to
    have the option to close the side bar, and open it whenever we want … It is valid for
    customer side, admins as well as for super admin." Scope stayed to sidebar responsiveness
    only — no auth/tenant-switching logic touched (`SuperAdminGuard` untouched).
  - **`(dashboard)/layout.tsx` deliberately NOT refactored onto this** despite being the pattern's
    origin — its `DashboardShell` is large and heavily depended-on (keyboard shortcuts, command
    palette, draft dock, realtime updates, read-only/impersonation banners, addon/plan-gated nav
    splicing, existing B449/B471 e2e coverage); the extraction itself is a faithful 1:1 copy of
    its logic, so a future low-risk migration stays open, but doing it under this task's own time
    budget wasn't worth the integration risk for a shell that already works. Left as-is, per the
    owner's own "only if low-risk, otherwise leave it and say so."
  - **`app/buyer/layout.tsx`** — B481: removed `maximumScale: 1` / `userScalable: false` from the
    `viewport` export (was locking pinch-zoom portal-wide, failing WCAG 2.1 §1.4.4); now matches
    the root layout, which never had this restriction.
- **Buyer-portal hotfix (2026-08-20): logos + connect copy.** Tenant logos must render via `GET /public/tenants/:slug/logo` (public, streams inline) — NEVER `\${apiUrl}/uploads/\${logoKey}`, which has required JWT-or-signature since RF-075 (2026-05-01) and an `<img>` can send neither; that raw pattern sat broken for 3.5 months in the portal SellerCard, the invite page, and the staff login page (all three now fixed). `ConnectSellerModal` now shows the SERVER's message: the backend auto-approves an exact email match straight to ACTIVE (no seller review since 0a245e89/April), and the modal's old hardcoded "your seller will review" copy told instantly-connected buyers they were pending. **SUPERSEDED the same day** — the "nothing writes `PENDING_SELLER_APPROVAL` anymore / the Approve button + `notifySellerOfRequest` are dead code" residue no longer holds: the identity-gated connect flow (see the `lib/api/portal-approvals.ts` bullet above and api.md `buyer/` "connect flow") writes PENDING again and re-wires both. **Residue still open:** `X-Tenant-Slug` is sourced ONLY from localStorage `activeSeller` — never the `[seller]` URL param — so deep links can misroute; a `[seller]`-layout reconciliation is the proper fix.

- **A5 buyer token-key outage (2026-08-19, client-facing fix):** `buyer-auth.ts` gained **`getBuyerAccessToken()`** — namespaced `rf:buyer:accessToken` first, legacy `"buyerAccessToken"` fallback — the ONLY sanctioned buyer-token read. Password login/register write ONLY namespaced keys while the Google callback backfills both; before A5 the auth context (4 sites), `/buyer/invite/[token]` accept, the portal ConnectSellerModal and `useBuyerNotifications` still read the legacy literal → after a PASSWORD login `GET /buyer/sellers` never fired (sellers stayed `[]`, "no connection with the seller" on any fresh device), and invite-accept was a silent no-op. Seller association itself is server-derived (`buyerAccountId` → `CustomerLink`) and was never broken. Admin buyer impersonation now writes the NAMESPACED key (legacy-only ⇒ portal looked logged-out). `useBuyerDashboard`/`useBuyerShelf`/`useBuyerTemplates` gained `enabled: !!getStoredActiveSeller()` (a call without `X-Tenant-Slug` 400s server-side). The dead `migrateLegacyBuyerToken()` was deleted 2026-08-27 (never called); the legacy fallback inside `getBuyerAccessToken()` STAYS — the Google buyer callback still writes the legacy key. e2e regression: BY-14 "password login fires the authorized /buyer/sellers fetch".
- **`lib/hooks/`** — `useNotifications`, `useBuyerNotifications`, `useRealtimeUpdates` (socket→query invalidation), `useUrlFilters` (filter↔URL), `useDebounce`, **`useUrlSearch` (2026-08-15, search↔URL — search survives Back)**, **`useUrlPage` (2026-08-17, page↔URL — page POSITION survives Back)**. **B343 (#898, 2026-09-19):** `useRealtimeUpdates`'s `creditNote.created` handler now also invalidates `["customers", customerId, "statement"]` (was missing — a statement left open in another tab never refreshed), and a new `creditNote.voided` handler (same invalidation) is wired for `RouteFlowGateway.emitCreditNoteVoided` — void previously fired no event at all.
- **`useNotifications` storage is tenant-scoped (2026-08-28):** bell feed persists under `rf_notifications:<slug>` (slug from `useTenant()` — TenantProvider's `resolveTenantSlug` owns JWT-wins/cookie-self-heal + focus re-resolution), re-hydrating whenever the slug resolves/switches; writes go through a `slugRef` so `push`/`markAllRead`/`clear` keep stable identities for the socket effect. No slug ⇒ no read/write. The legacy global `rf_notifications` key is **deleted on load, never migrated** — its rows can't be attributed to a tenant, and migrating them IS the cross-tenant bell leak (super-admin impersonation showed the previous tenant's history).
- **`useUrlFilters` → `[state, setFilter, clearAll, setFilters]`** — the 4th element `setFilters(partial)` (2026-08-17) applies several keys in ONE write. **Two `setFilter` calls in a row do not both apply**: `router.replace` commits asynchronously, so each call builds its query from the URL as it was before the handler ran and the last replace wins, silently dropping the earlier keys — which is why invoices' "Clear dates" only ever cleared `dateTo`. Any handler touching more than one filter must use `setFilters`. The same asynchrony is why a `setPage(1)` must never sit beside a `setFilter`/`setSearch` call (they already `delete("page")` themselves) — the extra write rebuilds from the pre-filter URL and reverts the filter the operator just picked.
- **`useUrlSearch(key="search", delay=300) → [value, setValue, debouncedValue]`** — drop-in for the `useState("")` + `useDebounce(search,300)` pair every list page declared. Input value stays local (instant typing); only the DEBOUNCED value is mirrored to the URL via `router.replace` (never `push` — replace overwrites the current entry, so an N-char query leaves ONE entry and Back exits the list instead of replaying keystroke-by-keystroke). Fixes the reported bug: search → open a row → Back landed on the UNSEARCHED list, because search was component-local state that died with the unmounted page. Two effects, ordered URL→input then input→URL, with a `settled` ref so our own write never echoes back over in-flight typing; **the write is a shallow `window.history.replaceState`, never `router.replace` (2026-08-26)** — the debounced write can land while a `router.push` to a detail row is in flight, and a router.replace there CANCELS the push (type → click a row within the debounce window → the click was silently swallowed; reproduced on the customers list, e2e BSD-01's create→search→open flow). Next ≥14.1 syncs usePathname/useSearchParams from native history calls, so Back-restore (e2e 12) is unchanged; the write rebuilds params from **`window.location.search`** (live, not the captured `searchParams`) — a debounced write lands a beat late, and the render-time snapshot would resurrect params a filter chip removed (the same stale-snapshot trap `customers/page.tsx`'s `clearAll` comment documents, which a debounced writer hits far more often). Nothing is written on mount (`useDebounce` seeds from the initial value, which already equals `settled`), so `?search=` deep-links hydrate with no flash and no rewrite. **Wired into 13 list surfaces:** products, inventory (`stockSearch`), customers, suppliers, drivers, orders (`customerSearch` — overturns the old "too transient for URL" comment), invoices, estimates, credit-notes, returns, shipments, finance/payments, finance/expenses (vendor-bills tab only). Pages that already debounced before querying keep feeding `debouncedSearch`; pages that filtered client-side or queried raw keep consuming the immediate value (only the URL write debounces) — no fetch/filter behavior changed anywhere. **Modal/sheet/inline-picker searches deliberately stay local** (inventory `refSearch`/`productSearch`, expenses `BarcodeProductPicker`/`createProductSearch`, returns/credit-notes/estimates customer pickers, CreateOrderModal): they have no history entry to return from, and publishing them would let an unrelated Escape/close re-hydrate the box — `e2e/08-create-order-escape.spec.ts:52` pins this. Two companion fixes this exposed: `products/page.tsx` now CONSUMES `?action=new` (it re-ran on every `searchParams` change and would re-open the create modal on the next keystroke), and `orders/page.tsx`'s deep-link effect strips only `action`/`resumeDraft`/`scan` instead of `router.replace("/orders")`, which had been discarding the status/date chips and the search whenever the builder opened from the draft dock. Spec `e2e/12-search-back-nav.spec.ts` (SB-01…04, + its own `search-back-nav` project entry in `playwright.config.ts` — a spec without one NEVER runs, cf. the #08 note) is the suite's ONLY `goBack` coverage and uses `pressSequentially`, since `fill()` sets the value atomically and never exercises the per-keystroke path.
- **`useUrlPage(key="page") → [page, setPage]`** — the **page-position half** of the Back-nav fix whose search half shipped as `useUrlSearch` in #346. Drop-in for the `const [page, setPage] = React.useState(1)` that all **12** dashboard list pages declared: the value is DERIVED from `?page=` instead of held in component state, so it survives the list unmounting when a row is opened, and Back returns to the page the operator left instead of page 1 (the reported bug — raised on mobile products, present identically on desktop). `router.replace`, never `push`, so the list keeps ONE history entry and Back exits instead of walking backwards page-by-page. **Page 1 = ABSENCE of the param**, matching `useUrlSearch`/`useUrlFilters`, which both already `params.delete("page")` when a search or filter re-ranks the list — the param was always in their contract; no page ever wrote it. `setPage` accepts a value or an updater and reads `window.location.search` live (not the render snapshot) so the updater form sees the current page and a concurrent filter write isn't clobbered — same stale-snapshot trap `useUrlSearch` documents. **Wired into all 12 list pages:** products, orders, invoices, customers, credit-notes, estimates, returns, shipments, finance/payments, finance/expenses (TWO call sites — `InventoryPurchasesTab` + `OtherExpensesTab`, both on the default key, safe only because the tab switcher `router.push`es a fresh query string), finance/reports (inside `LedgerReport`, one of ~20 switch-rendered reports), inventory/movements. Specs `PB-01` (page 2 → leave → Back restores page 2) and `PB-02` (a shared `?page=2` is not reset on load — pins the mount guard) in `e2e/12-search-back-nav.spec.ts`, self-skipping on a build that predates the fix like the SB tests beside them.
- **`useClampPage(setPage, page, totalPages)`** (same file) — pulls an out-of-range page back into range once `meta` resolves; no-ops while `totalPages` is undefined/0 (still loading). A URL-backed page can outlive its data in a way component state never could (Back onto `?page=3` after rows were deleted, or a shared/stale link): the list then requests a page past the end and the API returns an empty array with a truthy total, which rendered as a false "no records yet" empty state, a pager windowed around the missing page with **zero** usable buttons, and a caption reading "Showing 1961 to 15 of 15". Wired at all **13** sites (12 pages; finance/expenses twice).
- **`useResetPageOnChange(setPage, values[])`** (same file) — the load-bearing companion at every call site that had a filter-reset effect. The old `useEffect(() => setPage(1), [filters])` also fired **on mount**, which with a URL-backed page strips the `?page=` just restored by Back. It compares `JSON.stringify(values)` against a ref of the previous key instead of skipping the first run with a `didMountRef`, **because a ref survives React StrictMode's mount → cleanup → mount**: the second invocation would see `true` and reset anyway, clobbering the page in dev while working in prod (`reactStrictMode` is unset ⇒ Next 14 defaults it TRUE in dev). Serializing into ONE dep also keeps call sites eslint-clean with an inline array. Needed by only **4** pages (products, orders, customers, finance/payments) — the other 8 call `setPage(1)` inline inside filter handlers, never in an effect, so nothing fires on mount there.
- **`lib/drive-mode.tsx`** — Drive mode (pos-cost-roles-spec §4, "role = permissions; mode = layout").
  `useDriveMode()` → `{ driveMode, setDriveMode(on), toggle() }`, localStorage key `rf-drive-mode`
  (SSR-safe: `false` on server/first render, hydrated in an effect; cross-tab via `storage` event +
  an in-module listener set so same-tab toggles also re-sync). No deps, no API call. Consumed by
  `(dashboard)/layout.tsx` Header (topbar chip + one-tap Exit, avatar-menu toggle) and
  `routes/my-runs/page.tsx` (field-layout switch).
- **`lib/plan-gated-nav.ts` (new, Lite-L2 WP7, 2026-09-15)** — `PLAN_GATED_NAV: Record<string,
FlagKey>` maps a subset of OPERATOR_NAV hrefs (`/returns`, `/suppliers`, `/vendor-bills`,
  `/estimates`, `/credit-notes`, `/finance/reports`, `/analytics`) to the `FlagKey`
  (`@routeflow/types`) that must be granted to see them — `/sales-agents`, dispatch/routes/
  deliveries/drivers stay on their existing addon hooks (`useHasAddon`/`useRoutesAccess`/
  `useDeliveryAccess`), NOT added here. `planFlagVisible(s)` — same three-valued rule as
  `addons.ts`: resolved ⇒ go by the flag; unresolved ⇒ hidden (no flash); fetch failed ⇒ shown
  (client fails OPEN, server guard fails CLOSED). `matchPlanGatedRoute(pathname)` — exact-or-
  prefix match against `PLAN_GATED_NAV`, `null` if none. Test: `plan-gated-nav.test.ts`.
  **B501 fix (#853, 2438e6b9):** `PLAN_GATED_NAV` had no entry for `/invoices/recurring` even
  though that route carries its own server-side `@RequirePlanFlag("flag.recurring_invoices")`
  gate — a denied tenant deep-linking or navigating there got an unhandled 403 instead of the
  graceful lock every other plan-gated route shows via this mirror map. Entry added; test
  coverage in `plan-gated-nav.test.ts` and `PlanGateBoundary.test.tsx`.
- **`(dashboard)/layout.tsx` — plan-gated nav filtering + route lock (Lite-L2 WP8, 2026-09-15):**
  `filterPlanGatedNav(entries, planState)` drops every nav leaf `matchPlanGatedRoute` denies
  (a group left with zero children after filtering is dropped entirely, same precedent as the
  Dispatch-group filter); called in `DashboardShell`'s nav-building `useMemo` BEFORE the
  Analytics-relative inject index is computed, off the SAME `useSubscription({staleTime:60_000,
enabled:isStaff})` call the RO-1 banner already reads (`isSuccess`/`isError` captured
  alongside `data` — no second query). `RouteGuard` gained a SEPARATE `useSubscription` call
  (`enabled: isStaffRole` — CUSTOMER/DRIVER are untouched by plan-flag gating, their own
  GATED_PREFIXES/CUSTOMER_ALLOWED/DRIVER_ALLOWED checks already cover access) and, once
  `subscriptionResolved`, renders `<LockedPage>` (below) IN PLACE OF the page for a deep-
  link/bookmark into a plan-gated route the plan doesn't grant — never a redirect (unlike the
  addon-gated prefixes above), so the URL stays intact. Fails OPEN while unresolved/on a fetch
  error (existing page renders; a server-side PLAN_GATE 403, if any, is still caught by
  `PlanGateNotice`). **Fix-round finding 5 (2026-09-15):** `subscription?.flags`/
  `subscriptionStatus?.flags` can be `undefined` at runtime even though `SubscriptionView.flags`
  is now `flags?: string[]` (an old API build can omit the key entirely) — `RouteGuard`'s
  `planLocked` and `filterPlanGatedNav`'s `planState.flags` both now treat `undefined` as
  "unresolved, fail OPEN" (never gate/hide), distinct from `flags: []` ("resolved, no grants" —
  gate for real). Do not reintroduce `subscription?.flags ?? []` here.
- **B449 (2026-09-17, #804) — `RouteGuard`/the plan-flag lock split into their own files; the
  gated page no longer mounts underneath the lock.** Pre-fix (shipped in #777), `RouteGuard`
  wrapped `children` INSIDE `LockedPage` itself — the locked card rendered on top, but the gated
  page still mounted underneath and fired its own data queries, flashing gated content/errors
  before the lock appeared. Two named exports moved OUT of `(dashboard)/layout.tsx` into their own
  files (a named export from an App Router `layout.tsx` fails `next build`'s layout-file export
  check — finding 1 — and each needed to be unit-testable alone): **`_components/gates/RouteGuard.tsx`**
  (role-based guard: `CUSTOMER_ALLOWED`/`DRIVER_ALLOWED` prefix lists, `GATED_PREFIXES`
  routes/delivery/either addon redirects, `RECURRING_ROUTES_PATHS`/`matchGatedPrefix` — unchanged
  logic, just relocated) now DELEGATES the plan-flag decision entirely to
  **`_components/gates/PlanGateBoundary.tsx`**, a new component taking `{planGateKey, pathname,
subscription, subscriptionResolved, subscriptionErrored, children}`: while resolving it renders
  a spinner (NEITHER the page NOR the lock — the fix's core: `children` never mounts until the
  answer is known), then renders exactly one of `<LockedPage>` (a `Card` skeleton as its own
  children, `children` from the caller only reachable via the unlocked branch) or `{children}`;
  fails OPEN on `subscriptionErrored`/undefined flags, same invariant as before. **The ONE
  navigation notice (finding 2):** when `PlanGateBoundary` decides locked, its own `useEffect`
  fires the toast (naming THIS route's tier + a `secondary` "Want it? Contact us to upgrade." line)
  and calls **`lib/plan-gate-lock.ts`**'s `setRouteLocked(pathname, true)` (a tiny module-level
  `Set<string>`, cleared on unmount) — **`components/PlanGateNotice.tsx`** now checks
  `isRouteLocked(pathname)` FIRST in its `registerPlanGateListener` callback and swallows any
  stray 403-driven gate on that exact path, so a page whose other widgets 403 on unrelated flags
  can never stack a second, contradictory toast on top of the boundary's own. `PlanGateNotice`'s
  dedup key also changed from `gate.flag ?? gate.message` to `pathname` (a burst across several
  DIFFERENT flags failing together on one navigation now coalesces to one toast, not one per
  flag), with an explicit `lastNotified.current = null` reset on `pathname` change so a stale
  dedup entry from the PREVIOUS route can never suppress this one. `lib/api/portal-approvals.ts`
  also picked up an unrelated hardening pass in the same PR (see its own entry below). Specs:
  `PlanGateBoundary.test.tsx`, `RouteGuard.test.tsx` (asserts children are never wrapped inside
  `LockedPage`, pinning the #777 regression shape), `PlanGateNotice.test.tsx`,
  `lib/api/portal-approvals.test.tsx`, `apps/web/e2e/48-lite-locked-route-ux.spec.ts` (see
  `e2e-tests.md`).
- **B471 (2026-09-17) — the locked panel now renders INSIDE the shell, not in place of it.**
  Fixed the "known follow-up" noted above: `DashboardShell` used to be the OUTER wrapper
  (`AuthGuard` rendered `<DashboardShell>{children}</DashboardShell>`, then `AuthGuard`'s own
  `children` was `<RouteGuard>…</RouteGuard>`), so `PlanGateBoundary`'s `<LockedPage>` replaced
  the whole shell — no sidebar/header, only "See plans" or the browser back button to escape a
  locked route. `AuthGuard` now renders `<DashboardShell><RouteGuard>{children}</RouteGuard></DashboardShell>`
  instead (`DashboardLayout` itself just renders `<AuthGuard>{children}</AuthGuard>`) — the
  lock/spinner/real-page decision still happens exactly where it did (inside `RouteGuard` →
  `PlanGateBoundary`), but now lands inside `DashboardShell`'s `<main id="main-content">`, so the
  sidebar and header stay mounted on a locked route. `48-lite-locked-route-ux.spec.ts`'s first
  test extended to assert the sidebar nav's "Dashboard" link is attached to the DOM on a locked
  route (viewport-agnostic — the desktop `<aside>` is CSS-hidden, not DOM-removed, below `lg`).
- **`_components/gates/PlanGates.tsx` `LockedPage` gains an optional `secondary?: string`
  prop (Lite-L2 WP8)** — a plain line rendered under the CTA (e.g. RouteGuard's "Want it?
  Contact us to upgrade."); no link target invented, "See plans" stays the only action.
  Test: `PlanGates.test.tsx` (new — renders with/without `secondary`, CTA target unchanged).
- **`lib/api/plan-flags.ts` / `lib/api/billing.ts`** — see [`api-hooks`](api-hooks.md).
- **`e2e/47-lite-plan-gate.spec.ts` + `playwright.config.ts` `lite-plan-gate` project (Lite-L2,
  2026-09-15)** — R2.2/R2.5/R2.6/R2.8/R3b.8/R4.3/R4.5/R7.7 coverage (sidebar/route gate, Settings
  → Billing "Complete payment", choose-plan/marketing never rendering a "Lite" card).
  Self-skips (`test.skip`) when `PLAYWRIGHT_LITE_TENANT_SLUG` is unset — needs a dedicated
  LITE-plan tenant the shared `operator.json` fixture isn't on. Post-deploy only, NOT in the
  local Playwright allow-list (`apps/web/e2e/LOCAL-LANE.md`) — same convention as the
  sales-agents-gate/compliance-pack-gate/trip-builder-gate projects. **Without the project
  entry the spec never runs** (cf. the #08 note above).

- **`lib/tenant-features.ts` (new, feature grants v2 brief A, 2026-09-17, #825)** —
  `useTenantFeatures(options?)`: `useQuery` wrapping `GET /tenants/me/features` (the
  server-computed shadow-resolver + old-path trace). Query key includes the tenant slug so a
  stale answer can never leak across a tenant switch. **NOT yet a gating read path** (Opus
  review of 9923b87c, item 1) — `usePlanFlag`/nav gates stay on `useSubscription()`
  (`lib/api/plan-flags.ts`, above); this hook exists for a future PR that revisits the switch,
  and for admin/debug surfaces that want the raw resolver trace. Mirrors mobile's
  `lib/tenant-features.ts` byte-for-byte in contract.
- **`lib/feature-modes.ts` (new, feature grants v2 brief C, 2026-09-17, #837)** — pure
  selectors over a tenant's `modes` record (`TenantFeaturesResponse.modes`,
  `packages/types/api/features.ts`). `getRoutesDispatchVisibility(modes?)` →
  `{showScheduledEntry, showAdhocEntry}`: `"scheduled"` hides ad-hoc, `"adhoc"` hides scheduled,
  anything else (unset/mixed/unrecognized) shows both — never narrower on an unknown mode
  string. **Deliberately unwired into any page yet** — brief A's `/tenants/me/features` hook
  isn't consumed by routes pages on this base, so the "unset → before == after" invariant holds
  by construction rather than by testing an unwired call site. Test: `feature-modes.test.ts`.
