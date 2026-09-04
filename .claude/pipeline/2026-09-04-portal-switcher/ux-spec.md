# UX Spec: buyer ⇄ seller portal switcher

> Authored by Fable 5.1 on 2026-09-04. Status: APPROVED
> This file is the ONLY context the implementation, review, and UI-verification agents
> receive about the UI. It stands alone. Companion cache: `.claude/pipeline/design-system.md`
> (derived 2026-08-31) — cited, not repeated. Requirements served: `R#` ids from
> [spec.md](./spec.md).

## Job to be done

- **Who:** a person who holds both a buyer account and a seller (operator) account, any time they need the _other_ portal; and any signed-in user who lands on the wrong portal's sign-in page. A few times a week per dual-role person.
- **What job:** "get me to my other portal" — without signing out, without guessing URLs.
- **Why now:** today a buyer-first session traps them in the buyer portal (discovery §1).
- **Current workaround:** type `/login` by hand. If this ships half-built (guard changed, no doors), a buyer-only browser would land on the operator sign-in page with no way back — so the sign-in notices (R9, R10) are part of the minimum, not polish.

## Entry points & exits

- **Entry points**
  - Seller dashboard avatar menu → item "Switch to buyer portal" / "Buyer portal sign-in" (R6).
  - Buyer portal sidebar footer → item "Switch to seller dashboard" / "Seller dashboard sign-in" (R7).
  - Middleware: a buyer-only browser requesting any operator path → `/login?redirect=<path>` (R1); the sign-in page then shows "Go to buyer portal" (R9).
  - `/login` and `/buyer/login` footer cross-links (R9, R10).
- **Exits**
  - Switch items → `/buyer/portal`, `/buyer/login`, `/dashboard`, or `/login` (full navigation).
  - `/login` after sign-in → the validated `redirect` target or `/dashboard` (R4/R5); `/change-password` when forced.
  - Notice links → `/buyer/portal` (from `/login`) or `/dashboard` (from `/buyer/login`).

## Screen inventory

| Screen                       | Route / path                                                                          | Purpose (one line)                                                     | Primary user              | Requirement(s)   |
| ---------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- | ---------------- |
| Seller dashboard avatar menu | any `(dashboard)` route; menu opened from the header avatar button ("Open user menu") | add the buyer-portal door                                              | operator / tenant admin   | R6, R8, R11, R12 |
| Buyer portal sidebar footer  | `/buyer/portal/*`                                                                     | add the seller-dashboard door                                          | buyer                     | R7, R8, R11, R12 |
| Operator sign-in             | `/login`                                                                              | honour `redirect`; show the buyer-presence notice; aligned footer copy | operator; misrouted buyer | R4, R5, R9, R12  |
| Buyer sign-in                | `/buyer/login` (+ `/buyer/register` footer copy only)                                 | show the operator-presence notice; aligned footer copy                 | buyer; misrouted operator | R10, R12         |

## Per-screen anatomy

### Screen: seller dashboard avatar menu (`apps/web/app/(dashboard)/layout.tsx`, `Header`, the `DropdownMenu.Root` at lines 892–978)

- **Regions (existing, DOM order):** trigger button (Avatar + username + chevron) → `DropdownMenu.Content` → item "Profile & Settings" → optional item "Drive mode" → separator → "Language / Idioma" section with locale items → separator → "Sign out" (or "Exit impersonation").
- **Change:** insert **one item directly after the Drive-mode block and before the Language separator** — i.e. between the profile/drive items and the language section — so the order becomes: Profile · (Drive mode) · **Buyer portal** · ─ · Language … · ─ · Sign out.
- **Visual hierarchy:** unchanged; the new item is a peer of "Profile & Settings" (same classes, same 16px lucide icon).
- **Primary action:** n/a (menu). **Secondary:** the new item. **Destructive:** none.
- **Icon:** lucide `ShoppingCart` (already imported in this file), `h-4 w-4 text-navy/70`.
- **Label:** localized — `menu.switchToBuyerPortal` / `menu.buyerPortalSignIn` (see UI copy).
- **Implementation shape:** `<DropdownMenu.Item asChild>` wrapping the shared `PortalSwitchLink` anchor, so the item keeps Radix keyboard/highlight behavior and the anchor keeps middle-click/open-in-new-tab.

### Screen: buyer portal sidebar footer (`apps/web/app/buyer/portal/layout.tsx`, the Footer div at lines 430–444)

