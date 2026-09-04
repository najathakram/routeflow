# Spec — what the buyer ⇄ seller portal switcher must do

**Status:** `APPROVED` (DRAFT | APPROVED | IMPLEMENTED | CLOSED)
**Stage:** S2 — Spec (what) · **Author:** Fable 5.1 · **Date:** 2026-09-04
**Lives at:** `.claude/pipeline/2026-09-04-portal-switcher/spec.md`
**Prev:** [discovery.md](./discovery.md) · **Next:** [ux-spec.md](./ux-spec.md) then [test-plan.md](./test-plan.md)

> This file is the only context downstream agents receive about _what_ to build. Every
> requirement has an `R#`; nothing unwritten here will be built, tested or reviewed.

**Vocabulary used throughout (fixed — implementers do not invent names):**

- **buyer portal** — `/buyer/*`, identity `BuyerAccount`, presence cookie `rf-buyer-auth=1`, tokens under `rf:buyer:*` in localStorage. In operator-facing copy it is called "buyer portal".
- **seller dashboard** — `/dashboard` and the other operator paths, identity tenant `User`, presence cookie `rf-op-auth=1`, tokens under `rf:op:*`. In buyer-facing copy it is called "seller dashboard" (the buyer portal already calls tenants "Sellers"). Internally the code calls this side "op" / "operator".
- **operator path** — a pathname equal to one of the prefixes in the list currently inlined at `apps/web/middleware.ts:90-109` (`/dashboard`, `/settings`, `/invoices`, `/customers`, `/products`, `/routes`, `/orders`, `/finance`, `/credit-notes`, `/estimates`, `/inventory`, `/suppliers`, `/purchases`, `/vendor-bills`, `/returns`, `/analytics`, `/bookkeeping`, `/drivers`) or starting with one of them followed by `/`. The list's contents do not change in this work.
- **presence** — whether a given presence cookie is present with value `1` in the current browser. Presence is a _hint_ about a live session, not proof of one.
- **last portal** — a new cookie `rf-last-portal` with value `op` or `buyer`, written by whichever portal's authenticated layout last rendered.

---

## 1. Core capability, in one sentence (G2·Q1)

> A person who is both a buyer and a seller on RouteFlow can reach either portal from the other, and the site sends them where they asked to go instead of where a cookie happened to point.

## 2. Core use cases, in priority order (G2·Q2)

| #   | Use case (actor → action → outcome)                                                                                                                                                    | Priority | Justifies shipping |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ |
| U1  | As a dual-role person signed in only as a buyer, I open the seller dashboard (from a link or the switcher) and am taken to the operator sign-in, then straight to the page I asked for | must     | ★                  |
| U2  | As a person signed in to either portal, I see a "switch to the other portal" entry in that portal's account area and it takes me there (or to its sign-in if I have no session there)  | must     |                    |
| U3  | As a dual-role person with both sessions live, opening `routeflow.info` lands me in the portal I used last                                                                             | should   |                    |
| U4  | As a pure buyer who followed a stale operator link, I land on the operator sign-in page and see a one-click way back to my buyer portal                                                | must     |                    |

## 3. Completeness sweep (G2·Q3)

The "object" here is a _navigation preference and a set of doors_, not a stored record.

| Lifecycle step            | What it means for this feature                                                                                                              | Decision | Req IDs    | Note / why                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ------------------------------------------------------- |
| Create                    | the `rf-last-portal` cookie is written when an authenticated portal layout renders                                                          | keep     | R11        | client-side only, no server state                       |
| Read (detail)             | middleware reads presence + last-portal cookies on `/`; menus read presence                                                                 | keep     | R2, R6, R7 |                                                         |
| List / filter / search    | n/a — nothing to list                                                                                                                       | n/a      | —          |                                                         |
| Edit / update             | the cookie is overwritten by whichever portal renders next                                                                                  | keep     | R11        |                                                         |
| Delete / archive          | not cleared on logout: with one session gone, `/` follows the remaining presence cookie anyway                                              | n/a      | —          | R2 makes the value irrelevant once a session is missing |
| Undo / reverse            | using the switcher the other way rewrites the preference                                                                                    | keep     | R11        |                                                         |
| Permissions               | none — every destination enforces its own auth (dashboard `AuthGuard`, buyer portal guard)                                                  | n/a      | R3         | the switcher grants nothing                             |
| Audit trail               | n/a — no server-side write                                                                                                                  | n/a      | —          |                                                         |
| Notification              | n/a                                                                                                                                         | n/a      | —          |                                                         |
| Export / print / share    | n/a                                                                                                                                         | n/a      | —          |                                                         |
| Deep links (added row)    | a deep link into an operator path from a buyer-only browser round-trips through `/login?redirect=` and lands on the deep link after sign-in | keep     | R1, R4     | the ★ case                                              |
| Open redirect (added row) | the `redirect` parameter must never leave the origin or the operator surface                                                                | keep     | R5, R14    |                                                         |

