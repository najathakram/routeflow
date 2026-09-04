# Build plan: buyer ⇄ seller portal switcher

> **Stage S5 — "how".** Authored by Fable 5.1 on 2026-09-04. Status: APPROVED
> Written AFTER [test-plan.md](./test-plan.md). This file is the ONLY context the
> implementation and review agents receive; it stands alone.
> Inputs: [discovery.md](./discovery.md) (why), [spec.md](./spec.md) (`R#`),
> [ux-spec.md](./ux-spec.md) (UI), [test-plan.md](./test-plan.md) (`T#`).

**Every path below exists today unless marked (new).** Scale: `major` (auth-adjacent routing, 8 production files, UI change). `ui: true`.

---

## Objective

A person who is both a buyer and a seller on RouteFlow can reach either portal from the other. A browser holding only a buyer session that asks for an operator page is sent to the operator sign-in with the destination preserved (instead of being bounced to the buyer portal); each portal's account area gets a presence-aware "switch to the other portal" link; each sign-in page tells a user who is already signed in to the _other_ portal how to get there; and the landing page prefers the portal used last when both sessions are live.

**In scope:** `apps/web` only — middleware guard target and landing preference; a new pure routing module; presence-cookie readers and a last-portal cookie; a shared `PortalSwitchLink` component wired into the dashboard avatar menu and the buyer sidebar footer; `redirect` support and a notice on `/login`; a notice on `/buyer/login`; footer cross-link copy on `/login`, `/buyer/login`, `/buyer/register`; two i18n keys; Jest/RTL tests; Playwright additions; code-map entries.
**Explicitly out of scope:** subdomains; identity unification; mobile app / mobile-web; signed-out behavior on operator paths; any auto-redirect of an already-authenticated operator away from `/login`; logout flows; the contents of the operator prefix list (it moves, unchanged); platform-admin; new dependencies; anything under `apps/api` or `apps/mobile`.

---

## Constraints & conventions

- **Stack:** Next.js 14 App Router (`apps/web`), React 18 in this workspace, Tailwind, Radix primitives, lucide-react. Middleware runs on the edge runtime — `apps/web/lib/portal-routing.ts` and `apps/web/lib/presence-cookies.ts` must stay free of React/DOM-at-import-time code (guard `document` inside functions, as the existing file does).
- **Test runner and layout:** Jest via `next/jest` (`apps/web/jest.config.js`, jsdom, `testMatch: **/*.test.{ts,tsx}` under `roots` app/components/lib/hooks). RTL render helper: `apps/web/test-utils/render.tsx` (`renderWithProviders`). Playwright: `apps/web/playwright.config.ts`, specs in `apps/web/e2e/`, run post-deploy against `PLAYWRIGHT_BASE_URL`.
- **Lint / format that will fail the gate:** `next lint` (eslint-config-next; `react/no-unescaped-entities` → write `You&apos;re`), `tsc --noEmit` (the `Messages` type in `apps/web/lib/i18n/messages.ts` forces every key into both locales), Prettier (semicolons, double quotes, printWidth 100, trailing commas).
- **Existing patterns to copy rather than invent:**
  - Suspense boundary around `useSearchParams`: `apps/web/app/buyer/login/page.tsx:271-279`.
  - Radix menu item markup and classes: `apps/web/app/(dashboard)/layout.tsx:912-918`.
  - Sidebar footer row classes: `apps/web/app/buyer/portal/layout.tsx:436-443`.
  - Error box shape: `apps/web/app/(auth)/login/page.tsx:361`.
  - Cookie writer shape: `apps/web/lib/presence-cookies.ts:26-29`; cookie reader shape: `apps/web/lib/tenant-cookie.ts:19-23`.
  - RTL test shape (mocks for `next/navigation` and `@/lib/api-client`): `apps/web/app/(auth)/login/page.test.tsx`.
  - Raw-request Playwright pattern: `apps/web/e2e/05-cross-cutting.spec.ts:225-290`.
- **Design system source:** [design-system.md](../design-system.md); every class used is listed in ux-spec's compliance table — nothing new.
- **Must NOT change:** the operator prefix list contents; presence cookie names/attributes; `OPERATOR_PATH_PREFIXES` semantics ("equal, or prefix + `/`"); the `/` redirect status (307) and the `prefer-desktop` cookie handling; the buyer login's own `redirect` sanitizer; `apps/api/**`, `apps/mobile/**`; existing tests except the two additions to `apps/web/app/(auth)/login/page.test.tsx` owned by TP3.
- **Do-not-introduce:** Vitest, Biome, a second HTTP client, a root test runner, new dependencies, `data-testid` where a role/name works.
- **Landmines:**
  - Radix `DropdownMenu.Item asChild` needs a child that forwards its ref — `PortalSwitchLink` uses `React.forwardRef` and spreads the rest of its props onto the `<a>`.
  - Reading cookies during render breaks hydration; read them in `useEffect` (R8, T15).
  - `useSearchParams` outside a Suspense boundary fails `next build` on Next 14 — wrap the page exactly like the buyer login does.
  - The existing `page.test.tsx` mocks `next/navigation` with only `useRouter`; once the page calls `useSearchParams` that mock must provide it (TP3 does this).
  - Jest path patterns are regexes: never put `(auth)` unescaped in a command; `login/portal-switch.test` matches both new login test files.
  - Never run Jest through `turbo` for evidence (cache replay); invoke `npx jest` directly.
  - Every Playwright invocation carries `--reporter=list` (the config's JSON reporter writes `.campaign/runs/web-e2e.json`, a gate-consumed artifact); scratch configs/specs live in the OS temp dir, never in the repo.
  - A mobile user agent is rewritten by the middleware to the external mobile-web build — UI verify uses a desktop UA.
  - The worktree's `next dev` must run on port **3002** (3000/3001 belong to another stack's Docker containers).
  - Mutation probes back up to the OS temp dir and restore by copy — never `git stash/checkout/restore`.

---

## Test packages

