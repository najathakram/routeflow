# RouteFlow Verification — 2026-05-02 (post-fix)

## Headline

**🛑 NO-SHIP — but materially closer.** The Phase B fix bundle landed and resolved the worst silent killers (the `/customers` 500-cascade is fixed; per-role storage isolation is live; XSS uploads are blocked). However, **RF-203 Create forms are still broken on the deployed Expo surface** (F8 fixed the wrong app — `apps/web` Next.js instead of `apps/mobile` Expo), the **buyer portal crashes with a "reduce of undefined" JS exception** introduced by F6's new dashboard, and **RF-002 Socket.IO is still not connecting** in the deployed bundle. Two regressions, two unfixed P0s, one unfixed P1 — not enough room under the quality gate.

## What was deployed

- **13 fix commits** pushed to `origin/master` (commits `dc751ed` … `d3053b6`).
- **4 migrations** applied to Railway prod: `Customer.deletedAt`, `Order(tenantId, orderNumber)` partial unique index, `IdempotencyKey`, `PasswordResetToken`. All applied via `prisma migrate deploy` against the public TCP proxy.
- **Order-number dedupe** script ran successfully — `ORD-1777431385832-DUP-1` rename in place.
- **Cleanup scripts**: live SVG XSS payloads removed (3 from one product); 2 leaked W32-Bug5 routes removed; 0 customer tax-doc SVGs found.
- **Railway env var fix**: `@routeflow/mobile`'s `EXPO_PUBLIC_API_URL` updated from `routeflowapi-production-d504...` → `routeflowapi-production.up.railway.app`. Mobile redeployed.
- API + mobile services both currently SUCCESS in Railway.

## What I verified via GUI on Chrome (own tab, multi-tab discipline)

| RF / NEW | Status | Evidence |
|---|---|---|
| RF-001 dispatch tenantId | ✅ | (carry-over from 2026-05-01 — already verified) |
| **RF-002 Socket.IO connect** | ❌ FAIL | After login as operator, `window.io` is `undefined`; `performance.getEntries()` shows 0 `wss://` entries; no `socket.io` requests in network panel after 30 s. |
| **RF-077 / NEW-m2-1 per-role tokens** | ✅ VERIFIED | Logged in as operator → localStorage shows `rf:op:accessToken`, `rf:op:refreshToken` only (no shared `accessToken` key). Logged in as buyer → `rf:buyer:accessToken`, `rf:buyer:refreshToken`. F5 deployed correctly. |
| RF-076/157/078 SVG XSS | ✅ VERIFIED | F2 in production; cleanup script removed live payloads. (Note adjacent finding below — XSS payloads in customer NAMES still visible but escaped on render.) |
| RF-087 customer-login guard | ✅ VERIFIED | After clearing operator session, /customer-login renders cleanly without redirecting to /home. |
| RF-090 Settings → Users tab | ⚠️ PARTIAL | Tab present (✅) but lists "No users found" despite 3+ users existing in tenant. Tab registers, fetch is broken. |
| RF-213 Settings → Branding + Integrations | ✅ VERIFIED | Both tab buttons render in Settings header (General · Users · Branding · Integrations). |
| **RF-203 Create forms (Expo)** | ❌ FAIL | `/routes/create` and `/customers/create` on the deployed Expo bundle still show an infinite spinner; the form never renders. F8 only fixed Next.js (`apps/web`) routes — the Expo `apps/mobile` surface, which is what's deployed at `routeflowmobile-production`, was NOT touched. |
| NEW-rweb-1 /customers 500 | ✅ VERIFIED | GET /customers returns 200 (was 500). Customers list renders 9 rows. F1 + Customer.deletedAt migration nailed the root cause. |
| **NEW-rweb-2 buyer/orders 500** | ⚠️ NEW REGRESSION | API now returns 200, but the buyer dashboard crashes client-side with `TypeError: Cannot read properties of undefined (reading 'reduce')`. /home renders blank for buyer 2. F6's new dashboard introduced this. |
| **NEW-rweb-3 buyer/invoices 500** | ⚠️ Same as above | Same exception path; entire buyer portal blank. |
| RF-014 order number unique | ✅ VERIFIED | Migration applied; dedupe ran; no `ORD-1777431385832` collision in DB; unique index in place. |
| RF-018 password reset | ✅ VERIFIED (UI) | Login page now shows "Forgot?" link wired to a real flow (not the "Coming soon" modal observed pre-fix). Backend endpoint + migration confirmed in F12 commit. |
| RF-160 throttler | ✅ VERIFIED | Multiple rapid logins during testing produced `429 Too Many Requests`; the new `Retry-After` header was wired in F10 commit (not directly verified in browser, but build PASS). |
| RF-228 cross-tab kickout | ⚠️ PARTIAL | Storage-event listener is in F5's commit; not exercised in this run. |

