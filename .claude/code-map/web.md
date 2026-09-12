# Area: web (`apps/web`)

Next.js 14 App Router operator/buyer dashboard with multi-tenant Radix + Tailwind UI; the
**golden reference** for API flows and DTOs; dev on `:3001`.

## Where to find (this area)

| Need                  | File → symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth & tenant context | `middleware.ts` — tenant slug, mobile redirect; buyer-only guard now bounces to `/login?redirect=<encoded path+search>` (was a silent `/buyer/portal` sweep) and the signed-in landing 307 on `/` prefers `rf-last-portal` when both sessions are live (`/dashboard` default); both decisions delegate to `lib/portal-routing.ts` (portal-switcher, 2026-09-04)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Portal routing (pure) | `lib/portal-routing.ts` (new, portal-switcher 2026-09-04) — `OPERATOR_PATH_PREFIXES`/`isOperatorPath()` (moved verbatim off `middleware.ts`), `resolveOperatorPathGuard({pathname,search,opAuthed,buyerAuthed})` → `/login?redirect=…` or `null`, `resolveLandingTarget({opAuthed,buyerAuthed,lastPortal})` → `/dashboard`\|`/buyer/portal`\|`null`, `safeOperatorRedirect(raw)` (open-redirect guard for `/login`'s `?redirect=`, falls back to `/dashboard`), `portalSwitchTarget(to,presence)` + `PORTAL_SWITCH_LABELS` (feeds `PortalSwitchLink`). Unit-tested in `lib/portal-routing.test.ts`.                                                                                                                                                                                                                           |
| Presence cookies      | `lib/presence-cookies.ts` — `rf-op-auth`/`rf-buyer-auth`, 30-day TTL = refresh-token TTL; re-set on refresh, cleared on dead session (feeds the middleware redirect). Also `hasOpPresence()`/`hasBuyerPresence()` (readers, `=== "1"` only) and `setLastPortalCookie("op"\|"buyer")` (writes `rf-last-portal`, same TTL/attrs) — written once by `(dashboard)/layout.tsx`'s `AuthGuard` effect and `buyer/portal/layout.tsx`'s auth effect after their session is confirmed (portal-switcher, 2026-09-04).                                                                                                                                                                                                                                                                                                                    |
| Portal presence hook  | `lib/hooks/usePortalPresence.ts` (new) — `usePortalPresence(): {op, buyer}`; reads `hasOpPresence()`/`hasBuyerPresence()` inside a `useEffect` only (never during render), so server render and first client paint both see `{op:false, buyer:false}` — the hydration-safety contract `PortalSwitchLink` and the two sign-in-page notices depend on (R8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Portal switch link    | `components/PortalSwitchLink.tsx` (new) — presence-aware `<a>` via `usePortalPresence()` + `lib/portal-routing.ts#portalSwitchTarget`; `to="buyer"` in the dashboard avatar menu (`(dashboard)/layout.tsx`, `asChild` under `DropdownMenu.Item`), `to="op"` in the buyer sidebar footer (`buyer/portal/layout.tsx`, above Sign Out). SSR/first paint always renders the sign-in variant — no hydration mismatch.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Operator auth model   | `lib/auth.ts` — `AuthUser`, refresh-on-401, `changePassword`/`setPassword` (Google-only first password; both store the rotated pair), `onCrossTabTokenChange()`; the RF-077 legacy-key migration helpers were DELETED 2026-08-27 (never called anywhere — pre-RF-077 sessions expired within the 30d refresh TTL back in May)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Auth hook             | `lib/auth-context.tsx` — `useAuth()`, sign-in/out, user/role state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Token namespaces      | `lib/auth-keys.ts` — `OP_KEYS`, `BUYER_KEYS`, `DRIVER_KEYS` (localStorage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tenant slug cookie    | `lib/tenant-cookie.ts` — `setTenantCookie()`, `getTenantCookie()`, `clearTenantCookie()` (non-httpOnly, 30d)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Google sign-in start  | `lib/google-oauth.tsx` — `startGoogleSignIn({context,tenantSlug})` + `GoogleIcon` (shared by login, buyer login, re-auth sheet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Forgot/reset pages    | `app/(auth)/forgot-password` + `reset-password` (staff, `surface:"web"`), `app/buyer/forgot-password` + `buyer/reset-password` (buyer endpoints); enumeration-safe. **F3-004**: both reset pages capture the `?token=` into state then `history.replaceState` it out of the URL, and get a route-scoped `Referrer-Policy: no-referrer` (next.config) so the single-use token can't leak via history/Referer. `app/buyer/verify-email` (2026-08-20) mirrors the token-capture pattern for registration email verification (`buyerVerifyEmail` in `lib/buyer-auth.ts`) but requires an EXPLICIT button click — no auto-verify on load, so mail-scanner JS prefetch can't confirm an attacker-registered account; `app/buyer/portal/page.tsx` `VerifyEmailBanner` (profile-driven, best-effort) offers `buyerResendVerification` |
| Signup email verify   | `app/verify-email/page.tsx` (operator) — auto-POSTs `?token=` to `/auth/verify-email`, stores `OP_KEYS` + `setOpPresenceCookie()` + tenant cookie (mirrors `lib/auth.ts login()`), then FULL `window.location.replace("/dashboard")` — a client-side push would leave the already-mounted root AuthProvider unauthenticated and AuthGuard would bounce to /login (same constraint as `(auth)/callback`)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Password set/change   | settings `MyAccountTab` `PasswordCard` (set mode when `GET /users/me hasPassword=false`); buyer `app/buyer/change-password` (set mode via `GET /buyer/auth/profile`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| HTTP client & headers | `lib/api-client.ts` — axios, base URL, Bearer + X-Tenant-Slug, 401 refresh queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Buyer HTTP client     | `lib/buyer-api-client.ts` — isolated, reads BUYER_KEYS only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Super-admin client    | `lib/admin-api.ts` — `superAdminClient`, impersonation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Operator login        | `app/(auth)/login/page.tsx` — workspace picker. Reads `?redirect=` at submit time via `new URLSearchParams(window.location.search).get("redirect")` → `safeOperatorRedirect(...)` (single default export `LoginPage`, no Suspense boundary, so `/login` keeps prerendering its form) and navigates to the result on success (`forcePasswordChange` still wins); when `rf-buyer-auth=1` shows a `role="status"` notice "Go to buyer portal"; footer reads "Sign in to the buyer portal" (portal-switcher, 2026-09-04)                                                                                                                                                                                                                                                                                                          |
| OAuth callback        | `app/(auth)/platform/auth/callback/page.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Buyer login & portal  | `app/buyer/login/page.tsx`, `app/buyer/layout.tsx`. When `rf-op-auth=1` the login page shows a `role="status"` notice "Go to seller dashboard"; footer (+ `app/buyer/register/page.tsx`'s) reads "Sign in to the seller dashboard" (portal-switcher, 2026-09-04)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Buyer auth hook       | `lib/buyer-auth-context.tsx` — `useBuyerAuth()`, active seller, multi-seller switch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tenant branding       | `components/tenant-provider.tsx` — fetch branding, inject CSS vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Security & headers    | `next.config.mjs` — CSP, X-Frame-Options DENY, hardening                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Socket.io realtime    | `lib/socket.ts` — `connectSocket()`, `getSocket()`, reconnect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
- **`next.config.mjs`** — standalone output (Docker), CSP headers, X-Frame-Options DENY, image domains. **CSP `frame-src 'self' blob: https:`** (2026-08-21) — without it iframes fell back to `default-src 'self'` and every blob:/API-origin PDF preview (invoice scan, invoice builder, customer docs) rendered blank while `<img>` previews worked; `data:` deliberately excluded from frames. **`Permissions-Policy: camera=(self), geolocation=(self)`** — `camera=()` previously disabled the in-browser barcode/invoice scanner on Android Chrome ("access denied"; iOS Safari ignored it). The `headers()` CSP string itself is now built by `csp.mjs` (below) — `next.config.mjs` just computes `isDev` and calls `buildContentSecurityPolicy({ isDev, apiUrl: process.env.NEXT_PUBLIC_API_URL })`.
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
  Admin toggle: `(platform-admin)/admin/tenants/[id]/page.tsx` `AVAILABLE_ADDONS` += `msrp`.
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
- **`lib/stock-count-storage.ts`**, **`lib/buyer-cart.ts`**, **`lib/fetch-pdf-blob.ts`** — local state + PDF blobs.
- **`lib/admin-api.ts`**, **`lib/buyer-auth.ts`**, **`lib/buyer-api-client.ts`** — admin & buyer clients/types. **F4 (2026-08-22):** `BuyerSeller.customer` is now `{...} | null` — the API redacts customer identity on non-ACTIVE links, so EVERY portal render site must guard it: `app/buyer/portal/page.tsx` (`SellerCard` — both variants carry `data-testid="seller-card"` since 2026-08-26; e2e 04/17 locate it by that or by role+text, never by class) and the sidebar `app/buyer/portal/layout.tsx` (`SellerItem` shows "Pending approval" instead of a businessName, and is `disabled` unless `linkStatus === "ACTIVE"` — mirroring mobile's `canOpenSeller`, so a redacted row can never be stored as the active seller), plus the `activeSeller.customer` subtitles in `[seller]/{account,dashboard,finances,invoices,orders,payments}/page.tsx` (all switched to `activeSeller?.customer &&` / `?.`). An unguarded dereference throws inside the layout and blanks the whole portal.
- **`lib/api/portal-approvals.ts` (2026-08-20) — the SINGLE home for pending buyer-connect approvals.** Exports `PendingPortalApproval` (the raw link row + its `customer`/`buyerAccount` relations + the flattened `customerName`/`buyerName`/`buyerEmail`/`requestedAt` the API appends), the shared `pendingApprovalsKey` (`["customers", "pending-portal-approvals"]`), `usePendingPortalApprovals()` (60s poll — server state is what makes the bell's "Action needed" rows survive mark-all-read/clear/localStorage loss), and `useApprovePortalRequest()` / `useDeclinePortalRequest()`, which each invalidate the pending list AND `["customers", id, "portal-status"]`. **`lib/api/customers.ts` deliberately exports none of these** — it used to carry a second `usePendingPortalApprovals`/`useApprovePortalRequest` (plus `useApprovePortalFromList`) on the same cache key with a different declared row shape, so importing from the wrong module silently left the bell row on screen after an approve. Consumers: header bell (`(dashboard)/layout.tsx`), the customers-list banner, the customer-detail Buyer Portal card (approve + decline), and `useNotifications.ts` (socket invalidation).
- **Bell "Action needed" section (2026-08-20)** — `(dashboard)/layout.tsx` `Header` renders `usePendingPortalApprovals()` rows PINNED above the license-expiry section and the localStorage feed (`bellCount = unreadCount + expiring.length + pendingApprovals.length`); each row is "<buyerName> wants to connect" / "<buyerEmail> → <customerName>" and `router.push("/customers/<customerId>")` on select, where Approve/Decline live. Because the rows come from the server they are NOT part of the `AppNotification` feed and NOT cleared by "mark all read"/"clear" — they vanish only when the link is approved or declined (that is what "in the bar until addressed" means). `useNotifications.ts` gained the `"buyer"` `NotificationType` (Users icon) and subscribes to `buyer.connect.requested` (push a feed item + `invalidateQueries(pendingApprovalsKey)` so the pinned row appears without waiting for the 60s poll) and `buyer.connect.autolinked` (informational feed item only — an auto-connect leaves no pending row).
- **Buyer-portal hotfix (2026-08-20): logos + connect copy.** Tenant logos must render via `GET /public/tenants/:slug/logo` (public, streams inline) — NEVER `\${apiUrl}/uploads/\${logoKey}`, which has required JWT-or-signature since RF-075 (2026-05-01) and an `<img>` can send neither; that raw pattern sat broken for 3.5 months in the portal SellerCard, the invite page, and the staff login page (all three now fixed). `ConnectSellerModal` now shows the SERVER's message: the backend auto-approves an exact email match straight to ACTIVE (no seller review since 0a245e89/April), and the modal's old hardcoded "your seller will review" copy told instantly-connected buyers they were pending. **SUPERSEDED the same day** — the "nothing writes `PENDING_SELLER_APPROVAL` anymore / the Approve button + `notifySellerOfRequest` are dead code" residue no longer holds: the identity-gated connect flow (see the `lib/api/portal-approvals.ts` bullet above and api.md `buyer/` "connect flow") writes PENDING again and re-wires both. **Residue still open:** `X-Tenant-Slug` is sourced ONLY from localStorage `activeSeller` — never the `[seller]` URL param — so deep links can misroute; a `[seller]`-layout reconciliation is the proper fix.

- **A5 buyer token-key outage (2026-08-19, client-facing fix):** `buyer-auth.ts` gained **`getBuyerAccessToken()`** — namespaced `rf:buyer:accessToken` first, legacy `"buyerAccessToken"` fallback — the ONLY sanctioned buyer-token read. Password login/register write ONLY namespaced keys while the Google callback backfills both; before A5 the auth context (4 sites), `/buyer/invite/[token]` accept, the portal ConnectSellerModal and `useBuyerNotifications` still read the legacy literal → after a PASSWORD login `GET /buyer/sellers` never fired (sellers stayed `[]`, "no connection with the seller" on any fresh device), and invite-accept was a silent no-op. Seller association itself is server-derived (`buyerAccountId` → `CustomerLink`) and was never broken. Admin buyer impersonation now writes the NAMESPACED key (legacy-only ⇒ portal looked logged-out). `useBuyerDashboard`/`useBuyerShelf`/`useBuyerTemplates` gained `enabled: !!getStoredActiveSeller()` (a call without `X-Tenant-Slug` 400s server-side). The dead `migrateLegacyBuyerToken()` was deleted 2026-08-27 (never called); the legacy fallback inside `getBuyerAccessToken()` STAYS — the Google buyer callback still writes the legacy key. e2e regression: BY-14 "password login fires the authorized /buyer/sellers fetch".
- **`lib/hooks/`** — `useNotifications`, `useBuyerNotifications`, `useRealtimeUpdates` (socket→query invalidation), `useUrlFilters` (filter↔URL), `useDebounce`, **`useUrlSearch` (2026-08-15, search↔URL — search survives Back)**, **`useUrlPage` (2026-08-17, page↔URL — page POSITION survives Back)**.
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

## Routes (`app/`)

### `(auth)/` — operator login & OAuth

**Sign-in redesign (2026-09-08, PR #663, spec 46):** `login/`, `signup/`, `signup/check-email/`,
`forgot-password/`, `reset-password/` now render through the shared `AuthShell`
(`components/auth/` — see "Components & shared" below); request/redirect/branch logic is
byte-identical to before, only the chrome changed. `admin-login/page.tsx` and
`platform/auth/callback/page.tsx` are untouched (outside AuthShell's scope).

- `login/page.tsx` — workspace picker, email/password, legacy token migration.
- `signup/page.tsx`, `signup/check-email/page.tsx` — signup + confirmation (check-email's fenced
  heading stays `Check your inbox`, no trailing period).
- `forgot-password/page.tsx`, `reset-password/page.tsx` — reset flow (reset-password's
  invalid-token state keeps its old heading text as a state-derived `AuthShell` title; valid
  state is the fenced `Choose a new password`).
- `admin-login/page.tsx` — super-admin login (uses `superAdminClient`).
- `platform/auth/callback/page.tsx` — Google OAuth callback.

### `(dashboard)/` — operator dashboard (middleware-guarded)

- `dashboard/page.tsx` — KPI cards (pending orders, routes, drivers, receivables), tables.
- **Developer-mode gate (2026-08-20), split into two per-tenant addons (2026-08-25), NARROWED
  2026-08-28.** Dispatch/routes/drivers and order-delivery/deliveries are per-tenant features, so
  every entry point is gated. `RECURRING_ROUTES_ADDON` gates Dispatch/routes/drivers,
  `ORDER_DELIVERY_ADDON` gates Deliveries/trips, read through `useRoutesAccess()`/
  `useDeliveryAccess()` in `lib/api/addons.ts`. **Owner decision 2026-08-28: `developer_mode` no
  longer unlocks either feature client-side** — both helpers are now the feature addon ALONE
  (`{enabled: rr.enabled, resolved: rr.resolved}`), and `git grep useDeveloperMode apps/web`
  matches only its definition in `lib/api/addons.ts` (kept exported for mobile-mirror parity and
  future in-dev surfaces; web has none today).
  **No longer UI-only — the dispatch API is server-enforced** (`@RequireAddon` on `/routes`,
  `/route-runs`, `/drivers`, `/trips`, route-optimization; see [api](api.md) `billing/` →
  "Dispatch API gate"), so an ungated surface now 403s instead of degrading to an empty state.
  Consequence: **every query hitting those endpoints must carry `enabled:` on the same access
  gate that hides what it feeds**, or an unentitled tenant polls 403s — `useRoutes`/`useRouteRuns`
  (`lib/api/routes.ts`) and `useDrivers` (`lib/api/drivers.ts`) gained an `options.enabled`
  passthrough for exactly this. `lib/drive-mode.tsx` is untouched; only its entry points are gated.
  **Launch reversal = grep `useRoutesAccess`/`useDeliveryAccess`** and delete the conditions.
  - `layout.tsx` (**2026-08-26 owner-spec nav merge — ONE adaptive Dispatch group**): the
    standalone "Deliveries" group is GONE. Dispatch children = Overview `/dispatch` · Routes
    `/routes` (routesAccess-gated leaf) · Order delivery `/deliveries` (deliveryAccess-gated
    leaf) · Drivers `/drivers`; the group itself shows on
    `routesAccess || deliveryAccess` (2026-08-28: the `devMode ||` disjunct is gone from every
    condition in this file), leaves filtered per-feature inside it, and the
    `canActAsDriver` "My Routes" injection always targets Dispatch. `DRIVER_NAV`'s `/routes`
    leaf still needs `routesAccess || deliveryAccess`
    (a driver runs stops from either kind of route). `RouteGuard` swaps `DEV_MODE_PREFIXES` for
    `GATED_PREFIXES` — `/dispatch` (`need:"either"` since the merge), `/routes`
    (`need:"routes"`), `/deliveries`
    (`need:"delivery"`), `/drivers` (`need:"either"`) — resolved by `matchGatedPrefix()`, which
    (a) skips `/routes/trips*` entirely so a delivery-only tenant reaches the trips→deliveries
    redirect stub instead of bouncing to /dashboard, and (b) downgrades every `/routes` path
    outside `RECURRING_ROUTES_PATHS = {"/routes","/routes/create"}` to `need:"either"` — an
    ad-hoc delivery has NO detail page of its own, so `/routes/:id` (also where
    `deliveries/new` lands after a successful dispatch), `/routes/templates/:id` and
    `/routes/my-runs` must stay reachable on delivery access alone. Non-allowed paths redirect
    to `/dashboard`, each keyed on **its own `resolved`, not `!isLoading`**, so they
    fail OPEN both in flight and on an errored fetch. `g r`/`g d` chords
    no-op and their two `SHORTCUTS` rows are filtered out (the list is a `useMemo(…, [routesAccess])`);
    `Header` gates the topbar drive-mode pill and the avatar-menu "Drive mode" on `routesAccess`.
  - `dashboard/page.tsx`: `canActAsDriver` ANDs in `routesAccess` (`useRoutesAccess()`,
    which hides the ModeSwitcher and the driver viewMode branch), and the New-Route quick action,
    Scheduled-Routes + Active-Drivers StatCards, Scheduled-Route-Runs card and Driver-Status card
    are each gated on that SAME flag — a `recurring_routes`-only tenant that switches to the
    Driver view must not land on a blank page. The LowStockPanel after them stays. **2026-08-28:**
    its two 30s polls (`useRouteRuns`, `useDrivers`) also take `enabled: routesAccess` — `/route-runs`
    and `/drivers` 403 without a dispatch addon, so the polls must stop with the cards.
  - `components/CommandPalette.tsx`: `useStaticCommands` filters `ROUTES_COMMAND_IDS`
    (`nav-routes`, `nav-drivers`, `act-new-route`) on `routesAccess` and `DELIVERY_COMMAND_IDS`
    (**`act-plan-trip`** — 2026-08-24 — `nav-deliveries`) on `deliveryAccess`, both in its memo
    deps. No new nav leaf or chord.
  - `customers/[id]/page.tsx` (2026-08-28, NOT behind the shell's `RouteGuard`): the "Assign to
    Route" button renders only on `routesAccess`, and `AssignRouteModal`'s `useRoutes` takes
    `enabled: isOpen && routesAccess` — the modal is always MOUNTED (`isOpen` is a prop, not a
    mount condition), so without the double-gate every customer page fired a 403 `/routes` fetch.
- **Settings HUB redesign (full-hub):** `settings/page.tsx` is now a **grouped-card hub landing** instead of a tab strip. `SettingsPageInner` reads `?tab=` via **`useSearchParams`** (page-default wraps it in `<React.Suspense>` for the Next-14 prerender rule); **no tab → `settings/_components/SettingsHub.tsx`** (data-driven groups **Business profile / Team / Finance / Data & import / Integrations / Compliance** + a My-account footer, search filter + "frequently used" chips, app tokens navy/brand not raw mockup teal; **masonry columns** so each card is content-height [no empty stretch], single-purpose groups render as ONE clickable card [no redundant repeated link], multi-item groups = header + link list, subtle hover lift; role/addon gating — Regulated item `show:"admin"`, Tobacco `show:"tobacco"` via `useHasAddon(TOBACCO_ADDON)` — with empty groups auto-hidden); **a tab → that ONE screen** from a `SECTIONS` map (`profile/notifications/users/email/invoicing/costing/remittance/integrations/account` + admin-only `regulated`) rendered under a `← All settings` `NextLink` back link. The old `<Tabs.Root>`/`TabTrigger` strip + Radix `@radix-ui/react-tabs` import were removed; the **in-tab Zoho importer (`ImportTab`/`ProductsImportCard`/`ImportCard`/`IMPORT_SECTIONS`/`splitCsvRows`/`parseCSVLine`) was deleted** in favor of the richer standalone `/settings/import` (the `?tab=import` deep-link now `router.replace`s there). Existing deep-links (`?tab=email` from invoices, `?tab=regulated` from compliance) still land directly on their screen; every tab CONTENT component is reused unchanged. The four formerly-orphaned sub-pages (`/settings/billing`, `/settings/import`, `/settings/migration`, `/settings/batch-import`) are now surfaced as hub links. Verified in-browser (hub renders all groups/links/gating) + verify 18/18; local `next build` still hits the pre-existing react-dom hoisting quirk (Dockerfile-handled in prod, not this change).
- **Plan-change routing (B58, F18, 2026-09-06):** `lib/api/billing.ts` mirrors the API's `PlanChangeAction`/`PlanChangePreview` types (spread onto `PlanChangeQuote.change`) and adds `dispatchPlanChange(action, mutations, opts) → {outcome}` — the ONE place that decides which mutation a quote commits through: `SUBSCRIBE`→`subscribe.mutate`, `UPGRADE`→`upgrade.mutate`, `DOWNGRADE`→`downgrade.mutate` (carries the LIVE billing cycle read off the page, never the quote's own), `KEEP_CURRENT`→`resume.mutate`, `NOOP`/`CONTACT_SALES`→no commit (`CONTACT_SALES` returns `{outcome:"contact-sales"}` — its control is the sales-hand-off link, not a mutation). `choose-plan/page.tsx`'s `commit()` calls `dispatchPlanChange` exclusively now — pre-F18 it called `subscribe.mutate` unconditionally, which is B58 itself. The seat-acknowledgement checkbox gates on `changeAction === "DOWNGRADE" && preview?.change?.seatAckRequired === true` (server-computed, never guessed client-side); a failed quote/preview calls `clearPreview()` (wipes the summary card with no error toast yet — filed as B219). `settings/billing/page.tsx` gained a **"Keep current plan"** button beside the scheduled-downgrade banner (`resume.mutate()` — the self-service undo that clears the downgrade markers without touching the plan or period; a re-subscribe would reset `periodStart`/`periodEnd` instead). E2E: `e2e/33-change-plan-routing.spec.ts` + its own `playwright.config.ts` project `change-plan-routing` (operator storage state) — REG-B58 (T2/T4, **proven-pending-deploy**): an UPGRADE quote commits via `POST /billing/subscription` and a DOWNGRADE via `POST /billing/subscription/downgrade`, **never** `/billing/subscribe`; a third test proves the `PlanGates` upsell CTA still lands on a chooser that routes UPGRADE correctly (Amendment 2). Unit: `lib/api/billing.test.ts` (new) pins `dispatchPlanChange` per action.
- `settings/page.tsx` — branding, invoice numbering, delivery defaults. `settings/import/page.tsx` — bulk import. **Remittance / how-to-pay (P5-14):** local `RemittanceTab()` (mirrors `CostingTab`'s shape — `useToast`, `useAuth` isAdmin gate on `TENANT_ADMIN`, one `form` state hydrated from `useRemittanceConfig()` via `useEffect`, save via `useUpdateRemittanceConfig()` sending the whole form [server merges, `""` clears a field], inputs `disabled={!isAdmin}`) registered as `<TabTrigger value="remittance" icon={<Landmark/>}>How to Pay</TabTrigger>` + `<Tabs.Content value="remittance">` after the costing tab/content; consumes new `lib/api/remittance.ts`.
- **F17 import/migration robustness (B08 + R5, 2026-08-31):** `settings/migration/page.tsx` — the source picker's
  `SOURCES` entries carry a `connected` flag, and **Start migration is now `disabled` (label "Connector coming
  soon") for any source with `connected: false`** (Zoho Books, QuickBooks). Previously the button started a job
  for them, but `SourceConnectorRegistry`'s `OAuthConnectorStub` throws and is never even injected — so the
  "connector" was only ever the same manual CSV upload. Wiring real OAuth is a feature, not this fix.
  ⚠️ Same file, NOT fixed here and filed as **B205**: `parseProductsCsv` still naive-splits on `,`, so a
  quoted spreadsheet money cell (`"1,234.56"`) tears the row apart (price→`"1`) and shifts every later column;
  the API side (`MigrationService.optNum`) then does `Number(v)` → NaN and drops the price while the hub
  reports success. A quote-aware `splitCsvLine` + `parseImportNumber`-based `optNum` was written in this batch
  and **reverted**: routing `pricePerUnit` through it turned a present-but-unparseable price from a loud
  `products.create` throw into a **silent $0.00 commit**, and `parseFloat` leniency admitted `-$5`/`12abc`on a
path that calls`ProductsService.create()`in-process and therefore never runs the class-validator DTO.
With no web unit runner (campaign decision D1) the parser half is unprovable here — B205 needs its own batch
with an e2e that uploads a quoted CSV and asserts the staged price.`settings/import/page.tsx`—`ImportResult`gained`duplicates?: number`, surfaced in the success toast and the
card's result badge, because `importPayments`now reports rows it skipped as re-uploads (B99). e2e`25-migration-hub.spec.ts`(REG-B08) +`26-import-duplicates.spec.ts`prove both, each with its **own`playwright.config.ts` project entry** — a spec without one never runs (see 22-payment-truth's header).
  ⚠️ Neither spec self-skips on build age: on these surfaces a pre-change build and a REGRESSED build look
  identical, so a skip would swallow the exact regression the spec exists to catch. ci.yml's deployed-SHA gate
  handles staleness instead.
- **Buyer shop — Catalogue v2 (P5-02):** `buyer/portal/[seller]/shop/page.tsx` rebuilt into a category-rail + rich-tile catalog composing `shop/_components/*` (`CategoryRail`, `ProductTile`, `ShopSearch`, `QtyStepper`, `tile-pricing.ts`). Rail = All + smart collections (Your usuals/Favorites/New/Deals, server-filtered via `?collection=`) + per-category counts + **locked regulated categories** (rail affordance + info panel only, never product data; clicking a locked cat issues NO product request — query inputs held byte-identical so React Query serves cache). Tiles: multi-image 4:5 focal dot-pager (`objectPositionForUrl`), **struck promo price with cent-parity to the cart** (`tile-pricing.ts` `deriveTilePrice` mirrors the cart's derivation exactly — both consume the shared `toPromotionRules` from `lib/api/buyer.ts` → `applyBestPromotion`), stock-state text, Deal/New/Running-low/Featured chip (one, priority order), inline qty stepper. Default sort **"Best for you"** (replenishment frequency). Search dropdown (name/SKU/barcode). `lib/api/buyer.ts` += `useBuyerCatalogCounts`/`useBuyerReplenishment` hooks, additive optional `BuyerProduct` fields (isNew/isDeal/imageUrls/stockStatus/stockLeft), `toPromotionRules` (the ONE shared promo-rule mapping — cart `page.tsx:84` + shop `page.tsx:173` both call it). Buyer web only (mobile = P5-16 deferred); no migration.
- **Stock alerts / Notify-me (P5-03):** `lib/api/buyer.ts` += `useBuyerStockAlerts` (`GET /buyer/stock-alerts` → `{productIds}` of PENDING alerts, staleTime'd) + `useSubscribeStockAlert`/`useUnsubscribeStockAlert` (`POST|DELETE /buyer/products/:id/stock-alert`, invalidate `["buyer","stock-alerts"]`+`["buyer","products"]`+`["buyer","product",productId]`); `BuyerProductDetail` gains `alertSubscribed?: boolean`. `shop/_components/ProductTile.tsx` gains optional `isAlertSubscribed?`/`onToggleStockAlert?` props — when `outOfStock` (and no cart item) renders a **Bell** (lucide-react) Notify-me toggle instead of the disabled Add button (outlined "Notifying ✓" when subscribed, solid "Notify me" otherwise); in-stock tiles unchanged. `shop/page.tsx` wires the three hooks, builds `alertIds = new Set(stockAlerts?.productIds ?? [])`, and passes `isAlertSubscribed={alertIds.has(p.id)}` + a `toggleStockAlert(productId)` handler to grid-view tiles (list view unaffected). Money/pricing (`tile-pricing.ts`/`deriveTilePrice`) untouched.
- **Order create / scan-to-add:** `orders/_components/CreateOrderModal.tsx` and `invoices/new/page.tsx` both **auto-scroll the just-scanned line into view** (ref-map + `scrollIntoView`); CreateOrderModal pre-fills remembered price (`useCustomerPriceHistory`). **Regulated line tagging + split preview (T3-07):** CreateOrderModal consumes `useTrackedCategories({active:true},{enabled:isOpen})` → `categoryById` map + `lineCategory(li)`; regulated cart lines get a `"{Category} · regulated"` amber chip + amber-inset row, and an `invoiceSplit` memo (mirrors the API `groupOrderLinesForInvoicing`: each `SEPARATE_INVOICE` category = own invoice, rest fold to Standard) renders a "Splits into N invoices" preview block above Order totals when a split would occur (pre-tax subtotals shown). Display-only; mobile mirror deferred (P10-REG-4).
- **Orders/fulfillment:** `orders/page.tsx` (status views, bulk delete, export; **P5-11**: amber pending-CR pill next to the status badge, reads `_count.changeRequests` from the list payload — absent field = no pill, no per-row fetching), `orders/[id]/page.tsx` (items, pricing tiers, timeline, return, send to route; **P5-08 (R1-relaxed)**: `canEdit` honors the server `order.editWindow.editable` — **R1**: now editable at every live stage incl. OUT_FOR_DELIVERY/DELIVERED (only CANCELLED closes it; dispatch no longer does), so `canEditPrice` follows and the "Out for delivery — editing closed" chip (guarded on `closedReason==="DISPATCHED"`) went inert — **F07/B10 (2026-09-01) fixed exactly that**: the chip now renders for EVERY reason the API can emit (`closedReason` truthy), showing "Order cancelled — editing closed" on the staff `"STATUS"` branch and keeping the old copy for the buyer-only `"DISPATCHED"` value, so a cancelled order explains itself instead of silently dropping the Edit Items button. Proven post-deploy by e2e spec 27 (`REG-B10`). Note also that F07's cancel marks every line item CANCELLED, so the summary panel's "Line items"/"Total quantity" read `summaryLineItems` — all lines on a CANCELLED order, the usual active-only filter otherwise — or a cancelled order would report 0 beside its real money totals; keeps a status fallback + an "Edited N×" revision-count chip [hover = per-revision v/actor/date/total]. `lib/api/orders.ts` Order += `revisions?: OrderRevision[]` + `editWindow?:{editable,editableUntil,closedReason}`; **inline per-line unit-price edit + "$ off/unit" discount on DRAFT/PENDING/CONFIRMED** (gated by `canEditPrice={canEdit}`; was DRAFT-only) via `PriceEditRow` → net `unitPrice`/`overrideReason` to `PATCH /orders/:id/items`; reads `MANUAL` priceType strikethrough; `EditableLineItems` pre-fills remembered price from `useCustomerPriceHistory` + auto-scrolls the scanned row into view; `handleSaveItems` sends an incremental diff with **`replaceAll: false`** so adding an item never deletes the untouched lines; **P5-11**: "Change Requests" `Card` (main column) resolves PENDING post-dispatch CRs — Approve at stop / Approve as next delivery (ADD_ITEM + CHANGE_QTY-increase only) / Decline (reason required) via `useResolveChangeRequest`; a lost 409 race (`CHANGE_REQUEST_ALREADY_RESOLVED`) → toast + refetch, never retry; `REGULATED_AUTH_REQUIRED` routes into the existing `LicenseGuardModal` retry via `guardError`; header shows an amber "N pending" change-request chip; **RF-4:** a "Regulated tax" totals line (Σ non-cancelled `lineItems.categoryTaxAmount`) renders when >0 so Subtotal + Tax + Regulated tax reconciles to the server `order.total` — shown in both the read view and the edit preview; `lib/api/orders.ts` OrderItem += `categoryTaxAmount?`/`trackedCategoryId?`); `routes/page.tsx`, `routes/create/page.tsx` (pick stops → optimize → assign), `routes/[id]/page.tsx` (**F05/B167:** a read-only **Settlement** card — `settlementNote`, a signed/colored `settlementVariance` Badge [`data-testid="settlement-variance"`, the oracle for e2e spec 23 — a card-scoped assertion would also match the note's own "Variance:" line and prove nothing], and legacy `run.notes` — rendered for **EVERY** run status; before it, the sole `run.notes` renderer was `EditRunModal`, unreachable for a closed run behind two independent gates [`activeOnly` list + a status check], so the variance reason a driver was forced to type vanished the moment the run closed; live-run stop list w/ live status + map; `StopItem` takes an
  `onAtDoorActions` prop and shows an "At-door actions" button on the `IN_PROGRESS` (current) stop →
  opens the shared `ArrivedStopSheet` — Phase 2 §3, the real driver at-door surface; **durable POD
  2026-08-28:** expanded COMPLETED stops render `StopPodSection` — lazy `useStopPod(runId, stopId)`
  (`lib/api/routes.ts` → `GET /route-runs/:id/stops/:stopId/pod`, presigned URLs so never bundled
  into the run payload) showing photo thumbnails (click → full size), the customer-signature image,
  age/ID verified chips, and honest "captured by an older app version, can't be displayed"
  fallbacks off `legacyPhotoCount`/`signatureCaptured`), `routes/[id]/dispatch/page.tsx` (pre-run
  packing-list/loading-manifest view; `RequiredStopCard` shows an "At-door actions" button when a
  stop's packing status is `IN_PROGRESS` (arrived) → opens `ArrivedStopSheet` for that stop, Phase 2
  §3), `routes/templates/[id]/page.tsx`, `routes/my-runs/page.tsx` (driver's own runs; reskins to the **Drive mode** field layout — today's run promoted to a hero card with big stop rows, Progress/Next Stop/Delivered-Today `StatCard`s, and a prominent "Scan to add order" primary action linking `/orders?action=new&scan=1` — when `useDriveMode().driveMode` is true; same `useRouteRuns`/data untouched, off-state renders the prior compact Today/Upcoming lists).
- **F12 — dispatch-modal late-stop warning + acknowledge gate (B161/B31, PR #652).** TWO separate dispatch modals share the shape (still duplicated components, not extracted): `routes/page.tsx`'s own `DispatchModal` and `routes/templates/[id]/page.tsx`'s. Both: on open, POST `/routes/:id/analyze` via `useAnalyzeRoute({routeId, startTime, windowsOnly:true})` (no AI spend — see api.md's F12 bullet) and re-check whenever the operator edits Departure Time; `lateStopsFromAnalysis(result)` (NEW `routes/_components/late-stops.ts`, spec'd) maps `RouteAnalysisResult.etas` where `withinWindow===false` into `{stopId,label}`; `needsAcknowledge = lateStops.length > 0 && !acknowledged` gates the Dispatch button behind an explicit checkbox when any stop is late; `windowCheck: WindowCheckState` (`idle|checking|ok|failed`) fails OPEN — a throttled/errored analyze call warns but never blocks Dispatch. **Seed-once-per-open (fix-round 3+4 hardening):** `seededRef`/`startTimeRef` (`React.useRef`, mirrored from `startTime` state every render) replace the old effect-deps-on-`startTime` pattern that snapped an operator-cleared Departure Time back to the tenant default; seed effect deps stay `[open, routeSettings?.defaultStartTime]` (never `startTime`) and only fire when `!seededRef.current && !startTimeRef.current`. `routes/page.tsx` ALSO has a reset-on-open effect (deps `[open, today]`) that clears `startTime`/`startTimeRef` synchronously BEFORE the seed effect runs in the same commit — so on this page a chosen time does NOT survive a reopen (unlike the templates modal, which has no reset effect and stays seeded once per page life — **B230, unbatched**: unrelated departure-time hazards from this same guard, both minor). `routes/page.tsx`'s modal is the only one that sends `startTime` in the dispatch POST (default from `useRouteSettings`). `lib/api/routes.ts`: `OptimizeResult` += `windowViolations?`/`startTime?`/`windowsChecked?` (all optional — older servers omit them), `RouteVariant` += `windowViolations?`, new `WindowViolation` interface; `useAnalyzeRoute`'s mutation payload += `windowsOnly?`. `packages/types/api/routes.ts` `StopETA` += `waitMinutes?`. Proof: Playwright spec 35 (below), pending-deploy.
- **F16 orders search goes server-side (B144, 2026-09-07, #656).** `orders/page.tsx` no longer re-filters the CURRENT page's rows client-side against `customerSearch` (which silently hid matches on every page but the one the operator happened to be viewing, and hid the pager + per-page selector outright whenever a search was active). `useUrlSearch()` now destructures its third value (`debouncedCustomerSearch`) and both the table query and the CSV-export fetch send `search: debouncedCustomerSearch || undefined` — `useOrders`'s params type (`lib/api/orders.ts`) gained `search?: string`. The in-page `useMemo` keeps only its local SORT, no more `q`/`filter` branch. "Showing X of N orders" now always reads `meta.total` (was `filtered.length` conditional on `customerSearch`); the per-page `<select>` and the pager render unconditionally (were both `{!customerSearch && …}`-gated). Web e2e leg: `e2e/37-list-caps.spec.ts` REG-B144 (below).
- **F16 payment receipt fetches by id (B80, 2026-09-07, #656).** `finance/payments/[id]/page.tsx` replaced `useInvoicePayments({ limit: 200 })` + client-side `.find(p => p.id === id)` (a payment past the 200th most-recent 404'd as "Payment not found.") with `usePaymentDetail(id)` (`lib/api/invoices.ts`, wraps the pre-existing but previously-dead `GET /invoices/payments/:paymentId`). Web e2e leg: `e2e/37-list-caps.spec.ts` REG-B80 (below).
- **Invoicing/payments:** `invoices/page.tsx` (**WP4 2026-08-26**: `renderStatus`'s two LOCAL-time `setHours(0,0,0,0)` normalizations replaced by `calendarDaysUntil` from `lib/formatting.ts` — an invoice due "today" for a negative-UTC-offset viewer showed **Overdue by 1d**; the KPI dollar buckets were already fixed by #442 [`PaymentSummaryBar` compares `dueDate.slice(0,10)` calendar strings]), `invoices/new/page.tsx` (**WP4**: `getDaysForTerms`/`addDaysIso` moved out to `lib/invoice-terms.ts` and imported — behavior byte-identical), `invoices/[id]/page.tsx` (**WP4 `EditTermsModal` terms→dueDate linkage**: the Terms `<select>` used to call ONLY `setPaymentTermsLabel`, so picking "Net 60" persisted the OLD due date under the NEW label — the client-reported "Net 60 shows Net 30". `onChange` now also recomputes `setDueDate(addDaysIso(invoice.issueDate.slice(0,10), days))` for any known term; "Select terms…" [`days == null`] leaves the date alone, and a hand-typed date after picking a term still wins since the server accepts both fields. A muted helper line names the anchor issue date — rendered ONLY when `invoice.issueDate` is truthy, since without one the recompute is a no-op and the copy would promise behavior the user can't get); mark paid, apply credit/advance, void, email, PDF; **T1-16#1 regulated SEPARATE_SECTION grouping**: `useTrackedCategories` → `sectionedRows` memo pulls lines whose tracked category is treated `SEPARATE_SECTION` out of the flat line table and renders them under a `"{Category} · regulated"` heading row within the same invoice, standard/LINE_TAX lines stay inline — display-only, line data/totals untouched; the customer-facing **PDF template + mobile invoice-detail mirror are DEFERRED** [needs a server-side category name/treatment load into the money-critical PDF path]; **check lifecycle (P5-12)**: each CHECK `InvoicePayment` row gets a lifecycle badge (`effectiveCheckStatus`: null⇒RECORDED, manually-voided-not-bounced⇒no badge) + a "Check ▾" `DropdownMenu` (Mark deposited/cleared/bounced, available even on a PAID invoice) driving `useSetCheckStatus` (`lib/api/invoices.ts`, `PATCH :id/payments/:paymentId/check-status`, invalidates invoices list + detail + payments) and a `MarkBouncedModal` with an optional NSF-fee input; Paid/Balance totals and `editPaymentMax` now exclude `status==="VOID"` payments, voided/bounced rows render struck; `lib/api/invoices.ts` gained a `CheckStatus` type + `InvoicePayment` fields `status/checkStatus/depositedAt/clearedAt/bouncedAt/nsfFeeAmount/paymentNumber` + `CREDIT_CARD` in the method union), `invoices/[id]/edit/page.tsx`, `invoices/recurring/page.tsx`, `invoices/recurring/new/page.tsx`. **Sentinel-email + send-recovery (2026-08-14):** `invoices/[id]/page.tsx` `handleSend`/`handleReminder` treat `isInternalEmail(customer.email)` (`lib/formatting.ts`; `@imported.local`/`@placeholder.local` — triple mirror w/ api `common/internal-email.ts` canonical + mobile `lib/internal-email.ts`) as NO email; `isNoEmailOpen` boolean replaced by `sendBlocked: null|{kind:"no-email"}|{kind:"send-failed",message}` — `NoEmailModal` now takes `reason` and doubles as the **EMAIL_SEND_FAILED recovery modal** (Mark as Sent / Download / Print) so a failed email can't strand a DRAFT (payments are gated on non-DRAFT). `orders/[id]/page.tsx` filters the sentinel from `SendInvoiceModal.customerEmail` (modal's Email option hides, unconditional Mark-as-Sent remains). `customers/_components/CustomerFormModal.tsx` suppresses the sentinel from `initialData.email` too (was only user.email) and the UPDATE payload sends `email: data.email ?? ""` — "" clears server-side (api `UpdateCustomerDto` emptyToNull); previously `|| undefined` made clearing impossible.
- **F16 KPI tiles go server-side (B12, 2026-09-07, #656).** `invoices/page.tsx` deleted its `useInvoices({ limit: 999 })` fetch-all + the ~75-line client `useMemo` reduce (totalOutstanding/dueToday/dueIn30/overdue/avgDays/awaitingConfirmationCount) — past 999 invoices the tiles silently dropped the oldest rows (default sort). New `useInvoiceKpiSummary(today)` (`lib/api/invoices.ts`, `GET /invoices/kpi-summary`) reads the server aggregate instead; `today` is `todayLocalIso()` (the viewer's own calendar day, same anchor the due-soon chips already sent — L-047). Response type `InvoiceKpiSummary` (`packages/types/api/invoices.ts`, new file). Harness: `e2e/22-payment-truth.spec.ts`'s `summaryBarQuery` helper now waits on `/invoices/kpi-summary` instead of `/invoices?...limit=999` (its own comment updated). Web e2e leg: `e2e/37-list-caps.spec.ts` REG-B12 (below) — **PASSED** post-deploy (run 34137751080, headSha e02851af).
- **Ad-hoc order trips (2026-08-24, trip builder is NEW) — moved to `deliveries/` + re-gated 2026-08-25:** `orders/page.tsx` bulkbar renders a "Plan delivery trip" action only when `useDeliveryAccess().enabled` (was `useDeveloperMode().enabled`; parked selection → `lib/trip-draft.ts` local draft, `?n=` query param; **2026-08-26:** the select-mode row checkbox carries `onClick` stopPropagation — its td's own onClick also toggles, so a click ON the box double-toggled to a net no-op and the checkbox looked dead; e2e trip-builder-gate caught it); the builder now lives at `deliveries/new/page.tsx` (moved from `routes/trips/new/page.tsx`, `routes/trips/new/` left as a thin redirect stub) and implements a PICKING → Build → BUILT → Send state machine — PICKING reads the draft (empty/expired states link back to `/orders`), Build calls `POST /trips` best-effort-optimized (an optimize failure warns, never blocks — the route stays usable) rendering the resolved stops via the existing `TemplateRouteMap`, Send calls `useCreateRouteRun` with `orderIds` (draft clears ONLY on dispatch success, so a failed dispatch keeps the picked orders) and reports the run's `attachedOrderCount` — a warning toast names how many orders changed since Build and were left off; the BUILT review list renders the **server's** stop order (`builtRoute.stops` by `stopNumber`, orderIds keyed by customer from the Build-time snapshot) so its numbering matches the post-optimize map beside it, while the Build/Send CTA counts stay on the frozen snapshot. The tenant-depot origin is gated on `depotLat != null || depotAddress` (what `TripsService.resolveTenantDepot` can actually resolve — coords are only written by a successful geocode, so gating on them alone locked out every tenant that had never optimized); mobile uses the same predicate and the disabled copy points at Settings → Business profile, which is where the address actually lives. The DRIVER origin is gated on the selected driver's `homeLat`/`homeLng`, NOT merely on a driver being picked (`resolveOrigin` 400s without coords) — `TripOriginPicker` takes `hasDriverHome`/`driverHref` and both builders disable the option with "{name} has no home base set" + a link to the driver profile, whose Home Base section is the only writer. Discard (after Build) = `useDeleteRoute` + clear draft, gated behind an inline two-tap confirm (same idiom as the bulkbar delete). `routes/page.tsx` list defaults to `kind: SCHEDULED` (Trips get their own section) and gains a SHIP fulfillment-path filter across all 6 `useUrlFilters` touchpoints + a CSV column. `orders/page.tsx` renders a SHIP pill (icon + text, never color alone) next to `fulfillPath: SHIP` orders; ROUTE orders get no badge. Both trip lists (`routes/page.tsx`'s Trips card and `routes/trips/page.tsx`) render their delete affordance **only for run-less drafts** — a dispatched trip's `deleteRoute` cascade would hard-delete the run stops holding POD photos/signature, and the API now 400s that case for ADHOC routes. **2026-08-25 split:** `deliveries/page.tsx` is the new ADHOC-only history list (replaces `routes/trips/page.tsx`'s content, which is now a redirect stub to `/deliveries`) — `deriveDeliveryStatus(runs)` maps the latest `useRoutes({kind:"ADHOC"})` run onto Draft/Dispatched/In progress/Delivered/Cancelled (no run yet = Draft; one-shot routes never re-dispatch, so "latest" is always the only run), Date/Driver/Stops/Status columns off the `_count`/latest-run fields `findAllRoutes` now includes, drafts (`!runs?.length`) deletable via `useDeleteRoute` with confirm, no re-dispatch/reuse affordance on any row; `routes/page.tsx` now defaults to `kind: SCHEDULED` and drops its Trips card entirely (ADHOC routes live only under `/deliveries`).
- **Trip-builder IN-PAGE ORDER PICKER (2026-08-26 batch-d):** `deliveries/new/page.tsx`
  `orderIds` is now real STATE seeded once from `loadTripDraft()` (hydration-safe flag); every
  add/remove persists via `saveTripDraft` so refresh keeps the selection; the direct-nav
  dead-end ("go to Orders") is GONE — `_components/OrderPickerPanel.tsx` (new; collapsible
  "Add orders": debounced search + accumulated Load-more that stops on an EMPTY page, not
  short pages — the server post-filter can shorten pages while meta counts the superset;
  `fmtCalendarDate` on deliveryDate) renders inline with a hint pointing at the bulkbar path.
  `TripStopList` gained optional `onRemoveOrder` — per-order × on multi-order groups only;
  BUILT phase byte-untouched. Hook `lib/api/trips.ts` (new, narrow) `useEligibleTripOrders`
  against `GET /trips/eligible-orders` ({data, meta} envelope). e2e
  `20-trip-builder-gate.spec.ts` re-pinned to the picker UX (still assert-visibility-only —
  Build asserted DISABLED at 0 orders, never clicked).
- **Fulfillment-path forms (2026-08-24):** `orders/_components/CreateOrderModal.tsx`'s `fulfillPath` round-trips through the parked-draft payload AND its hydrate-from-draft path (a dropped field here silently reverts a draft's SHIP choice to ROUTE on resume); `customers/_components/CustomerFormModal.tsx` covers `fulfillPath` in both `buildDefaultValues` branches (create/edit), both create+update payloads, and both callers' `initialData`. `orders/[id]/page.tsx` gets a fulfillment-path control (`"Delivery route"`/`"Ship via carrier"` + one-line helper text, disabled once the order has shipped) driving `PATCH /orders/:id/fulfill-path`; the SHIP status label relabels on existing status-badge handlers only (no new component); `ShipmentCard` gained an optional, backwards-compatible `openSignal` prop that nudges the panel open after a fulfillment-path change.
- **Finance:** `finance/dashboard/page.tsx` (AR aging, sales breakdowns), `finance/payments/page.tsx` + `[id]/page.tsx`, `finance/reports/page.tsx` (AR aging, P&L, cash flow, expense breakdown). ⚠️ 2026-08-28: the Bills & Purchasing hub UI moved VERBATIM from `finance/expenses/page.tsx` to **`vendor-bills/page.tsx`** (now the ONE terminal home); `finance/expenses/page.tsx` and `purchases/page.tsx` are thin redirect stubs/aliases onto `/vendor-bills` (query/tab forwarded — tab map `bills→inventory`, `expenses→other`); `finance/expenses/new/page.tsx` (expense creation, OCR) stays a real route and post-saves to `/vendor-bills`. Finance nav group no longer has an "Expenses" item.
- **Comma-status 400 fix (2026-08-12):** `ListInvoicesDto.status` validates ONE enum value — a comma list 400s SILENTLY (verified live). `finance/payments` RecordPaymentModal now queries by `customerId` (+ `enabled` gate on `useInvoices` — `lib/api/invoices.ts` options gained `enabled`) and filters `OPEN_STATUSES` client-side, OLDEST FIRST (array order = allocation pre-fill order, mirrors mobile `payments/record`); `customers/[id]` Billing tab's "outstanding" filter had the same bug — client-filtered via `OUTSTANDING_STATUSES`. NEVER send a comma status to `/invoices`. **Waterfall extracted (2026-08-20, PR-E):** its greedy pre-fill + allocated/excess math now call `waterfallAllocations`/`allocationTotals` from `lib/api/supplier-payments.ts` — ONE copy shared with `components/CustomerRecordPaymentModal.tsx` and `components/RecordSupplierPaymentModal.tsx`; don't re-derive allocation arithmetic in a page.
- **Cancel warning + honest void errors (2026-08-13b):** `lib/cancel-impact.ts` (`describeCancelImpact`, mirror of the mobile helper — specs live on the mobile side) + `useCancelImpact` in `lib/api/orders.ts` (enabled only while the dialog is open). `orders/[id]/page.tsx`'s ConfirmDialog now states which invoices get voided and how much returns to which credit note, refuses with the blocking-payment detail instead of offering a confirm, and `confirmCancel` finally has an `onError` (a server refusal previously produced NO toast). `invoices/[id]/page.tsx` `handleVoid` relays `err.response.data.message` — the server names the exact blocking payment and the UI was replacing it with "Please try again", on the one page that also owns the Remove-credit fix.
- **Substituted-line payload (D1/B2/B3, 2026-08-19, money-critical):** `orders/[id]/page.tsx`'s substitute push used to be a bare `{id, substituteProductId, qty}` in BOTH save paths, with a comment documenting the omission as intended — it wasn't. New **`substituteDtoUpdate(it)`** is the single builder for `handleSaveItems` AND the DRAFT `saveThenPublish` path (the publish button now calls the SHARED **`buildItemUpdates()`** — `handleSaveItems`' per-line loop, extracted; its old inline copy also dropped `unitPrice` on new/repriced NON-substituted lines and mis-shaped new unlisted lines, so a price typed in edit mode was lost when publishing instead of saving. BOTH callers prepend `pendingDeletes` — the publish path skipping deletes let a trashed line survive "Save & Publish" and keep billing): `{id, substituteProductId, qty, ...boxedDtoFields(it), ...(isPriceOverridden(it) ? {unitPrice, overrideReason} : {})}`. New **`isPriceOverridden({unitPrice, basePrice})`** (EPS `0.0001`, ABSOLUTE difference) also replaced `handleSaveItems`' downward-only `unitPrice < basePrice − EPS` test, which silently dropped operator **upsells** (the server maps below-base→DISCOUNTED, above-base→MANUAL). `SubstitutePicker.onSelect` now receives the product's `unitsPerBox` and **re-denominates the line against the SUBSTITUTE's case size** — mirroring mobile `buildSubstituteLine`: piece count = `item.boxSplit || lineUpb <= 1 ? item.qty : item.qty * lineUpb` (a boxed line WITHOUT a split counts selling units), then `normalizeBoxesPieces` → `{qty, unitsPerBox: upb, boxSplit: split.boxes != null}`. It also carries the tier ladder (`SubstituteOption`) so the caller sets **`unitPrice = tierPriceFor(p)` over `basePrice = list`** — the same split mobile's `buildSubstituteLine` stores (`unitPrice`=tier, `catalogPrice`=list). Pinning both to list made every substitution look un-overridden, so no `unitPrice` reached the server and a tier customer was billed LIST on web while mobile billed tier. The page resolves the tier the way `CreateOrderModal` does — `useCustomer`/`useCustomerPrices` → `cpMap` → `tierPriceFor = getTierPrice(p, cpMap.get(p.id) ?? customerTier ?? 1)`, passed into `EditableLineItems` (NOTE: adds still price off list here; only substitution is tier-aware). Undoing a substitution needs the line's own denomination AND price back, so `EditItemState` gained `originalUnitsPerBox`/`originalBoxSplit` + `originalUnitPrice`/`originalBasePrice`/`originalOverrideReason` (seeded in both edit-state builders and both add-item paths) and the substitution-Undo button restores them (`restoredPrice(it)`) — otherwise the original product would keep the substitute's case size and price, and the plain UPDATE branch (`priceChanged`) would save the abandoned substitution's price onto it. The CANCELLED-line Undo only does that full revert when the line actually carries `substituteProductId` — "Not available" sets nothing but `cancelled:true`, so unconditional restore was discarding in-session price edits. `addProduct` seeds `unitsPerBox`/`originalUnitsPerBox` on new rows (boxSplit stays unset ⇒ still bills selling units) — without it, substituting a just-added case line read its selling-unit qty as PIECES (`lineUpb = 0` arm) and under-charged by the case size. Server side: api.md → `orders/` "Substitution branch".
- **SMTP fallback disclosure (2026-08-18, PR-6 WP5):** `lib/api/invoices.ts` exports `SendInvoiceEmailResult` (`success`/`sentTo` + optional `warning`/`fromAddress`, from the api `send()`'s `smtpFallbackReason`), typed onto **both** `useSendInvoiceEmail` and `useSendInvoiceReminder` — the two server paths return the same shape. `invoices/[id]/page.tsx` `handleSend` **and** `handleReminder` branch on `res.warning` to a `variant:"warning"` toast naming the platform From address ("Sent via RouteFlow's mail service (from …) — your own email couldn't send: …"); a Resend-rescued send is still a success, so never route it to the error path, and never leave one of the two buttons silent.

- **Provider-instruction accuracy pass (2026-08-21):** `settings/page.tsx` `EMAIL_PROVIDERS` help copy re-verified against each vendor's CURRENT flow — these strings are the operator's only setup instructions, so treat them as dated facts and re-check them, not as boilerplate. Gmail: steps rewritten for today's App Passwords UI (2SV first → open `myaccount.google.com/apppasswords` DIRECTLY [Google no longer links it from Security] → type an app NAME → **Create**; the old "select Mail + your device → Generate" dropdowns are GONE), plus Workspace-admin prerequisite ("Allow users to generate app passwords") and the revoked-on-password-change gotcha. Microsoft: preset relabelled **"Microsoft 365 (business)"** — it used to advertise "Outlook.com", but PERSONAL Outlook.com/Hotmail/Live/MSN mailboxes lost password SMTP on **2026-04-30** (OAuth only) and can never work here, so the copy now says so first; business steps add tenant **security defaults must be off** and the **end-of-December-2026** deadline when Microsoft disables SMTP basic auth by default for all tenants (final removal announced H2 2027). GoDaddy: lead with "check My Products → Email & Microsoft 365" (nearly all Workspace Email has been migrated to M365, so `smtpout.secureserver.net` applies only to the few unmigrated mailboxes). Custom: added the ALLOWED port list (25/465/587/2525 — enforced by api `ALLOWED_SMTP_PORTS`) + full-address-as-username. Help box is an unconstrained `<ol>`, so longer/extra steps just reflow.
- **Invoice-builder customer pricing NaN fix (2026-08-13):** `invoices/new/page.tsx` resolved customer prices from `cp.specialPrice` — a field the API no longer sends — so `parseFloat` gave NaN and every line silently fell back to LIST. `priceMap` now resolves `getTierPrice(cp.product, cp.pricingTier)` (import from `lib/pricing`), and `addProductFromCatalog` applies the customer's own tier ladder (`customerTier !== 1 ? getTierPrice(product, customerTier) : undefined`) when no per-product row exists; `effectivePrice` is guarded `Number.isFinite` and `isSpecialPrice`/`regularPrice` flags key off `effectivePrice !== listPrice`. Statement tab (same commit): `lib/api/customers.ts` `StatementTransaction` retyped to the server shape (`type: "INVOICE"|"CREDIT_NOTE"|"ADVANCE_PAYMENT"`, `runningBalance`, `expiresAt?`) — the old UPPER-vs-lower type mismatch zeroed every tile; `customers/[id]` statement table rebuilt: 5 columns w/ type badges (purple Advance), per-row remaining labeled owed/unused/in-wallet, Amount-Received tile = Σ|INVOICE amount| − Σ|INVOICE runningBalance|.
- **Playwright project 08 wired (2026-08-12):** `08-create-order-escape.spec.ts` (WP-1 Escape scoping + auto-park + WP-4 draft order-date) shipped WITHOUT a `playwright.config.ts` project entry, so it NEVER ran; now wired as `create-order-escape` (operator storage state). Its customer-pick selector scoped to the search input's sibling `ul` (page-wide `ul li button` grabs the sidebar nav toggle).
- **08 draft cleanup (2026-08-19):** the two ESC tests each park a REAL draft per run (ESC-01's dismissing Escape hits the same auto-park net as ESC-02's Cancel) and nothing deleted them — 43 rows piled up in the e2e operator's dock (pairs seconds apart, `"Order, E2E Order Cafe"`, device `Desktop web`; GET /drafts caps at 50). Fix: a `beforeEach` response listener captures ids from `POST /drafts`, `afterEach` deletes them (`DELETE /drafts/:id`, token via new `helpers/api.ts`); ESC-01 now also waits for the park toast (synchronizes cleanup AND asserts the net fires on Escape-dismiss). `e2e-seed.js` sweeps pre-fix residue (operator + `kind ORDER` + `device "Desktop web"` + title `Order…`).
  - `finance/expenses/page.tsx` is the **"Bills & Purchasing"** hub — 3 tabs: **Vendor Bills** (`InventoryPurchasesTab`, `useVendorBills`), **Purchase Orders** (`PurchaseOrdersTab`, read-only Ledger table off `usePurchaseOrders()` from `lib/api/inventory.ts`; PO status → `poBadge()` since the PO enum isn't in the shared Badge map), **Other Expenses** (`OtherExpensesTab`, `useExpenses`). KPI grid uses `StatTile` (Open Bills / Due This Week / Unlinked Items filter-toggle / Spend-30d — all derived client-side from the loaded bill list, no new endpoints). No web PO create/detail route exists (`/purchases` just redirects here), so no "New PO" button and PO rows aren't clickable.
- **Credit notes/estimates:** `credit-notes/page.tsx` + `[id]/page.tsx`; `estimates/page.tsx` + `[id]/page.tsx` (convert to invoice). **Wallet (P5-13):** `lib/api/credit-notes.ts` `CreditNote` type gained `amountUsed`/`expiresAt?`/`appliedAt?`/`autoApplied?` (`issueDate`/`notes` demoted optional). `credit-notes/page.tsx` Open-Credit tile now sums expiry-aware remaining (`Σ(amount−amountUsed)` over non-VOID, non-expired, remaining>0) instead of face amount over ISSUED; create modal gained an optional "Expires (optional)" date input → `expiresAt` in the create payload. `[id]/page.tsx` derives `remaining = amount − amountUsed` + an `isExpired` flag, shows "Auto-applied"/"Expired" pills + Applied/Remaining/Expires summary rows, and gates both Apply-to-Invoice buttons behind `!isExpired`. **2026-08-13:** the list's Amount cell adds an "`openCreditBalance(note)` left" sub-line on partially-used notes (mirrors mobile). **2026-07-30:** `CreateCreditNoteDto.issueDate` is optional + `@deprecated` (with `notes`) and NO web caller sends either — the `credit-notes/page.tsx` modal and `CreditNotePicker.submitCreate` both omit them, so the server DTO's accepted-and-ignored `issueDate`/`notes` fields exist purely for in-flight old bundles and can actually be retired. **F09 (2026-09-06):** the phantom `DRAFT` union member and every DRAFT/Issue affordance are gone — `IssueConfirmModal` deleted, the list's Issue chip/count removed, `[id]/page.tsx`'s void-modal copy no longer promises "issued" ("...cancelled. It can no longer be applied."). Three render sites (list row, detail header, detail sidebar) show `invoice?.invoiceNumber ?? invoiceId` instead of a raw UUID (B19).
- **People:** `customers/page.tsx`, `customers/create/page.tsx`, `customers/[id]/page.tsx` (form `_components/CustomerFormModal.tsx` — **email is OPTIONAL**; username derived from name when email absent; `SpecialPricesTab` tier cells/option-labels/preview append a subdued "(list)" suffix via local `tierUnset()` when the chosen tier column is 0/unset — price itself already falls back via `getTierPrice`; **Billing tab** Open-Balance card carries the customer-level **"Record Payment"** entry point → `components/CustomerRecordPaymentModal.tsx` (`isRecordPaymentOpen`; `onSuccess` invalidates `["customers", id]` because `useRecordPaymentStandalone` only invalidates `["invoices"]`), alongside the older "Record Advance Payment" `Modal` in the Advance-Balance card); `drivers/page.tsx`, `drivers/[id]/page.tsx`.
- **F16 customer statement figures (B110, 2026-09-07, #656).** `customers/[id]/page.tsx`: the Orders tab count/tile now read `ordersData?.meta?.total` (server count over the WHOLE order history) instead of `allOrders.length` (the `GET :id/orders` endpoint's own `take:50` display budget) — `useCustomerOrders<T>(id)` (`lib/api/customers.ts`) gained a generic + a `CustomerOrdersResponse<T>` shape (`data`/`meta`) so callers can read `meta.total`; a "Showing the latest N of M orders" note renders when the list is shorter than the count. Invoices-tab "Outstanding"/"Overdue" cards and the two lifetime tiles ("Total Invoiced"/"Total Received") now read `statement.outstandingAmount`/`overdueAmount`/`lifetimeInvoiced`/`lifetimeReceived` (server DB-side aggregates over the customer's WHOLE history) instead of reducing the page's own paged `invoicesData` or the capped `transactions` ledger — matches the Overview tile above (same `statement` object, never a second page-scoped basis). New **`ledger-truncation-note.tsx`** (`LedgerTruncationNote({truncated})`) renders nothing unless the server said `transactionsTruncated === true`; wired under the transactions table here and consumed by the buyer/mobile statement surfaces too (renders "Showing the most recent transactions only — older entries are not listed in this ledger."). Test: `ledger-truncation-note.test.tsx`.
- **Merchandising / promotions (P5-01):** `promotions/page.tsx` — operator manager for tenant promotions (list + status-chip filter (Active/Scheduled/Paused/Expired via `promotionStatus()`), create/edit `Modal` with typed rule (PERCENT/FIXED/QTY_BREAK), scope (ALL/CATEGORY/PRODUCTS) incl. an inline searchable multi-product picker, `datetime-local` window, pause/resume, delete). Nav leaf "Promotions" (Megaphone) under Warehouse in `(dashboard)/layout.tsx` + a CommandPalette `nav-promotions` entry. Consumes `lib/api/promotions.ts` only — **no pricing applied here** (cart-time application is P5-04). **Zero-price guard (2026-08-21):** the page already loads the whole catalogue (`useProducts({limit:0})`), so `toScopeProducts`/`draftRule`/`zeroPriceImpact` (module-local, over `lib/pricing.ts#scanPromotionZeroPrice`) recompute as the operator types: a FIXED amount ≥ an in-scope product's list price raises a blocking amber panel naming the count/denominator/examples plus an "I understand — sell these for $0.00" checkbox; submit is refused without the tick and sends `allowZeroPrice: true` with it (the API refuses the same rule independently, 400 `PROMOTION_ZERO_PRICE`). Any rule edit clears the tick. Saved promotions that ALREADY zero prices get a red "N sell for $0.00" chip in the list's Rule column (`zeroByPromoId`) so a live one can't sit unnoticed — the 2026-08-20 incident (a $35-off ALL promo zeroed 699 of 1,767 products). `products/[id]/page.tsx` gained a "Buyer merchandising" toggle card (Featured/New/Deal → `useUpdateProduct` isFeatured/isNew/isDeal) + header badges; `products/page.tsx` grid card + table cell show the same badges via a local `MerchBadges`.
- **B14 search debounce (2026-08-20):** `useUrlSearch()` returns THREE values — `[search, setSearch, debouncedSearch]`. Four finance lists destructured only the first two and fed the RAW `search` into their list query, which lands in the React Query key, so every keystroke was a distinct cache key and a fresh request: `credit-notes/page.tsx`, `estimates/page.tsx`, `finance/payments/page.tsx`, and the **Inventory Purchases tab inside `finance/expenses/page.tsx`** (that tab IS the vendor-bills list — the standalone `/vendor-bills` route is now just a redirect). Fixed to pass `debouncedSearch` into the query while the input stays bound to `search` for instant typing. Correct reference implementations already in `invoices/page.tsx`, `products/page.tsx`, `customers/page.tsx`.
- **In-app pack size (2026-08-20) — capture `unitsPerBox` where the operator already is.** Context: only 19 of 1,743 live products carried a pack size, and EVERY boxed affordance gates on `unitsPerBox > 1` (box-price proration, boxes/pieces inputs, box-aware scan, stock-count denominations, variant split), so all of that machinery was dormant. Two capture points, both driven by the single shared parser in `@routeflow/types` (`suggestPackSize`) — never a local re-implementation:
  - **Product create/edit** — `components/PackSizePrompt.tsx` (new), an inline dismissible prompt when a pack size is suggested and `unitsPerBox` is unset. `HIGH`/`MEDIUM` pre-fills the parsed count; **`AMBIGUOUS` states the conflict and pre-fills NOTHING**; `LOW` asks quietly; **`PIECE_UNIT` renders nothing at all**. Writes through the existing product mutation — no new endpoint. Mounted in `products/[id]/page.tsx` (edit card, gated on `isEditing`) and in **`components/ProductCreateModal.tsx`** under the "Units per box" field — `products/create/page.tsx` is ONLY a `redirect("/products?action=new")` stub (RF-203) and hosts no fields, so the create-side prompt lives in the modal, not on that route. The modal passes the same name the submit path resolves (`variantName` when creating under a parent, else `name`).
  - **Order builder line** — a quiet "Sold in a box?" affordance in `orders/_components/CreateOrderModal.tsx` that PATCHes the product and re-renders the line as boxed via the existing cases/pieces inputs. Module-level **`packSizeConversion(li, unitsPerBox)`** owns the conversion + the before/after totals and is called by BOTH the inline preview and `applyPackSize`, so the two can never disagree. It maps the existing qty onto **BOXES** (`normalizeBoxesPieces({boxes: li.qty, pieces: 0, unitsPerBox})`), because a not-yet-boxed catalogue line's `qty` counts SELLING UNITS priced at the box `pricePerUnit` — see `addLineItem`'s `qty: upb ? upb : 1` / `boxes: 1`. **Never re-read that qty as a PIECE total** (`{qty: li.qty}`): that shrinks the shipped quantity AND divides the line total by `unitsPerBox` (2 cartons @ $80 → "2 pcs" @ $16). `applyPackSize` re-reads the row from a `lineItemsRef` mirror after its `await`, not the pre-await closure, so a qty typed while the PATCH is in flight is not reverted.
  - ⚠️ **Setting `unitsPerBox` RE-PRICES the line** — it switches from `qty × unitPrice` to BOX-price proration, so the affordance surfaces the resulting line total rather than silently changing money on screen. With the boxes mapping the total is normally UNCHANGED, and the preview/toast say so explicitly instead of showing a fake "→".

- **PR-B find-by-product + sales history (2026-08-20, no migration):** `lib/api/product-sales.ts` (`useProductSales`, mirrors cost-history/product-demand) over `GET /analytics/product-sales/:productId`; `products/[id]/SalesHistoryCard.tsx` (own file — `page.tsx` is ~2.7k lines and, NOTE, has **no Radix Tabs at all**: it is stacked cards, so the plan word "tab" means a CARD here, slotted between `DemandCard` and `CostHistoryCard`). Summary chips + a `useSortableData`/`SortableTh` table (date · order # · invoice # · customer · qty · unit price · line total); qty via `formatQtySplit`, money rendered as the server sent it, struck-through `originalPrice` when `overridden`. **Avg price carries an explicit ⓘ saying it is revenue-weighted** — a plain mean of the column below it would be a different (wrong) number. Order # renders the real `orderNumber` (the API returns it; never slice the uuid) and a muted "—" for a directly-raised invoice. Orders list gained a `productId` filter via `SearchableProductPicker` as a 5th `useUrlFilters` key — one `setFilter` per handler, so the async-`router.replace` trap does not bite; `clearFilters()` sweeps it for free.
- **PR-D generic → variant stock split (2026-08-20, no migration):** `components/VariantSplitModal.tsx` (new) is the ONE split UI — the product detail page, the Inventory Stock-tab row action and the vendor-bill line badge all render this exact component, so behaviour can't diverge. Hand-rolled overlay (`fixed inset-0 z-[200]`, panel `max-w-2xl`) following `GroupAsVariantsModal.tsx`, **not** `Modal` from `@routeflow/ui/web` (capped at `max-w-lg`, too narrow for a row table). Props `{parent:{id,name,currentStock,averageCost,unitsPerBox,costingMethod}, pool?, onClose, onSuccess}`; `pool` is only this session's assignable ceiling and defaults to the parent's own `currentStock` — "unassigned stock" is NOT new state, it IS that column. Children come from `useProduct(parent.id)` **filtered to `isActive !== false`**: `GET /products/:id` returns deactivated variants too (it only sorts `isActive desc`) and the server 400s on an inactive target, so offering one would just be a row that fails. `RowState.cost` is **raw text, never a number** — a controlled numeric input eats the decimal point mid-typing; parsed once at submit via `roundUnitCost` (same rule as mobile's `unitCostText`). A boxed parent renders two adjacent number inputs (cases + loose units, pieces capped at `unitsPerBox - 1`, mirroring `CreateOrderModal` ~1592-1613) and sends `boxes`/`pieces`, **never a client-derived `qty`**, so the server's `normalizeBoxesPieces` stays authoritative on the base-unit total; `clampFor` clamps a boxed edit as a TOTAL against the pool minus every other row, then re-splits through `normalizeBoxesPieces` so the two fields can't disagree. A STANDARD-costed parent drops the whole Cost column (its cost is operator-set and must not move). **`onSuccess` fires when the operator dismisses the success view, not when the response lands** — entry points close the modal from that callback, so firing it on the response would unmount in the same React tick and the success table + `/inventory/movements?reference=…` link would never paint (cache invalidation is the hook's job; nothing needs it earlier). Hook `lib/api/variant-assign.ts` (new) — `useAssignToVariants()` → `POST /inventory/variant-assign`, invalidating `["inventory"]`/`["products"]`/`["vendor-bills"]`. **Three entry points, every affordance gated so none appears on a product that is itself a variant:** (1) `products/[id]/page.tsx` — an "Unassigned stock" row in the Stock & Cost card + an "Assign to variants" header action on the Variants card, both behind `!product.parentProductId && (product.variants?.length ?? 0) > 0`; (2) `inventory/page.tsx` — a 5th Stock-row action, gated off a **side `useProducts({includeVariants:true, limit:0})` → `variantInfoById` map** because `/inventory/overview` rows carry neither `parentProductId` nor a variant count (`StockItem` also gained `costingMethod` — already selected server-side, just never typed here); (3) `vendor-bills/[id]/page.tsx` — a "Generic — split into variants?" badge on the Mapped Product cell, off WP2's additive `parentProductId` + `_count.variants` (narrowed locally as `MappedProductVariantHint`; the shared `VendorBillItem["product"]` type is deliberately NOT widened), with `pool` = new **`lineReceivedBaseUnits(bill,item)`**, which multiplies the received qty by `packSize` when >1 — the bill counts CASES while `currentStock` counts pieces, so this mirrors the API's `lineInventoryDelta` — and the full parent fetched on demand via `useProduct`. That badge is **always skippable and never blocks receiving**; unsplit units simply stay on the generic. Movements-page `?reference=` chip: see Inventory/sourcing below. Server side: api.md → "PR-D WP1/WP2"; mobile counterpart: mobile.md → "PR-D".
- **A2/A3 cross-surface reach (2026-08-19, PR-A):** `components/SetCostModal.tsx` is NEW but NOT a fork — the modal was EXTRACTED verbatim out of `inventory/page.tsx` (its only prior home) onto a minimal `CostBasisTarget` shape, so the inventory table, the inventory search suggestions and `products/[id]` all render the SAME component. Cost stays modal-driven ON PURPOSE: every change writes an audited COST_BASIS movement via `useSetCostBasis`, so a raw editable field would bypass the audit trail — the modal, not the discipline, became reachable from everywhere. Inventory search **no longer force-opens Adjust**: picking a suggestion scrolls to + flashes the row (`scrollToId`/`onScrolled` on `StockTable`, row-ref map, 1.6s flash), and `pickSuggestion` clears ONLY the filter that would hide the target (`missingCostOnly` / section) — the effect deliberately does not clear `scrollToId` when the ref is missing, because `setUrlFilter` round-trips through `router.replace` asynchronously and the row appears a render later. Suggestion rows and table rows now carry the same four actions (Adjust · Set cost · Movements · Open product). Movement rows link product→`/products/[id]` and supplier→`/suppliers/[id]` (null-guarded); customer-detail order rows link the order # AND get `onRowClick` (the link `stopPropagation`s so it cannot double-navigate).
- **Inventory/sourcing:** `products/page.tsx`, `products/[id]/page.tsx` (pricing tiers — READ mode renders unset (0) tiers as the inherited list price + tiny "list" badge, edit mode has a persistent "Tiers left at 0 inherit the list price" helper, variants-table Tier 2 cells use `getTierPrice(…, 2)`; image+focal editor, variants, `CostHistoryCard` from /analytics/cost-history, amber "No cost set" states; **P5-03**: `ApiProduct` (`lib/api/products.ts`) gains `stockAlertCount?: number`; a "Waitlist — N waiting for restock" row renders in the Stock & Cost card right after "On hand" [warning color when >0, muted otherwise]); `inventory/page.tsx` (valuation card + missing-cost chip/filter, `SetCostModal`/`BulkSetCostModal`/`RecomputeModal` dry-run→apply); `inventory/movements/page.tsx` (client-side `?reference=` batch filter — chip label comes from `referenceLabel()`/`REFERENCE_PREFIX_LABELS`, mapping `STOCK_COUNT-`→"Stock count" and `VARIANT_ASSIGN-`→"Variant assignment", falling back to "Reference"; add a prefix here whenever a new op groups movements under a shared reference); `suppliers/page.tsx` + `[id]/page.tsx`; `vendor-bills/page.tsx` + `[id]/page.tsx` (`UnlinkedItemsModal` catches UNLINKED_ITEMS 409, unmapped-DRAFT banner); vendor-bill LIST lives in `finance/expenses/page.tsx` `InventoryPurchasesTab` (needs-mapping KPI chip + row badge).
- **Returns/analytics:** `returns/page.tsx` (list — reskinned to Unified Ledger per `docs/design-package/project/unified/returns.html`: `PageHeader`+subtitle, 3 KPI stat cards incl. warning-ring "Awaiting Review", status-chip filter bar (all `ReturnStatus` values, not just the design's 5) + reason `<select>` + search, table gained a computed "Value" column (sum of `item.unitPrice*qty`, presentational only), row action button "Review"/"View" by status — same `useReturns`/`useCreateReturn`, same handlers/filters/pagination, unchanged) + `[id]/page.tsx` (detail — NOT reskinned yet; approve/reject/in-transit/received live here. **2026-07-30 WP10:** the old dual "Issue Credit Note" (client-side `Σ qty×unitPrice`, box-unsafe, double-mint hazard)/"Process Refund" buttons are GONE — RECEIVED shows a single "Resolve Return" button opening `ResolveReturnModal` (radio: Issue store credit vs Refunded outside RouteFlow, amount shown from the server's `ret.refundEstimate`, no restock checkbox — that field was always inert). APPROVED/IN_TRANSIT keep their physical-path button (Mark In Transit / Mark Received) plus a secondary "Resolve without receiving" (`useMarkReturnReceived({id,restock:false})` then opens the same modal — abandoning it leaves the return truthfully at RECEIVED). A sidebar "Resolution" `Card` renders once `refundMethod`/`refundedAt` is set: method/amount/date + a `creditNoteId` → `/credit-notes/:id` link labelled with `creditNote.creditNoteNumber`. `handleResolveReturn` posts `useProcessRefund({id,method})`. **F08 (2026-09-06, #645):** list KPI
  "Total Return Value" and the row "Value" column now sum `r.refundEstimate ?? 0` (server-priced from
  the billed basis) instead of a client-side `Σ item.unitPrice×qty` reduce, and both EXCLUDE
  REJECTED/CANCELLED returns (a return that settled nothing with the customer is not return value;
  caption reads "excludes rejected and cancelled" — B75). Detail page: `ResolveReturnModal` shows
  `refundEstimateReason` as prose under the radio choices when the estimate is $0 (distinguishes a
genuine $0 from a refusal); `handleResolveReturn`'s refund-failure toast now surfaces the server's
  `err.response.data.message` (an invoice-named headroom refusal, an EXTERNAL_REFUND pointer) instead
  of a hardcoded "Please try again." (only the true fallback for a message-less error); a `canCancel`
  = status ∈ {PENDING,APPROVED,IN_TRANSIT,RECEIVED} "Cancel Return" button opens a confirm modal wired
  to the new `useCancelReturn()` (B21). `apps/web/lib/api/returns.ts` gained `refundEstimateReason` on
  `Return` and a `search` param on `useReturns` (B166 — search UI pre-existed the reskin; F08 wires it
  to the server). E2E: `apps/web/e2e/29-returns-lifecycle.spec.ts` (project `returns-lifecycle` in
  `playwright.config.ts`) T12(REG-B166 search)/T13(REG-B75 KPI value)/T14(REG-B21 cancel + B82 quota
  release) — **T12 passed, T13/T14 FAILED on the post-deploy run** (34075878788): T14 is a
  `getByRole("heading",{name:ret.returnNumber})` STRICT-MODE double-match (the same return number
  renders in two `<h1>`s — a page-header/breadcrumb title AND the `#main-content` heading — mirrors
  L-076's "assert through a scoped container" pattern, not yet applied here); T13 polled `before+10`
  but observed `before+15/25/35` growing by exactly 10 per Playwright retry, suggesting the KPI is not
  isolated per test attempt. Not discharged pending investigation.); `analytics/page.tsx` — **Operations tab (2026-08-28):** Route/Driver Performance tables gained On-Time % · Stops/hr · Avg Duration columns via shared `opsMetricColumns<T extends RunOpsMetrics>()` (null metrics render "—" — "no measurable data", distinct from 0; `fmtDuration` renders "1h 23m"); the tab's from/to params were always sent and are now honored server-side (see api.md analytics). **date-range semantics (B40, 2026-08-28):** every card fetch passes the page picker's from/to EXCEPT Margin Alerts, which is current-state (API takes no from/to; fetch deliberately param-less with `[]` deps so it never refetches on range change) — both inventory cards carry captions stating their window ("no activity in the selected range" / "not affected by the date range"); dead-stock `daysInactive`/`lastMovement` are nullable and render "—"/"Never".
- **Tobacco (addon-gated):** `tobacco/page.tsx` — KPIs, monthly chart, tabs (Reports w/ CSV+PDF downloads + generate/regenerate, Inventory, Purchases w/ supplier license, Sales w/ customer-license warnings), TENANT_ADMIN exclusion-toggle card; nav "Tobacco" leaf spliced after Analytics in `layout.tsx` when `useHasAddon("tobacco_dealer")`; product detail Mark-as-tobacco action + banner; product list tobacco badge. Hooks: `lib/api/tobacco.ts` (`useTenantAddons`/`useHasAddon` = the flag read, staleTime 5 min).
- **Regulated Items / compliance (Phase 4 B1 + section→subcategory B/C/D):** `compliance/page.tsx` is now a **view-only index** — KPI cards (Tracked Sections / Regulated Products / Tax-this-month [tobacco-overview-bound, "—" otherwise] / Filings) + section **cards that link to `/compliance/[id]`** + a cross-section filings roll-up. "Manage sections" links `/settings?tab=regulated` (all create/edit/toggle moved there — see Regulated Settings below). NEW **per-section dashboard** `compliance/[categoryId]/page.tsx` — `useTrackedCategory` header, `useRegulatedLedger({category,from})` YTD net-sales/tax as KPIs + a recharts monthly bar (**tax KPI labelled snapshot-pending** until the W3 engine; `to` omitted so today isn't clipped), `useRegulatedFilings(id)` + `usePrepareFiling` + `lastCompletedPeriod` (Prepare filing → CSV), read-only subcategory chips (`useTrackedSubcategories`). Shared filings table = `components/RegulatedFilingsTable.tsx` (`showCategory`/`categoryName` props); shared helpers in `lib/regulated-format.ts` — labels (`lastCompletedPeriod`/`taxRuleLabel`/`treatmentLabel`) + **`sectionPickerOptions`/`subcategoryPickerOptions`** (the active/inactive `<select>` option lists, used by BOTH product forms so their filtering can't drift — a since-deactivated current tag stays selectable, labelled "(inactive)"). **Nav:** `layout.tsx` DashboardShell useMemo injects a **"Regulated Items" NavGroup** whose children are the tenant's active sections (`useTrackedCategories({active:true})`, staff-only via `{enabled:isStaff}`, spliced after `/analytics`; empty group never spliced); the addon-gated **Tobacco** leaf stays a separate splice. **New hooks** in `lib/api/tracked-categories.ts`: `useTrackedSubcategories(categoryId)` + `useCreate|Update|ToggleSubcategory` (`TrackedSubcategory` type; routes `GET/POST /tracked-categories/:id/subcategories`, `PATCH .../:subId[/toggle]`, no DELETE) + `useRegulatedLedger` (`RegulatedLedgerResponse{rows,totals}` over `GET /regulated/ledger`); `useTrackedCategories` gained an `{enabled}` 2nd arg. `lib/api/products.ts` `ApiProduct` gained `trackedCategoryId`/`trackedCategory{id,name}`/`trackedSubcategoryId`/`trackedSubcategory{id,name,trackedCategoryId}`. **Product-form pickers (Phase B):** `products/page.tsx` CreateProductModal (selects between Category and Description, guarded on `sections.length`) + `products/[id]/page.tsx` inline edit (two `InfoRow` pickers, edit-mode-only) gained dependent **section→subcategory** selects (subcategory cleared on section change; create payload `|| undefined`, edit payload `|| null` to clear); product-detail "Separately handled" banner is now **read-mode-only**, shows the subcategory, and links `/compliance/[id]`; the `?action=new` deep-link now auto-opens the create modal. **W4:** SEPARATE_INVOICE split unchanged; SEPARATE_SECTION in-invoice heading still a GAP (api.md).
- **Per-product TX config + arbitrary-range reports (2026-07-30 fix round):** `components/DateRangePicker.tsx` (new — the repo's first date picker, and the reason `date-fns` is no longer a dead dependency) wraps a `react-day-picker` v9 two-month range calendar + preset rail in a hand-rolled popover (outside-click/Escape close mirrors `SubcategoryCombobox`); owns its in-progress `pendingAnchor` locally so the `maxDays` range-cap disables far-away days from the FIRST click rather than depending on a parent round-trip, the first click never calls `onChange` (no meaningless one-day-window refetch), and the anchor clears on preset-click and on close (outside-click/Escape). `parseLocalDate`/`formatLocalIso` are the only ISO↔Date conversions — never `toISOString()`, which would shift the visible day for any tenant west of UTC. `defaultMonth` = `pendingAnchor ?? range start ?? today`, so the calendar always opens on the month containing the active selection: rdp 9 derives its initial month from `month || defaultMonth || today` and IGNORES `selected`, and the popover is conditionally rendered so `DayPicker` remounts on every open — without it the calendar reopens on the current month with the active range off-screen. Anchoring the LEFT pane on the range's start keeps a range spanning up to two calendar months fully visible under `numberOfMonths={2}`. `components/ReportColumnsPicker.tsx` (new) — column show/hide checklist off a template's column superset; `toggle()` materializes the template defaults on the FIRST change away from `null` so later toggles never reset unrelated columns; "Reset to template" calls `onChange(null)`, and "Save for this section" stays visible whenever `onSave` is provided (disabled only while `saving`) so a reset can still be persisted instead of the button vanishing. `RegulatedReportPanel.tsx` — state machine: `template` (`""` = category default) / `selectedColumns` (`null` = template default) / `previewParams` (set only on the Preview click, gates `useRegulatedReportPreview`); seeds `selectedColumns` from the category's `reportColumnPrefs[resolvedTemplate]` whenever the resolved template or the saved prefs change; `handleSaveColumns` writes `selectedColumns` into `reportColumnPrefs[resolvedTemplate]` when set, else DELETES that template's key from the prefs map (never persists an empty/null value — the API rejects that) and PATCHes the category with `reportColumnPrefs: null` once no template keys remain; `isCustom` = ordered comparison against the resolved template's default keys, feeding both the CSV `-custom` filename token and the "custom layout" preview notice. Download goes through `fetchRegulatedReportCsv` → blob → `<a download>`, never `window.open` (the endpoint needs the auth header). `components/CategoryFormModal.tsx` — the TX item-type/UoM selects are REMOVED (that config now lives on the product); only `wholesalerLicenseNo` stays TX-specific. `compliance/[categoryId]/page.tsx` — "Prepare filing" moved from the page header into the "Filings" `Card`'s own header (next to `RegulatedFilingsTable`), since it's a filing action, not a page-level one; `RegulatedReportPanel` sits above it, unrelated to the persisted filing archive. Product create (`ProductCreateModal.tsx`) and detail (`products/[id]/page.tsx` — a separate inline block, not a shared component; on the detail page these fields live in their OWN "Regulatory reporting" card rendered between Details and the demand chart, NOT in the Details grid, because filing vocabulary sitting beside the catalog's own Unit of Measure / Units per case reads as a duplicate of them. That card also owns the Regulated type select and the read-mode type/subcategory line that used to be a banner above Details, so regulated info lives in exactly one place; `hasActiveRegType` mirrors `activeProductConfig`'s edit/read split so the "template needs no per-product config" note never fires off a stale saved value while the draft has the type cleared) regulatory-reporting fields (`regItemType`/`regUomUnit`/`regUomCase`) are sourced from `useRegulatedTemplates()`'s `productConfig` (registry-driven, not hardcoded); switching item type clears any UoM no longer valid under it; the case-UoM field renders only when `productConfig.caseUomSupported && unitsPerBox > 1` (boxed products only). `lib/api/tracked-categories.ts` gained `useRegulatedReportPreview`/`fetchRegulatedReportCsv` (`GET /regulated/reports/{preview,csv}`, `RegulatedReportParams` incl. optional `columns`) + `useRegulatedTemplates` (`GET /regulated/templates`, `staleTime: Infinity`) + `ReportTemplateDef`/`TemplateItemType`/`TemplateColumn` types mirroring the API registry (`regulated/template-registry.ts`, see api.md).
- **Regulated license web surfaces (Phase 4 W6b):** operator **customer-detail Licenses tab** (`customers/_components/AuthorizationsTab.tsx`, wired into `customers/[id]/page.tsx` as `<TabTrigger value="authorizations">`) — list rows w/ status badge (local `authStatusBadge`, since Badge lacks VERIFIED/PENDING_REVIEW/NONE), approve/reject/renew + add wholesaler-added license (category picker off `useTrackedCategories`). **Order-builder license guard** `orders/_components/LicenseGuardModal.tsx` — catches 409 `REGULATED_AUTH_REQUIRED` (parsed by `parseRegulatedAuthError` in `lib/api/authorizations.ts`), **3 exits: capture license / §8 override / remove line**; wired into `CreateOrderModal` (`LineItem.trackedCategoryId` added + set from `product.trackedCategoryId`; retry via `licenseRetryRef`; UNTIL-24h override scope pre-create) and `orders/[id]/page.tsx` (`guardError` on updateItems/updateStatus/publish; ORDER override scope; remove-exit omitted — lines removed via edit UI). **Buyer self-serve** `buyer/portal/[seller]/licenses/page.tsx` (+ `ShieldCheck` nav in `buyer/portal/layout.tsx`) — per-category status + submit/renew w/ consent. **`providers.tsx`** MutationCache now skips the generic error toast for handled 409 codes (`MERGE_CHOICE_REQUIRED`, `REGULATED_AUTH_REQUIRED`). Hooks: `lib/api/authorizations.ts` (operator: `useCustomerAuthorizations`/`useCreate|Approve|Reject|RenewAuthorization`/`useCreateAuthorizationOverride` + `parseRegulatedAuthError`/`displayAuthStatus`/`authStatusBadge`), `lib/api/buyer.ts` (`useBuyerAuthorizations`/`useSubmitBuyerAuthorization`).
- **Deposit policy UI (2026-08-26 batch-d):** `settings/page.tsx` "Default Invoice Terms" card
  (the one holding `defaultTerms` + `hideOriginalPrice` — NOT the differently-purposed
  "Invoice Defaults" notes/T&C card) gained a "Deposits" sub-section: percent input
  (commit-on-blur, clamped 0–100, mirrors the customer-page deposit input pattern) +
  "Collect deposit at order placement" toggle, both via `useInvoiceSettings`/
  `useUpdateInvoiceSettings` (`InvoiceSettings` += `depositDefaultPercent`,
  `depositCollectAtOrder`). Buyer portal `buyer/portal/[seller]/invoices/[id]/page.tsx`
  renders a deposit banner ("Deposit due <date>: $X · Remainder due <dueDate>") from payload
  fields via the file's narrow-cast idiom when `depositPercent != null`.
- **`settings/page.tsx SessionsCard` — honest revoke + a stable row key (B155, F14 2026-09-02):**
  each session `<li>` now carries `data-session-id={session.id}` (the api-side fix rotates the
  refresh row IN PLACE — same `id` across rotations — so a row captured before a rotation is still
  the SAME row after one; this attribute is what an e2e spec can key on to prove that). Single
  revoke: on failure it now also re-fetches (`loadSessions()`) instead of just toasting an error,
  so a row that actually died server-side (e.g. it had already rotated out) doesn't sit as a
  phantom the user can't act on. Revoke-all: was `Promise.all(...).catch(() => null)` per call —
  ANY failure was swallowed into the same "All sessions revoked" success toast, which could be a
  lie. Now `Promise.allSettled`, counts rejections, and only claims success when `failed === 0`;
  any failure toasts "Some sessions could not be revoked" and re-syncs the list rather than
  clearing it client-side. No Playwright unit proof pre-merge (D1) — proven post-deploy by e2e
  spec 32 below.
- **Regulated management → Settings (Phase C, was B2 on /compliance):** section create/edit/toggle + a per-section **subcategory manager** now live in a **TENANT_ADMIN-gated "Regulated" tab** — `settings/page.tsx` (`<TabTrigger value="regulated">` + `<Tabs.Content>`, both gated on `useAuth().user?.role==="TENANT_ADMIN"`, deep-linkable `?tab=regulated`) rendering `settings/_components/RegulatedSettingsTab.tsx` (section list reusing `components/CategoryFormModal.tsx` [create/edit] + `components/AssignProductsModal.tsx` [bulk product assign] + `useToggleTrackedCategory`; inline `SubcategoryManager` per section = add/rename/toggle via `useCreate/Update/ToggleSubcategory`, 409-dup message surfaced). `CategoryFormModal`/`AssignProductsModal` unchanged (self-contained, `isOpen`/`onClose`/`category`). `compliance/page.tsx` no longer creates/edits (that moved here).
- **Settings → Notifications (P6-6, no migration):** real event×channel matrix + templates replace the old dummy checkbox tab — `settings/page.tsx` `<Tabs.Content value="notifications">` (`max-w-4xl`) now mounts `settings/_components/NotificationsSettingsTab.tsx` (RegulatedSettingsTab extraction pattern; `useAuth`→`isAdmin` gate) instead of the deleted local `NotificationsTab`; the real device push-status card + "Send test" button (`useNotificationsStatus`/`useSendTestNotification`) is retained inside the new component, only the fake hardcoded checkbox list was removed. Sections: (1) matrix `Card` — rows=`NotificationEvent`, cols=`MessageChannel`, per cell a `MiniSwitch` (`role="switch"`, MerchFlagToggle idiom) → `useToggleRule` (optimistic), locked G12 cells (`INVOICE_SENT`×WA/SMS) show `Lock`+tooltip instead of a switch, WA cells also show a `waApprovalStatus` badge (display-only, P6-3 owns transitions), MSGS meter line in the header; **F23 (B180/B183a, PR #650):** a cell carrying `MatrixCell.unavailable` renders NO switch — `UNAVAILABLE_COPY` maps `NO_TRANSPORT`→"Not available: no transport configured", `NO_CONSENT_WRITER`→"Not available: needs customer consent", `NO_TRIGGER`→"Not available: no trigger yet" as plain qualifier text instead (`cell.unavailable` checked before the `MiniSwitch` branch); (2) per-event template editor modal — body `Textarea`, live `extractTemplateVars` chip row re-parsed per keystroke, debounced (400ms) `usePreviewTemplate` panel, WA channel gets a "Meta template name" input + approval badge, `isActive` `MiniSwitch`, Save → `useUpdateTemplate`; (3) quiet-hours `Card` — `MiniSwitch` + two `<input type=time>` → `useUpdateMessagingSettings`; **F23 (B160):** copy no longer claims a hold — now "The window is recorded for reporting; messages are not yet held or delayed during it." (was "…are held outside this window…", which the engine never enforced). New hooks module `lib/api/messaging.ts` (mirrors `margin.ts`): types `MessageChannel`/`WaApprovalStatus`/`MessageTemplateInfo`/`MatrixCell`(**+`unavailable?: "NO_TRANSPORT"|"NO_CONSENT_WRITER"|"NO_TRIGGER"`, F23, mirrors the api's `MessagingConfigService`**)/`MatrixEvent`/`MessagingSettings`/`MsgsMeter`/`MessagingConfig`; `useMessagingConfig` (`["messaging-config"]`, `GET /messaging/config`, lazily seeds server-side on first read), `useToggleRule` (`PATCH /messaging/rules/:id`, optimistic `onMutate` cell flip + rollback + settled invalidate), `useUpdateTemplate`/`usePreviewTemplate`/`useUpdateMessagingSettings`, `extractTemplateVars(body)` (client-side mirror of the API's `{{var}}` regex parser, pure). New RTL suite `settings/notifications-settings.test.tsx` (F23; precedent `settings-users.test.tsx`) pins the honest quiet-hours copy and the qualifier-not-switch rendering for an `unavailable` cell.
- **Stripe Connect buyer payments, WP1 (2026-08-21):** `lib/api/stripe-connect.ts` (new) — `StripeConnectStatus` type mirroring `GET /settings/stripe-connect` (`configured/connected/stripeAccountId/chargesEnabled/detailsSubmitted/livemode/connectedAt`), `useStripeConnectStatus`, `useStartStripeConnect` (`POST .../link` → `{url}`, `onSuccess` navigates `window.location.href`), `useDisconnectStripe` (`DELETE`, invalidates the status key). `settings/_components/StripeConnectCard.tsx` (new) — the tenant "Payments" card, five states (not configured / configured-not-connected / connected+chargesEnabled=Active / connected+!chargesEnabled=Finishing-setup / livemode===false=Test-mode chip), masked account id (`maskAccount`), Disconnect via the shared `components/ConfirmDialog.tsx`, and a `?stripe=connected|error` return banner read with `useSearchParams` (safe without its own Suspense wrapper because `settings/page.tsx` already wraps `SettingsPageInner` in one). Status badges pass `label=` — `Badge` renders its own children and DISCARDS a spread `children`, so `<Badge>Active</Badge>` would be an empty pill. **Mounted on the settings hub branch** (`settings/page.tsx`, no-`?tab=` path, below `<SettingsHub />`) rather than behind a tab, because the Connect OAuth callback returns the operator to bare `/settings?stripe=...` and only the card renders that banner. Sibling work packages ship in the same batch and have their own bullets below (WP2 operator review queue, WP3/WP4 buyer panel + wiring); the API side and the WP5 specs are in api.md, batch plan `.claude/pipeline/plans/2026-08-21-stripe-connect-web.md`.
- **Stripe Connect buyer payments, WP2 — operator review queue (2026-08-21):** `lib/api/payment-requests.ts` (new) — `PaymentRequest`/`AllocationPreviewLine` types, `usePaymentRequests(status?)` (`GET /payment-requests`, key `["payment-requests", status ?? "all"]`), `useApprovePaymentRequest()`/`useRejectPaymentRequest()` (both invalidate `["payment-requests"]` + `["invoices"]` + `["customers"]` so balances refresh). `finance/payment-requests/page.tsx` (new) — status filter (PENDING default); approve/reject appear ONLY on PENDING **CASH** rows (CARD rows are read-only history — "Settles automatically via Stripe"); the pending row and the approve confirm both render the server's `allocationPreview` table (oldest-invoice-first explainer, "(partial)" marker) — **the UI never computes allocations**. `isError` renders a distinct "couldn't load … you may not have permission" + Try-again state, NOT the empty state: the endpoint is `@Roles(OPERATOR)`, so a lower-role user gets a 403 and would otherwise read it as "nothing to review". **Discoverability (added in the review-fix pass):** nav leaf "Payment Requests" (`DollarSign`) in the Finance group of `(dashboard)/layout.tsx`, between Payments and Expenses — leaf `active` is `pathname.startsWith(href)` and `/finance/payments` does not prefix-match `/finance/payment-requests`; plus a `buyer.payment.requested` subscription in `lib/hooks/useRealtimeUpdates.ts` (operators room, payload `{requestId,customerId,customerName,kind,amount,requestedAt}`) that invalidates `["payment-requests"]` and toasts only for `kind === "CASH"` (the only kind the API emits — `payment-requests.service.ts` cash path). Without both, a buyer's declaration sat PENDING unseen while the API blocked them from opening a second request.
- **Stripe Connect buyer payments, WP3/WP4 — buyer "Make a payment" (2026-08-21):** `lib/api/buyer-payments.ts` (new, **`buyerApiClient` only** — the tenant `apiClient` sends the wrong token and 401s) — types `BuyerPaymentAllocationLine`/`BuyerPaymentRequestRow`/`BuyerPaymentContext`/`BuyerPaymentPreview`; `useBuyerPaymentContext()` (key `["buyer","payment-context"]`, `staleTime` 30s, `enabled: !!getStoredActiveSeller()` because a call without `X-Tenant-Slug` 400s — same guard as `useBuyerShelf`), `useBuyerPaymentPreview(amount)` (350ms debounce, `enabled` only at ≥ 0.5, `placeholderData: (prev) => prev` so the table doesn't flash empty per keystroke), `useStartCardPayment` (`POST /buyer/payments/card` → `{requestId,url,amount}`; the CALLER navigates `window.location.href = url`), `useDeclareCashPayment`, `useCancelPaymentRequest` — every mutation invalidates the context key. `buyer/portal/[seller]/payments/_components/MakePaymentPanel.tsx` (new, prop `defaultAmount?`) — balance-due headline, amount input seeded from `defaultAmount ?? context.balanceDue` behind a `touched` flag so a context refetch can't stomp typing, the fixed "Payments are applied to your oldest invoices first." line, and an allocation table rendered **purely from the server preview** ("Partial" badge when `applied < balanceDue`, `excess` shown as on-account credit) — **the UI never allocates**, or the two sides would disagree. `Pay by card` is absent entirely (muted "This seller doesn't accept card payments yet.") when `cardEnabled` is false, and disabled above the balance: a card may not exceed the balance due, cash may (surplus becomes credit). A PENDING request replaces both actions with `PendingRequestStatus`. **Cancelling a CARD request used to be silently destructive** — flipping the row to CANCELLED left the later `checkout.session.completed` webhook with no PENDING row to claim, so it read itself as a replay and wrote nothing: a card that DID charge never reached an invoice. **The hole is now closed server-side** (`payment-requests.service.ts` `cancelOwn`: asks Stripe first — already paid ⇒ settle instead of cancel; not paid ⇒ expire the session, THEN cancel; unreadable ⇒ refuse), so the UI mitigations below are defence in depth rather than the only guard. Cancel is HIDDEN for 60s after the Stripe return (`?payment=processing` → `awaitingWebhook`), the panel polls `refetch()` every 5s across that window so it visibly clears instead of looking stuck (a stuck-looking panel is what tempts the cancel), and the card cancel that remains is behind a `window.confirm`. On the poll where the PENDING card row disappears — settlement — it also invalidates `["buyer","statement"]` and `["buyer","payments"]`: the page's Outstanding tile and Payment History have no polling of their own and `refetchOnWindowFocus` is off globally, so without that the banner's "your balance updates in a moment" was a lie until a manual reload. Badges pass `label=` (same `Badge` trap as WP1). **WP4 wiring:** `buyer/portal/[seller]/payments/page.tsx` — the default export is a thin `React.Suspense` wrapper around `BuyerPaymentsPageInner` because the page (and the panel inside it) calls `useSearchParams()`, which fails the PRODUCTION build without a boundary (`next build` dies; CI never runs it but Railway's Docker build does — pre-ship review catch). It mounts `<MakePaymentPanel />` as the FIRST block under the header (above the wallet row — it is the primary action), reads `?payment=` → an info banner saying the card payment is _confirming_, **never that it succeeded** (settlement is webhook-only; the `success_url` redirect proves nothing), or a neutral "Payment cancelled."; `?amount=` (finite and > 0) seeds `defaultAmount`. `buyer/portal/[seller]/invoices/[id]/page.tsx` gained a "Pay this invoice" header button rendered only when the status is in `PAYABLE_STATUSES` (SENT/VIEWED/PARTIAL/OVERDUE, mirroring the API's `OPEN_STATUSES`) AND `balanceDue > 0.001` — the buyer invoice list also returns PAID/VOID/WRITTEN_OFF, which the payments API will not allocate against — routing to `…/payments?amount=<balanceDue.toFixed(2)>`. Every pre-existing section on both pages is untouched.
- **Supplier-statement reconciliation (PR-F, 2026-08-20):** `finance/statements/page.tsx` — a `ScanInvoiceModal`-shaped 3-step wizard (`upload | processing | review`) on a full page rather than a modal, because the review grid is a dense table. `?scanId=` deep-links straight into review (`revisitId` seeds the step as `processing`, then `useSupplierStatementScan` hydrates). **Error handling branches on all four typed AI codes** — `AI_KEY_INVALID` links to the Anthropic settings section, `AI_UNAVAILABLE` is the ONLY one offered a Retry, `AI_SCAN_REJECTED` / `AI_PARSE_FAILED` get their own copy (this is the gap the older `ScanInvoiceModal` still has — it special-cases only `AI_KEY_INVALID`).
  - `components/StatementReviewGrid.tsx` — the review grid itself. Four sections (Matched pre-checked · Needs a look, with a per-line candidate picker · Unmatched statement lines · Unmatched local bills, read-only) plus the **implied-paid panel, deliberately isolated**: its own checkbox and its own `ImpliedPaidConfirmOverlay` second confirmation that lists every affected bill. **It is never folded into the main Apply** — it can mark dozens of bills paid at once and is the most dangerous affordance in the batch. `computeLinesAgree` mirrors the server's closing-balance sanity guard so the UI shows the same "don't trust this read" state the matcher computed. Hand-rolled overlay rather than `Modal` from `@routeflow/ui/web` (capped at `max-w-lg`), same as the other multi-row modals. Each confirmed row sends its **`lineIndex`** (the row index into `matches`) so the server caps against the line the operator actually used, not the matcher's suggestion — required for the candidate picker to work at all. Two included rows pointing at the same bill is a blocking `rowError` (the server rejects one-bill-twice outright). **DRAFT bills never enter the implied-paid proposal** (the server refuses them too), and row seeding waits for `useVendorBills` to settle — before it does, `outstandingFor` falls back to the candidate's full total and an already part-paid bill would pre-fill above its real balance; a bill with nothing left to pay is matched but not pre-checked.
  - `lib/api/supplier-statements.ts` — types mirroring the API (`StatementLineMatch`, `MatchTier`, `StatementScanResult`, `ApplyStatementDto`…), `scanStatement()` (multipart, **field name `files`** — not vendor-bills' `images`), `useSupplierStatementScan`, `useApplyStatement` (`POST /supplier-statements/:scanId/apply`, live — `ConfirmedStatementMatch` carries `lineIndex`; `ApplyStatementResult.excess` is **always 0**, the apply never mints supplier credit), and `getStatementAiError()` which narrows an axios error onto the four `StatementAiErrorCode`s.
  - `ApplyStatementResult` is `{ paymentGroupId, alreadyApplied, payments[], excess, bills[] }` — **the overpayment field is `excess`, not `surplus`** (it mirrors `recordSupplierPayment`'s own return shape); both the grid toast and the applied-summary read `excess`.
  - **Applied step reads from two sources, never just the in-session one:** `appliedRows` prefers the `AppliedState` captured by `onApplied`, and falls back to `result.appliedPayments` (what the server reads back off the payment group) so a scan reopened via `?scanId=` days later still lists every bill and amount. The reset in the `useSupplierStatementScan` effect is keyed on the **scan id changing** (`loadedScanId` ref) — applying invalidates `["supplier-statements"]`, and clearing on every new data reference wiped the summary one frame after it rendered. The footer link deep-links to the group (`/suppliers/<id>?paymentGroup=<appliedPaymentGroupId>`), not the supplier at large.
  - `suppliers/[id]/page.tsx` honours that `?paymentGroup=` — matching Account-Activity rows get `bg-brand-50` and the first scrolls into view. It reads the param with `useSearchParams`, so the page is split into `SupplierDetailPageInner` + a `React.Suspense` default export (same wrapper the statements page uses).
  - **Entry point:** nav leaf "Supplier Statements" (`FileSpreadsheet`) in the Finance group of `app/(dashboard)/layout.tsx`, between Expenses and Reports. Without it the page is URL-only.
- **Sales agents & commissions UI (PR-D, 2026-08-23)** — the surfaces the PR-C engine deferred. **Every one is hidden behind `useHasAddon(SALES_AGENTS_ADDON)`** (`SALES_AGENTS_ADDON = "sales_agents"` in `lib/api/addons.ts`, MSRP precedent); the server's class-level `PlanFlagGuard` on both controllers is the real enforcement — the client gate is UX only.
  - **Nav (`app/(dashboard)/layout.tsx`)** — two leaves injected in the `navStructure` memo, NEVER in `OPERATOR_NAV`: "Sales Agents" (`Handshake`) right after Customers, "Commissions" (`BadgePercent`) inside the Finance group after Supplier Statements. Same `flatMap` splice style as the `hasTobacco` / `canActAsDriver` rewrites; `hasSalesAgents` is in the memo deps. Hide-only, so the bare boolean is correct (no `resolved` handling).
  - **`sales-agents/page.tsx` + `[id]/page.tsx` + `_components/AgentFormModal.tsx` + `AssignCustomersModal.tsx`** — list (search / status / show-deactivated), create-with-optional-first-rate, and a detail page whose ONE `useSalesAgent` query drives header `accrualTotals`, contact/status cards, the default- and customer-rate cards, and the open-assignments card; the accrual ledger is its own paged `useAgentAccruals`. Delete affordance on rate rows renders **only for future-dated rows** (mirrors the server rule; past rows get a "add a correcting row instead" tooltip). Backdated rate/assignment writes toast the server's `recompute.invoicesSynced`.
  - **`finance/commissions/page.tsx` + `[id]/page.tsx` + `_components/GenerateStatementModal.tsx` + `RecordPayoutModal.tsx`** — list with agent/status filters; detail fed by the single `findOne` payload (lines + payouts in one query — `GET :id/payouts` is deliberately never called). Generate's **409** ("agent already has a PENDING statement") re-fetches `{agentId, status: "PENDING"}` and routes to that statement; the **400** "Nothing to generate" is left to the global toast. **The stale-409 contract:** approve 409s carrying `"stale"` in the message flip a `staleGate` banner whose one click voids the statement and re-generates with the SAME `agentId`/`periodFrom`/`periodTo`, then `router.replace`s onto the fresh one. It matches on message TEXT because the 409 body has no machine code and adding one was out of scope — a message change degrades it to the plain toast. The chain is two requests, not one tx: a crash between them leaves a VOID statement and no replacement (ledger still clean — void releases claims atomically), recovered by clicking Generate. Payout modal defaults to remaining and offers `SELECTABLE_PAYMENT_METHODS` only.
  - **Locked state (both page families):** `useTenantAddons()` `isLoading` → spinner (no lock-flash), then `LockedPage` from `_components/gates/PlanGates` with a `PLAN_GATE` body. That is the deep-link story — nav is hidden, a pasted URL renders the house upsell card.
  - **Customer detail (`customers/[id]/page.tsx`)** — a `Card title="Sales Agent"` directly above "Account Status", fed by `useCustomerCurrentAgent(customerId, { enabled: hasSalesAgents })` (the PR-D read endpoint). Shows the holding agent + "since" date + the customer rate; operators get Assign / Reassign (local modal → `useAddAssignment`) and Remove (`useCloseAssignment`). `CustomerFormModal` gains a "Sales agent (optional)" select in **add mode only** (`salesAgentId` threaded into the create payload) — edit mode gets nothing, because reassignment lives in the agent box.
  - **Order commission override** — `CreateOrderModal` grows a `DecimalInput` in the Options section gated `isStaff && hasSalesAgents`; the payload spread is `commissionRatePct != null` so **`0` (exempt) is sent and `null` is not**, and `OrderDraftPayload.commissionRatePct?: number | null` (`lib/drafts.ts`, optional so parked drafts predating it still hydrate) round-trips it through park/resume. `orders/[id]/page.tsx` Summary `<dl>` renders Default / Exempt (0%) / N% (override) with a staff-only Edit modal on `usePatchOrderCommissionRate` (incl. "Clear override" → `null`).
  - **Money discipline:** these pages render **STORED amounts only** — `accruedAmount`/`payableAmount`/`claimedAmount`/`totalAmount`/`paidAmount`/line `amount` and the API-computed `drift` (rendered verbatim as "Unclaimed") and `adjustmentsTotal`. No `base × rate` anywhere. The only client arithmetic is the display-time `total − paid` remaining in the payout modal, which the server re-derives and caps in-tx.
- **Other:** `dispatch/page.tsx` (**2026-08-26 adaptive overview** — reads
  `useRoutesAccess`/`useDeliveryAccess` (the `useDeveloperMode` read was dropped 2026-08-28);
  three-way subtitle, "Plan delivery"
  `PageHeader` action when delivery access, "Delivery" chip on `route.kind === "ADHOC"` runs
  ONLY when both features on, delivery-flavored empty copy; runs feed already includes ADHOC
  trips — `findAllRuns` has no kind filter, its route select now returns `kind`),
  `bookkeeping/page.tsx` + `[transactionId]/page.tsx`.

### 2026-08-25 — customer-feedback batch (address CRUD, agent quick-create, deposit defaults, due-soon chips, dead reopen, shipment gating)

- **Address CRUD + primary (`customers/[id]/page.tsx`)** — full edit (all fields incl. type/
  label) via `useUpdateCustomerAddress`; delete via new `useDeleteCustomerAddress`
  (`DELETE :id/addresses/:addrId`) behind an inline two-tap confirm keyed by address id (the
  suppliers-page idiom, `deleteAddressConfirmId` state) — a 409 from the server (address used by a
  route stop) surfaces `err.response.data.message` verbatim in the failure toast; "Set as primary"
  (`handleSetPrimaryAddress`) patches `isDefault` on the target address. `lib/api/customers.ts`
  gained the `useDeleteCustomerAddress` mutation hook.
- **`CustomerFormModal.tsx` — edit mode drops the inline address inputs entirely** (was silently
  discarding edits since address is multi-row now); edit mode instead links to the Addresses tab.
  Add mode is unchanged (still creates the customer's first address inline).
- **"+ New agent" quick-create** — next to the "Sales agent (optional)" `Select` (add mode only,
  behind `hasSalesAgents`), a ghost button opens the existing `sales-agents/_components/
AgentFormModal` in a nested modal (`isAgentModalOpen` state); on create it selects the new agent
  into `salesAgentId` without closing/leaving the customer form. No new endpoint — reuses
  `AgentFormModal`'s existing create mutation.
- **Per-customer deposit default** — `CustomerFormModal` gains a `defaultDepositPercent` field
  (mirrors the existing `defaultPaymentTerms` control) threaded into `useCreateCustomer`/
  `useUpdateCustomer` payloads (`lib/api/customers.ts`); server auto-applies it to every invoice
  GENERATED for that customer (see api.md `invoices/` 2026-08-25 entry). Explicit per-invoice
  deposits still win — this page never computes deposit amounts client-side.
- **Due-soon chips + DUE TODAY tile (`invoices/page.tsx`)** — `DUE_CHIPS` (`today`/`tomorrow`/
  `7d`) compute a `[dueFrom, dueTo]` ISO window via the new `addDaysIso` helper (UTC-safe, mirrors
  `invoices/new/page.tsx`'s date math) and are sent as the API's new `dueFrom`/`dueTo` list params
  ALONGSIDE the existing `statuses` filter (`UNPAID_STATUSES` — SENT/VIEWED/PARTIAL/OVERDUE, the
  same set `isOverdue` composes server-side) — reuses the existing filter mechanism rather than a
  new one. The "Due Today" `StatTile` in `PaymentSummaryBar` is now clickable
  (`dueTodayActive`/`onDueTodayClick` props) and toggles the `today` chip; `StatTile` gained an
  `ariaLabel` prop. **Both anchor on `todayLocalIso()` — the viewer's LOCAL calendar day, NOT
  `todayIso()`/UTC** (mirrors `dispatch/page.tsx`'s `todayLocalISO`): `PaymentSummaryBar`'s KPI
  math now compares `dueDate.slice(0,10)` (the UTC calendar day the table renders via
  `fmtCalendarDate`) as YYYY-MM-DD strings instead of local-midnight `Date`s, so the tile and the
  chip it applies can't target different dates for negative-UTC-offset viewers.
- **BUG-ORD-01, web parity (`orders/[id]/page.tsx`)** — the DELIVERED-status "Reopen Order" button
  is removed (server's transition map is `DELIVERED: []` — it always 400'd; mobile never showed
  it). Replaced with static helper text pointing at Edit Items / the route run. `OUT_FOR_DELIVERY`'s
  "Return to Confirmed" demotion button is unaffected.
- **Shipment card gating (`orders/[id]/page.tsx`, `invoices/[id]/page.tsx`)** — `ShipmentCard` now
  renders only when `order.fulfillPath === "SHIP"` or the row already carries a
  `shippingCarrier`/`shippingTrackingNumber` (historical rows), instead of unconditionally.
  The invoice page can't see `fulfillPath` (its `order` select doesn't carry it, deliberately not
  widened), so it gates on `!invoice.orderId || carrier || trackingNumber`: an order-linked invoice
  gets tracking mirrored down from `orders.service.updateShipment`, but a STANDALONE invoice has no
  order to record it on and keeps the card as its only entry point (this page is the sole caller of
  `useUpdateInvoiceShipment`; `/shipments` is read-only).

### 2026-08-25 — sale-integrity phase 2 WP5: Reopen restored + delete-any + new-sale date picker (⚠️ server not caught up)

- **SUPERSEDES the BUG-ORD-01 bullet above** — item 3 of the phase-2 plan restores the DELIVERED
  "Reopen Order" button (`orders/[id]/page.tsx`) wired to the existing `DemoteReasonModal` /
  `setDemoteTarget("CONFIRMED")` machinery (the same reasoned-demotion flow `OUT_FOR_DELIVERY`'s
  "Return to Confirmed" already used), keeping the prior helper text as its subtext, reworded to
  point run-delivered orders at their route stop instead. Server 409s (route-stop-completed) surface
  via the standard error toast.
  - **"Delete order"** — a staff-only inline two-tap confirm action added for ANY order status
    (reusing the page/bulkbar's existing inline-confirm idiom), copy warning the delivery record is
    permanently removed for a DELIVERED order; server 409s (invoice has payments) toast the message.
  - **`invoices/new/page.tsx`** — the "Going out today?" binary gained a **Delivery date** input
    driving a new `deliveredOn` field sent alongside `deliveredNow` (kept for back-compat): past/
    today ⇒ delivered semantics (defaults to today), a future date auto-switches to deliver-later
    copy ("Scheduled — the order is created and delivers on {date}"). The items payload no longer
    sends `boxes: 0, pieces: 0` for plain-qty lines — the keys are omitted unless the operator used
    box entry (the server now tolerates the old zero payload per WP1, but the payload is honest).
  - **`lib/api/orders.ts`** — no new endpoints; verified the delete hook already surfaces server
    error messages for the 409 case above.
- These web changes ride on the server transition-map liberalization, delete-any rule, and
  `deliveredOn` semantics in `apps/api/src/orders/orders.service.ts` (`changeStatus` /
  `deleteOrder(id, user?)` / `createSale`) — see `api.md` `orders/` section for the exact rules,
  including the run-stop-completed 409 the Reopen button surfaces through the global error toast.

### `(platform-admin)/` — super-admin panel (role-guarded)

- `admin/dashboard/page.tsx` — platform stats (tenants, users, plans, MRR).
- `admin/tenants/page.tsx`, `new/page.tsx`, `[id]/page.tsx` (edit plan, trial, suspend, impersonate, audit). Its `AVAILABLE_ADDONS` array is the **only** toggle surface for unbridged addon keys — `tobacco_dealer`, `msrp`, `sales_agents`, `DRIVER_PAYMENTS_ADDON` ("Driver payments (at-door collection)", server-enforced via DriverPaymentsGuard, added 2026-08-25 #437), `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON` ("Recurring routes"/"Order delivery" — split 2026-08-25, gate Dispatch+`/routes` vs Deliveries+`/deliveries` respectively, **server-enforced via AddonGuard since 2026-08-28**) and `DEVELOPER_MODE_ADDON` ("Developer Mode" — 2026-08-28 copy rewrite: unlocks the mobile driver-app preview + dispatch API access for end-to-end testing, and explicitly NO LONGER unlocks Recurring routes / Order delivery, which must be enabled individually); no API change needed since the enable/disable endpoints take free-text addon keys and an unset `stripePriceId` creates no Stripe item. `toggleAddon` failures now surface in a `toggleError` banner (was a silent catch — a failed toggle looked like success).
- `admin/buyers/page.tsx` + `[id]/page.tsx`; `admin/buyers/merge-requests/page.tsx` + `[id]/page.tsx`.
- `admin/plans/page.tsx`, `admin/billing/page.tsx`, `admin/audit-logs/page.tsx`, `admin/{profile,settings}/page.tsx` — settings' AI usage panel (`AiUsage` type off `GET /platform-admin/ai-config/usage`) shows OCR scans / Forecast runs / **Route insights (`insightRuns`, 2026-08-28 — populated now that `recordAiUsage` is wired server-side)** / tokens / est. spend / error rate.

### `buyer/` — buyer portal (multi-seller B2B)

- **Auth:** `login/page.tsx`, `register/page.tsx`, `change-password/page.tsx`, `invite/[token]/page.tsx` (**2026-08-26:** `handleAccept` awaits `refreshSellers()` after a successful accept — register→accept→portal is all soft navigation under ONE BuyerAuthProvider whose sellers list was seeded `[]` at registration, so without the refetch a freshly-linked buyer landed on "No sellers connected yet" until a hard reload; e2e BSD-01 caught it), `verify-merge/page.tsx`, `forgot-password/page.tsx`,
  `reset-password/page.tsx`, `verify-email/page.tsx`. **Sign-in redesign (2026-09-08, PR #663):**
  all 8 buyer auth pages now render through the shared `AuthShell` (`components/auth/`, see
  "Components & shared"), on the SAME link utility the operator `/login` "Forgot password?" link
  uses (`#0b6e6b`, 6.07:1 — the old buyer pages used a separate emerald palette at 3.77:1);
  `invite/[token]/page.tsx` and `verify-merge/page.tsx` gained state-derived `AuthShell` titles
  (invalid/accepted/idle, and verifying/verified/failed respectively) — logic byte-identical,
  chrome only.
- **Portal (`portal/[seller]/`):** `page.tsx` (landing), `shop/page.tsx` (browse/cart), `cart/page.tsx` (checkout → order), `dashboard/page.tsx`, `orders/page.tsx` + `[id]/page.tsx` (+ **P5-10** "Request a change" modal on dispatched orders (run `IN_PROGRESS`; no prices shown by design) → `POST /buyer/orders/:id/change-requests`; CR status chips PENDING/APPROVED/DECLINED from `order.changeRequests`; buyer `canEdit` now honors `editWindow`), `invoices/page.tsx` + `[id]/page.tsx` (PDF; **check lifecycle (P5-12)**: badge rendering now imports the shared **`lib/check-badge.ts`** `checkBadgeFor` helper [extracted verbatim in P5-14 — was local to this file; CHECK-only, manually-voided-not-bounced ⇒ no badge, Bounced ⇒ danger + struck amount + optional NSF line; also consumed by `payments/page.tsx`], displayed paid total filters `status!=="VOID"` so a bounce re-opens the balance, payment date now reads `p.paidAt ?? p.createdAt` [fixes a prior always-"N/A" bug from a never-returned `recordedAt` field]; `lib/api/buyer.ts` `BuyerInvoiceDetail.payments[]` += `status?/checkStatus?/nsfFeeAmount?/paidAt?/createdAt?`, dropped `recordedAt`; `useBuyerNotifications.ts` now also invalidates `["buyer","invoice"]` on `invoice.updated` so the badge/balance goes live, not just a notification), `templates/page.tsx`, `favorites/page.tsx`, `finances/page.tsx` (**P5-13 wallet**: `lib/api/buyer.ts` += `BuyerStatement`/`BuyerStatementTransaction` types + `useBuyerStatement()` (`GET /buyer/statement`); fifth `StatCard` "Store Credit" (`icon=Wallet`, `value=statement?.availableCredit`) + a lean "Active Credits" card listing `transactions.filter(type==="CREDIT_NOTE" && runningBalance>0)` w/ remaining + expiry, capped at 6 — the page's own load/error state is NOT gated on this hook), **`payments/page.tsx`** (P5-14 — Payments & credits: `useBuyerPayments({page,limit:20})` paginated payment table [Date/Invoice #/Method/Status via shared `checkBadgeFor`/Amount, VOID struck] + a "Store Credit" `StatCard` reading the SAME `useBuyerStatement().availableCredit` P5-13 hook [never recomputed — same cache entry as `finances/page.tsx`] + a how-to-pay card off `useBuyerRemittance()` [hides empty fields, friendly empty state when no field is set]; nav "Payments" (CreditCard icon) inserted between Invoices and Finances in `portal/layout.tsx`; `useBuyerNotifications.ts` `onInvoiceUpdated` also invalidates `["buyer","payments"]`+`["buyer","statement"]`; **Monthly statement (P5-15)**: a "Monthly statement" `Card` between the wallet grid and the payments table — `useBuyerStatementMonths()` feeds a native month `<select>` (options via a module-scope `monthLabel(bucket)`, default = `months[0]`) + a Download button; handler mirrors the invoice-detail `handleDownloadPdf` exactly — `fetchStatementPdfUrl(month)` → `fetchPdfBlob(url, buyerApiClient)` → programmatic `<a download="statement-${month}.pdf">` (blob URL revoked after 60s, error toast on failure, `finally` clears a `statementDownloading` spinner state); empty-months state "Statements become available after your first invoice."), `licenses/page.tsx` (W6b — self-serve license submit/renew), `account/page.tsx`; `portal/settings/page.tsx`.
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
- **`layout.tsx`** wraps every route in a `.rf-marketing`-classed shell (the scope every rule in
  `marketing.css` — ~10,092 lines, ported near-verbatim from the redesign — hangs off) plus
  `SiteHeader` + `EditorialMotion` + a footer; `app/globals.css` and
  `packages/config/tailwind.config.ts` stay byte-identical to the pre-port baseline (MKT-PIN, see
  `marketing-port.static.test.ts` below) — marketing ships its own token/utility layer instead
  (registry B247, consolidation deferred).
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
  stays visible with no JS either way).
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

## Unit tests (Jest + RTL) (wave D, item 5, 2026-09-03)

`apps/web` previously had **zero** unit/component tests (Playwright E2E only — the gap
[`docs/IMPROVEMENTS.md`](../../docs/IMPROVEMENTS.md) item 5 flagged). Now 19 spec files, run via
`npm test -w apps/web` (script `"test": "jest"`) or `npm run test` (Turbo `test` task; `apps/web`
now contributes alongside api/mobile).

- **Next 15 `useParams()` migration (2026-09-10, `chore/next-15` #5b3b3c4e)** — every dynamic
  Client Component page dropped the old synchronous `{ params }: { params: { id: string } }` prop
  for `const params = useParams(); const id = params.id as string;` (`useParams` added to the
  `next/navigation` import). Mechanical, one shape, 16 pages: `drivers/[id]`, `estimates/[id]`,
  `orders/[id]`, `products/[id]`, `invoices/[id]`, `invoices/[id]/edit`, `credit-notes/[id]`,
  `vendor-bills/[id]`, `returns/[id]`, `sales-agents/[id]`, `finance/commissions/[id]`,
  `compliance/[categoryId]`, `bookkeeping/[transactionId]`, `routes/[id]`,
  `routes/[id]/dispatch`, `routes/templates/[id]`. **`customers/[id]/page.tsx` is the exception**
  (two sites, not one — `client-page-params.spec.ts` counts by site): the default export
  (`CustomerDetailPage`, the `<React.Suspense>` wrapper for its `useSearchParams()` deep link)
  now calls `useParams()` and passes `id` as a plain `string` prop into
  `CustomerDetailPageInner({ id }: { id: string })`, which no longer takes `params` at all.
  Guard: `apps/api/src/common/client-page-params.spec.ts` (T3) — a repo-wide source-text scan for
  the three old-prop shapes (destructure / `props.params` / body-destructure) and, for Server
  Components, an un-awaited `params:`/`searchParams:` annotation.
- **`jest.config.js`** — built on `next/jest` (`createJestConfig`), `testEnvironment: "jsdom"`,
  `setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"]`. **Campaign gate artifact (2026-09-08, #686):**
  `reporters` wires `["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "web" }]`,
  writing `.campaign/runs/web.json` so `scripts/campaign-check.mjs` can discharge REG-B### pins
  living in `apps/web` (e.g. `lib/api/*.test.tsx`) — before this, apps/web never ran the
  reporter and the gate reported "no test titled with REG-B## found" for every web-hosted pin
  (#683). Guard: `apps/api/src/common/campaign-check-web-report.spec.ts` (see [`api`](api.md)).
  Opts out of `next/jest`'s optional-dependency
  lockfile auto-patch via `NEXT_IGNORE_INCORRECT_LOCKFILE=1` (network call to the npm registry is
  unavailable in this environment and would abort config load; the lockfile itself is pD1's, not
  touched here). ⚠️ **`testMatch` is deliberately `["**/*.test.{ts,tsx}"]`, NOT the
  `<rootDir>`-anchored form the brief suggested** — every worktree in this repo lives under
  `.claude/worktrees/<name>`, so a rootDir-substituted glob always contains a `\.claude` segment
  on Windows; `jest-config`'s `replacePathSepForGlob()` converts `\`→`/` EXCEPT when the backslash
  precedes `$()+.?^{}` (assumed an escaped glob char), so that one separator survives literally and
  picomatch then compiles `\.` as an escaped dot — matching nothing (confirmed via
  `npx jest --listTests` returning empty). `roots: ["<rootDir>/{app,components,lib,hooks}"]` scopes
  discovery instead, so the plain relative glob needs no rootDir anchor. Lesson **L-055**.
  **REMOVED (2026-09-10, `chore/next-15` #5b3b3c4e):** the `moduleNameMapper` single-`react`-
  instance pin (`^react$`/`^react/jsx-runtime$`/`^react/jsx-dev-runtime$` →
  `<rootDir>/node_modules/react`) that worked around `apps/web` pinning React 18 while the rest of
  the repo ran React 19. The upgrade moves `apps/web`'s own `package.json` to `"react": "^19.2.0"`
  (matching `next@15.5.25`'s peer range), so there is one React major repo-wide and the pin's
  reason for existing is gone — do not restore it. Guard:
  `apps/api/src/common/no-react-skew-hacks.spec.ts` (T2) pins BOTH this and the Dockerfile removal
  below as a pair — a half-reverted skew (one hack back, the other still gone) breaks every RTL
  suite. **`testTimeout: 30_000`** (2026-09-05): RTL suites
  mount the real providers and pay a cold SWC compile on each file's first test; under pre-push /
  CI load on a slow host that overran Jest's 5 s default twice (portal-switch T10, buyer-portal
  connect-seller) as a _timeout_, not an assertion — the ceiling is raised, green tests are no slower.
- **`package.json` / `Dockerfile` (2026-09-10, `chore/next-15` #5b3b3c4e)** — `next` 14.2.35 →
  `15.5.25`, `react`/`react-dom` `^18` → `^19.2.0`, `eslint` `^8` → `^9`, `eslint-config-next` →
  `15.5.25`, `@next/swc-win32-x64-msvc` → `^15.5.25` (pins: `next-version.spec.ts` T1).
  `Dockerfile`'s `RUN npm install --force --no-save react@18.3.1 react-dom@18.3.1` (the root-level
  React-18 hoisting hack the [[L-062]]-adjacent jest note above referenced) is **deleted** — Next
  15 accepts React 19 natively, so the production build no longer needs a second, force-installed
  React copy at the image root. See `docs/testing/lockfile-edges.md`'s "Unsatisfied peer ranges"
  section, now at 0 (was 2 — the React 18/19 peer clash and the ESLint 9-vs-Next-14-peer warning,
  both resolved by this bump). Guard: `apps/api/src/common/no-react-skew-hacks.spec.ts` (T2, pairs
  with the `jest.config.js` removal in 1b).
- **`jest.setup.ts`** — `import "@testing-library/jest-dom"` plus RTL
  `configure({ asyncUtilTimeout: 10_000 })` (findBy*/waitFor headroom on slow hosts; pairs with
  `testTimeout` above).
- **`test-utils/render.tsx`** — `renderWithProviders(ui, opts)` (re-exports RTL +
  `createTestQueryClient()`: retries off, no caching). Wraps `QueryClientProvider` →
  `ToastProvider` → `I18nProvider` → `BuyerAuthProvider` → `AuthProvider` — the REAL context
  providers (safe with zero mocking as long as a test doesn't seed localStorage with a token,
  since both auth providers' refresh calls short-circuit to `null` with no network call when
  unauthenticated). Deliberately excludes `TenantProvider`/`ReAuthProvider` (both have safe
  non-null defaults without a real provider).
- **`lib/` suites (4)** — `api-client.test.ts`, `format.test.ts`, `formatting.test.ts`,
  `tenant-host.test.ts` (the last pins `tenantSlugFromHostname()`, the single source of truth
  documented above under "App shell & lib" — never re-inline its rules).
- **Component specs (15)** — auth surfaces: `app/(auth)/{login,forgot-password}/page.test.tsx`,
  `app/buyer/{login,forgot-password,portal}/page.test.tsx`; settings:
  `app/(dashboard)/settings/settings-{password,profile,users}.test.tsx`; domain modals/cards:
  `app/(dashboard)/bookkeeping/[transactionId]/page.test.tsx`,
  `app/(dashboard)/drivers/_components/{Add,Edit}DriverModal.test.tsx`,
  `app/(dashboard)/orders/_components/CreateOrderModal.test.tsx`,
  `app/(dashboard)/products/[id]/SalesHistoryCard.test.tsx`,
  `app/(dashboard)/routes/_components/late-stops.test.ts` (F12, PR #652 — `lateStopsFromAnalysis`;
  `CreateRouteModal.tsx`+`.test.tsx` DELETED same PR, B31 dead code),
  `components/MoneyInput.test.tsx`.
- **Auth-redesign specs (PR #663, spec 46)** — `components/auth/AuthShell.test.tsx`
  (`describe("AuthShell — T1")`, the shell component itself); `app/(auth)/auth-redesign.static.test.ts`
  (454 lines, 12 `describe`s: all 15 pages render `AuthShell` — T2a; `.rf-auth` CSS scoping —
  T2c/D10(b); RF monogram removed from forgot/reset/change-password — T2d; `auth-copy.ts` exports
  `AUTH_STORY` — T2f; `audience` prop matches route family — T2g; buttons use `.rf-btn` — T2h; ONE
  `h1` — T2j; success blocks carry `.rf-auth-success` — T2i; D1 pages compute their title rather
  than a literal — D10(a); no low-contrast emerald link utility on a buyer page — D10(c); fenced
  headings carry no trailing period — D10(d)); `app/(auth)/auth-redesign.guards.test.ts` (127
  lines, 2 `describe`s: no design-preview leftovers — T2b; no `next/image` import — T2e).
  **`app/(auth)/login/page.test.tsx` now module-mocks `@/lib/tenant-host` and
  `@/components/tenant-provider` for the whole file** — its assertions no longer exercise
  `tenantSlugFromHostname` directly (still covered by `lib/tenant-host.test.ts`); fidelity-loss
  note, registry B260.
- **Marketing-port specs (11, PR #657)** — static guards: `components/no-next-image.test.ts`
  (walks `app/`+`components/` for any `next/image` import — see `components/brand/` above),
  `app/(marketing)/marketing-port.static.test.ts` (MKT-PIN: dead asset/dependency scans,
  `globals.css`/`tailwind.config.ts` byte-identical to the branch baseline, one tokenised
  `--ring` focus rule — the two-colours-hardcoded finding from review is fixed and pinned here;
  plus a `.signin-menu [role="menuitem"]` CSS-rule-parser pin, R-MKT signin-menu, PR #673
  [[L-098]]: structural `display: flex` + `white-space: nowrap`, the anchor's own `:focus-visible`
  ring, no inner-child outline),
  `app/(marketing)/middleware.marketing.test.ts` (`lib/site.ts#routes` ↔
  `lib/marketing-routes.ts#MARKETING_PAGE_PATHS` parity), `app/(marketing)/seo.test.ts`,
  `lib/marketing-routes.test.ts`, `app/(marketing)/lib/operation-model.test.ts`. Component:
  `components/brand/BrandMark.test.tsx`, `app/(marketing)/components/{site-header,marketing,faq,
demo-form}.test.tsx`.
- **`app/(marketing)/distributors-redirect.static.test.ts` (PR #665, `/distributors` follow-through,
  [[L-093]])** — pins the `next.config.mjs` `redirects()` entry (loaded via a real
  `node --input-type=module` subprocess import of the config, since Jest/`next/jest`'s transform
  collides with the config's own `__dirname` binding — same technique `lib/csp.test.ts` uses) and
  the absence of `app/(marketing)/distributors/page.tsx`, so the alias can never regress back to a
  prerendered `redirect()` page.

## E2E tests (`apps/web/e2e/`)

Playwright against production (`routeflowweb-production.up.railway.app`). Auth via per-role
storage-state JSON (created once by `setup/auth.setup.ts`). ⚠️ **`helpers/auth.ts`
`fillWorkspaceIfShown` must stay a SINGLE atomic `fill(slug,{timeout})` in a try/catch — never
`isVisible()`-then-`fill()`.** That pair raced hydration (the server-rendered login form shows the
Workspace field for a frame before the client derives the tenant from the hostname and drops it),
so `isVisible()` returned true and the follow-up `fill()` burned the full 20s `actionTimeout` on a
detached node. Because every role project `depends on` `setup`, that ONE failure turned the whole
E2E job red on master for weeks — signature: operator FAILS, customer FLAKY on the identical path.
Swallowing the miss is safe, not vacuous: if the value were required, the `waitForURL("**/dashboard")`
right after fails loudly. **No mutations — read-only so safe
against production data** — with deliberate exceptions: `08-create-order-escape.spec.ts`'s ESC
tests park REAL drafts on the e2e tenant (the auto-park net is the behavior under test) and delete
them in `afterEach` via `DELETE /drafts/:id` (ids captured from the builder's POST); and
`17-buyer-shop-density-detail.spec.ts` creates a real E2E-prefixed customer + portal invite +
buyer account on `e2e-routeflow` (same additive-seed pattern `04-buyer-portal.spec.ts`'s BY-01/
BY-07 already establish — never cleaned up, harmless test-tenant fixtures), though its only cart
mutation is client-side localStorage (cleared at the end). Helpers: `helpers/api.ts` (`apiBase`,
`operatorAccessToken` — the direct-API conventions 06 established).
`apps/api/scripts/e2e-seed.js` sweeps any pre-cleanup draft residue from the operator's dock.
**Tenant admin seeded (B138, F14 2026-09-02):** `e2e-seed.js` now also creates/verifies an ACTIVE
`TENANT_ADMIN` user `e2e_admin`/`TenantAdmin1!` on `e2e-routeflow` (both the fresh-tenant and
existing-tenant branches) — `platform-admin.service.ts impersonate()` requires one ACTIVE
TENANT_ADMIN to resolve, and without it spec 31 below self-skips with a named reason rather than
running. `helpers/constants.ts CREDENTIALS.tenantAdmin` carries the pair; spec 31 targets this
shared `e2e_admin` directly (as on master — a dedicated `impersonatedAdmin` identity was tried
and reverted in wave D, see below), and `e2e-routeflow` holds exactly one ACTIVE TENANT_ADMIN.
**Seeding contract (2026-08-26, `setup/global.setup.ts`):** SKIP_E2E_SEED=true → skip;
`E2E_SEED_DATABASE_URL`/`DATABASE_URL` set → seed and **throw on failure** (aborts the run — no
more "Continuing despite seed error", which let the CI suite rot red for a week unnoticed); no URL

- CI → loud skip (the deployed app's standing `e2e-routeflow` tenant is assumed pre-seeded; wire
  the `E2E_SEED_DATABASE_URL` repo secret to re-seed every run); no URL + local → seed the local-dev
  fallback DB, failure aborts.

**Dedicated identity (L-050, wave D, #598/#607):** `helpers/constants.ts` `CREDENTIALS` gains
`sessionsOp` (`e2e_sessions_op`/`Sessions1!`) — seeded by `apps/api/scripts/e2e-seed.js` (both
branches). Spec 32 (active-sessions) logs in fresh as `sessionsOp` instead of the shared
operator, so its session-revoke never touches the `admin` account every `storageState:
operator.json` project also loads. Spec 31 (impersonation-signout) mutates only its own fresh
impersonation session and stayed on the shared `e2e_admin` (a dedicated `impersonatedAdmin`
identity was tried and reverted in wave D — see the 31 table row). This is what un-quarantines
both `playwright.config.ts` project entries below (see the 31/32 table rows).

**JSON reporter path (wave D — reverted to master's hardcoding):** `playwright.config.ts`'s
`json` reporter keeps master's literal `outputFile: "../../.campaign/runs/web-e2e.json"` —
unchanged. A wave-D attempt to read `PLAYWRIGHT_JSON_OUTPUT_NAME` in the config itself was wrong
on two counts: that env var is never consulted by the JSON reporter (it only feeds an
`OUTPUT_DIR`/`OUTPUT_NAME` fallback pair used when a reporter has no `outputFile` at all), and
`resolveOutputFile()` in `node_modules/playwright/lib/runner/index.js` already checks
`PLAYWRIGHT_JSON_OUTPUT_FILE` via `resolveFromEnv` **before** falling back to the config's
`outputFile` (line 1520 runs first; line 1521 only applies when that env var is unset) — so the
config never needed to change. `scripts/local-env.mjs --e2e` sets `PLAYWRIGHT_JSON_OUTPUT_FILE`
to an ABSOLUTE `<repo-root>/.campaign/runs/web-e2e-local.json` (computed from the script's own
file location — `resolveFromEnv` resolves relative to `process.cwd()`, not the config's
directory, so a `../../`-relative value would be cwd-dependent) so a local run never touches
campaign evidence; `scripts/campaign-check.mjs` carries a pointer comment to this file for the
same reason.

- **`e2e/46-auth-redesign.spec.ts`, project `auth-redesign`** (PR #663, spec 46; `testMatch:
/46-auth-redesign\.spec\.ts/`, no `dependencies`, Desktop Chrome only — **not part of the local
  red gate** per `test-plan.md`'s Harness notes; this project resolving/running IS the post-deploy
  proof). 4 `test.describe`s: T5 (desktop 1280×800 chrome/copy/labels), T5d (mobile 375×812
  chrome), T5e (accessibility), T5f (tenant logo on a tenant subdomain host). Specs 47
  (`47-auth-redesign-evidence.spec.ts`) and 48 (`48-auth-redesign-a11y.spec.ts`) were planned in
  the build-plan then DROPPED in the round-2 ruling (D3) — 47 duplicated the driver's own evidence
  capture, 48 duplicated this spec's own T5e — so 47/48 return to the free spec-number pool.

### Local E2E lane (`apps/web/e2e/LOCAL-LANE.md`, wave D)

A pre-PR Playwright pass against the local Docker stack (ADR 0001: `npm run local:up`, API
`:3000`, web `:3001`) — item 6 of `docs/IMPROVEMENTS.md` at "half" (dedicated users done; gating
the merge on hosted-staging E2E stays deferred, ADR 0002). Root scripts `npm run local:e2e`
(allow-listed `setup` + 7 money/guard projects, ≤ 10 min: `critical-paths`,
`create-order-escape`, `boxed-order-entry`, `order-edit-pricing`, `payment-truth`,
`destructive-guards`, `cancelled-edit-banner`) and `npm run local:e2e:all` (every project, no
`--project` filter — a report, not a gate) both run through `node scripts/local-env.mjs --e2e --
"npm --prefix apps/web run test:e2e -- ..."`. The `--e2e` flag (added to `local-env.mjs`
alongside `--db`/`--smoke`/`--db-specs`) sets `PLAYWRIGHT_BASE_URL=http://localhost:3001`,
`SMOKE_BASE_URL=http://localhost:3000`, `PLAYWRIGHT_TENANT_SLUG=e2e-routeflow`,
`E2E_SEED_DATABASE_URL=<compose Postgres URL>`, `PLAYWRIGHT_JSON_OUTPUT_FILE=<repo-root>/
.campaign/runs/web-e2e-local.json` (absolute), and unsets `CI`. Excludes `super-admin`/
`impersonation-signout` (need
`PLAYWRIGHT_SA_*`, not assumed present on every machine). Two known traps documented in
LOCAL-LANE.md: the shared-IP `/auth/login` throttle (`@Throttle` 10/5min, RF-160 —
`apps/api/src/auth/auth.controller.ts:66`) can present as a bogus login failure under retries,
and host CPU contention (other concurrent sessions/builds) can blow Playwright's navigation
timeouts even while the containers themselves respond in milliseconds.

| File                                   | Project                | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-super-admin.spec.ts`               | `super-admin`          | SA-01–12 admin panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `02-operator.spec.ts`                  | `operator`             | OP-01–22 dashboard, orders, invoices, routes, finance + **OP-03b dispatch-addon canary** (renamed 2026-08-28: Dispatch nav group must be visible — the e2e tenant keeps `recurring_routes` + `order_delivery` via `e2e-seed.js` now that `developer_mode` no longer unlocks them, and a broken seed row otherwise surfaces as a vague OP-10 `/routes` failure). OP-18b quick restock fills the FIRST and LAST `input[type=number]` (qty/boxes + the required cost) — the modal renders 2 inputs for a piece product but 3 (Boxes/+Pieces/Cost per Box) for a BOXED one since #417, and `nth(1)` filled Pieces leaving Cost empty, silently blocking the submit **⚠ OP-09c/OP-11b must NEVER target 'the first row' (#556, 2026-08-31):** both drive the tier editor, and spec 21's `E2E B24 Delete Target` guard fixtures sort newest-first into row 1 — the guard under test refuses their deletion, so a failed run leaks them. OP-09c then wrote its hardcoded 9.75 onto a $1.00-list leftover, violating tier monotonicity; the warning glyph joins the label's own text node ('Tier 2 ⚠') and `getByText('Tier 2',{exact:true})` never matches again — the chronic deploy-signal red of 2026-08-31. Both now resolve seeded `E2E Espresso Beans 1kg` ($24 list keeps 9.75 monotone) via `gotoTierEditorProduct` (API lookup, straight to the detail URL) and match `/^Tier 2/` prefix-tolerantly. GENERAL RULE: a spec that WRITES must pick a target whose invariants its own write cannot break, and never index into a list other fixtures can enter.                                                                                                                                                                                                   |
| `03-customer.spec.ts`                  | `customer`             | CU-\* customer portal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `04-buyer-portal.spec.ts`              | `buyer`                | BP-\* buyer B2B portal. BY-09..12 locate the portal seller card via `button[data-testid="seller-card"]` (2026-08-26 — the old `[class*='seller'], [class*='card'] button` locator never matched the portal DOM, so these four silently self-skipped forever)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `05-cross-cutting.spec.ts`             | `cross-cutting`        | CC-\* auth edge cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`06-critical-paths.spec.ts`**        | `critical-paths`       | **CP-01–10 money-math regression + float-artifact scan**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `13-boxed-order-entry.spec.ts`         | `boxed-order-entry`    | BOXED-01 — boxed cases/pieces proration read live off the order builder (box price + pack size scraped from the row, never hardcoded); parks a draft on Escape and deletes it in `afterEach`. ⚠️ **Never `fill()` a row qty input straight after adding the line.** `CreateOrderModal#addLineItem` re-focuses the product search on a `setTimeout(…, 50)`, and Playwright’s `fill()` on an `input[type=number]` is two round trips (in-page `select()+focus()`, then a separate CDP `Input.insertText`) — a re-focus landing between them delivers the keystroke to the SEARCH box and leaves the qty input untouched, silently, because `fill()` never reads the value back. That was the master-CI flake (2026-08-29): cases input kept "1", the total sat at 1 case + 2 pieces, and the 10s money poll could never converge. Guards: `waitForPostAddRefocus` (search empty AND focused) → `setBoxedQty` (fill, read back, re-type) → `assertLineTotal` gates the money poll on the row’s `N pcs total` text before sampling `$`. `findBoxedLine` also waits for the row to be VISIBLE after the add (and hidden after a remove) — the old non-retrying `isVisible()` probe could call a slow-rendering boxed row "not boxed", remove it, and let the spec self-skip green. ⚠️ Deliberately row-scoped, NOT a page-wide `toHaveCount(1)` on `ul.divide-y`: that class combo is **not** unique to this modal (`orders/[id]/page.tsx` and `CreditNotePicker.tsx` render it too, 4 matches repo-wide), so a count assertion would be a latent false RED the day one of those mounts behind the modal. Likewise the `N pcs total` gate is `\b`-anchored — a bare substring lets "12 pcs total" satisfy "2 pcs total" on any tenant whose `unitsPerBox` ends in 0. |
| `11-product-demand.spec.ts`            | `product-demand`       | Sales Demand card on `/products/[id]` — default 6M window, range switch refetches while **metric switch must NOT** (units+revenue ride one payload), 5Y axis-label thinning, never-sold (toggles hidden) and empty-window (jump-to-range) states. All endpoints mocked — incl. `/api/v1/analytics/product-sales/:id` (2026-08-26; unmocked it hit the live API, whose empty answer made `SalesHistoryCard` render a SECOND "Never sold" and violate strict mode — the never-sold assertion is also scoped to the Demand card via its "Sales Demand" heading ancestor); **route patterns MUST be anchored to `/api/v1`** — the page route is also `/products/:id`, so an unanchored matcher intercepts the HTML document navigation. Self-SKIPS on builds without the card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `09-regulated-compliance.spec.ts`      | `regulated-compliance` | Report-panel UX on `/compliance/[categoryId]` — DateRangePicker (presets, two-click anchor/commit), ReportColumnsPicker (materialize-then-toggle, save/reset round-trip incl. `reportColumnPrefs: null` clear), `columns=` preview param, Prepare-filing placement in the Filings card. ALL regulated/tracked-categories endpoints mocked (`mockSuppliers` pattern) — no writes reach any tenant; self-SKIPS on web builds without the panel (pre-deploy safe).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `17-buyer-shop-density-detail.spec.ts` | `buyer-shop`           | BSD-01 — self-contained operator-creates-customer→sends-invite→fresh-buyer-registers→accepts dance (invite token read from the `POST .../portal-invite` response body, not scraped from the DOM); seller card matched by `getByRole("button").filter({hasText: businessName})` (2026-08-26 — the `[class*='seller']…` locator never matched the portal DOM; the spec had never passed in CI); shop grid density (`density-sm`/`density-lg`) — assert `2xl:grid-cols-7`, the one class ONLY the "sm" map entry carries, across a reload; a bare `/grid-cols-3/` also matches "md"'s `sm:grid-cols-3` and would pass with persistence broken; first `product-tile-link` → `/shop/[id]` detail page (`product-detail-name`/`product-detail-price` visible); `product-detail-add` → floating cart button matched qty-agnostically (`/^View cart \(\d+ items\)$/`) because the badge counts total UNITS and a boxed Add stores `unitsPerBox` — pinning "1 items" would encode the boxed-Add bug. Clears `localStorage` at the end (cart-only; no server writes there).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `18-sales-agents-gate.spec.ts`         | `sales-agents-gate`    | PR-D entitlement gate — reads `GET /tenants/me/addons` and **branches on the tenant's live `sales_agents` state**, so it is green both before and after the addon is enabled. Off → no "Sales Agents" nav entry and a `/sales-agents` deep link renders the locked card; on → nav entry visible, "Add agent" on `/sales-agents` and "Generate" on `/finance/commissions`. Read-only by construction: GETs and renders only, nothing is created/approved/paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `20-trip-builder-gate.spec.ts`         | `trip-builder-gate`    | Ad-hoc trip builder entitlement gate (2026-08-24, renumbered 19→20, updated for the 2026-08-25 addon split and again 2026-08-28): reads the tenant's live addon state and asserts the **`order_delivery` flag alone** (the `developer_mode` disjunct was dropped — it no longer unlocks GA delivery UI) across BOTH branches (access off → no "Plan delivery trip" bulkbar action / no `act-plan-trip` command / `/deliveries/new` redirects; on → all three present at the new `/deliveries`/`/deliveries/new` URLs). Read-only, its own `playwright.config.ts` project entry; not part of the local verify gate (CI only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `21-destructive-guards.spec.ts`        | `destructive-guards`   | F02b destructive-write guards (REG-B24/B130/B154). Mutating but self-provisioning: mints its own `E2E B2x ...` throwaway product/customer fixtures and never destroys a discovered record. **⚠️ Its B24 fixtures are the ones that poisoned OP-09c/OP-11b** — the guard under test REFUSES to delete them, so a failed run leaks them and they sort newest-first into products row 1; see the 02-operator entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `22-payment-truth.spec.ts`             | `payment-truth`        | F03 (shipped #564; REG-B11 discharged post-deploy in #568). REG-B11's T2 leg: a DRAFT (unconfirmed) InvoicePayment must stay VISIBLE on the invoice payment-history row with a 'Draft - unconfirmed' badge while being excluded from every money SUM. **Its `payment-truth` project entry was added separately (commit e46cab10) because the authoring package could not reach `playwright.config.ts`** — the spec existed for a while with no entry, i.e. it would never have run. Third occurrence of that trap; see the #08 note above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

| `24-order-edit-pricing.spec.ts` | `order-edit-pricing` | F06 (2026-09-01). REG-B62's T2 leg: the operator order-edit page auto-enters edit mode on a DRAFT the instant the ORDER resolves, while `useCustomer`/`useCustomerPrices` are still in flight and `customerTier` falls back to `?? 1` — so a line added in that window bakes the LIST price, and the substitute path (which always SENDS `unitPrice`) persists it. Spec holds `/customers/:id` with `page.route` to make the race deterministic, asserts the add + substitute controls stay disabled behind `pricingReady` until it resolves, then that the added line prices at the seeded tier. Self-provisioning fixtures (its own tier-2 customer + DRAFT order, unique suffix) — never selects "the first row" (see the 02-operator poisoning note). Its `projects[]` entry ships in the SAME PR as the spec. |
| `31-impersonation-signout.spec.ts` | `impersonation-signout` | F14 (2026-09-02). REG-B138's T2 leg: logs in as super-admin, impersonates the shared `e2e_admin` TENANT_ADMIN seeded on `e2e-routeflow`, opens the avatar menu (asserts NO "Sign out" item, only "Exit impersonation"), clicks it, and proves the tenant admin's server-side session count is UNCHANGED and no `/auth/logout` request was ever made — the impersonated admin's own sign-in survives the super-admin walking away. No `storageState` (manages both sessions itself, mutating only its own fresh session). Own `playwright.config.ts` project entry — without one it never runs (see 08's precedent). Skips (not a discharge, L-041) until `PLAYWRIGHT_SA_*` are set and `e2e-seed.js` has seeded `e2e_admin` on the target. **Un-quarantined 2026-09-03 (L-050, #598/#607):** was quarantined 2026-09-02 (#599, post-deploy run 33612887226 red) because this phase-1 project and spec 32 both wrote to the shared `e2e_admin`/`admin` accounts every phase-2 `storageState: operator.json` project also reads (root cause: spec 32 revokes `/auth/sessions` `rows[0]`, listed `createdAt DESC`, which becomes `operator.json`'s own session once `setup` logs in after spec 32 — a phase-1 WRITE against a phase-2 READ on one shared user). Investigation found the collision was specific to spec 32's revoke, not spec 31's read-mostly impersonation flow (spec 31 only ever mutates the fresh impersonation session it creates and exits within the test) — so spec 32 alone needed a dedicated identity (`e2e_sessions_op`); a wave-D attempt to also give spec 31 a dedicated `e2e_impersonated_admin` identity was reverted (kept `e2e-routeflow` at exactly one ACTIVE TENANT_ADMIN, avoiding the two-admin `findFirst` ambiguity that identity would have introduced). `playwright.config.ts`'s project entry is re-enabled. B138/B155 stay `proven-pending-deploy` (L-041: a skip is not a discharge) until a real run confirms it. |
| `32-active-sessions.spec.ts` | `active-sessions` | F14 (2026-09-02). REG-B155's T2 leg: logs in fresh as `sessionsOp` (`e2e_sessions_op`), captures its Active Sessions row's `data-session-id`, forces a refresh-token rotation, reloads the sessions list, and asserts the SAME `data-session-id` is still present with its ORIGINAL sign-in time (proves the api-side in-place rotation, not a new row); revokes it and confirms the rotated token then 401s (the revoke bites the live session, not a stale row); a second test forces a revoke to fail and asserts the list re-syncs instead of leaving a phantom row; a third adds a second login so "Sign out all" renders, forces EVERY revoke to 403 and asserts the honest branch — toast "Some sessions could not be revoked", rows still listed, one re-fetch — instead of the old swallow that emptied the list and claimed success. No `storageState` on purpose; its cleanup is scoped to the sessions it created, so it never revokes the shared `operator.json` row (Fable final-pass finding, #598). **Un-quarantined 2026-09-03 (L-050, #598/#607):** was quarantined 2026-09-02 (#599) for the same shared-user collision described in the 31 row above — this spec logs in fresh as the dedicated `e2e_sessions_op` operator (seeded by `e2e-seed.js`) instead of the shared `admin`, so its `/auth/sessions` revokes can no longer land on `operator.json`'s row; `playwright.config.ts`'s project entry is re-enabled. B138/B155 stay `proven-pending-deploy` (L-041: a skip is not a discharge). |
| `33-change-plan-routing.spec.ts` | `change-plan-routing` | F18 (2026-09-06). REG-B58's web leg (proven-pending-deploy — a real post-deploy run is the proof, see web.md's Plan-change routing entry above): an UPGRADE quote commits via `POST /billing/subscription`, a DOWNGRADE via `POST /billing/subscription/downgrade`, **never** the old `POST /billing/subscribe` (T2/T4); a third test proves the `PlanGates` upsell CTA still lands on a chooser that routes UPGRADE correctly (Amendment 2). Own `playwright.config.ts` project entry — a spec without one never runs (08's precedent). |
| `34-calendar-dates.spec.ts` | `calendar-dates` | F25 (2026-09-04). B59 + B91 e2e legs (proven-pending-deploy — a real post-deploy run is the proof). Per-project `timezoneId` America/Los_Angeles. Flow 1 `REG-B59`: create route + run (scheduledDate 2026-06-10T00:00:00.000Z), open Edit Route Run, change only the driver, save, re-fetch and assert `scheduledDate` byte-identical. Flow 2 `REG-B91`: create customer + authorization expiring 2026-11-01, open Customers -> Licenses tab, assert it renders "Nov 1, 2026" and not "Oct 31, 2026". Own `playwright.config.ts` project entry — a spec without one never runs (08's precedent). |
| `35-route-windows.spec.ts` | `route-windows` | F12 (2026-09-06/07, PR #652). REG-B161's T2/pending-deploy leg (T4 in the F12 bug-test-plan.md — the API-side jest proof is a separate REG-B161 case, T1/T2 in that plan; see api.md's F12 bullet and web.md's dispatch-modal entry above): builds a template route with one windowed stop the persisted order misses, opens the template page, Optimize, asserts the dispatch modal's late-stop warning renders (dialog-role scoped) and Dispatch requires the acknowledge checkbox before it un-disables, and that the optimize toast names the miss count (scoped via `getByRole("region",{name:/notifications/i}).getByRole("listitem")`, L-076 — never a bare `getByText`). `dependencies:["setup"]`, operator `storageState`. Own `playwright.config.ts` project entry — a spec without one never runs (08's precedent). Proof lands post-deploy; B161 stays `proven-pending-deploy` until that run is green (L-041: a skip is not a discharge). |
`06-critical-paths.spec.ts` is the key regression guard for the money-math fix: verifies all
displayed amounts are `$X.XX`, API money fields have ≤2 dp, and invoice `total = subtotal + tax`.
CP-07 (finance dashboard) extracts amounts with `allInnerTexts()` joined by `\n` — NEVER
`allTextContents()`: textContent glues an amount to the next label's leading digits (AR-aging
"$0.00"+"1 to 15 days" → "$0.001"), a false failure whenever the tenant has open AR.

**Portal switcher (2026-09-04):** `05-cross-cutting.spec.ts` CC-16…CC-21 (raw-request, `cross-cutting`
project) prove the middleware contract — buyer-only on an operator path → `/login?redirect=`
encoded; landing `/` resolution incl. `rf-last-portal` tie-break; the guard's negative cases. Two
read-only menu tests prove the presence-aware switch affordances post-deploy: `02-operator.spec.ts`
OP-23 (avatar menu "Buyer portal sign-in" → `/buyer/login`, `rf-last-portal=op` cookie) and
`04-buyer-portal.spec.ts` BY-15 (sidebar "Seller dashboard sign-in" → `/login`, `rf-last-portal=buyer`
cookie). `seedPresenceCookies` in 05 now also accepts `{name,value}` pairs (was bare cookie names
defaulting to `"1"`) so `rf-last-portal` can be seeded with `"op"`/`"buyer"`.

Run: `cd apps/web && npx playwright test`

- **Sales Demand card (2026-08)** — `products/[id]/DemandCard.tsx` (NEW; its own file rather than inline like the neighbouring `CostHistoryCard`, because it owns range+metric state and five render states) replaces the old `generateDemandData` seeded-PRNG demo chart (deleted from the page AND from the dead `mocks/products.ts` copy), and the page's `isMounted` hydration guard went with it — it existed solely for that chart. `lib/api/product-demand.ts` `useProductDemand(productId, range)`, key `["products", id, "demand", range]`, `placeholderData: keepPreviousData` so a range switch holds the previous bars instead of flashing a skeleton. **Metric is client-only state — NOT in the query key and NOT a param** (units+revenue ship together). X-axis `interval` derives from the BUCKET COUNT, not granularity: 1y and 5y are both monthly at 12 vs 60 points, and a per-granularity value renders all 60 labels. Bucket labels are formatted from the `YYYY-MM-DD` string parts — never `new Date(iso)`, which parses date-only strings as UTC midnight and renders the previous day west of UTC. Tooltip reuses `formatQtySplit`+`normalizeBoxesPieces` from `lib/pricing.ts`.

Run: `cd apps/web && npx playwright test` (all projects) or `--project=critical-paths`.

## Components & shared

- **`components/auth/` (2026-09-08, PR #663, spec 46) — shared `AuthShell` for all 15 reskinned
  auth pages** (operator `(auth)/login`, `(auth)/signup`, `(auth)/signup/check-email`,
  `(auth)/forgot-password`, `(auth)/reset-password`; buyer `buyer/login`, `buyer/register`,
  `buyer/change-password`, `buyer/invite/[token]`, `buyer/reset-password`, `buyer/forgot-password`,
  `buyer/verify-email`, `buyer/verify-merge`; top-level `change-password`, `verify-email`) — logic
  on every page is byte-identical to before, only the chrome changed.
  `AuthShell.tsx` (98 lines) — `AuthShellProps { audience: "distributor"|"retailer", kicker: string,
title: string, lead?: ReactNode, backHref?: string, backLabel?: string, logoUrl?: string|null,
logoAlt?: string, footer?: ReactNode, children: ReactNode }` (`title` is the single `h1`; this is
  NOT the mobile scanner shell — no `initialScanOpen` here). Renders one
  `<main id="main-content" className="rf-auth">` with a `.rf-auth-story` panel (`Brand tone="light"
standalone`, an `h2` kicker/heading/paragraph from `AUTH_STORY[audience]`, an aria-hidden
  order-status/AI-chip visual, a tagline) and a `.rf-auth-form` section (back link, `.rf-auth-card`
  with an optional tenant `logoUrl`, the `h1 title`, optional `lead`, `children`, then a footer slot
  that ALWAYS renders even with no `footer` prop so "Need help?" stays right-aligned). **The story
  panel's `h2` precedes the card's `h1` in DOM order** — design intent (left-to-right
  story-then-form), hidden entirely at ≤ 850px — registry B261.
  `auth-copy.ts` — `AuthAudience`, `AUTH_STORY`, `AUTH_ORBIT`, `AUTH_AI_CHIP`, `AUTH_TAGLINE`
  (verbatim fenced strings transcribed from an external redesign source, cited in the file header).
  `auth-shell.css` (336 lines) — every top-level selector is prefixed `.rf-auth` (D4; a dead
  `.rf-auth-forgot` rule was removed) so `.rf-auth .rf-btn` (0,2,0) beats Tailwind's
  `bg-accent-strong` (0,1,0) by specificity, never bundle order; `app/globals.css` and the Tailwind
  config are untouched. `index.ts` re-exports `AuthShell`, `AuthShellProps`, and all of
  `auth-copy.ts`. State-derived `h1` titles (no state string rendered twice) on
  `buyer/invite/[token]`, `verify-email` (top-level + buyer), `buyer/verify-merge`, and both
  `reset-password` pages. Buyer auth pages moved off a separate emerald link palette onto the SAME
  utility the operator `/login` "Forgot password?" link uses (`#0b6e6b`, 6.07:1). **Deferred**
  (not fixed, registry rows): B260 (`(auth)/login/page.test.tsx` module-mocks `tenant-host`/
  `tenant-provider` for the whole file instead of exercising `tenantSlugFromHostname` directly —
  unit coverage stands in via `lib/tenant-host.test.ts`), B261 (h2-before-h1 above), B262
  (operator/buyer copy asymmetries: OR/or divider, one-sided back-arrow, `/reset-password` missing
  its footer link — fenced strings, needs a copy ruling). Guards: see "Unit tests" and "E2E tests"
  below.
- **Duplicate-invoice UX in `ScanInvoiceModal.tsx` (2026-08-07):** `InvoiceGroup` gained
  `duplicate` / `duplicateCheckPending` / `allowDuplicate`. A check fires from `applyScan` for every
  invoice in a batch and again (500ms debounce, keyed by invoice id, cleared on discard + unmount)
  whenever the Supplier Invoice # or supplier changes — both of which also reset `allowDuplicate`.
  The posted `total` is the SAME `roundMoney(invoiceTotal + scannedTax)` figure `createOne` sends, so
  the server's supplier+date+total fallback can actually line up. A banner under the Supplier
  Invoice # field distinguishes **resumable** (existing bill is DRAFT — finish it) from **hard**
  (already received — a second bill would double stock), each offering "View existing bill" (new tab,
  so the modal survives) and "Create anyway". **Duplicates are SKIPPED, never batch-blocking**:
  `invoiceValidationError` is deliberately NOT the vehicle (that pre-validation loop aborts the whole
  batch) — `handleCreateAll` partitions targets, posts only the clean ones, and reports
  "Created X of Y — N skipped as duplicates". A skipped duplicate is not a failure and gets no
  `inv.error`. `createOne` also re-parses a 409 in its catch, which covers the same number appearing
  twice inside ONE batch (invoice 1 creates the bill, invoice 3 then 409s) without aborting the loop.
- **Scan archive wiring in `ScanInvoiceModal.tsx` (2026-08-09):** `POST /vendor-bills/scan-invoice`
  now answers with `scanId` and, when the uploaded BYTES hash to a scan already on file, a
  `priorScan` block (`{scanId, scannedAt, status, vendorBillId, billNumber, supplierInvoiceNumber,
total}`) — types live in `lib/api/vendor-bills.ts` as `PriorScanSummary`/`ScanArchive`, folded in
  at the modal as `ArchivedScanResult = ScanResult & ScanArchive` because `lib/api/invoice-scan.ts`
  stays a plain transport type. `PriorScanBanner` (top of the review panel, `data-testid=
"prior-scan-banner"`, plus a marker in `InvoiceNavigator` suppressed when the duplicate marker
  already says it) has two shapes: **amber** when the earlier scan is POSTED with a bill (offers
  "Open BILL-…"), **green** when a review was abandoned — that payload is the STORED extraction
  replayed with no second AI call, so the form fills in exactly as a fresh scan would. `createOne`
  stopped discarding what the OCR read: `scanId` (links bill↔scan and marks it POSTED), `subtotal`,
  and per-line `sku`/`packSize`/`lineTotal`, all as PRINTED — an operator edit to qty/unitCost does
  not rewrite them. **Split rows send NO sku/lineTotal** (the printed code and amount describe the
  whole line, not each variant) **but DO inherit `packSize`** (2026-08-12): a split divides the CASE
  count across flavors, so each part stays case-denominated — dropping it received cases as pieces.
- **Skip pre-existing invoices in `ScanInvoiceModal.tsx` (2026-08-12):** `InvoiceStatus` gained
  `"skipped"` — one status value updates every consumer (`targets`/`creatable`/`leftBehind`/
  `firstUnposted`/`hasWork`). `alreadyInSystem(inv)` is the ONE predicate for "pre-existing"
  (number/fuzzy `blockingDuplicateOf` OR a POSTED `priorScan` with a bill; expense-mode and
  `allowDuplicate` exempt) consumed by banners, navigator, skip affordances and the create-all
  partition. `skipInvoice`/`unskipInvoice` flip status (never array removal — object URLs + nav
  indices stay stable); editing supplier/invoice-number un-skips like it resets `allowDuplicate`.
  DuplicateBanner gained "Skip this invoice" (`data-testid="duplicate-skip"`), skipped panel
  (`duplicate-skipped`) offers "Undo skip", navigator shows "N already recorded · Skip them"
  (`skip-all-duplicates`). `handleCreateAll` counts `dropped` (explicit skips — DONE decisions)
  separately from `autoSkipped` (still-blocked dups left scanned); clean close =
  `failed===0 && autoSkipped===0 && leftBehind===0` — **a batch containing skipped duplicates
  now finishes**; toast reports "N skipped as already recorded". All-dups batch → confirm →
  skip-all + close. Qty cell gained a per-line pack-size input ("× N pcs", clearable) and the cost
  cell a "per case of N" hint; quick-create from a case line passes PER-PIECE `initialCost`
  (box-price `initialPrice` unchanged — the boxed contract asymmetry; `ProductCreateModal`'s cost
  hint is pack-aware). e2e: OP-17f (one dup skipped, other posts, modal closes).
- **`ScanInvoiceModal.tsx` single-scan error fidelity (2026-09-04, REG-OCR-2):** the single-scan failure toast now reads `msg || "Please check the file and try again."` — `msg` is the server's own `error?.response?.data?.message` — so a 403 `ADDON_GATE` denial (or any other server message) surfaces verbatim instead of the generic file hint; the generic copy is now a true fallback for when the server sends none. Mirrors the batch branch (`scanOne`), which already read the server message. e2e: `e2e/02-operator.spec.ts` OP-17g — mocks a 403 `ADDON_GATE` response on `**/vendor-bills/scan-invoice` and asserts the server's message is visible and the generic hint has zero matches.
- **Partial receiving on `vendor-bills/[id]/page.tsx` (2026-08-12):** `ReceiveBillModal` — per-line
  qty inputs primed to outstanding (`lineRemaining(bill,item)` mirrors the server's legacy rule:
  receivedDate set + all `qtyReceived` null = fully received), invalid/over-remaining blocks
  confirm, unlinked count noted; confirm posts `items: [{itemId, qty}]` (`useReceiveVendorBill`
  gained `items`; `ReceiveVendorBillLine` in `lib/api/vendor-bills.ts`, `VendorBillItem` gained
  `sku/packSize/lineTotal/qtyReceived`). `pendingReceiveItems` re-sends the same plan through the
  UNLINKED_ITEMS confirm retry. Receive affordance: DRAFT, paid-first-never-received (status is a
  payment blend — receipt truth is receivedDate), and PARTIAL/PAID with outstanding ("Receive
  remaining"). Items table shows "× N pcs" / "per case" / "n received" hints; the line editor
  gained a Pcs/case column (cost label flips Unit↔Case Cost) and PRESERVES sku/lineTotal through
  `handleSaveEdit` (server recreates lines on edit — anything not resent is lost); quick-create
  from a case line seeds per-piece price AND cost (no pack prefill on `InlineCreateProductModal`).
- **Date fields (2026-08-07):** `CreateOrderModal.tsx` has an optional "Order date" (`max=today`)
  beside Requested Delivery Date; `invoices/new/page.tsx` relabels its issue-date field "Sale date" in
  SALE mode and sends `orderDate` ONLY when it differs from today (so the default path stays
  byte-identical and `deliveredAt` keeps a full `now()` timestamp); `orders/[id]` and the orders list
  render `orderDate ?? createdAt`, the list marking a backdated row where the two UTC days differ.
  `invoices/[id]/page.tsx`'s RecordPaymentModal gained BOTH a "Payment date" (it previously had NO
  date at all — the server stamped now) and the optional "Money received in bank"; EditPaymentModal
  clears the latter by sending `null`; the payment-history row switched from `createdAt` to `paidAt`
  (it disagreed with every other surface and already misreported a backdated payment) and appends
  "· landed {date}". `finance/payments` gained the field, a sortable "Bank date" column, and the
  detail display; date FILTERS stay on `paidAt`. Buyer surfaces untouched — settlement is internal.
  **`orderDate` must survive the two places it used to vanish:** it is part of `OrderDraftPayload`
  (`lib/drafts.ts`) plus the `draftPayload` memo AND its dependency array, the hydration effect and the
  `lastSavedRef` autosave baseline — `handleDismiss` auto-parks on Cancel/backdrop/Escape, so a missing
  key silently discarded the date without the operator choosing to discard anything (and a stale memo
  emits no autosave PATCH at all). And when a date is set the merge prompt DISABLES "Merge into …"
  (demoted to secondary, "Create as separate" promoted to primary) because that branch merges via
  `updateOrderItems` server-side and never carries the date; the API rejects the combination anyway.
  `finance/expenses`'s CreateBillModal now parses 409s with `getDuplicateVendorBillError` and renders
  the same duplicate banner (amber resumable / danger hard, "View existing bill" + "Create anyway" →
  re-post with `allowDuplicate`) instead of swallowing the server message in a generic toast.
- `SentryInit.tsx` (2026-08-26): client component mounted in root `app/layout.tsx` — inert
  unless `NEXT_PUBLIC_SENTRY_DSN` set; dynamic-imports `@sentry/react`, tags `tenant` from the
  slug cookie.
- `tenant-provider.tsx` (branding CSS vars; **2026-08-26 branding-by-session** — slug resolves
  JWT-first via `lib/auth.ts getSessionTenantSlug()` (module-level, NOT a hook: the provider
  mounts OUTSIDE the auth context), a disagreeing `tenant-slug` cookie is REWRITTEN (self-heal
  — it also feeds the X-Tenant-Slug header), and branding re-resolves+refetches on window
  focus/visibilitychange when the resolved slug changed (multi-tab impersonation switches)
  **plus `subscribeImpersonation(recheck)` (2026-08-28)** for the same-tab case — an
  impersonation set/clear during a soft nav fires no focus/visibility event, so the sidebar logo
  and business name used to stay on the previous tenant; the slug-changed guard still means no
  refetch on an unrelated event. `refreshTokens()` in auth.ts also re-syncs the cookie. Root cause fixed: a stale cookie
  could brand one tenant's invoice letterhead with another tenant's name), `CommandPalette.tsx` (Cmd+K nav/search),
  `BarcodeScannerButton.tsx`, `DocumentLetterhead.tsx` (PDF header), `ScanInvoiceModal.tsx` (OCR),
  `BatchItemReviewModal.tsx` (`settings/batch-import` — per-line product remap + supplier link;
  the review gate for `resolveItem`, see api.md's P5 batch-queue defect-fixes note),
  `SearchableProductPicker.tsx`, `SupplierSelect.tsx`, `InlineCreate{Product,Supplier}Modal.tsx`
  (Product modal's `CreatedProduct` carries `unitsPerBox`/`parentProductId`/`variantName`/`parent`
  so `onCreated` consumers — CreateOrderModal, invoices/new — get the Boxes+Pcs editor + the
  `displayProductName` label for a just-created boxed product/variant),
  `AddressAutocomplete.tsx` (Google Maps), `UnitCombobox.tsx`, `GroupAsVariantsModal.tsx`,
  `ConfirmDialog.tsx`, `DraftDock.tsx` (parked-draft dock + scan-to-draft, Phase 2 §2; its
  `resumeHref`/`newOrderHref` and `CommandPalette`'s `createHref` MERGE the intent param onto the
  current query when already on the target route — building it from scratch discarded the
  operator's `?page=`/`?search=`, because the target page's deep-link effect strips only the intent
  params and replaces with whatever is left),
  `ArrivedStopSheet.tsx` (Phase 2 §3 at-door actions sheet: `Modal` w/ 3 nav tiles — Adjust order
  → `/orders/{orderId}` (shown only if the stop has an order), New order at door →
  `/orders?action=new`, Collect payment → `/finance/payments`; pure navigation dispatcher, no new
  API/state, closes on selection via `router.push`),
  `SortableTh.tsx`, `ReportChart.tsx` (recharts), `ReportToolbar.tsx`,
  `TenantLogo.tsx`, `PwaInstallPrompt.tsx`/`InstallAppButton.tsx`, `ServiceWorkerRegistry.tsx`,
  `AutoRedirectIfAuthed.tsx`, `inventory/StockCount{Tab,Row,BulkBar,ReviewModal}.tsx` (the per-row
  count qty is a **`DecimalInput`** — was a native `type=number` that couldn't take fractional counts
  for kg/liter units and snapped a cleared field to 0; `decimals` = 3 for decimal units else 0;
  **2026-08-26:** `beginNewSession` marks a FRESH session as already hydrated
  (`hydratedSessionRef.current = res.id` when not amending) — the session is created empty
  server-side, so letting the detail query's `lines: []` through the hydrate effect wiped the row
  the operator scanned in the same breath (the first counted line vanished on every new count;
  e2e COUNT-01 caught it). Amend sessions still hydrate — those ARE seeded server-side).
- **order-entry / catalog batch (2026-07-11):** `MoneyInput.tsx` (`MoneyInput`/`DecimalInput` — raw draft string, parse live, `toFixed` on blur only; replaced every reformat-while-typing / numeric-bound money input incl. the `PriceEditRow` echo `useEffect` + product-tier `EditableNumber`), `CategoryCombobox.tsx` (pick-or-type-new, fork of `UnitCombobox`; `GET /products/categories`), `formatQtySplit` in `lib/pricing.ts` ("2 boxes + 3 pcs" on order/invoice detail + PDF). `ScanInvoiceModal.tsx` + `vendor-bills/[id]` gained the unmatched-line banner + per-line link/create (reuse `InlineCreateProductModal` w/ `initialPrice`/`initialCost`) and STOP auto-`acknowledgeUnlinked`. `QuickRestockModal` (inventory) = `SearchableProductPicker`(+`inputRef` wedge) + `BarcodeScannerButton`. `vendor-bills/[id]` `EditLineItems` line-item product select uses `SearchableProductPicker async` (server-side search, no 500-row `useProducts` fetch) instead of a native `<select>`; `onChange(id, product)` sets `productId`/`description`/`unitCost` from `product.averageCost`, clearing sets `productId: ""` (custom item). Per-line item **note** input on `CreateOrderModal`/`orders/[id]`; per-line **cost eye** toggle (operator-only) on `CreateOrderModal`.
- **`ScanInvoiceModal.tsx` batch scan (one bill per PDF):** state = `invoices: InvoiceGroup[]` + `activeIndex`; flat names (`supplierId`, `reviewItems`, `pagePreviews`, expense fields…) are DERIVED from `invoices[activeIndex]` with plain-closure wrapper setters (NEVER memoize — stale `activeIndex` would cross-write invoices). `groupFiles`: each PDF = own invoice, all images = one invoice (pages). One `scanInvoice(files, signal)` call per group (concurrency 3, per-invoice `AbortController` + `runIdRef` stale-guard, per-invoice Retry). `InvoiceNavigator` (◀ Invoice X of N ▶ + status dots + within-batch dup-invoice# warn) switches preview AND form. `handleCreateAll`: `isSubmittingAll` gate, ONE up-front aggregated unlinked-lines confirm (single-invoice copy must keep "aren't linked to a product" — OP-17b asserts it), per-invoice create→receive→expense with `createdBillId`/`expenseCreated` idempotency (no double-post on retry); supplier invoice # editable → bill `notes` + expense `referenceNumber`; `roundMoney` on all totals; modal stays open if failed/scanning invoices remain. Object URLs revoked on re-upload/unmount (`invoicesRef`). e2e: OP-17b (single, unchanged) + OP-17c/d/e (batch/retry/idempotency, all write-routes mocked). Partial-failure branch now resets `createFromRow` alongside `activeIndex` (was desynced — a still-open "Create product from this line" flyout could attribute the new product to the wrong invoice after `setActiveIndex` jumped); `InvoiceNavigator` + the per-row create-product button are `disabled` while `isPending` so an operator can't switch invoices or open that flyout mid-batch-create. `invoiceTotalOf` sums RAW line amounts and rounds ONCE at the end (was rounding each line then summing) — must match the server create() totalOwed computation exactly, since this value also feeds the paired both-mode Expense.amount; per-line rounding could drift a cent from the server total on a fractional qty or >2-decimal unit cost.
- **`components/brand/` (new, marketing-port #657)** — the one shared brand mark, replacing every
  per-site logo treatment (marketing nav/footer SVG, login's inline SVG, the 404 "RF" monogram,
  platform-admin's Shield icon, every legacy per-brand `<img>`). `BrandMark({size=34, className,
tone="dark"|"light"})` — plain `<img src="/brand/routeflow-mark-192.png">`, deliberately NOT
  `next/image` (guarded by `components/no-next-image.test.ts` below — `apps/web` builds
  `output:"standalone"` with no `images` config); `tone="light"` applies `brightness-0 invert` for
  dark surfaces. `BrandSignature({size, periodColor, standalone, tone})` = mark + "routeflow."
  wordmark; `standalone` opts into the marketing header's own type metrics on surfaces outside
  `.rf-marketing` (login, 404, platform-admin) so the signature is self-contained there. `Brand` =
  `BrandSignature` wrapped in a `Link href="/"`. **`TenantLogo.tsx` falls back to `BrandMark`**
  (via a `role="img" aria-label` wrapper, since `BrandMark` itself is `alt=""`/`aria-hidden`) when
  no `branding.logoUrl` is uploaded; its own `tone` prop (default `"dark"`) affects only the
  fallback mark, never a tenant's uploaded logo.

## API hooks (`lib/api/`)

Each module exports TanStack Query hooks + TS types mirroring API DTOs. **2026-09-03 (wave E /
imp-10b):** the 95 identical/near-identical DTOs the dup sweep found now live in
`packages/types/api/*.ts` and every Prisma-enum mirror in `packages/types/api/enums.ts` — these
modules `import type { ... } from "@routeflow/types"` instead of redeclaring; the divergent shapes
(39 names) stay local. See [`packages`](packages.md) → `@routeflow/types` for the domain-file
layout and the enum-parity guard. Key entries:

| Module | Key hooks |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders.ts` | `useOrders`, `useOrder`, `useCreateOrder`, `useUpdateOrderStatus`, `useToggleUrgent`, `useReopenOrder`, `useBulkDeleteOrders`, `useResolveChangeRequest` (P5-11) |
| `invoices.ts` | `useInvoices`, `useInvoice`, `useCreateInvoice`, `useUpdateInvoice`, `useSendInvoice`, `useVoidInvoice`, `useApplyCreditNote`, `useApplyAdvanceToInvoice`, `useDownloadInvoicePdf`, `useRecordInvoicePayment`, `useRecurringInvoices` |
| `routes.ts` | `useRoutes`, `useRoute`, `useCreateRoute`, `useAddStopToRoute`, `useUpdateRoute`, `useRouteRuns`, `useCreateRouteRun`, `useOptimizeRoute`, `useAnalyzeRoute`, `useUpdateRouteRunStatus` (**F11:** `onSuccess` also invalidates `["orders"]`, `["trips-eligible-orders"]` (trips.ts picker list) + `["trip-eligibility"]` — a CANCELLED/COMPLETED write releases the run's undelivered orders, freeing the pointer both trip-builder queries read) |
| `customers.ts` | `useCustomers`, `useCustomer`, `useCreateCustomer`, `useUpdateCustomer`, `useDeleteCustomer` (hard), `useSoftDeleteCustomer` (force → restorable) + `useRestoreCustomer` (8s-undo pair). **F09/B13 (2026-09-06):** `useApplyAdvancePayment` deleted — zero component callers ever existed (`git log -S` shows it added once, never wired to any JSX); `invoices.ts`'s `useApplyAdvanceToInvoice` is the one advance-apply hook, itself still uncalled from any page (B13 refuted as a bug — a real "Apply advance" web affordance is a FEATURE, deferred to dev-pipeline). |
| `products.ts` | `useProducts`, `useProduct`, `useProductByBarcode`, `useCreateProduct`, `useUpdateProduct`, `useBulkAssignParent` (one POST `/products/bulk-assign-parent` → `BulkAssignParentResult{succeeded,failed}`; consumed by GroupAsVariantsModal) |
| `drivers.ts` | `useDrivers`, `useDriver`, `useCreateDriver`, `useUpdateDriver`, `useChangeDriverStatus`, `useDriverHistory`, `useDriverMetrics`, `UpdateDriverInput` (= `Partial<Driver>` + the four `home*` write fields — the home base READS back as one composed `Driver.homeAddress` but WRITES as line1/city/state/zip; `drivers/_components/EditDriverModal.tsx`'s "Home Base" section is the only web writer, and the only way the `trips.service.ts` DRIVER trip origin becomes usable) |
| `suppliers.ts` | `useSuppliers` (key `["suppliers", params]`), `useSupplier`, `useCreateSupplier`, `useUpdateSupplier`, `useDeactivateSupplier`, `useDeleteSupplier`, `useImportExpenseSuppliers` + **`invalidateSupplierLists(qc)`** — supplier lists live under TWO key families (`["suppliers"]` here, `["inventory","suppliers"]` in `inventory.ts`); every supplier mutation in BOTH files invalidates both via this helper (2026-08-23 fix: "+ New" supplier in the purchase/scan-invoice/vendor-bill modals never appeared in the other family's dropdowns) |
| `returns.ts` | `useReturns`, `useReturn`, `useCreateReturn`, `useApproveReturn`, `useRejectReturn`, `useMarkReturnInTransit`, `useMarkReturnReceived` (**WP10:** `{id, restock?}`, sends body), `useProcessRefund` (**WP10:** `{id, method?: "CREDIT_NOTE"\|"EXTERNAL_REFUND"}`, drops dead `restock`, also invalidates `["credit-notes"]`). `Return` gained `creditNoteId`/`creditNote{id,creditNoteNumber,amount,status}`/`refundAmount`/`refundMethod`/`refundedAt`/`refundEstimate` (server-computed, always present). |
| `estimates.ts` | `useEstimates`, `useEstimate`, `useCreateEstimate`, `useUpdateEstimate`, `useSendEstimate`, `useConvertEstimate` |
| `credit-notes.ts` | `useCreditNotes`, `useCreditNote`, `useCreateCreditNote`, `useApplyCreditNote`, `useVoidCreditNote`. **F09/B18 (2026-09-06):** `useIssueCreditNote` deleted (the `/issue` route never worked — the enum had no DRAFT). `CreditNoteStatus` now `export type { CreditNoteStatus }` re-exported from `@routeflow/types` (was a hand-typed `"DRAFT" \| "ISSUED" \| "APPLIED" \| "VOID"` union incl. the phantom DRAFT — [[L-072]]). `CreditNote.invoice?: { id; invoiceNumber }` added (F09/B19). |
| `vendor-bills.ts` | `useVendorBills` (+`needsMapping`, meta.needsMappingCount), `useVendorBill`, `useCreateVendorBill`, `useReceiveVendorBill` (`{id, acknowledgeUnlinked?}`), `getUnlinkedItemsError` |
| `finance.ts` | `useFinanceDashboard`, `useArAgingInvoices`, `useSalesByCustomer`, `useSalesByItem`, `useProfitAndLoss`, `useCashFlow`, `useExpenses`, `useCreateExpense`, `useUploadExpenseReceipt` |
| `bookkeeping.ts` | `useBookkeepingSummary`, `useTransactions`, `useTransaction`, `useRecordPayment`, `useDownloadInvoice`; types `Transaction`/`Payment` — `Payment.method` is `AnyPaymentMethod` (display type; the picker writes any of the 6 selectable methods) |
| `inventory.ts` | `useStockOverview`, `useStockMovements`, `useRecordPurchase`, `useRecordAdjustment`, `usePurchaseOrders`, `useForecasting`, `useInventoryValuation`, `useSetCostBasis`, `useBulkSetCostBasis`, `useRecomputeCosts` + a DUPLICATE supplier hook set (`useSuppliers` key `["inventory","suppliers"]` ← the purchase/scan-invoice/vendor-bill dropdowns, `useCreateSupplier`, `useUpdateSupplier` — mutations invalidate both key families via `suppliers.ts#invalidateSupplierLists`) |
| `order-templates.ts` | `useOrderTemplates`, `useOrderTemplate`, `useCreateOrderTemplate`, `useGenerateTemplateOrder` |
| `buyer.ts` | `useBuyerProducts`, `useBuyerOrder`, `useBuyerCreateOrder`, `useBuyerCancelOrder`, `useBuyerInvoice`, `useBuyerDashboard`, `useBuyerFavorites`, `useBuyerAnalytics`, `useBuyerAuthorizations`, `useSubmitBuyerAuthorization` (W6b), `useBuyerCreateChangeRequest` (P5-10), `useBuyerStatement` (P5-13, `BuyerStatement`/`BuyerStatementTransaction` types), `useBuyerPayments` (P5-14, `GET /buyer/payments`, paginated `BuyerPayment[]`), `useBuyerRemittance` (P5-14, `GET /buyer/remittance` → `BuyerRemittance`, staleTime 5min), `useBuyerStatementMonths` (P5-15, `GET /buyer/statements` → `{months}`, staleTime 5min), `fetchStatementPdfUrl` (P5-15, imperative `GET /buyer/statements/:month` → presigned `url`; caller MUST download via `fetchPdfBlob`+programmatic `<a download>`, never `<a href>`/`window.open`) |
| `remittance.ts` | (P5-14, operator, mirrors `margin.ts`) `RemittanceConfig` type (10 optional strings) + `useRemittanceConfig()` (`GET /settings/remittance`, queryKey `["remittance-config"]`, staleTime 5min) + `useUpdateRemittanceConfig()` (`PATCH /settings/remittance`, invalidates `["remittance-config"]`) |
| `promotions.ts` | (P5-01) `usePromotions`, `usePromotion`, `useCreatePromotion`, `useUpdatePromotion`, `useSetPromotionActive`, `useDeletePromotion`; helpers `promotionStatus`/`promotionRuleLabel` + `Promotion`/`PromotionInput` types |
| `authorizations.ts` | (W6b, operator) `useCustomerAuthorizations`, `useCreate/Approve/Reject/RenewAuthorization`, `useCreateAuthorizationOverride`; helpers `parseRegulatedAuthError`/`displayAuthStatus`/`authStatusBadge` |
| `tracked-categories.ts` | `useTrackedCategories`/`useTrackedCategory`/`useCreate\|Update\|ToggleTrackedCategory`, `useTrackedSubcategories`+`useCreate\|Update\|ToggleSubcategory`, `useAssign\|UnassignProductsToCategory`, `useRegulatedLedger`; **(2026-07-30 fix round)** `useRegulatedReportPreview`, `fetchRegulatedReportCsv` (`GET /regulated/reports/{preview,csv}`, optional `columns`), `useRegulatedTemplates` (`GET /regulated/templates`) + `ReportTemplateDef`/`TemplateItemType`/`TemplateColumn`/`RegulatedReportParams`/`RegulatedReportPreview` types |
| `users.ts` | `useMe`, `useChangePassword`, `useUpdateProfile` |
| `notifications.ts` | `useNotificationCount`, `useUnreadNotifications` |
| `addons.ts` | `useDeveloperMode(): {enabled, isLoading, resolved}` — composes `tobacco.ts`'s `useTenantAddons()` (same `["tenant","addons"]` cache) and reads the hidden `DEVELOPER_MODE_ADDON` (`@routeflow/types`). `resolved` = query `isSuccess`: `useTenantAddons` is `retry: false`, so on an errored fetch `enabled` AND `isLoading` are both false. **2026-08-25 split:** `useRecurringRoutes()`/`useOrderDelivery()` read `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON` off the same query; **`useRoutesAccess()`/`useDeliveryAccess()`** (`{enabled,resolved}`) are the composition helpers every gate should read — never the raw addon hooks alone. **2026-08-28:** those two helpers now return the matching feature hook UNCHANGED — the `devMode ||` disjunct is gone (owner decision: `developer_mode` unlocks only in-development surfaces, and web has none). `useDeveloperMode` itself stays exported but has **no remaining caller in `apps/web`** — kept for mobile-mirror parity and future in-dev surfaces. Any **stranding** gate (the `RouteGuard` prefix redirects in `(dashboard)/layout.tsx`) must key off the composed `resolved` and fail OPEN; hide-only gates (nav, `g r`/`g d` shortcuts, palette, dashboard cards) use `enabled`. Launch reversal = grep `useDeveloperMode`/`useRoutesAccess`/`useDeliveryAccess`. |
| `sales-agents.ts` | (PR-D) `useSalesAgents`, `useSalesAgent`, `useAgentAccruals`, `useCustomerCurrentAgent`, `useCreate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Update | UpdateStatus | DeleteSalesAgent`, `useAdd | RemoveAgentRate`, `useAddCustomerRate`, `useAddAssignment(agentId)`/`useBulkAssign(agentId)`/`useCloseAssignment`, `useRecomputeAgent`, `useCommissionStatements`, `useCommissionStatement`, `useGenerate | Approve | VoidStatement`, `useRecordCommissionPayout`; types mirror the Prisma `Decimal`-over-JSON reality (`number | string`) plus `RATE_SOURCE_LABELS`and`pctLabel()`. **Every query hook takes `opts?: { enabled?: boolean }`** — a gated GET that 403s trips the `api-client.ts`PLAN_GATE toast bridge, so an unflagged tenant must fire ZERO`/sales-agents*`or`/commission-statements*`requests. Invalidation: agent/rate/status →`["sales-agents"]`; assignments → that plus `["sales-agents","current-assignment",customerId]`; statements → `["commission-statements"]`**and**`["sales-agents"]` (claims move accrual state). |
| `messaging.ts` | (P6-6, operator) `useMessagingConfig` (`["messaging-config"]`, `GET /messaging/config`, lazy server-side seed), `useToggleRule` (`PATCH /messaging/rules/:id`, optimistic), `useUpdateTemplate`, `usePreviewTemplate`, `useUpdateMessagingSettings`; `extractTemplateVars(body)` client mirror of `{{var}}` parsing; types `MatrixCell`(**+`unavailable?: "NO_TRANSPORT"\|"NO_CONSENT_WRITER"\|"NO_TRIGGER"`, F23/#650**)/`MatrixEvent`/`MessagingSettings`/`MsgsMeter`/`MessagingConfig` |

### Batch 2026-07-23 (PRs #305, #309, #310)

- **Sidebar casing (#305)** — `app/(dashboard)/layout.tsx` `NavGroupSection` header button: removed the `uppercase` Tailwind token so collapsible group labels render Title Case ("Orders"/"Finance"/…) consistent with the leaf links. Label strings were already Title Case; buyer portal + mobile drawer unchanged (they already reserve caps for section headers).
- **Payment image (#309)** — `lib/api/invoices.ts` payment types gain `imageKey/imageOriginalName/imageMimeType`; `useRecordInvoicePayment` result gains `createdPaymentId`; new `useUploadPaymentImage`/`useDeletePaymentImage`/`useGetPaymentImageUrl` (FormData, cloned from `lib/api/finance.ts` receipt hooks). UI: `invoices/[id]/page.tsx` record + edit payment modals get an `accept="image/*"` attach control (deferred best-effort upload) + Payment History "View receipt"; `finance/payments/page.tsx` standalone modal + paperclip presence icon; `finance/payments/[id]/page.tsx` renders the image.
- **Unit code (#310)** — `components/ProductCreateModal.tsx` + `products/[id]` detail/variant forms add the "Unit code" field (label pair "Case code"/"Unit code"); `lib/barcode-resolve.ts` exact-preference widened to `unitSku`. All other scan callers unchanged (server `findByBarcode` widening covers them).

### 2026-09-04 — F13 recurring templates + standing-order items (B09 / B46 / B48 / B92 / B106)

- **`lib/api/invoices.ts`** — `RecurringInvoice` gains `lastRunStatus?: "SUCCESS"|"FAILED"|null` and
  `lastError?: string|null`. New exports **`RUN_UNFINALIZED_PREFIX`** (mirrors
  `RUN_UNFINALIZED_ERROR` in `apps/api/src/recurring-invoices/recurring-invoices.service.ts` —
  reword one and you must reword the other, they are coupled by a `startsWith`) and
  **`isRetryableRunFailure(lastError?): boolean`** — false for an already-billed-but-unfinalized
  cycle, so the UI never invites a Run Now that would bill the customer twice.
  `useActivateRecurringInvoice`'s comment now records WHY resume is its own endpoint: the PATCH is
  validated and whitelisted since `UpdateRecurringInvoiceDto`, which deliberately omits `isActive`.
- **`lib/api/order-templates.ts`** — `useUpdateOrderTemplate` variables are typed explicitly
  (`{id, name?, daysOfWeek?, isActive?, notes?, items?: {productId, qty, notes?}[]}`); `items` is
  the REG-B09 replace-the-list field the API gained.
- **`app/(dashboard)/invoices/recurring/page.tsx`** — the Last-run row renders the recorded outcome
  (green "Succeeded" / red "Failed" pill) and, on failure, the error text; the "use Run Now to
  retry" hint is appended ONLY when `isRetryableRunFailure(ri.lastError)` (REG-B106). Each card also
  gains an **Edit** button linking to `/invoices/recurring/[id]/edit`.
- **`app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx`** (new) — the whole
  create form (customer search, schedule fields, line items, money totals) extracted out of
  `new/page.tsx` verbatim so the new edit page reuses it; `new/page.tsx` is now a thin wrapper.
  Takes an optional existing `RecurringInvoice` to seed edit mode.
- **`app/(dashboard)/invoices/recurring/[id]/edit/page.tsx`** (new, REG-B92) — loads the template
  with `useRecurringInvoice`, renders `RecurringInvoiceForm`, saves through
  `useUpdateRecurringInvoice`. Before F13 there was no edit surface at all and the PATCH behind it
  was unvalidated.
- **`app/(dashboard)/customers/[id]/StandingOrderModal.tsx`** (REG-B09) — edit mode now saves the
  item list it displays: rows carry `notes`, and the PATCH includes `items` **only when the list
  actually differs** from the loaded template, compared by the new order-free
  **`itemSignature(items)`** helper (`productId:qty:notes` sorted and joined). Two reasons, both
  load-bearing: an untouched list must not be churned (the API replaces items by delete +
  re-create, minting new ids), and a name/day/notes-only edit stays the scalar-only shape the
  pre-F13 API accepts — api and web are independent Railway services, so that keeps every
  non-item edit working through the deploy window and behind a rollback.
- **`e2e/30-recurring-standing.spec.ts`** (new) + **`playwright.config.ts`** project
  `recurring-standing` (`dependencies: ["setup"]`, operator storage state) — **without the project
  entry the spec never runs.** Three tests: REG-B09 the Edit Standing Order modal persists item
  adds and qty changes; REG-B92 the recurring edit page persists a schedule/notes change; REG-B106
  the card shows "Succeeded" after Run Now. Mutating but self-contained — throwaway `E2E B09 …` /
  `E2E B92 …` fixtures on the approved seed tenant, the recurring template created with `nextRunAt`
  in 2099 so a leaked row can never fire the cron. ⚠️ **`DELETE /recurring-invoices/:id` is
  DEACTIVATE, not a row delete** (unlike `/order-templates/:id`), so the second test's `finally`
  voids the Run Now invoice and leaves an inert, deactivated template behind. ⚠️ Never run this
  file locally with `npx playwright test` — not even `--list`; it clobbers
  `.campaign/runs/web-e2e.json`. Both toast assertions ("Standing order updated", "Recurring
  template updated") are scoped through
  `getByRole("region", { name: /notifications/i }).getByRole("listitem")` — a bare
  `page.getByText(...)` hits 2 elements (the toast + Radix's aria-live announcer mirror);
  see [[L-076]].
- **`e2e/28-credit-note-wallet.spec.ts`** (new, F09) + **`playwright.config.ts`** project
  `credit-note-wallet` (`dependencies: ["setup"]`, operator storage state) — without the project
  entry the spec never runs (08's precedent). Two tests, both read-only (mocked API responses via
  route fulfillment, no seed mutation): REG-B19 `/credit-notes` renders the mocked row's invoice
  number, never the raw UUID (T13); REG-B18 `/credit-notes/:id` loads (number heading) with no
  "Issue Credit Note" button, using a **DRAFT** fixture on purpose — DRAFT is the phantom status
  the deleted flow keyed its button on (wire-shaped but never actually issuable post-fix, since a
  real note is created ISSUED), so a green result here is real evidence the dead button is gone,
  not an accident of an ISSUED fixture never having shown it (T14). Both heading assertions are
  scoped through `page.locator("#main-content").getByRole("heading", {...})` — the dashboard
  shell's own `<h1>` duplicates the page's title string via `setTitle`, so an unscoped match hits
  2 elements and violates Playwright's strict mode (same trap as `15-stock-count-ui.spec.ts:150-152`,
  `21-destructive-guards.spec.ts`'s `#main-content` convention).
- **`e2e/29-returns-lifecycle.spec.ts`** (new, F08 #645) + **`playwright.config.ts`** project
  `returns-lifecycle` (`dependencies: ["setup"]`, operator storage state, appended after
  `credit-note-wallet`) — a DELIVERED-order fixture built via the API (transition guards) backs
  three tests: REG-B166 search (T12), REG-B75 KPI/row value (T13), REG-B21 cancel + B82 quota
  release (T14). **Post-deploy run 34075878788 (headSha 99d5b87a): T12 passed, T13 and T14
  FAILED** (all retries). T14 (`:319`) asserts `page.getByRole("heading", { name: ret.returnNumber
})` WITHOUT the `#main-content` scope this exact trap already taught spec 28 (immediately above)
  to use — the dashboard shell's own title `<h1>` duplicates the return number a second time, so
  the bare locator hits 2 elements (strict-mode violation), never reaching the Cancel Return
  button. This reads as a TEST bug in the new spec, not a product regression — apply the
  `#main-content` scoping convention. T13 polled `before+10` but observed `before+15/25/35`,
  growing by exactly $10 per Playwright retry — consistent with the KPI/fixture not being isolated
  per attempt (each retry's setup adds another billed return without the prior attempt's being
  cleaned up or excluded). Neither failure has been root-caused to a fix; F08's T2 rows
  (B166/B75/B21) are NOT discharged pending a clean re-run. **T13 root cause + fix (#654,
  2026-09-07, B234):** the race was the KPI baseline, not the fixture — `returns/page.tsx` paints
  a fully formatted "$0.00" with no loading branch while `useReturns({ limit: 500 })` is still in
  flight, so a `toBeVisible` + DOM `textContent` read of the tile cannot tell loading-zero from
  loaded-zero. T13's `before` now comes from the API sum (#654) — `GET /returns?limit=500`,
  `refundEstimate` summed over every row excluding REJECTED/CANCELLED, mirroring the tile's own
  definition — never the DOM (L-086: a post-deploy money oracle comes from the API). Confirmed
  green post-fix: GitHub Actions run 34099966904 (deployment_status, headSha 05b6c805), job E2E
  (Playwright), project `returns-lifecycle`, test #160 REG-B75 PASSED; 139 passed / 0 failed / 26
  skipped.
- **`e2e/37-list-caps.spec.ts`** (new, F16 #656) + **`playwright.config.ts`** project `list-caps`
  (`dependencies: ["setup"]`, operator storage state) — the web leg for the four F16 rows with a
  web surface (B12/B80/B144/B110; B89/B117/B169 are api-only, proven pre-merge). Four tests,
  self-provisioned fixtures (throwaway customer/invoice/payment for B80, throwaway 25-order
  customer for B144): REG-B12 the invoices page derives its KPI tiles from `/invoices/kpi-summary`
  (never `limit=999`) and "Total Outstanding" agrees with the endpoint's own figure (API oracle,
  L-086); REG-B80 the payment receipt page fetches by id (never `useInvoicePayments(limit:200)`);
  REG-B144 an active customer search is sent server-side (`search=`) and the pager stays visible;
  REG-B110 the customer detail page's Profile and Invoices-tab Outstanding figures agree with each
  other and the statement endpoint. **Post-deploy run 34137751080 (headSha e02851af): REG-B12
  PASSED (test #168, 974ms); REG-B80/REG-B144/REG-B110 all FAILED (all 3 attempts each) on
  `Error: operator storageState carried no access token`** (`:136`/`:222`/`:290` —
  `expect(token, "operator storageState carried no access token").toBeTruthy()`). Run totals: 140
  passed / 4 failed / 25 skipped. **The fourth failure is `REG-B11` in `22-payment-truth.spec.ts`
  — a REAL, LIVE regression, not a flake:** the "Awaiting confirmation" KPI tile reads 0 after a
  DRAFT payment is recorded. Cause (team-board diagnosis, unconfirmed in this session): `m7`
  scoped `getKpiSummary`'s `awaitingConfirmationCount` to the OPEN-invoice set (the old client
  memo counted DRAFT payments across every loaded invoice, open or not), and/or the new
  `kpi-summary` query is never invalidated after a payment mutation, so the bar reads stale until
  a reload. **A hotfix light loop was already launched separately** (`fix-round-5-hotfix.md`:
  restores the memo's basis, keys the summary query under the invoices cache prefix, fixes the
  spec-37 `operatorAccessToken` ordering below) — not touched in this bookkeeping session; do not
  re-attribute this failure to a pre-existing cause. REG-B80/REG-B144/REG-B110 separately **reads
  as a TEST bug in the new spec, not a product regression** — same class as spec 28/29's
  `#main-content` trap immediately above: REG-B80,
  REG-B144 and REG-B110 each call `operatorAccessToken(page)` (`helpers/api.ts` — reads
  `localStorage` in the CURRENT page) as their first statement, before any `page.goto(...)`, so it
  evaluates on an unnavigated page; Playwright only restores a `storageState`'s `localStorage`
  entries once the browser has actually navigated to the matching origin, so the read is always
  empty. REG-B12 (which calls `page.goto("/invoices")` first and never touches
  `operatorAccessToken`) passed in the same file and run. Precedent specs
  `21-destructive-guards.spec.ts` and `22-payment-truth.spec.ts` both call `page.goto` before ever
  reading the token — `37-list-caps.spec.ts` broke that established ordering. F16's registry rows
  B80/B144/B110 (T2 tier) are therefore left `queued`, not discharged, pending a harness fix
  (move each `operatorAccessToken` call to after the test's first navigation) and a clean re-run;
  B12 (T2) is `done` on its own passing leg. See `.claude/campaign/bugs/B80.md` /`B144.md`/`B110.md`
  History for the full note. **Both root causes fixed (#659, 2026-09-07, master `4d977168`, L-090):**
  REG-B11's cause was confirmed as diagnosed above — `m7` scoped the awaiting-confirmation count to
  the money tiles' OPEN basis instead of the memo's own (none); the count now carries no
  invoice-status scope for staff, exactly the memo's basis, and `{ not: DRAFT }` for a buyer (see
  `api.md`'s F16-hotfix bullet). The "never invalidated after a mutation" half of the diagnosis did
  NOT need a code fix — `useInvoiceKpiSummary`'s query key was already `["invoices", "kpi-summary",
today]`, under the shared `["invoices"]`-prefix invalidation every payment mutation already fires,
  since #656; new `apps/web/lib/api/invoices.kpi-summary.test.tsx` now pins that behaviourally
  through a real `QueryClient` so a future re-key would fail here first. The harness ordering bug
  is also fixed: new `openApp()` (navigates to `/invoices`, waits on the "New Invoice" button) and
  `apiHeaders()` (calls `operatorAccessToken` only after `openApp`) helpers replace the three bare
  pre-navigation token reads that failed REG-B80/REG-B144/REG-B110. Deployed api `4495be33` + web
  `690cd7b7`, both SUCCESS 2026-09-07. **T2 proof for B80/B110/B144 still awaits this deployment's
  own E2E run** — do not discharge from this bullet alone; confirm the spec-37 REG lines PASSED on
  master `4d977168` first. **A second, deeper harness defect surfaced on that very run (34146107042)
  and was fixed in #661 (2026-09-07, master `92cb0fb6`, L-091):** REG-B80's `getByText(paymentNumber)`
  hit Playwright's strict-mode violation because the receipt page renders the payment number twice —
  once in the `<h2>` heading, once in a meta `<p>` (`finance/payments/[id]/page.tsx:107-109`) — fixed
  by asserting the heading through `getByRole("heading", { name, exact: true })`, which resolves the
  element by ROLE instead of by a text value that appears more than once. REG-B144's fixture provisioned
  25 pending orders for ONE customer through the staff-create endpoint, whose 2nd-and-later POST hits
  the customer-level auto-merge guard (`orders.controller.ts:110-127`, 409 `MERGE_CHOICE_REQUIRED`) —
  fixed by sending each order with `mergeChoice: "separate"` (`create-order.dto.ts:103` →
  `orders.controller.ts:107-108,273-282` sets `skipAutoMerge=true`), the API's own documented escape
  hatch, rather than working around the guard; `test.setTimeout(120_000)` added for the 25-order
  provisioning. Both are spec-only changes — `apps/web/e2e/37-list-caps.spec.ts` is the only file #661
  touched. Confirmed green: deployment E2E run 34154308035 (master `92cb0fb6`, web deployed SUCCESS
  2026-09-07 19:06Z, api SKIPPED — no api change) — REG-B12/REG-B80/REG-B144/REG-B110 all PASSED
  (list-caps project, attempt 1); run totals 143 passed / 0 failed / 26 skipped. B80/B144 (T2)
  discharged on this run; B110 (T2) was already discharged in the #659 follow-up (#660).
- **`e2e/36-marketing-site.spec.ts`** (new, marketing-port #657) + **`playwright.config.ts`**
  project `marketing` (`testMatch: /36-marketing-site\.spec\.ts/`, NO `dependencies` — signed-out
  throughout, Desktop Chrome by default; T2's mobile assertions opt into `devices["iPhone 13"]`
  via `test.use()` inside that describe block) — NOT part of the local red gate (post-deploy proof
  only, same convention as 08-create-order-escape's "without this entry the spec never runs").
  T1 per-route chrome/copy across the 9 public pages + the `/distributors` redirect + a bogus-path
  404 + `/privacy` noindex + the contact form + the company page's photo credit; T2 the mobile
  sheet (9 links) and desktop sign-in menu, the contact mailto draft, the wholesalers tab, home
  FAQ single-open; T3 crawls every internal link on the 9 pages for < 400; T12 a mobile UA still
  gets the marketing site on `/pricing` (R11 — see the middleware carve-out under `(marketing)/`
  above; B249 is the gap this project's Desktop-Chrome-only run does NOT cover); T13
  below-the-fold `.reveal-pending` clears on scroll and stays opaque under reduced-motion.

### 2026-09-11/12 — CRM: Settings → GoHighLevel tab (new, R29-R31, ux-spec.md)

- **`lib/api/crm.ts`** — TanStack Query hooks for the CRM tab: `useCrmStatus()`,
  `useCrmPipelines()`, `useCrmHandoffs(params)`, `useSaveCrmConnection()`,
  `useTestCrmConnection()`, `useDisconnectCrm()`, `useUpdateCrmConfig()`, `useSyncCrmNow()`,
  `usePreviewCrmImport()`, `useImportExistingCrmLeads()`; query keys `crmStatusKey`,
  `crmHandoffsKey(params)`, `crmPipelinesKey`; plus `useRetryHandoff()` / `useDismissHandoff()`
  (fix round 1). Calls `POST /crm/gohighlevel/sync`, `import-existing{,/preview}` and
  `handoffs/:id/{retry,dismiss}` — all 12 routes exist in `crm.controller.ts` since fix round 1
  (F1); the handoffs list is the `{data,total,page,limit}` envelope.
- **`app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx`** —
  `GoHighLevelSettingsTab(props: GoHighLevelSettingsTabProps)` (presentational, all four
  ux-spec.md cards: Connection / trigger config / Options / Activity) and default export
  `GoHighLevelSettingsTabConnected()` (wires the hooks above). Types: `CrmActivityRow`,
  `CrmConfigView`, `GoHighLevelSettingsTabProps`.
- **`app/(dashboard)/settings/_components/SettingsHub.tsx`** / **`.../settings/page.tsx`** — add
  the "GoHighLevel" tab entry alongside the existing settings tabs.
- **`lib/hooks/useNotifications.ts`** — extended for the CRM `NEEDS_ATTENTION` /
  stale-poll notification surfaces the bell/Activity-card states rely on.
- **`app/(dashboard)/layout.tsx`** / **`app/(dashboard)/customers/page.tsx`** — bell entry point
  and a CRM-linked-customer affordance per ux-spec.md's "Entry points" section.
