# Plan: Adaptive Dispatch nav · session-keyed branding · hide-strike-off invoice setting · Sentry (DSN-optional)

> Authored by Fable 5 on 2026-08-26. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Four independent changes to RouteFlow (npm+Turbo monorepo: NestJS API `apps/api`, Next.js 14
web `apps/web`, Expo mobile `apps/mobile`):

1. **Adaptive Dispatch (WP1+WP2):** merge the standalone "Deliveries" sidebar group into the
   "Dispatch" group as one "Order delivery" item; the Dispatch group shows when the tenant has
   EITHER the recurring-routes or order-delivery feature; the Dispatch overview page adapts its
   copy/CTAs to which features are enabled and tags ad-hoc delivery runs.
2. **Branding follows the session (WP3):** the web dashboard's tenant branding (business name,
   logo, colors) must be resolved from the LOGGED-IN user's JWT tenant, not from the
   `tenant-slug` cookie, and a disagreeing cookie must be rewritten — a stale cookie must never
   render another tenant's name on screen or on the invoice document.
3. **Hide strike-off price (WP4+WP5):** a per-tenant invoice setting `hideOriginalPrice`
   (default false). When true, the operator web invoice document renders ONLY the net unit
   price on discounted/special/promo lines — no struck-through original price, no badge.
4. **Sentry error monitoring, DSN-optional (WP6):** wire Sentry into api/web/mobile such that
   it is completely inert unless the DSN env var is set. Tag events with the tenant.

## Constraints & conventions

- Prettier: semicolons, double quotes, printWidth 100, trailing commas. ESLint flat config per
  workspace — lint via `npm run lint` from repo root only.
- **Do NOT touch** `.claude/code-map/**` (the orchestrator maintains it), any `Dockerfile`,
  `railway.toml`, or prisma schema/migrations. NO new heavy deps beyond the Sentry SDKs named
  in WP6. Never introduce Vitest/Biome/Supabase/Vercel.
- Never reference a real client tenant slug or name in code, tests, or fixtures.
- Web tests are Playwright only (`apps/web/e2e`); api and mobile use Jest. No snapshot tests.
- Money renders exactly as the server sends it; this plan changes only WHICH price elements
  render, never any arithmetic.
- Existing behavior that must NOT change: `/routes` list & `/routes/create` stay gated to the
  recurring-routes feature; `/routes/<id>` detail pages stay accessible with either feature;
  legacy `/routes/trips*` redirect stubs keep working; DRIVER-role nav untouched.
- Work in the worktree you are given as cwd; use absolute paths under it for all file edits.

## Work packages

### WP1 — Web nav: one adaptive Dispatch group

- **files:** `apps/web/app/(dashboard)/layout.tsx`
- **brief:** In `OPERATOR_NAV`: DELETE the entire `label: "Deliveries"` group entry. Rework the
  `label: "Dispatch"` group's children to exactly:
  `Overview /dispatch (icon LayoutDashboard)`, `Routes /routes (icon MapPin)`,
  `Order delivery /deliveries (icon Package)`, `Drivers /drivers (icon Truck)`.
  In the nav-filtering logic (currently `showDispatch = devMode || routesAccess` and
  `showDeliveries = devMode || deliveryAccess` followed by group filtering and a block that
  moves a "Drivers" leaf into Deliveries when Dispatch is hidden):
  - The Dispatch group is visible when `devMode || routesAccess || deliveryAccess`.
  - Inside a visible Dispatch group, filter children: the `/routes` leaf renders only when
    `devMode || routesAccess`; the `/deliveries` leaf only when `devMode || deliveryAccess`;
    `/dispatch` and `/drivers` always render (the group itself is already access-gated).
  - DELETE the now-obsolete "Drivers moves into Deliveries" block entirely.
  - The existing `canActAsDriver` "My Routes" injection must now always target the "Dispatch"
    group (it can no longer target "Deliveries" — that group no longer exists). Simplify the
    `targetLabel` logic accordingly.
    In `GATED_PREFIXES`: change the `/dispatch` entry's `need` from `"routes"` to `"either"`.
    Nothing else in `matchGatedPrefix`/`RouteGuard` changes.