## 4. States, per surface (G2·Q4)

### Surface A: seller dashboard — account menu item "Buyer portal" (web, `apps/web/app/(dashboard)/layout.tsx` avatar dropdown)

| State                                                                                 | Required behavior                                                     | Req ID |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| Default (no buyer presence)                                                           | item reads "Buyer portal sign-in", links to `/buyer/login`            | R6     |
| Buyer presence                                                                        | item reads "Switch to buyer portal", links to `/buyer/portal`         | R6     |
| Empty / Loading / Partial / Error / Offline / Too much data / Stale / Concurrent edit | n/a — a static link; nothing is fetched                               | —      |
| Unauthorized                                                                          | n/a — the destination enforces its own auth                           | R3     |
| Before hydration                                                                      | renders the "sign-in" variant; updates after mount if presence exists | R8     |

### Surface B: buyer portal — sidebar footer item "Seller dashboard" (web, `apps/web/app/buyer/portal/layout.tsx`)

| State                          | Required behavior                                              | Req ID |
| ------------------------------ | -------------------------------------------------------------- | ------ |
| Default (no operator presence) | item reads "Seller dashboard sign-in", links to `/login`       | R7     |
| Operator presence              | item reads "Switch to seller dashboard", links to `/dashboard` | R7     |
| Other states                   | n/a — static link                                              | —      |
| Before hydration               | "sign-in" variant, updates after mount                         | R8     |

### Surface C: operator sign-in page `/login` (`apps/web/app/(auth)/login/page.tsx`)

| State                                                               | Required behavior                                                                                                                  | Req ID |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Default (no buyer presence)                                         | page unchanged except the footer cross-link copy                                                                                   | R9     |
| Buyer presence                                                      | a notice above the form: "You're signed in to the buyer portal." with the link "Go to buyer portal" → `/buyer/portal`              | R9     |
| Arrived with `?redirect=<operator path>`                            | after a successful sign-in the browser goes to that path (query preserved); `forcePasswordChange` still goes to `/change-password` | R4     |
| Arrived with an unsafe or non-operator `redirect`                   | after sign-in the browser goes to `/dashboard`                                                                                     | R5     |
| Error (bad credentials)                                             | unchanged: existing error box                                                                                                      | —      |
| Loading                                                             | unchanged                                                                                                                          | —      |
| Empty / Partial / Offline / Too much data / Stale / Concurrent edit | n/a — unchanged page                                                                                                               | —      |
| Unauthorized                                                        | n/a                                                                                                                                | —      |

### Surface D: buyer sign-in page `/buyer/login` (`apps/web/app/buyer/login/page.tsx`) and `/buyer/register` footer

| State                          | Required behavior                                                                                                        | Req ID |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| Default (no operator presence) | page unchanged except the footer cross-link copy                                                                         | R10    |
| Operator presence              | a notice above the form: "You're signed in to a seller dashboard." with the link "Go to seller dashboard" → `/dashboard` | R10    |
| Other states                   | unchanged                                                                                                                | —      |

### Surface E: middleware routing (not a screen; `apps/web/middleware.ts`)

| Input                                                                        | Required behavior                                                     | Req ID  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------- |
| operator path, buyer presence only                                           | `307` → `/login?redirect=<encodeURIComponent(pathname + search)>`     | R1      |
| operator path, operator presence (± buyer)                                   | pass through (no redirect)                                            | R3      |
| operator path, no presence                                                   | pass through (the client `AuthGuard` handles it, unchanged)           | R3      |
| non-operator path (e.g. `/login`, `/buyer/portal`, `/pricing`), any presence | never touched by the guard                                            | R3      |
| `/`, operator presence only                                                  | `307` → `/dashboard`                                                  | R2, R13 |
| `/`, buyer presence only                                                     | `307` → `/buyer/portal`                                               | R2, R13 |
| `/`, both, `rf-last-portal=buyer`                                            | `307` → `/buyer/portal`                                               | R2      |
| `/`, both, `rf-last-portal=op` or absent or any other value                  | `307` → `/dashboard`                                                  | R2, R13 |
| `/`, no presence                                                             | no redirect (marketing page)                                          | R13     |
| `/`, operator presence only, `rf-last-portal=buyer`                          | `307` → `/dashboard` — a preference never overrides a missing session | R2      |