_Authored FIRST. Test-only edits; no implementation code, no edits to source files other than the one mock extension named in TP3._ All new tests use the guarded-import pattern from test-plan §2.1 so a missing module fails on an assertion, and clear the three cookies (`rf-op-auth`, `rf-buyer-auth`, `rf-last-portal`) in `beforeEach`.

### TP1 — routing module tests

- **writes:** `apps/web/lib/portal-routing.test.ts` (new)
- **tests:** T1, T2, T3, T4, T5, T6, T7, T8, T9
- **effort:** high
- **brief:** import via `load<typeof import("./portal-routing")>("./portal-routing")`; cover the three exports `resolveOperatorPathGuard`, `resolveLandingTarget`, `safeOperatorRedirect` with the exact inputs and expected values in test-plan §2 (T7 and T9 as `it.each` tables). Every expectation is the test's own literal (e.g. `"/login?redirect=%2Forders%2Fabc%3Ftab%3D1"`), never derived from the implementation. Tag each `it`/`describe` with its `R#`/`T#`.
- **must fail with:** `expect(received).toBe("/login?redirect=%2Fdashboard")` received `undefined` (and the equivalent per case).

### TP2 — presence cookies + switch link component tests

- **writes:** `apps/web/lib/presence-cookies.test.ts` (new), `apps/web/components/PortalSwitchLink.test.tsx` (new)
- **tests:** T26; T13, T14, T15
- **brief:** T26 — call `setLastPortalCookie`/`hasOpPresence`/`hasBuyerPresence` through no-op fallbacks and assert on `document.cookie` / the boolean (`rf-op-auth=0` must read `false`). T13/T14 — `render(<Comp to="buyer" />)` with/without `document.cookie = "rf-buyer-auth=1; path=/"`; assert `screen.queryByRole("link", { name: "Switch to buyer portal" })` is not null and has `href="/buyer/portal"` (jsdom: `expect(link).toHaveAttribute("href", "/buyer/portal")`); the op side likewise; the `labels` prop override renders its `signIn` text when no cookie is present. T15 — `renderToString(<Comp to="buyer" />)` from `react-dom/server` with the buyer cookie set must contain `Buyer portal sign-in` and `/buyer/login` and must not contain `Switch to buyer portal`. Plain `render` from `@testing-library/react` is enough for the component (it has no provider needs); wrap state updates in `act` where RTL warns.
- **must fail with:** `expect(received).not.toBeNull()` received `null`; `expect("").toContain("Buyer portal sign-in")`; `expect("").toContain("rf-last-portal=op")`.

### TP3 — sign-in page tests

- **writes:** `apps/web/app/(auth)/login/portal-switch.test.tsx` (new), `apps/web/app/buyer/login/portal-switch.test.tsx` (new), and **two additions to the existing** `apps/web/app/(auth)/login/page.test.tsx`: (a) extend its `next/navigation` mock to `{ useRouter: () => ({ push }), useSearchParams: () => mockParams }` with `let mockParams = new URLSearchParams();` reset in `beforeEach`; (b) append T11 and T12 as two new `it` blocks (pins — they pass today; they are deliberately outside the red gate).
- **tests:** T10, T16, T17 (operator new file); T18, T19 (buyer new file); T11, T12 (existing file)
- **brief:** copy the mock shape of `apps/web/app/(auth)/login/page.test.tsx` (api-client mock, `renderWithProviders`, the three field labels `Workspace` / `Username or email` / `Password`, the `Sign in` button); T10 sets `mockParams = new URLSearchParams("redirect=/orders/abc?tab=1")` and expects `push` with exactly `"/orders/abc?tab=1"`. T16/T18 set the cookie **before** rendering and assert `screen.queryByRole("status")` is not null, its `textContent` contains the sentence from ux-spec, and `within(status).queryByRole("link", { name: "Go to buyer portal" })` has `href="/buyer/portal"` (buyer page: "Go to seller dashboard" → `/dashboard`). T17/T19 assert the absence of `status`, the new footer link text + href, and the absence of the old text (`/retailer portal/i`, `/Staff Portal/`). The buyer page test copies the mock shape of `apps/web/app/buyer/login/page.test.tsx` (its `next/navigation` mock already provides `useSearchParams`).
- **must fail with:** T10 `toHaveBeenCalledWith("/orders/abc?tab=1")` — called with `"/dashboard"`; T16/T18 `expect(received).not.toBeNull()` received `null`; T17/T19 the new footer link is `null`.

**Red gate command** _(only these new tests; every one must fail on an assertion, none may pass)_:

```bash
cd apps/web && npx jest --ci lib/portal-routing.test lib/presence-cookies.test components/PortalSwitchLink.test login/portal-switch.test
```

---

## Work packages

### WP1 — routing core: pure module, presence readers, middleware wiring

- **files:** `apps/web/lib/portal-routing.ts` (new), `apps/web/lib/presence-cookies.ts`, `apps/web/middleware.ts`
- **satisfies:** R1, R2, R3, R5, R11 (the cookie writer), R13, R14
- **provenBy:** T1, T2, T3, T4, T5, T6, T7, T8, T9, T26
- **dependsOn:** none
- **effort:** high
- **brief:** (1) Append to `presence-cookies.ts` the `Portal` type, `LAST_PORTAL_COOKIE`, a private `readCookie`, `hasOpPresence`, `hasBuyerPresence`, `setLastPortalCookie` — keep the file dependency-free. (2) Create `portal-routing.ts` with the operator prefix list moved verbatim from `middleware.ts:90-109`, `isOperatorPath`, `resolveOperatorPathGuard`, `resolveLandingTarget`, `safeOperatorRedirect`, `portalSwitchTarget`, `PORTAL_SWITCH_LABELS`. (3) In `middleware.ts` delete the inlined list and both decision blocks' logic, import the module, and wire it as shown; keep the `prefer-desktop` handling, the 307, and everything after the guard untouched. Also fix the stale "3-day" wording in the landing comment (the constant is 30 days).
- **exact code:**

`apps/web/lib/presence-cookies.ts` — append after `clearBuyerPresenceCookie`:

