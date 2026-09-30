# Discovery — why a portal switcher between the buyer portal and the seller dashboard

**Status:** `IMPLEMENTED` (DRAFT | APPROVED | IMPLEMENTED | CLOSED)
**Stage:** S1 — Discovery (why) · **Author:** Fable 5.1 · **Date:** 2026-09-04
**Lives at:** `.claude/pipeline/2026-09-04-portal-switcher/discovery.md`
**Next:** [spec.md](./spec.md)

> This file is the only context downstream agents receive about _why_ this work exists.
> Every fact they need is written here in full.

---

## 1. The problem, in the requester's own words (G1·Q1)

> "when we log into routeflow.info, if the user has already logged in as a buyer, they are
> automatically get directed to the buyer portal. if they are also a tenant, it's not taking
> them to the tenant dashboard. How can we tackle that, and let them go to any portal they
> want to go if they are both a tenant and a buyer? what if we do tenant.routeflow.info and
> buyer.routeflow.info? would that be better? or in the general login, as routeflow.info,
> they can switch? what is the nice, less complicated, and the standard approach?"

**Restated in our words:** The web app hosts two portals — the **buyer portal** (`/buyer/*`,
identity = platform-wide `BuyerAccount`) and the **seller dashboard** (`/dashboard` and the
other operator paths, identity = tenant-scoped `User`). They are separate identities with
separate sessions that already coexist in one browser (presence cookies `rf-buyer-auth` /
`rf-op-auth`, separate localStorage token namespaces). A person who holds both identities and
signed in as a buyer first is **trapped in the buyer portal**: the landing page sends them to
`/buyer/portal`, any operator URL bounces them back to `/buyer/portal` (middleware guard), and
no screen offers a way to the seller dashboard or its sign-in. The owner wants dual-role users
to reach whichever portal they choose, in the simplest standard way, and asked whether
per-portal subdomains would be better than switching inside `routeflow.info`.

**Source:** repo owner (Najath Akram), 2026-09-04, Claude Code session. The owner then
approved the recommendation in §8 ("go ahead and do it").

## 2. Who has this problem (G1·Q1)

| Role                                                                                  | How often they hit it                                                                              | What it costs them today                                                                                                                                    | How we know                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dual-role person: a retailer/buyer who also runs a wholesale tenant (or staff at one) | every visit to `routeflow.info` while their buyer session is live (30-day sliding presence cookie) | cannot reach the seller dashboard from the site at all; must know to type `/login` by hand, or sign out of the buyer portal, or use another browser profile | owner report; `apps/web/middleware.ts:66-86` (landing redirect) and `:88-122` (buyer-only guard → `/buyer/portal`); no link to `/login` or `/dashboard` anywhere in `apps/web/app/buyer/portal/layout.tsx`; comment in `apps/web/lib/buyer-api-client.ts:90-94` ("the same Google account can be both") |
| Pure buyer who follows a stale operator link                                          | rare                                                                                               | silently bounced to their portal (arguably fine today)                                                                                                      | code reading of the same guard                                                                                                                                                                                                                                                                          |
| Support / owner                                                                       | whenever a dual-role user reports "I can't get to my dashboard"                                    | a manual explanation of the `/login` workaround                                                                                                             | owner raised it                                                                                                                                                                                                                                                                                         |

## 3. What they do instead today (G1·Q2)

- **Current workaround:** type `https://www.routeflow.info/login` directly (the guard does not cover `/login`), sign in as an operator, after which the operator cookie wins and both sessions coexist. Or sign out of the buyer portal. Or use a second browser profile.
- **Why it fails:** undiscoverable — nothing on any screen says it exists; signing out of the buyer portal destroys a session they still need; a second profile duplicates everything.
- **Cost of the workaround:** a support conversation per affected person; users assume the product is broken.

## 4. Why now (G1·Q3)

The owner hit it personally and asked for the standard approach. Dual-role accounts exist by design (the buyer portal is multi-seller and platform-wide; operators are tenant-scoped), so the trap is structural, not a one-off.

**Deadline / external date:** none.

## 5. If we ship nothing (G1·Q4)

Every dual-role user stays locked into whichever portal they used first, per browser, until they discover `/login` by accident. The cost is bounded (a workaround exists) but the experience reads as a bug on the product's front door, and it grows with every tenant that is also someone else's customer.

## 6. Success signal — one, observable (G1·Q5)