## 5. Non-functional requirements

| Area                        | Requirement                                                                                                                                                                                                                                                                                         | Budget / rule                                  | Req ID  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| Performance                 | routing decisions are pure string/cookie checks in the middleware; no fetch, no async                                                                                                                                                                                                               | zero added I/O                                 | R1, R2  |
| Security and authorization  | the `redirect` parameter is validated: must start with `/`, must not start with `//` or `/\`, must contain no `..`, `://`, `//` or `\`, and its path must be an operator path; anything else → `/dashboard`. No new endpoints. The switcher grants no access; every destination keeps its own guard | open-redirect blocked; presence is a hint only | R5, R14 |
| Tenancy / ownership scoping | n/a — no data read or written server-side                                                                                                                                                                                                                                                           | —                                              | —       |
| Observability               | the guard's `307` with `location: /login?redirect=…` is visible in the web service's request logs; nothing else to log                                                                                                                                                                              | —                                              | —       |
| Accessibility               | switch items are real links (`<a href>`) with accessible names equal to their visible text, reachable by keyboard inside the Radix menu (Arrow keys/Enter) and by Tab in the sidebar; the sign-in notices are announced politely (`role="status"`) and their link has a descriptive name            | repo baseline (design-system.md)               | R12     |
| Idempotency                 | rendering a layout twice writes the same cookie twice — harmless                                                                                                                                                                                                                                    | —                                              | R11     |
| Data retention / PII        | `rf-last-portal` holds only `op` or `buyer`; the presence cookies are unchanged                                                                                                                                                                                                                     | no PII                                         | —       |
| Hydration safety            | presence-dependent markup renders the "no presence" variant on the server and on first client render, then updates after mount; no hydration mismatch warnings                                                                                                                                      | zero console errors                            | R8      |

## 6. Overlap and scope fence (G2·Q6)

- **Existing feature this overlaps:** the middleware landing redirect and buyer-only guard (`apps/web/middleware.ts:57-122`) → **extend** it: same file, decisions moved into a pure module so they can be unit-tested; the buyer portal's `redirect`-param sanitizer (`apps/web/app/buyer/login/page.tsx:32-41`) → **leave as is** (it is buyer-scoped); the operator side gets its own operator-scoped sanitizer in the shared module.
- **In scope:** middleware guard target and landing preference; pure routing module; presence readers and the last-portal cookie; the two switch affordances; the two sign-in notices; footer cross-link copy on `/login`, `/buyer/login`, `/buyer/register`; unit/RTL tests; Playwright raw-request tests in `apps/web/e2e/05-cross-cutting.spec.ts`.
- **Out of scope:** everything in discovery §10 (subdomains, identity unification, mobile, signed-out guard behavior, operator-login auto-redirect, logout, the prefix list contents, platform-admin, new dependencies).
- **Do-not-introduce check (G4·Q10):** no new dependency; Jest + RTL and Playwright only; Next `Link`, lucide icons and the existing Radix dropdown primitives; no second HTTP client.

## 7. Deploy day (G2·Q7)

- **Existing users on deploy day:** browsers already hold presence cookies; `rf-last-portal` is absent for everyone, so `/` behaves exactly as today (operator wins) until a portal layout renders once. Buyer-only browsers that hit an operator URL now see the operator sign-in page with the "Go to buyer portal" notice instead of being bounced silently.
- **Existing data:** none touched.
- **Backfill:** none.
- **Migration:** none.
- **Gate:** none — ungated feature. (No flag, no plan key.)

## 8. Rollback (G2·Q9)

- **Kill switch:** none; a revert deploy is the rollback.
- **Code rollback:** revert the squash commit — safe; old code ignores the `rf-last-portal` cookie.
- **Data rollback:** nothing persisted server-side.
- **Blast radius (G4·Q1):** worst credible bug is a redirect loop between `/login` and an operator path, or an open redirect via the `redirect` parameter. Both are covered by negative requirements (R3, R5, R14) and unit tests; the operator login page deliberately has no "already signed in → redirect" effect, so the guard can never bounce a page that itself bounces back.
- **Detection:** post-deploy E2E (`05-cross-cutting.spec.ts` CC-11…CC-15 plus the new cases) and the operator login smoke in `post-deploy-check`.