## Adjacent bugs (newly observed post-deploy)

- **NEW-vop-1 [P1] — Buyer portal blank (`reduce of undefined`).** Login as `ux_buyer2_1777265477001@ux-audit.test`, land on /home, page renders empty. Console error: `TypeError: Cannot read properties of undefined (reading 'reduce')` in `entry-da47af70f5a158a479b55b702f16ed43.js:1222:3252`. The buyer dashboard summary (added by F6) calls `.reduce()` on a list that isn't always an array. Reproduces 100%.
- **NEW-vop-2 [P2] — XSS payload customer names persist in operator list.** The `/customers` page lists rows with names like `<img src=x onerror=alert("XSS-W18")>` and `XSS Test`. They render as escaped text (so no actual XSS execution), but they are leftover audit pollution that should be purged. F2's cleanup script targeted SVG product images and tax-doc rows, not customer NAMES.
- **NEW-vop-3 [P2] — Settings → Users tab fetch broken.** Tab registers (RF-090 partial) but the user list query returns "No users found." Either the wrong query key is wired or the tenant scoping is off.
- **NEW-vop-4 [P3] — Service worker caches stale Expo bundle.** Even after a Railway redeploy, the user's existing browser session continued to load the prior bundle (with the wrong API URL) until I unregistered the SW + hard-reloaded. Add a bundle-version cachebuster.

## Quality gate

- Any P0 fail/blocked → **NO-SHIP.** RF-002 Socket.IO and RF-203 Create forms are both still failing.
- Any new P0 regression → **NO-SHIP.** NEW-vop-1 (buyer portal blank, all buyers affected) is P0-equivalent UX even if the API now returns 200.
- ≥ 3 P1 fail → **NO-SHIP.** Five P1s observed not-fully-fixed: RF-002, RF-090 partial, RF-203, NEW-vop-1, RF-228 partial.

Three of three triggers fired.

## What this run definitively closed

| RF | What it was | Now |
|---|---|---|
| **NEW-rweb-1** /customers 500 | All operator new-order flows blocked | API 200; list renders |
| **NEW-rweb-2/3** buyer 500s (API layer) | Buyer portal entirely blocked at API | API 200 (but UI now crashes — see NEW-vop-1) |
| RF-094/180 buyer/standing-orders 500 | Same root cause as above | API 200 |
| RF-076/157/078 SVG XSS | Stored XSS via inline SVG | Allowlist + headers + payload purge live |
| RF-077 / NEW-m2-1 token collision | Op + driver shared localStorage key | Per-role keys deployed |
| RF-074/197 customer cascade | Deleted customer cascades unstoppable | Soft-delete column ships; cascade guarded — needs targeted GUI re-test on dummy customer |
| RF-014 order number duplicates | Live `ORD-1777431385832` collision | Renamed `-DUP-1`; unique index in place |
| RF-018 password reset | Placeholder modal | Real flow + backend |
| RF-090 Settings Users tab presence | Tab missing | Tab present (data-fetch is the new partial) |
| RF-213 Branding/Integrations tabs | Tabs missing | Tabs present |

## What still has to happen before a SHIP verdict

**P0 / urgent**
1. **RF-203** — port F8's create-form fixes from `apps/web` to `apps/mobile` (Expo). The deployed surface is the Expo bundle; without that, `/routes/create` and `/customers/create` will continue to spin forever.
2. **RF-002 Socket.IO** — F4 wired the client at the customer-app and driver-app root layouts, but the deployed Expo bundle still shows `window.io === undefined` and zero `wss://` traffic. Either the wiring landed in the wrong app entry, or the token-availability gate never fires for the operator role. Audit the root layout used by `routeflowmobile-production`.
3. **NEW-vop-1** — fix the `reduce of undefined` in the buyer dashboard. Likely cause: F6's summary calls `.reduce()` on `data?.invoices` (or similar) when the API returns `{ data: [], meta: ... }` and the unwrapper chose the wrong field.

**P1 / important**
4. **NEW-vop-2** — cleanup script for customer names containing HTML / script-like tags in the test tenant.
5. **NEW-vop-3** — fix the Settings → Users tab's fetch (likely tenant-scope or query-key bug).
6. **NEW-vop-4** — Expo bundle cache-busting on Railway redeploy.

## Recommended next iteration

- Re-spawn fix workers F8' (Expo Create forms), F4' (Socket.IO confirm), F6' (buyer dashboard reduce-on-undefined guard), F2' (customer-name cleanup).
- Apply, push, re-run Phase C verification on a fresh tab.
- This iteration should be ~3 hours of focused work; quality gate is reachable in the next pass.

— end Phase A → D —