- **Regions (existing):** `<aside>` (always 256 px, every viewport) → header → scrolling nav (Settings link, "Your Sellers" switcher, nav items) → **footer**: identity card (name/email) → "Sign Out" button.
- **Change:** insert the switch link **between the identity card and "Sign Out"**, styled like the sidebar's other rows (dark theme: `text-buyer-300/70`, hover `bg-white/10` + `text-buyer-100`), lucide `LayoutDashboard` (already imported) at `h-4 w-4`.
- **Hierarchy:** the identity card stays first; the switch link and Sign Out are peers; Sign Out keeps its red hover as the only destructive-looking row.
- **Primary action:** n/a. **Destructive:** none added.

### Screen: operator sign-in `/login` (`apps/web/app/(auth)/login/page.tsx`)

- **Regions (existing):** left marketing panel → right form panel: h1 "Sign in", subtitle "Wholesaler portal — manage your operations.", Google button/divider (where present), error box (`{apiError}`), Workspace/Username/Password fields, submit, footer links.
- **Change 1 — notice:** when `rf-buyer-auth=1` is present, render **one** `<p role="status">` immediately **above the error box** inside the form column: text "You're signed in to the buyer portal." followed by the link "Go to buyer portal" → `/buyer/portal`. Same box shape as the error box (`rounded-lg px-3 py-2 text-sm`) but neutral: `border border-surface-border bg-surface-raised text-navy`; the link uses the page's existing link style `text-[#0B6E6B] hover:underline font-medium`.
- **Change 2 — footer:** replace "Not a staff member? Sign in to retailer portal" with "Buying from a seller? **Sign in to the buyer portal**" (same `<a href="/buyer/login">`, same classes). The trial link is unchanged.
- **Change 3 — redirect:** invisible; after sign-in navigate to the validated `redirect` (R4/R5).

### Screen: buyer sign-in `/buyer/login` (`apps/web/app/buyer/login/page.tsx`; footer only in `apps/web/app/buyer/register/page.tsx`)