| Signal                                                                                                                                                                                                            | Today's baseline                                                                                          | Target    | Where it is measured                                                                                                                       | When we check                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| A browser holding only a buyer session that requests `/dashboard` is sent to the operator sign-in with the destination preserved (`307 → /login?redirect=%2Fdashboard`), and each portal shows a way to the other | today: `307 → /buyer/portal` (`apps/web/middleware.ts:113-121`); zero switch affordances in either portal | as stated | Playwright `apps/web/e2e/05-cross-cutting.spec.ts` (raw-request middleware contract, run post-deploy) and the Jest/RTL suite in `apps/web` | on merge (CI) and after deploy (E2E fires off the deploy signal) |

## 7. Everyone else affected that nobody asked (G1·Q6)

| Party                                       | How this touches them                                                                                                                                                            | What they need from us                                   | Consulted?                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| Pure buyers deep-linking to an operator URL | instead of a silent bounce to `/buyer/portal` they now land on the operator sign-in page, which must offer "go to your buyer portal" prominently when a buyer session is present | the presence-aware notice on `/login`                    | no — behavior change recorded in spec |
| Existing E2E suite                          | `05-cross-cutting.spec.ts` CC-11…CC-15 pin the landing redirect; CC-13 ("operator wins when both cookies") must stay true when no last-portal preference exists                  | default stays operator                                   | n/a (code)                            |
| Mobile web users                            | phones are rewritten to the mobile-web build _before_ any of this logic (`middleware.ts:44-55`); the mobile build does its own role routing and is out of scope                  | a follow-up ticket if the mobile build has the same trap | no                                    |
| Support                                     | new copy and one new behavior to explain                                                                                                                                         | this document                                            | no                                    |

## 8. Root-cause check — is this a symptom? (G1·Q7, G1·Q8)