## 9. Requirements table

| ID  | Requirement (observable behavior)                                                                                                                                                                                                                                                           | Priority | Verification method                                        | Test IDs                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | ------------------------- |
| R1  | A request for an operator path from a browser with `rf-buyer-auth=1` and no `rf-op-auth=1` receives a `307` to `/login?redirect=` + `encodeURIComponent(pathname + search)` on the same origin                                                                                              | must     | unit (pure resolver) + e2e raw request                     | T1, T2, T20, T21          |
| R2  | A request for `/` resolves to: op-only → `/dashboard`; buyer-only → `/buyer/portal`; both → `/buyer/portal` iff `rf-last-portal=buyer`, otherwise `/dashboard`; no presence → no redirect; a preference never overrides a missing session                                                   | must     | unit + e2e raw request                                     | T3, T4, T5, T22, T23, T24 |
| R3  | (negative) The guard never redirects: an operator path with `rf-op-auth=1` present; an operator path with no presence cookies; any non-operator path (`/login`, `/buyer/portal`, `/pricing`) whatever the cookies                                                                           | must     | unit + e2e raw request                                     | T6, T7, T25               |
| R4  | After a successful operator sign-in on `/login?redirect=<safe operator path>` the browser navigates to exactly that path (query preserved); with `forcePasswordChange` it navigates to `/change-password` instead                                                                           | must     | RTL (login page)                                           | T10, T11                  |
| R5  | (negative) A `redirect` value that is empty, does not start with `/`, starts with `//` or `/\`, contains `..`, `://`, `//` or `\`, or whose path is not an operator path (e.g. `/buyer/portal`, `/pricing`) results in navigation to `/dashboard`                                           | must     | unit (sanitizer) + RTL                                     | T8, T9, T12               |
| R6  | The seller dashboard's avatar dropdown contains a link that reads "Switch to buyer portal" → `/buyer/portal` when `rf-buyer-auth=1` is present, and "Buyer portal sign-in" → `/buyer/login` otherwise                                                                                       | must     | RTL (shared link component) + review of the menu wiring    | T13, T14                  |
| R7  | The buyer portal sidebar footer, directly above "Sign Out", contains a link that reads "Switch to seller dashboard" → `/dashboard` when `rf-op-auth=1` is present, and "Seller dashboard sign-in" → `/login` otherwise                                                                      | must     | RTL (shared link component) + review of the sidebar wiring | T13, T14                  |
| R8  | Server-side rendering of the switch link and of the sign-in notices does not depend on cookies: SSR output always shows the "no presence" variant; the client updates after mount without hydration errors                                                                                  | must     | unit (renderToString)                                      | T15                       |
| R9  | `/login` shows, only when `rf-buyer-auth=1` is present, a notice "You're signed in to the buyer portal." with a link "Go to buyer portal" → `/buyer/portal`; its footer cross-link reads "Buying from a seller? Sign in to the buyer portal" → `/buyer/login`                               | must     | RTL                                                        | T16, T17                  |
| R10 | `/buyer/login` shows, only when `rf-op-auth=1` is present, a notice "You're signed in to a seller dashboard." with a link "Go to seller dashboard" → `/dashboard`; its footer cross-link (and `/buyer/register`'s) reads "Selling on RouteFlow? Sign in to the seller dashboard" → `/login` | must     | RTL                                                        | T18, T19                  |
| R11 | Once its session is confirmed, the seller dashboard layout writes `rf-last-portal=op` and the buyer portal layout writes `rf-last-portal=buyer` (path `/`, `max-age` 30 days, `samesite=lax`, not httpOnly)                                                                                 | must     | unit (cookie writer) + review of the two layout call sites | T26                       |
| R12 | Every switch affordance is an `<a href>` whose accessible name equals its visible label; notices carry `role="status"`; all are keyboard reachable                                                                                                                                          | must     | RTL (roles/names) + UI verify a11y                         | T13, T16, T18             |
| R13 | The existing landing contract stays true: op-only → `/dashboard`, buyer-only → `/buyer/portal`, both with no preference → `/dashboard`, signed-out → `200` marketing page (E2E CC-11…CC-15 unchanged and green)                                                                             | must     | e2e (existing) + unit                                      | T3, T4, T5                |
| R14 | (negative) The guard's `location` is always a same-origin path beginning `/login?redirect=`; it never echoes a host, scheme or a value other than the request's own path+query                                                                                                              | must     | unit + e2e                                                 | T2, T21                   |

## 10. Assumptions (unverified) — MANDATORY

| #    | Claim                                                                                                                                                                                                                                                                                  | Basis                                                                                                                                  | What would confirm it                                                    | R#s that fall with it | What breaks if wrong                                                  | Status               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------- | -------------------- |
| D-A4 | dual-role users exist beyond the owner                                                                                                                                                                                                                                                 | owner said                                                                                                                             | production count (not permitted)                                         | value only            | nothing breaks                                                        | unverified, accepted |
| D-A5 | phones are rewritten to the mobile-web build before this logic and need no change                                                                                                                                                                                                      | `apps/web/middleware.ts:44-55`                                                                                                         | reading `apps/mobile`                                                    | none                  | a mobile follow-up                                                    | out of scope         |
| D-A6 | an always-visible switch line does not confuse single-role users                                                                                                                                                                                                                       | judgment                                                                                                                               | owner feedback                                                           | R6, R7 (label policy) | make it presence-only                                                 | accepted             |
| A7   | Radix `DropdownMenu.Item asChild` wrapping a Next `Link` keeps the menu's keyboard behavior and closes on select                                                                                                                                                                       | Radix documentation pattern; `@radix-ui/react-dropdown-menu` is already the primitive used at `apps/web/app/(dashboard)/layout.tsx:50` | UI verify with a signed-in operator (needs an API) or reviewer knowledge | R6, R12               | fall back to `onSelect={() => router.push(href)}` with the same label | unverified           |
| A8   | The operator login page can adopt `useSearchParams` inside a `React.Suspense` boundary exactly like `apps/web/app/buyer/login/page.tsx:271-279`, and its existing test `apps/web/app/(auth)/login/page.test.tsx` only needs its `next/navigation` mock extended with `useSearchParams` | repo precedent                                                                                                                         | the red gate + final gate                                                | R4, R5                | tests fail at the gate; fixer extends the mock                        | unverified           |
| A9   | The operator login page has no effect that redirects an already-authenticated user, so `/login?redirect=` can never loop with the guard                                                                                                                                                | grep `isAuthenticated` in `apps/web/app/(auth)/` — no matches (2026-09-04)                                                             | the same grep                                                            | R1, R3                | a loop; must remove the effect                                        | confirmed 2026-09-04 |
| A10  | Presence cookies are readable by client JS (set via `document.cookie` without `httpOnly`, `apps/web/lib/presence-cookies.ts:26-29`)                                                                                                                                                    | code read                                                                                                                              | same                                                                     | R6, R7, R9, R10       | the menus cannot be presence-aware                                    | confirmed 2026-09-04 |

---

## STOP GATE — S2 → S3 / S4

- [x] Core capability is one sentence a customer would recognise
- [x] Exactly one ★ use case
- [x] Completeness sweep has an explicit decision on every row
- [x] Every surface has all states, or an `n/a` with a reason
- [x] NFRs cover performance, authorization, tenancy, observability, accessibility
- [x] Deploy day answered; ungated
- [x] Rollback and blast radius written
- [x] Every requirement has an ID, a priority, and a verification method
- [x] At least one negative requirement (R3, R5, R14)
- [x] Assumptions block filled

## Stage log — did the gate fire?

| Stop condition                                                          | Evaluated?    | What it answered                                                      | Evidence | Verdict |
| ----------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- | -------- | ------- |
| Completeness sweep has a decision on every row                          | yes           | keep/n/a on every row, two rows added (deep links, open redirect)     | §3       | pass    |
| Every surface covers all states or n/a with a reason                    | yes           | static links: n/a with reason; sign-in pages: only the changed states | §4       | pass    |
| Gate key match                                                          | n/a — ungated | —                                                                     | §7       | pass    |
| Rollback, blast radius and detection written                            | yes           | revert; loop/open-redirect covered by R3/R5/R14                       | §8       | pass    |
| Every R# has a priority and a verification method; a negative R# exists | yes           | 14 requirements, 3 negative                                           | §9       | pass    |

- **Gate outcome:** PASS — S3/S4 may start
- **Assumptions carried into S4:** A7, A8

**Approved by:** repo owner ("go ahead and do it") · **on:** 2026-09-04