- **Change 1 — notice:** when `rf-op-auth=1` is present, one `<p role="status">` above the error box: "You're signed in to a seller dashboard." + link "Go to seller dashboard" → `/dashboard`. Same neutral box; link style `text-buyer-600 hover:underline font-medium` (the page's link style).
- **Change 2 — footer:** replace "Staff member? Sign in to Staff Portal" with "Selling on RouteFlow? **Sign in to the seller dashboard**" (`<a href="/login">`, same classes) on both `/buyer/login` and `/buyer/register`.

## State set — every surface above must ship ALL of these

Switch items and notices are static links; the only dynamic input is cookie presence, read after mount.

| State                  | Trigger / condition                                                                                                                           | What's shown                                                                                               | Recovery / next action                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Default                | no presence cookie for the _other_ portal                                                                                                     | menu item / sidebar row in its **sign-in** variant; sign-in pages show **no** notice                       | click → the other portal's sign-in page                                                                  |
| Presence               | the other portal's presence cookie = `1`                                                                                                      | **switch** variant (links straight into the other portal); sign-in pages show the notice                   | click → the other portal; its own guard signs the user in or bounces to its login if the session is dead |
| Before hydration / SSR | server render and first client paint                                                                                                          | sign-in variant; no notice                                                                                 | updates after mount (R8) — no flash of wrong text is required beyond one frame                           |
| Empty                  | n/a — nothing listed                                                                                                                          | —                                                                                                          | —                                                                                                        |
| Loading                | n/a — no fetch                                                                                                                                | —                                                                                                          | —                                                                                                        |
| Partial                | n/a                                                                                                                                           | —                                                                                                          | —                                                                                                        |
| Error                  | n/a — a link cannot fail; a dead session on the destination is handled by that portal's existing guard (`/login` or `/buyer/login?redirect=`) | —                                                                                                          | —                                                                                                        |
| Unauthorized           | n/a — the destination decides                                                                                                                 | —                                                                                                          | —                                                                                                        |
| Offline                | n/a — navigation only                                                                                                                         | —                                                                                                          | —                                                                                                        |
| Too-much-data          | n/a                                                                                                                                           | —                                                                                                          | —                                                                                                        |
| Stale                  | presence cookie cleared/set in another tab after mount                                                                                        | the label may be one state behind until the next mount; the destination's guard still does the right thing | none needed                                                                                              |
| Concurrent edit        | n/a                                                                                                                                           | —                                                                                                          | —                                                                                                        |
| Success / confirmation | n/a — navigation is the confirmation                                                                                                          | —                                                                                                          | —                                                                                                        |

## Interaction & validation

- No forms are added. The `redirect` query parameter on `/login` is validated silently (R5): an unsafe or non-operator value is replaced by `/dashboard`; no message is shown (the user never typed it).
- The `/login` form's existing behavior (zod validation, throttle countdown, error box, Google sign-in) is unchanged.
- Menu item: selecting it (click, Enter, Space) performs a full navigation to the target. The Radix menu closes on select as it does for the other items.
- Double-submit: n/a.

## UI copy

| Element                                                           | Copy                                                                      | Notes                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Dashboard menu item — switch variant (`menu.switchToBuyerPortal`) | en: `Switch to buyer portal` · es: `Cambiar al portal de compradores`     | added to both locales in `apps/web/lib/i18n/messages.ts` (the `Messages` type forces `es`) |
| Dashboard menu item — sign-in variant (`menu.buyerPortalSignIn`)  | en: `Buyer portal sign-in` · es: `Acceder al portal de compradores`       |                                                                                            |
| Buyer sidebar row — switch variant                                | `Switch to seller dashboard`                                              | English only, like the sidebar's other strings ("Sign Out", "Your Sellers")                |
| Buyer sidebar row — sign-in variant                               | `Seller dashboard sign-in`                                                |                                                                                            |
| `/login` notice                                                   | `You're signed in to the buyer portal.` + link `Go to buyer portal`       | `role="status"`; link → `/buyer/portal`                                                    |
| `/login` footer                                                   | `Buying from a seller?` + link `Sign in to the buyer portal`              | link → `/buyer/login`                                                                      |
| `/buyer/login` notice                                             | `You're signed in to a seller dashboard.` + link `Go to seller dashboard` | `role="status"`; link → `/dashboard`                                                       |
| `/buyer/login` and `/buyer/register` footer                       | `Selling on RouteFlow?` + link `Sign in to the seller dashboard`          | link → `/login`                                                                            |

The apostrophe in "You're" is rendered with `&apos;` in JSX (react/no-unescaped-entities is part of `next lint`).

## Responsive behavior

| Breakpoint                                      | Layout change                                                                                                                          | What's hidden / collapsed / reflowed    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Below `sm` (640 px, stock Tailwind) — dashboard | the avatar trigger keeps rendering; only the username and chevron inside it are hidden (existing)                                      | the menu and the new item are unchanged |
| Any width — buyer portal                        | the sidebar is a fixed 256 px column at every width (existing); the footer stays pinned                                                | nothing new hides                       |
| Phones by user agent                            | never reach these surfaces on the web app: the middleware rewrites mobile user agents to the mobile-web build before any of this logic | —                                       |

## Accessibility

- **Focus order:** dashboard menu — unchanged Radix roving focus; the new item sits between Drive mode (or Profile) and the Language section. Buyer sidebar — Tab reaches the switch link before "Sign Out". Sign-in pages — the notice's link precedes the form fields in DOM order.
- **Labels:** every switch affordance is an `<a href>` whose accessible name is its visible text (icon is `aria-hidden="true"`). Inside the Radix menu the anchor carries `role="menuitem"` from `asChild`; its name is still the visible text.
- **Announcements:** the sign-in notices are `role="status"` (polite) because they appear after mount; nothing else updates without navigation.
- **Contrast / target size:** inherit the sibling rows' classes exactly (dashboard: `px-3 py-2 text-sm text-navy`; sidebar: `px-3 py-2 text-sm text-buyer-300/70`), so no new color pairs are introduced. Notice text is `text-navy` on `bg-surface-raised`, the dashboard's own body-on-raised pair.
- **Keyboard path:** dashboard — open menu with Enter/Space on "Open user menu", Arrow keys to the item, Enter navigates. Sidebar — Tab, Enter. Sign-in — Tab to the notice link, Enter.
- **Reduced motion:** no new motion.

## Motion

| Element / transition | What animates                                                           | Duration | Easing   | Reduced-motion behavior |
| -------------------- | ----------------------------------------------------------------------- | -------- | -------- | ----------------------- |
| none added           | the dashboard menu keeps its existing `animate-in fade-in-0 zoom-in-95` | existing | existing | existing                |

## Design-system compliance

| Token / component                                                                                                                                                | Used for              | Source file                                                                                                                              | New?                                                                  | Justification if new                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@radix-ui/react-dropdown-menu` `DropdownMenu.Item` (+ `asChild`)                                                                                                | dashboard menu item   | `apps/web/app/(dashboard)/layout.tsx:50, 912–918`                                                                                        | no                                                                    | —                                                                              |
| item classes `flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-navy outline-none hover:bg-surface-raised`                                           | dashboard menu item   | `apps/web/app/(dashboard)/layout.tsx:913`                                                                                                | no                                                                    | copied verbatim from the Profile item                                          |
| lucide `ShoppingCart`, `LayoutDashboard` at `h-4 w-4`                                                                                                            | item icons            | design-system.md "Icons"; both already imported in the respective layouts                                                                | no                                                                    | —                                                                              |
| sidebar row classes `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-buyer-300/70 transition-colors` + `hover:bg-white/10 hover:text-buyer-100` | buyer sidebar row     | `apps/web/app/buyer/portal/layout.tsx:439` (Sign Out) and `:356` (`hover:bg-white/10`)                                                   | no                                                                    | non-destructive hover instead of Sign Out's red                                |
| notice box `rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy`                                                               | sign-in notices       | shape from the error box `apps/web/app/(auth)/login/page.tsx:361`; tokens `surface-border`/`surface-raised`/`navy` from design-system.md | no                                                                    | neutral status, not an error                                                   |
| link classes `text-[#0B6E6B] hover:underline font-medium` (operator page) / `text-buyer-600 hover:underline` (buyer page)                                        | notice + footer links | `apps/web/app/(auth)/login/page.tsx:463`, `apps/web/app/buyer/login/page.tsx:260`                                                        | no                                                                    | page-local link styles, reused                                                 |
| `role="status"`                                                                                                                                                  | notice announcement   | —                                                                                                                                        | **yes** (design-system.md notes no live-region convention exists yet) | standard ARIA for a polite, non-modal status message; no visual token involved |

## Playwright verification flows

Environment for these flows: `next dev` on `http://localhost:3002` from the worktree with **no API of its own** (requests to `localhost:3000` belong to another stack and may fail — that is baseline noise, not a finding). All flows are cookie-driven and never submit the sign-in form. Seed cookies with `context.addCookies([{ name, value, domain: "localhost", path: "/" }])`. Use a **desktop user agent only** — a mobile UA is rewritten by the middleware to the external mobile-web build. Never write scratch specs inside the repo; use a temp config and `--reporter=list`.

1. Given `rf-buyer-auth=1` only, when the browser requests `/dashboard` with redirects disabled, then the response is `307` with `location` ending `/login?redirect=%2Fdashboard`; when the page then navigates to `/dashboard`, it lands on `/login?redirect=%2Fdashboard` and shows the status notice "You're signed in to the buyer portal." with a link "Go to buyer portal" whose `href` is `/buyer/portal`. Screenshot. — proves R1, R9; state: presence.
2. Given `rf-buyer-auth=1` only, requesting `/orders/abc?tab=1` (redirects disabled) yields `307` → `/login?redirect=%2Forders%2Fabc%3Ftab%3D1`. — proves R1, R14.
3. Given `rf-op-auth=1` and `rf-buyer-auth=1`, requesting `/` yields `307` → `/dashboard`; adding `rf-last-portal=buyer` yields `307` → `/buyer/portal`; changing it to `rf-last-portal=op` yields `/dashboard`. — proves R2, R13.
4. Given `rf-op-auth=1` only and `rf-last-portal=buyer`, requesting `/` yields `307` → `/dashboard`. — proves R2.
5. Given no cookies, `/login` shows no `role="status"` element; its footer shows the link "Sign in to the buyer portal" (`href` `/buyer/login`) and no text "retailer portal". `/buyer/login` shows the link "Sign in to the seller dashboard" (`href` `/login`) and no text "Staff Portal". Screenshot both. Run the a11y check on both. — proves R9, R10, R12; state: default.
6. Given `rf-op-auth=1` only, `/buyer/login` shows the status notice "You're signed in to a seller dashboard." with link "Go to seller dashboard" (`href` `/dashboard`). Screenshot. — proves R10; state: presence.
7. Given `rf-op-auth=1` (with or without `rf-buyer-auth=1`), requesting `/dashboard` with redirects disabled is **not** a `307` (the middleware passes it through; a later client-side bounce to `/login` because there is no token is expected and not a finding). — proves R3.
8. Given `rf-buyer-auth=1` only, requesting `/login` and `/buyer/portal` with redirects disabled is not a `307` from the middleware. — proves R3.
9. Console check on every page visited above: zero hydration warnings/errors (`Hydration failed`, `did not match`); failed requests to `localhost:3000` are baseline noise.

The dashboard menu item and the buyer sidebar row cannot be reached in this environment (they need an authenticated session against an API). They are proven by the RTL tests on the shared `PortalSwitchLink` component and by review of the two call sites; their post-deploy proof is the Playwright additions in `02-operator.spec.ts` and `04-buyer-portal.spec.ts` (test-plan T27, T28).