- **exact code** (child filter — adapt names to the file's existing style):
  ```ts
  const showDispatchGroup = devMode || routesAccess || deliveryAccess;
  let baseNav = OPERATOR_NAV.filter(
    (entry) => !(entry.kind === "group" && entry.label === "Dispatch" && !showDispatchGroup),
  ).map((entry): NavEntry => {
    if (entry.kind !== "group" || entry.label !== "Dispatch") return entry;
    return {
      ...entry,
      children: entry.children.filter((c) => {
        if (c.href === "/routes") return devMode || routesAccess;
        if (c.href === "/deliveries") return devMode || deliveryAccess;
        return true;
      }),
    };
  });
  ```

### WP2 — Dispatch overview adapts; runs payload carries route kind

- **files:** `apps/web/app/(dashboard)/dispatch/page.tsx`, `apps/web/lib/api/routes.ts`,
  `apps/api/src/routes/routes.service.ts`
- **brief:**
  - `routes.service.ts` → in `findAllRuns` (~line 794), the run include currently selects
    `route: { select: { id: true, name: true } }` — add `kind: true` (additive; nothing else).
  - `apps/web/lib/api/routes.ts` → `RouteRun.route` type becomes
    `route?: { id: string; name: string; kind?: "SCHEDULED" | "ADHOC" }`.
  - `dispatch/page.tsx` → the page (three cards: `ActiveNowCard`, `TodaysScheduleCard`,
    `DriversCard`) adapts:
    - Import `useRoutesAccess`, `useDeliveryAccess`, `useDeveloperMode` from `@/lib/api/addons`
      (same hooks the dashboard layout uses).
    - Subtitle: routes-only → keep current "Today's runs and driver status across the
      operation."; delivery-only → "Today's deliveries and driver status."; both → "Today's
      routes, deliveries, and driver status.".
    - When `devMode || deliveryAccess`, the `PageHeader` area gains a "Plan delivery" button
      → `router.push("/deliveries/new")` (match the page's existing button components/styles;
      check how other pages pass an action next to `PageHeader` and follow that pattern —
      if `PageHeader` has no action slot, render the button in a flex row wrapping the header).
    - In BOTH run-listing cards, when a run's `route?.kind === "ADHOC"`, render a small
      "Delivery" chip/tag next to the route name (subtle pill, existing badge styling in the
      file or minimal inline style consistent with `statusBadge`). Show the chip only when the
      tenant has BOTH features enabled (chips are noise when everything is a delivery).
    - Empty states: `TodaysScheduleCard`'s empty copy becomes delivery-flavored when
      delivery-only ("No deliveries scheduled today." plus, if the header CTA isn't visible in
      that layout, keep it simple — copy change only).
- **exact code** (chip, adapt to file's styles):
  ```tsx
  {
    bothFeatures && run.route?.kind === "ADHOC" ? (
      <span className="ml-2 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 ring-1 ring-brand-200">
        Delivery
      </span>
    ) : null;
  }
  ```
  (If `bg-brand-50`/`text-brand-600` classes are not used elsewhere in this file's stylesheet
  context, reuse the exact class set from another badge in the web app rather than inventing
  colors.)

### WP3 — Tenant branding follows the session

- **files:** `apps/web/components/tenant-provider.tsx`, `apps/web/lib/auth.ts`,
  `apps/web/e2e/07-auth-password.spec.ts`
- **brief:**
  - `lib/auth.ts`: add and export
    ```ts
    /** Tenant slug of the CURRENT session (JWT beats any cookie); null when logged out. */
    export function getSessionTenantSlug(): string | null {
      return getStoredUser()?.tenantSlug ?? null;
    }
    ```
    Place it after `getStoredUser`. Also: at the end of `login()` the cookie is already
    corrected; ADDITIONALLY in `refreshTokens()` success path, after storing the new tokens,
    re-sync: `if (data.user?.tenantSlug) setTenantCookie(data.user.tenantSlug);` (import
    already present).
  - `tenant-provider.tsx`: change slug resolution so the SESSION wins over the cookie:

    ```ts
    import { getSessionTenantSlug } from "@/lib/auth";
    import { setTenantCookie } from "@/lib/tenant-cookie";

    function resolveTenantSlug(): string | null {
      const jwtSlug = getSessionTenantSlug();
      const cookieSlug = getTenantSlugFromCookie();
      if (jwtSlug && cookieSlug !== jwtSlug) {
        // Self-heal: a stale cookie must not brand the app as another tenant,
        // and it also feeds the X-Tenant-Slug header on every API call.
        setTenantCookie(jwtSlug);
      }
      return jwtSlug ?? cookieSlug;
    }
    ```

    In `fetchBranding`, replace `const tenantSlug = slug ?? getTenantSlugFromCookie();` with
    `const tenantSlug = resolveTenantSlug();` and when it differs from the `slug` state, update
    the state (`setSlug(tenantSlug)`).
    Replace the mount-only effect with one that ALSO re-checks on tab focus (covers multi-tab
    impersonation switches, where localStorage/cookie changed underneath a mounted app):

    ```ts
    React.useEffect(() => {
      void fetchBranding();
      const recheck = () => {
        const next = resolveTenantSlug();
        if (next && next !== slugRef.current) void fetchBranding();
      };
      window.addEventListener("focus", recheck);
      document.addEventListener("visibilitychange", recheck);
      return () => {
        window.removeEventListener("focus", recheck);
        document.removeEventListener("visibilitychange", recheck);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    ```

    Where `slugRef` is a `React.useRef<string | null>(null)` kept in sync whenever `setSlug`
    is called (fetchBranding sets both). Make sure `fetchBranding` itself re-resolves the slug
    every call (do NOT early-return on the stale `slug` state — drop the `slug ??` short
    circuit) so a re-check after a tenant switch actually refetches the NEW tenant's branding
    and re-applies CSS vars. Keep every other behavior (CSS variable application, refresh()
    contract) identical.
    NOTE: this file is rendered OUTSIDE the auth React context (it wraps `Providers` in
    `app/layout.tsx`), which is exactly why it must use the module-level
    `getSessionTenantSlug()` from lib/auth rather than a hook.

  - `e2e/07-auth-password.spec.ts`: READ the file's header comment first — this suite manages
    the tenant cookie deliberately (no shared setTenantCookie helper). Add one test:
    "stale tenant cookie is corrected on login": seed the browser context with cookie
    `tenant-slug=qa-wrong-tenant` (use the suite's existing cookie-seeding style and BASE_URL),
    perform the suite's normal operator login, then assert
    `(await context.cookies())` contains `tenant-slug` with the value of the suite's
    `TENANT_SLUG` constant (import it the same way sibling specs do). Do not assert on the
    rendered business name (tenant config text is not stable across environments).

- **exact code:** included above.

### WP4 — API: invoice setting `hideOriginalPrice`

- **files:** `apps/api/src/system-config/dto/update-invoice-settings.dto.ts`,
  `apps/api/src/system-config/settings.controller.ts`,
  `apps/api/src/system-config/settings.controller.spec.ts`
- **effort:** low
- **brief:** Extend the EXISTING invoice-settings endpoints (`GET/PATCH /settings/invoice`,
  SystemConfig KV — no schema change):
  - DTO: add
    ```ts
    @IsOptional()
    @IsBoolean()
    hideOriginalPrice?: boolean;
    ```
    (add `IsBoolean` to the class-validator import).
  - `getInvoiceSettings()`: also read `invoice.hideOriginalPrice` via `this.svc.get(...)` and
    return `hideOriginalPrice: raw === "true"` alongside `defaultTerms`.
  - `updateInvoiceSettings()`: when `dto.hideOriginalPrice !== undefined`,
    `await this.svc.set("invoice.hideOriginalPrice", String(dto.hideOriginalPrice));`.
  - Spec: follow the file's existing mocking style; add cases — GET returns false when unset,
    true when stored "true"; PATCH `{hideOriginalPrice:true}` calls
    `svc.set("invoice.hideOriginalPrice", "true")`; PATCH without the field does not touch
    that key.

### WP5 — Web: settings toggle + invoice document honors it

- **files:** `apps/web/lib/api/invoices.ts`, `apps/web/app/(dashboard)/settings/page.tsx`,
  `apps/web/app/(dashboard)/invoices/[id]/page.tsx`
- **brief:**
  - `lib/api/invoices.ts`: the `useInvoiceSettings` / `useUpdateInvoiceSettings` hooks
    (~line 955) type their payload — widen it with `hideOriginalPrice?: boolean` (find the
    `InvoiceSettings` interface/inline type and extend it).
  - `settings/page.tsx`: in the invoice-defaults section (~line 2408–2490, where
    `defaultTerms` renders with a save + "Invoice defaults saved" toast), add a labeled toggle
    row: label "Show original price on discounted lines", help text "When off, invoices show
    only the final unit price — no struck-through original price or badge." The toggle
    reflects `!settings.hideOriginalPrice` (i.e. checked = show) and saves
    `{ hideOriginalPrice: !checked }` through the SAME mutation + toast pattern the
    defaultTerms control uses. Reuse the page's existing switch/checkbox component (search the
    file for an existing `Switch`/`Checkbox` import before adding one).
  - `invoices/[id]/page.tsx`: the invoice document's unit-price cell (~line 2412) renders
    four decorated branches on `item.priceType`: `SPECIAL`, `DISCOUNTED`, `PROMO` (each a
    struck `originalPrice` + colored net price + badge) and a `MANUAL` upsell branch. Fetch
    `useInvoiceSettings()` at the page level (hook already imported elsewhere in the app;
    follow existing usage) and compute
    `const hideOriginal = invoiceSettings?.hideOriginalPrice === true;`.
    When `hideOriginal` is true, the `SPECIAL`/`DISCOUNTED`/`PROMO` branches must render
    exactly what the undecorated default branch renders (plain net `unitPrice`, no strike, no
    badge, default color). Implement by short-circuiting the branch condition, e.g.
    `item.priceType === "SPECIAL" && !hideOriginal ? (...)`— applied to all three decorated
    branches. Leave the MANUAL upsell branch untouched (it shows no original price).
- **exact code:** condition change shown above; no arithmetic changes.

### WP6 — Sentry, DSN-optional, all three apps

- **files:** `apps/api/src/instrument.ts` (new), `apps/api/src/main.ts`,
  `apps/api/src/common/sentry-exception.filter.ts` (new),
  `apps/web/components/SentryInit.tsx` (new), `apps/web/app/layout.tsx`,
  `apps/mobile/lib/sentry.ts` (new), `apps/mobile/app/_layout.tsx`,
  `apps/api/.env.example`, `apps/web/.env.example`, `apps/mobile/.env.example`,
  `apps/api/package.json`, `apps/web/package.json`, `apps/mobile/package.json`,
  `package-lock.json`
- **brief:** Install deps FROM THE REPO ROOT so the single lockfile updates:
  `npm install @sentry/node --workspace=apps/api` and
  `npm install @sentry/react --workspace=apps/web --workspace=apps/mobile`.
  - `apps/api/src/instrument.ts` (new):

    ```ts
    import * as Sentry from "@sentry/node";

    // DSN-optional: with SENTRY_DSN unset this init is a no-op and the SDK
    // stays fully inert (enabled:false disables transport + instrumentation).
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      enabled: !!process.env.SENTRY_DSN,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
      tracesSampleRate: 0,
    });
    ```

  - `apps/api/src/main.ts`: `import "./instrument";` as the VERY FIRST import line. Then where
    global filters are registered (the file already registers `ThrottlerExceptionFilter`),
    change to register both, catch-all first:
    ```ts
    const { httpAdapter } = app.get(HttpAdapterHost);
    app.useGlobalFilters(new SentryExceptionFilter(httpAdapter), new ThrottlerExceptionFilter());
    ```
    (import `HttpAdapterHost` from `@nestjs/core` and the new filter; if the file registers
    the throttler filter differently, preserve its exact construction and just add the Sentry
    filter BEFORE it in the same call.)
  - `apps/api/src/common/sentry-exception.filter.ts` (new):

    ```ts
    import { ArgumentsHost, Catch, HttpException } from "@nestjs/common";
    import { BaseExceptionFilter } from "@nestjs/core";
    import * as Sentry from "@sentry/node";

    /**
     * Reports unexpected (non-HttpException, or 5xx) errors to Sentry with the
     * tenant tagged, then defers to Nest's default handling. Inert when Sentry
     * is disabled (capture becomes a no-op).
     */
    @Catch()
    export class SentryExceptionFilter extends BaseExceptionFilter {
      catch(exception: unknown, host: ArgumentsHost) {
        const status = exception instanceof HttpException ? exception.getStatus() : 500;
        if (status >= 500) {
          const req = host.switchToHttp().getRequest();
          const user = req?.user as
            | { tenantSlug?: string; tenantId?: string; sub?: string; username?: string }
            | undefined;
          Sentry.withScope((scope) => {
            if (user?.tenantSlug ?? user?.tenantId) {
              scope.setTag("tenant", user.tenantSlug ?? user.tenantId!);
            }
            if (user?.sub) scope.setUser({ id: user.sub, username: user.username });
            scope.setTag("path", req?.originalUrl ?? req?.url ?? "");
            Sentry.captureException(exception);
          });
        }
        super.catch(exception, host);
      }
    }
    ```

  - `apps/web/components/SentryInit.tsx` (new): client component, dynamic import so the SDK
    never enters the bundle-critical path when unset:

    ```tsx
    "use client";

    import { useEffect } from "react";

    /** Initializes Sentry in the browser ONLY when NEXT_PUBLIC_SENTRY_DSN is set. */
    export function SentryInit() {
      useEffect(() => {
        const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
        if (!dsn) return;
        void import("@sentry/react").then((Sentry) => {
          Sentry.init({ dsn, environment: process.env.NODE_ENV });
          const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
          if (match) Sentry.setTag("tenant", decodeURIComponent(match[1]));
        });
      }, []);
      return null;
    }
    ```

    Mount `<SentryInit />` inside the `<body>` of `apps/web/app/layout.tsx` (alongside the
    existing providers, position not critical).

  - `apps/mobile/lib/sentry.ts` (new):

    ```ts
    import { Platform } from "react-native";

    /**
     * Web-build-only Sentry init (the production mobile deployment is the Expo
     * web export). Inert unless EXPO_PUBLIC_SENTRY_DSN is set; native builds
     * skip entirely. Fire-and-forget: never block startup on the SDK.
     */
    export function initSentry(): void {
      if (Platform.OS !== "web") return;
      const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
      if (!dsn) return;
      void import("@sentry/react")
        .then((Sentry) => Sentry.init({ dsn, environment: "production" }))
        .catch(() => {});
    }
    ```

    Call `initSentry()` once at module top level (or first effect) of
    `apps/mobile/app/_layout.tsx` — read the file and place it where other one-time module
    setup happens; do not wrap the tree in any ErrorBoundary.

  - `.env.example` files: append `SENTRY_DSN=` (api), `NEXT_PUBLIC_SENTRY_DSN=` (web),
    `EXPO_PUBLIC_SENTRY_DSN=` (mobile) with a one-line comment "# optional — error monitoring
    activates only when set".

## Acceptance criteria

1. The sidebar has NO "Deliveries" group; the "Dispatch" group contains Overview, Routes,
   Order delivery, Drivers in that order.
2. Nav gating: with only recurring-routes access → Dispatch shows Overview/Routes/Drivers
   (no Order delivery); with only order-delivery access → Overview/Order delivery/Drivers
   (no Routes); with neither and no dev mode → no Dispatch group at all; dev mode shows all.
3. `/dispatch` is reachable with only order-delivery access (GATED_PREFIXES `need: "either"`);
   `/routes` (list) still requires routes access; `/routes/<id>` details still work with
   either.
4. `findAllRuns` response's `route` object includes `kind`; nothing else about the API
   response changed.
5. Dispatch overview: delivery-flavored subtitle when delivery-only; "Plan delivery" button
   when delivery access; ADHOC runs get a "Delivery" chip only when BOTH features are on.
6. With a stale/wrong `tenant-slug` cookie and a valid login, the dashboard fetches branding
   for the JWT's tenant and rewrites the cookie to the JWT tenant slug (new e2e test asserts
   the cookie value post-login).
7. `refreshTokens()` success re-syncs the tenant cookie.
8. `GET /settings/invoice` returns `hideOriginalPrice` (false when unset); PATCH persists it;
   controller spec covers get/set/absent.
9. With the setting ON, the web invoice document renders SPECIAL/DISCOUNTED/PROMO lines — AND
   the below-list MANUAL branch ("Adjusted" badge, which also shows a struck original) — as
   plain net price (no strike/badge); with it OFF (or unset) rendering is byte-identical to
   before this change. The MANUAL upsell branch (above list, never shows a struck price) stays
   untouched. [Amended by the orchestrator after WP5 surfaced the fifth branch: the setting's
   intent is "never show a struck-off price", so every strikethrough branch honors it.]
10. Settings page has the toggle wired to the same mutation/toast pattern as defaultTerms.
11. With no Sentry env vars set: `npm run verify` passes, apps boot and behave identically,
    and no Sentry network calls occur (enabled:false / early return). With a DSN set, a thrown
    5xx in the API is captured with a `tenant` tag.
12. No files outside the listed packages changed (except `package-lock.json` from WP6's
    installs, and the orchestrator-owned `.github/dependabot.yml` + `.claude/**` files, which
    land as their own PR). No prisma schema/migration changes.
13. [Post-review fixes, applied by the orchestrator] `hideOriginalPrice` rides the
    `GET /invoices/:id` payload (SystemConfig read in `invoices.service.ts findOne`) and the
    web invoice document reads it from `invoice`, NOT from operator-only `useInvoiceSettings`
    — CUSTOMER viewers must honor the preference too; `instrument.ts` passes
    `skipOpenTelemetrySetup` when the DSN is unset; the settings toggle carries an
    `aria-label`; e2e AP-09 additionally corrupts the cookie AFTER login and asserts
    TenantProvider rewrites it on a dashboard reload.

## Verification commands

From the worktree root (dependencies are pre-installed; Prisma client pre-generated):

- Per-package quick gate: `npm run check-types`
- Final gate: `npm run verify` (turbo: check-types + lint + test across workspaces)

Playwright e2e is NOT run locally (it targets a deployed site); the new WP3 test must
compile/lint only.

## Risks & rollback

- WP1/WP2 are UI-gating only; wrong gating shows/hides nav items — verify criterion 2 matrix
  carefully in review. Rollback = revert the commit.
- WP3 touches every page's branding; the failure mode to hunt in review is an infinite
  refetch loop (focus/visibility handler must only refetch when the resolved slug CHANGED)
  and SSR safety (`typeof window`/`document` guards — the provider is "use client" but is
  rendered during SSR; `getStoredUser` already guards `window`; `resolveTenantSlug` must be
  safe when `document` is undefined — reuse the existing guarded cookie reader).
- WP5's only risk is accidentally changing the default rendering — criterion 9 demands
  byte-identical output when the setting is off.
- WP6 must be provably inert without env vars; watch for `import "./instrument"` ordering and
  for the filter double-handling exceptions (it defers to `super.catch` — must not swallow).