```ts
export type Portal = "op" | "buyer";

/**
 * Which portal's authenticated layout rendered last. The landing page ("/")
 * prefers it when BOTH presence cookies are set; it never overrides a missing
 * session (lib/portal-routing.ts). Same lifetime/attributes as the presence
 * cookies; written client-side by the two portal layouts.
 */
export const LAST_PORTAL_COOKIE = "rf-last-portal";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

/** True only when the operator presence cookie is present with value "1". */
export function hasOpPresence(): boolean {
  return readCookie(OP_PRESENCE_COOKIE) === "1";
}

/** True only when the buyer presence cookie is present with value "1". */
export function hasBuyerPresence(): boolean {
  return readCookie(BUYER_PRESENCE_COOKIE) === "1";
}

export function setLastPortalCookie(portal: Portal): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LAST_PORTAL_COOKIE}=${portal}; path=/; max-age=${PRESENCE_COOKIE_MAX_AGE}; samesite=lax`;
}
```

`apps/web/lib/portal-routing.ts` (new) — complete file:

```ts
/**
 * Portal routing decisions shared by the Next.js middleware and the operator
 * sign-in page. Pure functions of (path, query, cookie presence) so they can be
 * unit-tested; the middleware only wires them to NextResponse.
 *
 * Two portals live in one app with two independent sessions (presence cookies
 * rf-op-auth / rf-buyer-auth). A person can hold both; these rules make sure a
 * URL they asked for wins over whichever cookie happens to exist.
 */
import type { Portal } from "@/lib/presence-cookies";

export type { Portal };

/** Operator surfaces the buyer-only guard protects. Moved verbatim from middleware.ts. */
export const OPERATOR_PATH_PREFIXES = [
  "/dashboard",
  "/settings",
  "/invoices",
  "/customers",
  "/products",
  "/routes",
  "/orders",
  "/finance",
  "/credit-notes",
  "/estimates",
  "/inventory",
  "/suppliers",
  "/purchases",
  "/vendor-bills",
  "/returns",
  "/analytics",
  "/bookkeeping",
  "/drivers",
] as const;