- **Symptom or cause:** cause. Two independent sessions plus a routing rule that silently prefers one and a UI with no door between the portals.
- **If a symptom, the root cause is:** n/a.
- **Would fixing the root cause delete this request entirely?** The request _is_ the root cause fix.
- **Are we solving the problem, or building the solution the requester already picked?** The requester offered two candidates. Evaluated:
  - **Per-portal subdomains (`tenant.` / `buyer.routeflow.info`) — rejected.** The subdomain namespace already carries tenant slugs (`acme.routeflow.info` → tenant `acme`, `apps/web/lib/tenant-host.ts`, `middleware.ts:158-194`); `buyer` / `tenant` would have to become reserved slugs. Sessions are already isolated by cookie name on one origin, so a second origin adds cookie scoping, OAuth redirect-URI churn and host routing while adding no discoverability. Dual-role users would bounce between origins with two logins instead of switching in place.
  - **Unifying the two identities server-side (one account, two roles, SSO between portals) — rejected for now.** Large (two identity tables, two token pairs, two auth modules); not needed to solve the trap.
  - **Chosen: one login domain, URL intent wins, an in-app switcher in each portal, a last-used-portal preference for the landing page.** This is the pattern most SaaS with a customer side and an operator side use (Shopify, Stripe, Etsy's shop-manager toggle): one login, role-aware landing, a switch affordance.
- **Prior art (G3·Q3):** the buyer portal's own "Your Sellers" switcher (`apps/web/app/buyer/portal/layout.tsx:351-401`) switches between tenants _within_ the buyer identity — same affordance shape, different axis. The buyer portal's auth guard already round-trips through `/buyer/login?redirect=<path>` (`layout.tsx:155-160`); the operator side gets the mirror of that.

## 9. Riskiest assumption and the cheapest way to kill it (G3·Q1, G3·Q6)

| #   | Assumption                                                                                                        | If it is wrong, what breaks                                                | Cheapest thing that would kill it                                                                                                           | Cost  | Result                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| A1  | The presence cookies are readable by client-side JavaScript, so a menu can be presence-aware without an API call  | the switcher cannot know which session exists; falls back to a static link | read `apps/web/lib/presence-cookies.ts:26-29` — set via `document.cookie`, no `httpOnly`                                                    | 1 min | **held** — confirmed 2026-09-04                                     |
| A2  | Nothing else depends on the guard's current `/buyer/portal` target                                                | a hidden consumer breaks when the target changes                           | grep `rf-buyer-auth` in `apps/web/e2e/` — only CC-12/CC-13 landing tests, none on operator paths; grep app code for the guard target — none | 2 min | **held** — confirmed 2026-09-04                                     |
| A3  | Next.js 14 (this repo's version) requires a `Suspense` boundary around a client component using `useSearchParams` | `next build` fails on `/login`                                             | repo precedent: `apps/web/app/buyer/login/page.tsx:271-279` wraps `BuyerLoginInner` in `React.Suspense` for exactly this reason             | 1 min | **held** — pattern confirmed                                        |
| A4  | Dual-role accounts exist among real users, not only the owner's                                                   | the feature is still correct but low-value                                 | cannot be checked without a cross-table join of production emails (not done — client data policy)                                           | —     | **pending; accepted** — the owner is one such user and asked for it |

## 10. Non-goals — the scope fence (G2·Q5)

- No per-portal subdomains (`buyer.` / `tenant.`), no change to tenant-subdomain resolution — rejected in §8.
- No identity unification, account linking, or SSO between `BuyerAccount` and `User` — separate follow-up if ever wanted.
- No change to the mobile app or the mobile-web build; phones never reach this logic.
- No change to signed-out behavior on operator paths (still the client-side `AuthGuard` → `/login`); the middleware guard keeps firing only for buyer-only sessions.
- No auto-redirect of an already-authenticated operator away from `/login` (the operator login page has none today; adding one risks a redirect loop with the guard — see spec §10).
- No edits to the contents of the operator path prefix list (it moves into a shared module; the list itself is unchanged).
- No logout changes.
- No platform-admin changes.
- No new dependencies, no new test runner, no second HTTP client.

## 11. Open questions for the requester

| #   | Question                                                                                         | What decision it unblocks | Blocking S2? | Answer / assumption made                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | When both sessions exist and the user has never used the switcher, which portal should `/` open? | the landing default       | no           | **assumed: seller dashboard** (today's rule; keeps E2E CC-13 true). A last-used-portal cookie overrides it once either portal has been used.                                                                                                                                                                                            |
| Q2  | Show the switch affordance always, or only when the _other_ session exists in this browser?      | menu design               | no           | **assumed: always**, with a presence-aware label ("Switch to …" when the other session exists, "… sign-in" when it does not). The whole problem was an undiscoverable door; one quiet menu line is cheap.                                                                                                                               |
| Q3  | Names for the two sides in UI copy?                                                              | copy                      | no           | **assumed:** buyer-facing copy says **"seller dashboard"** (the buyer portal already calls tenants "Sellers"); operator-facing copy says **"buyer portal"** (the page title is "RouteFlow Buyer Portal"). The existing footer links on the two login pages, which say "retailer portal" and "Staff Portal", are aligned to these names. |

## 12. Assumptions (unverified) — MANDATORY

| #   | Claim, as this file states it (and its §)                                           | Basis                                                                            | What would confirm it                                           | What breaks if it is wrong                                  | Status                   |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| A4  | §2/§4: dual-role users exist beyond the owner                                       | owner said it; code comment `apps/web/lib/buyer-api-client.ts:90-94`             | a production count (not permitted under the client-data policy) | value, not correctness                                      | unverified, accepted     |
| A5  | §7: the mobile-web build has its own role routing and is unaffected                 | `apps/web/middleware.ts:57-63` comment ("which does its own role-based routing") | reading `apps/mobile` routing — out of scope                    | a mobile follow-up is needed; nothing in this change breaks | unverified, out of scope |
| A6  | §11 Q2: an always-visible switch line does not confuse pure buyers / pure operators | judgment                                                                         | owner feedback after ship                                       | one menu line is removed or made presence-only              | unverified, accepted     |

---

## STOP GATE — S1 → S2

- [x] Problem stated in the requester's own words **and** restated in ours
- [x] User named: role + frequency + cost today
- [x] Current workaround named, and why it fails
- [x] One observable success signal **with today's baseline**
- [x] "If we ship nothing" answered honestly
- [x] Root-cause check done — we are not building a solution to a symptom by reflex
- [x] Riskiest assumption named, with a check that costs less than the build
- [x] Non-goals written down
- [x] Every blocking open question answered, or the assumption recorded
- [x] Assumptions block filled

## Stage log — did the gate fire?

| Stop condition                                 | Evaluated? | What it answered                                                     | Evidence   | Verdict |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------- | ---------- | ------- |
| Shipping nothing is materially bad             | yes        | dual-role users locked out of one portal per browser; front-door bug | §5         | pass    |
| The ask is a cause, not a symptom              | yes        | cause — structural gap between two sessions                          | §8         | pass    |
| User, workaround and success signal all stated | yes        | dual-role person; type `/login` by hand; guard target + affordances  | §2, §3, §6 | pass    |
| Every blocking open question answered          | yes        | none blocking; Q1–Q3 assumed and recorded                            | §11        | pass    |

- **Gate outcome:** PASS — S2 may start
- **Assumptions carried into S2:** A4, A5, A6

**Approved by:** repo owner (verbal "go ahead and do it") · **on:** 2026-09-04