export function isOperatorPath(pathname: string): boolean {
  return OPERATOR_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface Presence {
  opAuthed: boolean;
  buyerAuthed: boolean;
}

/**
 * Buyer-only guard: a browser with a buyer session and no operator session that
 * asks for an operator path is sent to the operator sign-in, destination kept.
 * Returns null when the request must pass through untouched.
 */
export function resolveOperatorPathGuard(
  input: Presence & { pathname: string; search: string },
): string | null {
  if (!isOperatorPath(input.pathname)) return null;
  if (input.opAuthed || !input.buyerAuthed) return null;
  return `/login?redirect=${encodeURIComponent(input.pathname + input.search)}`;
}

function parsePortal(value: string | null | undefined): Portal | null {
  return value === "op" || value === "buyer" ? value : null;
}

/**
 * Landing page ("/") target. One session → that portal. Both → the portal used
 * last (rf-last-portal), seller dashboard by default. A preference never
 * overrides a missing session. No session → null (render the marketing page).
 */
export function resolveLandingTarget(
  input: Presence & { lastPortal: string | null | undefined },
): "/dashboard" | "/buyer/portal" | null {
  if (input.opAuthed && input.buyerAuthed) {
    return parsePortal(input.lastPortal) === "buyer" ? "/buyer/portal" : "/dashboard";
  }
  if (input.opAuthed) return "/dashboard";
  if (input.buyerAuthed) return "/buyer/portal";
  return null;
}

export const DEFAULT_OPERATOR_LANDING = "/dashboard";

/**
 * Validates the `redirect` query parameter of the operator sign-in page. Only a
 * same-origin operator path survives; anything else (absolute URLs, protocol-
 * relative `//host`, backslashes, `..`, non-operator surfaces) falls back to the
 * dashboard. Open-redirect guard — keep it strict.
 */
export function safeOperatorRedirect(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_OPERATOR_LANDING;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return DEFAULT_OPERATOR_LANDING;
  }
  if (/\.\.|:\/\/|\/\/|\\/.test(raw)) return DEFAULT_OPERATOR_LANDING;
  const pathname = raw.split(/[?#]/, 1)[0];
  return isOperatorPath(pathname) ? raw : DEFAULT_OPERATOR_LANDING;
}

export type SwitchVariant = "switch" | "signIn";

/** English defaults; the dashboard passes localized labels from lib/i18n. */
export const PORTAL_SWITCH_LABELS: Record<Portal, Record<SwitchVariant, string>> = {
  buyer: { switch: "Switch to buyer portal", signIn: "Buyer portal sign-in" },
  op: { switch: "Switch to seller dashboard", signIn: "Seller dashboard sign-in" },
};

/** Where a "go to the other portal" link should point, given what this browser holds. */
export function portalSwitchTarget(
  to: Portal,
  presence: { op: boolean; buyer: boolean },
): { href: string; variant: SwitchVariant } {
  if (to === "buyer") {
    return presence.buyer
      ? { href: "/buyer/portal", variant: "switch" }
      : { href: "/buyer/login", variant: "signIn" };
  }
  return presence.op
    ? { href: "/dashboard", variant: "switch" }
    : { href: "/login", variant: "signIn" };
}
```

`apps/web/middleware.ts` — imports (replace lines 1–3 with):

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { tenantSlugFromHostname } from "@/lib/tenant-host";
import {
  BUYER_PRESENCE_COOKIE,
  LAST_PORTAL_COOKIE,
  OP_PRESENCE_COOKIE,
} from "@/lib/presence-cookies";
import { resolveLandingTarget, resolveOperatorPathGuard } from "@/lib/portal-routing";
```

`apps/web/middleware.ts` — replace lines 57–122 (the landing comment+block and the buyer-only guard, including the inlined `OPERATOR_PATH_PREFIXES`) with:

```ts
// Signed-in users skip the landing page: operators → dashboard, buyers →
// buyer portal; when both sessions are live the portal used last wins
// (rf-last-portal, written by each portal's authenticated layout) and the
// seller dashboard is the default. Keyed on the presence cookies, which track
// the live session (30-day sliding window re-set on every token refresh,
// cleared on refresh failure — see lib/presence-cookies.ts). Deliberately
// scoped to exactly "/": every other marketing page stays reachable while
// signed in. Runs AFTER the mobile-UA proxy so phones land in the mobile-web
// build, which does its own role-based routing. 307 (never 308) so nothing is
// cached if the user signs out. Decisions live in lib/portal-routing.ts.
const opAuthed = request.cookies.get(OP_PRESENCE_COOKIE)?.value === "1";
const buyerAuthed = request.cookies.get(BUYER_PRESENCE_COOKIE)?.value === "1";
if (pathname === "/") {
  const target = resolveLandingTarget({
    opAuthed,
    buyerAuthed,
    lastPortal: request.cookies.get(LAST_PORTAL_COOKIE)?.value,
  });
  if (target) {
    const dest = url.clone();
    dest.pathname = target;
    dest.search = "";
    const res = NextResponse.redirect(dest, 307);
    // Preserve the desktop opt-out even though we return before the
    // prefer-desktop block below.
    if (url.searchParams.get("desktop") === "1") {
      res.cookies.set("prefer-desktop", "1", {
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return res;
  }
}

// Buyer-only guard: a signed-in buyer with no operator session who asks for an
// operator surface goes to the operator sign-in with the destination kept, so
// a person who is both a buyer and a seller can open the second session (the
// sign-in page offers "Go to buyer portal" to everyone else). The operator
// path list lives in lib/portal-routing.ts, shared with that page's redirect
// validation so the two can never drift.
const guardTarget = resolveOperatorPathGuard({
  pathname,
  search: url.search,
  opAuthed,
  buyerAuthed,
});
if (guardTarget) {
  return NextResponse.redirect(new URL(guardTarget, request.url), 307);
}
```

Nothing below the guard changes. Note the guard now keys on `=== "1"` like the landing block (today it keys on truthiness); the setters only ever write `1`.

### WP2 — presence hook and the shared switch link

- **files:** `apps/web/lib/hooks/usePortalPresence.ts` (new), `apps/web/components/PortalSwitchLink.tsx` (new)
- **satisfies:** R6, R7, R8, R12 (the component half)
- **provenBy:** T13, T14, T15
- **dependsOn:** WP1
- **brief:** exactly the two files below. The component is a plain anchor (full navigation between the two app shells), forwards its ref and spreads extra props so Radix `asChild` can drive it, hides the icon from assistive tech, and reads presence only after mount.
- **exact code:**

`apps/web/lib/hooks/usePortalPresence.ts` (new):

```ts
"use client";

import * as React from "react";
import { hasBuyerPresence, hasOpPresence } from "@/lib/presence-cookies";

export interface PortalPresence {
  op: boolean;
  buyer: boolean;
}

const NONE: PortalPresence = { op: false, buyer: false };

/**
 * Presence cookies, read AFTER mount — never during render — so the server
 * render and the first client render agree (no hydration mismatch). Until the
 * effect runs, callers see "no presence" and render their sign-in variant.
 */
export function usePortalPresence(): PortalPresence {
  const [presence, setPresence] = React.useState<PortalPresence>(NONE);
  React.useEffect(() => {
    setPresence({ op: hasOpPresence(), buyer: hasBuyerPresence() });
  }, []);
  return presence;
}
```

`apps/web/components/PortalSwitchLink.tsx` (new):

```tsx
"use client";

import * as React from "react";
import { LayoutDashboard, ShoppingCart } from "lucide-react";
import { usePortalPresence } from "@/lib/hooks/usePortalPresence";
import {
  PORTAL_SWITCH_LABELS,
  portalSwitchTarget,
  type Portal,
  type SwitchVariant,
} from "@/lib/portal-routing";

export interface PortalSwitchLinkProps extends Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
> {
  /** The portal this link leads to. */
  to: Portal;
  iconClassName?: string;
  /** Localized labels; defaults to the English PORTAL_SWITCH_LABELS. */
  labels?: Record<SwitchVariant, string>;
}

/**
 * The door between the buyer portal and the seller dashboard. Presence-aware:
 * links straight into the other portal when this browser holds a session there,
 * otherwise to its sign-in page. A plain anchor on purpose — the two portals are
 * separate app shells and a full navigation resets client state. Forwards its
 * ref and spreads props so Radix `DropdownMenu.Item asChild` can drive it.
 */
export const PortalSwitchLink = React.forwardRef<HTMLAnchorElement, PortalSwitchLinkProps>(
  function PortalSwitchLink({ to, iconClassName = "h-4 w-4", labels, ...rest }, ref) {
    const presence = usePortalPresence();
    const target = portalSwitchTarget(to, presence);
    const label = (labels ?? PORTAL_SWITCH_LABELS[to])[target.variant];
    const Icon = to === "buyer" ? ShoppingCart : LayoutDashboard;
    return (
      <a ref={ref} href={target.href} {...rest}>
        <Icon className={iconClassName} aria-hidden="true" />
        {label}
      </a>
    );
  },
);
```

### WP3 — dashboard avatar menu item + last-portal write + i18n keys

- **files:** `apps/web/app/(dashboard)/layout.tsx`, `apps/web/lib/i18n/messages.ts`
- **satisfies:** R6, R11, R12 (dashboard half)
- **provenBy:** T13, T14 (component), T27 (post-deploy), T26 (writer)
- **dependsOn:** WP2
- **brief:** (1) `messages.ts`: add two keys to the `en` block right after `"menu.signOut"` (line 49) and the same two keys to `es` right after its `"menu.signOut"` (line 99) — the `Messages` type makes a missing `es` key a typecheck error. (2) `layout.tsx`: import `PortalSwitchLink` and `setLastPortalCookie`; in `AuthGuard`'s effect (lines 352–361) write the cookie once the session is confirmed; insert the menu item after the Drive-mode block (line 939) and before the Language separator (line 942). Nothing else in this 1451-line file changes — targeted edits only.
- **exact code:**

`apps/web/lib/i18n/messages.ts` — `en`, after `"menu.signOut": "Sign out",`:

```ts
  "menu.switchToBuyerPortal": "Switch to buyer portal",
  "menu.buyerPortalSignIn": "Buyer portal sign-in",
```

`es`, after `"menu.signOut": "Cerrar sesión",`:

```ts
  "menu.switchToBuyerPortal": "Cambiar al portal de compradores",
  "menu.buyerPortalSignIn": "Acceder al portal de compradores",
```

`apps/web/app/(dashboard)/layout.tsx` — imports (add near line 52):

```ts
import { PortalSwitchLink } from "@/components/PortalSwitchLink";
import { setLastPortalCookie } from "@/lib/presence-cookies";
```

`AuthGuard` effect (replace lines 352–361):

```tsx
React.useEffect(() => {
  if (isLoading) return;
  if (!isAuthenticated) {
    router.push("/login");
    return;
  }
  if (user?.forcePasswordChange) {
    router.push("/change-password");
    return;
  }
  // "/" opens the portal used last when both a buyer and an operator session
  // are live (lib/portal-routing.ts) — record that this one rendered.
  setLastPortalCookie("op");
}, [isAuthenticated, isLoading, user, router]);
```

Menu item (insert between line 939 `)}` and line 941 `{/* Language / Idioma …`):

```tsx
{
  /* Buyer ⇄ seller portal switch — the two portals are separate
                  sessions in one browser; this is the door between them
                  (components/PortalSwitchLink.tsx). */
}
<DropdownMenu.Item asChild>
  <PortalSwitchLink
    to="buyer"
    className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-navy outline-none hover:bg-surface-raised"
    iconClassName="h-4 w-4 text-navy/70"
    labels={{
      switch: t("menu.switchToBuyerPortal"),
      signIn: t("menu.buyerPortalSignIn"),
    }}
  />
</DropdownMenu.Item>;
```

### WP4 — buyer sidebar row + last-portal write

- **files:** `apps/web/app/buyer/portal/layout.tsx`
- **satisfies:** R7, R11, R12 (buyer half)
- **provenBy:** T13, T14 (component), T28 (post-deploy), T26 (writer)
- **dependsOn:** WP2
- **brief:** import `PortalSwitchLink` and `setLastPortalCookie`; extend the auth effect (lines 155–160) to write the cookie once authenticated; insert the row in the footer between the identity card (ends line 435) and the Sign Out button (line 436). Targeted edits only.
- **exact code:**

imports (add after line 33):

```ts
import { PortalSwitchLink } from "@/components/PortalSwitchLink";
import { setLastPortalCookie } from "@/lib/presence-cookies";
```

auth effect (replace lines 155–160):

```tsx
React.useEffect(() => {
  if (isLoading) return;
  if (!isAuthenticated) {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    router.push(`/buyer/login?redirect=${redirect}`);
    return;
  }
  // "/" opens the portal used last when both a buyer and an operator session
  // are live (lib/portal-routing.ts) — record that this one rendered.
  setLastPortalCookie("buyer");
}, [isLoading, isAuthenticated, router]);
```

footer row (insert before the `<button type="button" onClick={logout}` at line 436):

```tsx
<PortalSwitchLink
  to="op"
  className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-buyer-300/70 transition-colors hover:bg-white/10 hover:text-buyer-100"
  iconClassName="h-4 w-4"
/>
```

### WP5 — operator sign-in: `redirect` parameter, presence notice, footer copy

- **files:** `apps/web/app/(auth)/login/page.tsx`
- **satisfies:** R4, R5, R9, R12
- **provenBy:** T10, T11, T12, T16, T17
- **dependsOn:** WP2
- **effort:** high
- **brief:** (1) imports: `useSearchParams` from `next/navigation` (merge into the existing `useRouter` import), `safeOperatorRedirect` from `@/lib/portal-routing`, `usePortalPresence` from `@/lib/hooks/usePortalPresence`. (2) Rename `export default function LoginPage()` (line 53) to `function LoginPageInner()` and add the Suspense wrapper at the end of the file. (3) In the component body read the params and presence; in `onSubmit` replace `router.push("/dashboard")` (line 101) with `router.push(redirectTarget)`; `forcePasswordChange` keeps winning. (4) Insert the notice directly above the `{apiError ? …}` block (line ~360). (5) Replace the first footer paragraph (lines 461–466). Nothing else changes.
- **exact code:**

```tsx
// (2) at the top of the component body, after `const { login: authLogin } = useAuth();`
const searchParams = useSearchParams();
const redirectTarget = safeOperatorRedirect(searchParams.get("redirect"));
const presence = usePortalPresence();
```

```tsx
// (3) in onSubmit
const user = await authLogin(data.username, data.password);
if (user.forcePasswordChange) router.push("/change-password");
else router.push(redirectTarget);
```

```tsx
// (4) notice — placed immediately before the existing apiError block
{
  presence.buyer && (
    <p
      role="status"
      className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy"
    >
      You&apos;re signed in to the buyer portal.{" "}
      <a href="/buyer/portal" className="text-[#0B6E6B] hover:underline font-medium">
        Go to buyer portal
      </a>
    </p>
  );
}
```

```tsx
// (5) footer — replaces "Not a staff member? … Sign in to retailer portal"
<p className="text-xs text-navy/70">
  Buying from a seller?{" "}
  <a href="/buyer/login" className="text-[#0B6E6B] hover:underline font-medium">
    Sign in to the buyer portal
  </a>
</p>
```

```tsx
// (2) end of file — Suspense boundary required by useSearchParams
// (mirrors app/buyer/login/page.tsx).
export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginPageInner />
    </React.Suspense>
  );
}
```

### WP6 — buyer sign-in notice + footer copy (login and register)

- **files:** `apps/web/app/buyer/login/page.tsx`, `apps/web/app/buyer/register/page.tsx`
- **satisfies:** R10, R12
- **provenBy:** T18, T19
- **dependsOn:** WP2
- **brief:** `login/page.tsx`: import `usePortalPresence`; `const presence = usePortalPresence();` inside `BuyerLoginInner`; insert the notice immediately before `{apiError && (` (line 167); replace the footer paragraph (lines 258–263). `register/page.tsx`: replace only its footer paragraph (lines 297–299 region, "Staff member? … Sign in to Staff Portal") with the same copy. The buyer page's own `redirect` sanitizer is untouched.
- **exact code:**

```tsx
{
  presence.op && (
    <p
      role="status"
      className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy"
    >
      You&apos;re signed in to a seller dashboard.{" "}
      <a href="/dashboard" className="text-buyer-600 hover:underline font-medium">
        Go to seller dashboard
      </a>
    </p>
  );
}
```

```tsx
<p className="text-xs text-navy/70">
  Selling on RouteFlow?{" "}
  <a href="/login" className="text-buyer-600 hover:underline">
    Sign in to the seller dashboard
  </a>
</p>
```

### WP7 — Playwright contract additions (post-deploy tests)

- **files:** `apps/web/e2e/05-cross-cutting.spec.ts`, `apps/web/e2e/02-operator.spec.ts`, `apps/web/e2e/04-buyer-portal.spec.ts`
- **satisfies:** R1, R2, R3, R6, R7, R11, R13, R14 (e2e level)
- **provenBy:** T20, T21, T22, T23, T24, T25, T27, T28 — these tests are what this package writes; the in-run proof is `cd apps/web && npx playwright test --list --reporter=list` showing them under their existing projects (`cross-cutting`, `operator`, `buyer`). They execute post-deploy.
- **dependsOn:** WP1
- **brief:** In `05-cross-cutting.spec.ts` extend the existing `seedPresenceCookies` helper (lines 229–241) to accept `Array<string | { name: string; value: string }>` so `rf-last-portal` can be seeded, then append CC-16…CC-21 inside the existing `test.describe("Cross-cutting — Landing-page auto-redirect", …)` block using the same raw-request style (`context.request.get(path, { maxRedirects: 0 })`, `expect(resp.status()).toBe(307)`, `expect(resp.headers()["location"]).toContain(...)`). In `02-operator.spec.ts` add one read-only test at the end of its top-level describe: `page.goto("/dashboard")`, `page.getByRole("button", { name: "Open user menu" }).click()`, `await expect(page.getByRole("menuitem", { name: "Buyer portal sign-in" })).toHaveAttribute("href", "/buyer/login")`, then `expect((await context.cookies()).some((c) => c.name === "rf-last-portal" && c.value === "op")).toBe(true)`. In `04-buyer-portal.spec.ts` add one read-only test after an existing buyer login in that file (reuse the buyer it already creates/logs in; read the file first): `await expect(page.getByRole("link", { name: "Seller dashboard sign-in" })).toHaveAttribute("href", "/login")` and the `rf-last-portal=buyer` cookie assertion. Semantic locators only; web-first assertions; no sleeps; never `.first()` on lists. Do not modify CC-11…CC-15.
- **exact code (CC-16/CC-18 as the template):**

```ts
test("CC-16 buyer-only session on an operator path → /login with the destination kept", async ({
  context,
}) => {
  await seedPresenceCookies(context, ["rf-buyer-auth"]);
  const resp = await context.request.get("/dashboard", { maxRedirects: 0 });
  expect(resp.status()).toBe(307);
  expect(resp.headers()["location"]).toContain("/login?redirect=%2Fdashboard");
});

test("CC-18 both sessions + rf-last-portal=buyer → /buyer/portal", async ({ context }) => {
  await seedPresenceCookies(context, [
    "rf-op-auth",
    "rf-buyer-auth",
    { name: "rf-last-portal", value: "buyer" },
  ]);
  const resp = await context.request.get("/", { maxRedirects: 0 });
  expect(resp.status()).toBe(307);
  expect(resp.headers()["location"]).toContain("/buyer/portal");
});
```

### WP8 — code map

- **files:** `.claude/code-map/web.md`, `.claude/code-map/_meta.json`, `.claude/code-map/CHANGELOG.md`
- **satisfies:** none (repo routine — required by CLAUDE.md, not by the spec)
- **provenBy:** none (documentation)
- **dependsOn:** WP3, WP4, WP5, WP6, WP7
- **effort:** low
- **brief:** surgical edits only. In `web.md`'s "Where to find" table update the `middleware.ts` row (guard now → `/login?redirect=`; landing prefers `rf-last-portal`; decisions in `lib/portal-routing.ts`), the `lib/presence-cookies.ts` row (readers + `rf-last-portal` writer), and the operator/buyer login rows (`redirect` param, presence notices); add rows for `lib/portal-routing.ts`, `lib/hooks/usePortalPresence.ts`, `components/PortalSwitchLink.tsx`; add one bullet under the E2E section for CC-16…CC-21 / the two menu tests. Add a dated bullet at the top of `CHANGELOG.md` and replace `_meta.json.notes` with that same bullet; set `generatedAt` to now and leave `mappedSha` as `a5be8626` with the note "branch feat/portal-switcher". Never reference a live client.

### Package map

| WP  | satisfies                               | provenBy                | dependsOn               | Wave |
| --- | --------------------------------------- | ----------------------- | ----------------------- | ---- |
| WP1 | R1, R2, R3, R5, R11, R13, R14           | T1–T9, T26              | —                       | 1    |
| WP2 | R6, R7, R8, R12                         | T13, T14, T15           | WP1                     | 2    |
| WP7 | R1, R2, R3, R6, R7, R11, R13, R14 (e2e) | T20–T25, T27, T28       | WP1                     | 2    |
| WP3 | R6, R11, R12                            | T13, T14, T26, T27      | WP2                     | 3    |
| WP4 | R7, R11, R12                            | T13, T14, T26, T28      | WP2                     | 3    |
| WP5 | R4, R5, R9, R12                         | T10, T11, T12, T16, T17 | WP2                     | 3    |
| WP6 | R10, R12                                | T18, T19                | WP2                     | 3    |
| WP8 | — (routine)                             | —                       | WP3, WP4, WP5, WP6, WP7 | 4    |

Cross-check: R1–R14 all appear in some `satisfies:`; T1–T28 all appear in some `provenBy:`.

---

## Acceptance criteria

1. `R1` — with only `rf-buyer-auth=1`, `GET /dashboard` returns 307 to `/login?redirect=%2Fdashboard`; `GET /orders/abc?tab=1` → `/login?redirect=%2Forders%2Fabc%3Ftab%3D1`.
2. `R2`/`R13` — `GET /`: op-only → `/dashboard`; buyer-only → `/buyer/portal`; both → `/dashboard` unless `rf-last-portal=buyer`; op-only with `rf-last-portal=buyer` → `/dashboard`; no cookies → 200.
3. `R3` — the guard never redirects an operator with `rf-op-auth=1`, a signed-out visitor, or any non-operator path (`/login`, `/buyer/portal`, `/pricing`, `/dashboards`).
4. `R4`/`R5` — signing in on `/login?redirect=/orders/abc?tab=1` navigates to `/orders/abc?tab=1`; `redirect=https://evil.com/x`, `//evil.com`, `/buyer/portal`, `/dashboard/../admin` all navigate to `/dashboard`; `forcePasswordChange` → `/change-password`.
5. `R6` — the dashboard avatar menu contains, between Profile/Drive mode and the Language section, an anchor "Switch to buyer portal" (`/buyer/portal`) when `rf-buyer-auth=1`, else "Buyer portal sign-in" (`/buyer/login`); Spanish strings present.
6. `R7` — the buyer sidebar footer contains, above Sign Out, an anchor "Switch to seller dashboard" (`/dashboard`) when `rf-op-auth=1`, else "Seller dashboard sign-in" (`/login`).
7. `R8` — `renderToString` of the link shows the sign-in variant regardless of cookies; no hydration warnings in UI verify.
8. `R9`/`R10` — the notices appear only with the other portal's presence cookie, carry `role="status"` and the exact copy/links; footer copy reads "Sign in to the buyer portal" / "Sign in to the seller dashboard" and the strings "retailer portal" / "Staff Portal" are gone from `/login`, `/buyer/login`, `/buyer/register`.
9. `R11` — after the dashboard `AuthGuard` confirms a session `rf-last-portal=op` is set; after the buyer portal layout confirms one `rf-last-portal=buyer` is set (path `/`, 30 days, lax).
10. `R12` — every switch affordance is an `<a href>` whose accessible name equals its text; icons are `aria-hidden`.
11. `R14` — no guard `location` ever contains a scheme or host; `safeOperatorRedirect` never returns a value that fails its own rules.
12. Deploy day — existing browsers behave as today on `/` (no `rf-last-portal` yet ⇒ operator default) and existing tests CC-11…CC-15 stay green.
13. Nothing under `apps/api`, `apps/mobile`, or `packages` changed; no new dependency.

---

## Verification commands

Per round (after every implementation wave and fix round):

```bash
cd apps/web && npx tsc --noEmit
cd apps/web && npx next lint
```

Final (once, decides `clean`):

```bash
cd apps/web && npx jest --ci
cd apps/web && NEXT_IGNORE_INCORRECT_LOCKFILE=1 npx next build
cd apps/web && npx playwright test --list --reporter=list
```

`next build` is the check that the `useSearchParams` Suspense boundary exists; `--list --reporter=list` proves the new Playwright tests resolve under their projects without writing the campaign artifact. Baseline runs all five on the untouched tree first; a command that fails there is a broken command, corrected in this plan, never in code.

---

## UI verification

- **URL:** `http://localhost:3002`
- **Start command:** `cd apps/web && npx next dev -p 3002` — the agent that starts it stops it; ports 3000/3001 belong to another stack's containers.
- **Flows:** test-plan §8 rows 1–9, verbatim in the args below.
- **Viewports:** `desktop` (desktop user agent only — a mobile UA is rewritten to the external mobile-web build).
- **Checks:** `console-errors`, `a11y`, `design-system` (`network-failures` dropped: this origin has no API; failed requests to `localhost:3000` are baseline noise).
- The authenticated menus cannot be reached here; their proof is T13/T14 plus review, and T27/T28 post-deploy.

---

## Risks & rollback

| Risk                                                                  | Likelihood          | Blast radius                            | Mitigation / what the reviewer should watch                                                                                                                     |
| --------------------------------------------------------------------- | ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| open redirect via `?redirect=`                                        | low                 | phishing hand-off from a trusted origin | `safeOperatorRedirect` strictness (T9, probe #2); the reviewer checks the sanitizer is the only path into `router.push`                                         |
| redirect loop guard ⇄ `/login`                                        | low                 | operator login unusable                 | `/login` is not an operator path (T7); the operator login page must NOT gain an already-authenticated redirect (spec A9); UI verify flow 1 is a real navigation |
| hydration mismatch from cookie-dependent markup                       | low–med             | console errors, flicker                 | `usePortalPresence` reads in an effect (T15); UI verify flow 9                                                                                                  |
| existing `page.test.tsx` breaks when the page calls `useSearchParams` | certain without TP3 | red final gate                          | TP3 extends the mock before implementation                                                                                                                      |
| `next build` fails on the missing Suspense boundary                   | low                 | broken deploy                           | WP5 wraps the page; final gate runs `next build`                                                                                                                |
| Radix `asChild` + anchor keyboard behavior                            | low                 | menu item not keyboard-selectable       | `forwardRef` + prop spread; T27 exercises the real menu post-deploy                                                                                             |
| Playwright JSON reporter clobbers `.campaign/runs/web-e2e.json`       | med if forgotten    | false gate reds elsewhere               | every invocation carries `--reporter=list`                                                                                                                      |
| pure buyers deep-linking now see the operator sign-in                 | certain (intended)  | confusion without the notice            | R9 notice is mandatory, not optional                                                                                                                            |

- **Rollback:** revert the squash commit. The `rf-last-portal` cookie left in browsers is ignored by old code.
- **Migration reversibility:** none — no migration.
- **Feature flag / entitlement:** none — ungated.
- **Deploy day:** existing sessions unchanged on `/`; buyer-only browsers hitting operator URLs see `/login` with the buyer notice.
- **Observability:** the web service's request logs show the guard's 307s with `location=/login?redirect=…`; a loop would show as repeated 307/200 pairs for one client.

---

## Pipeline args

```js
{
  planPath: '.claude/pipeline/2026-09-04-portal-switcher/build-plan.md',
  discoveryPath: '.claude/pipeline/2026-09-04-portal-switcher/discovery.md',
  specPath: '.claude/pipeline/2026-09-04-portal-switcher/spec.md',
  uxSpecPath: '.claude/pipeline/2026-09-04-portal-switcher/ux-spec.md',
  testPlanPath: '.claude/pipeline/2026-09-04-portal-switcher/test-plan.md',
  designSystemPath: '.claude/pipeline/design-system.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '<ISO at launch>',
  scale: 'major',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-portal',
  context: 'Buyer <-> seller portal switcher (apps/web only): middleware guard -> /login?redirect=, last-portal landing preference, presence-aware switch links in both portals, sign-in notices; auth-adjacent routing, no API/schema changes.',
  formatCommand: 'npx prettier --write apps/web --log-level warn',
  testPackages: [
    { id: 'TP1', title: 'routing module tests', files: ['apps/web/lib/portal-routing.test.ts'], brief: '<TP1 brief>', effort: 'high' },
    { id: 'TP2', title: 'presence cookies + switch link tests', files: ['apps/web/lib/presence-cookies.test.ts', 'apps/web/components/PortalSwitchLink.test.tsx'], brief: '<TP2 brief>' },
    { id: 'TP3', title: 'sign-in page tests', files: ['apps/web/app/(auth)/login/portal-switch.test.tsx', 'apps/web/app/buyer/login/portal-switch.test.tsx', 'apps/web/app/(auth)/login/page.test.tsx'], brief: '<TP3 brief>' }
  ],
  redGate: { commands: ['cd apps/web && npx jest --ci lib/portal-routing.test lib/presence-cookies.test components/PortalSwitchLink.test login/portal-switch.test'], expect: 'fail' },
  packages: [
    { id: 'WP1', title: 'routing core', files: ['apps/web/lib/portal-routing.ts', 'apps/web/lib/presence-cookies.ts', 'apps/web/middleware.ts'], brief: '<WP1 brief>', satisfies: ['R1','R2','R3','R5','R11','R13','R14'], provenBy: ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T26'], effort: 'high' },
    { id: 'WP2', title: 'presence hook + PortalSwitchLink', files: ['apps/web/lib/hooks/usePortalPresence.ts', 'apps/web/components/PortalSwitchLink.tsx'], brief: '<WP2 brief>', dependsOn: ['WP1'], satisfies: ['R6','R7','R8','R12'], provenBy: ['T13','T14','T15'] },
    { id: 'WP3', title: 'dashboard menu item + i18n', files: ['apps/web/app/(dashboard)/layout.tsx', 'apps/web/lib/i18n/messages.ts'], brief: '<WP3 brief>', dependsOn: ['WP2'], satisfies: ['R6','R11','R12'], provenBy: ['T13','T14','T26','T27'] },
    { id: 'WP4', title: 'buyer sidebar row', files: ['apps/web/app/buyer/portal/layout.tsx'], brief: '<WP4 brief>', dependsOn: ['WP2'], satisfies: ['R7','R11','R12'], provenBy: ['T13','T14','T26','T28'] },
    { id: 'WP5', title: 'operator sign-in redirect + notice', files: ['apps/web/app/(auth)/login/page.tsx'], brief: '<WP5 brief>', dependsOn: ['WP2'], satisfies: ['R4','R5','R9','R12'], provenBy: ['T10','T11','T12','T16','T17'], effort: 'high' },
    { id: 'WP6', title: 'buyer sign-in notice + copy', files: ['apps/web/app/buyer/login/page.tsx', 'apps/web/app/buyer/register/page.tsx'], brief: '<WP6 brief>', dependsOn: ['WP2'], satisfies: ['R10','R12'], provenBy: ['T18','T19'] },
    { id: 'WP7', title: 'Playwright contract additions', files: ['apps/web/e2e/05-cross-cutting.spec.ts', 'apps/web/e2e/02-operator.spec.ts', 'apps/web/e2e/04-buyer-portal.spec.ts'], brief: '<WP7 brief>', dependsOn: ['WP1'], satisfies: ['R1','R2','R3','R6','R7','R11','R13','R14'], provenBy: ['T20','T21','T22','T23','T24','T25','T27','T28'] },
    { id: 'WP8', title: 'code map', files: ['.claude/code-map/web.md', '.claude/code-map/_meta.json', '.claude/code-map/CHANGELOG.md'], brief: '<WP8 brief>', dependsOn: ['WP3','WP4','WP5','WP6','WP7'], effort: 'low' }
  ],
  verifyCommands: {
    perRound: ['cd apps/web && npx tsc --noEmit', 'cd apps/web && npx next lint'],
    final: ['cd apps/web && npx jest --ci', 'cd apps/web && NEXT_IGNORE_INCORRECT_LOCKFILE=1 npx next build', 'cd apps/web && npx playwright test --list --reporter=list']
  },
  uiVerify: {
    url: 'http://localhost:3002',
    startCommand: 'cd apps/web && npx next dev -p 3002',
    flows: ['<test-plan §8 rows 1–9>'],
    viewports: ['desktop'],
    checks: ['console-errors', 'a11y', 'design-system']
  },
  mutationProbe: { targets: ['<test-plan §9 rows 1–6>'] }
}
```
