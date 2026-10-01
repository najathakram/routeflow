# RouteFlow Verification — 2026-05-01

> **Update 2026-05-01 (post-fix-orchestration):** Phase B fixes are STAGED.
> 13 commits in working tree, 4 migrations + 3 cleanup scripts pending manual apply on Railway.
> See [`DEPLOY-HANDOFF.md`](./DEPLOY-HANDOFF.md) for the deploy steps and the migration order.
> Phase C re-verification will run **after deploy completes**.

## Headline

**🛑 NO-SHIP.** Five P0 fixes from the 2026-04-29 audit are still broken or unverifiable on production, two new P0-class regressions surfaced (entire buyer Orders and Invoices APIs return 500), and 17 P1s remain FAIL/PARTIAL. All six verification domains are HOLD or RE-FIX.

## Counts

| Bucket              | n                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| RFs in scope        | 13 P0 + 55 P1 + 19 P2 = 87                                                                                       |
| P0 VERIFIED         | 7                                                                                                                |
| P0 FAIL             | 4 (RF-002, RF-076, RF-157, RF-203)                                                                               |
| P0 BLOCKED          | 2 (RF-074, RF-197 — both blocked by NEW /customers 500)                                                          |
| P1 VERIFIED         | ~12                                                                                                              |
| P1 FAIL             | 13                                                                                                               |
| P1 PARTIAL          | 4                                                                                                                |
| P1 BLOCKED          | 4 (all blocked by /customers 500)                                                                                |
| P1 NOT COVERED      | 7 (RF-004, 005, 006, 009, 016, 018, 019 — race/cron/notification flows not exercisable in pure-GUI verification) |
| P2 VERIFIED         | 1 (RF-219)                                                                                                       |
| P2 FAIL             | 2 (RF-209, RF-222)                                                                                               |
| P2 BLOCKED          | 16 (cascade of P1 infra failures)                                                                                |
| **NEW regressions** | **2 P0, 4 P1, 5 P2**                                                                                             |

Quality-gate triggers fired (any one ⇒ NO-SHIP):

1. ≥1 P0 FAIL/BLOCKED — six instances (RF-002/074/076/157/197/203).
2. ≥3 P1 FAIL — 13 instances.
3. New P0-class regressions — buyer Orders and Invoices 500.

## Critical re-opens (P0/P1)

1. **RF-002 (P0) — Socket.IO still dead.** GUI: `window.io === undefined`; zero `wss://` connections after 30 s on any surface. Two prior "FIXED in Session 3 / Session 5" claims contradict live state. **Fix:** import and initialize the socket-client at the Expo router root layout, connect when `accessToken` is available, join `tenant:{id}:operators` / `tenant:{id}:customer:{userId}` rooms, invalidate React Query cache on relevant events.
2. **RF-076 / RF-157 (P0) — Stored XSS via SVG still live.** Pre-existing payload at `/uploads/products/<id>.svg` served HTTP 200 with `Content-Type: image/svg+xml` and embedded `<script>` body. **Fix:** allowlist JPEG/PNG/WEBP only on image upload endpoints; add `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on every file response; one-shot script to delete the three live payloads in the test tenant.
3. **RF-203 (P0) — All "Create" forms still broken.** `/routes/create` shows a 15-second spinner then redirects to `/home`; form never renders. Same shape on `/customers/create`, `/products/create`, `/invoices/create`. **Fix:** render the form synchronously; load secondary lookup data inside a Suspense boundary so the form is interactive immediately.
4. **RF-074 (P0) and RF-197 (P0) — BLOCKED by /customers 500.** Cascade-delete guards cannot be confirmed because every `/customers/*` request returns HTTP 500 in the test tenant. Whether the audit fix is correct or not, **RF-074/197 cannot be claimed shipped** until /customers is restored and the guards re-tested.
5. **RF-011 (P1) — Order-linked invoice can be duplicated.** `POST /invoices/{order-linked-id}/duplicate` → 201 creates a duplicate. **Fix:** throw `BadRequestException` in `invoices.service.duplicate()` when `invoice.orderId !== null`.
6. **RF-012 (P1) — Invoice total not recalculated on discount/shippingFee patch.** Only triggered when `items` are in payload. **Fix:** trigger recalculation whenever `discount` or `shippingFee` change.
7. **RF-013 (P1) — Cart not cleared on buyer logout.** `signOut()` in buyer-session-store omits `useCartStore.getState().clear()`. **Fix:** add the call after `buyerLogout()`.
8. **RF-014 (P1) — Duplicate order numbers in production data.** `ORD-1777431385832` already shared by two distinct orders in the live ux-audit tenant. **Fix:** add unique index on `(tenantId, orderNumber)`; replace MAX+1 with a Postgres sequence or `SELECT FOR UPDATE`. Backfill: deduplicate the existing collision before adding the constraint.
9. **RF-017 (P1) — No stock check at order creation.** `POST /orders` with stock=0 product → 201. **Fix:** validate `currentStock >= qty` per item inside a pessimistic-lock transaction; return 422.
10. **RF-081 (P1) — IDOR: DRIVER reads any customer's return.** DRIVER token `GET /returns/{id}` → 200 with full return body. **Fix:** restrict `GET /returns/:id` to OPERATOR/TENANT_ADMIN/CUSTOMER and add ownership check for CUSTOMER role.
11. **RF-086/087 (P1) — Buyer auth redirect loops.** Buyer 401 redirects to non-existent `/buyer/login`; `/customer-login` blocked when operator session present. **Fix:** point interceptor to `/customer-login`; on customer-login guard, key off `buyerAccessToken` only.
12. **RF-090 / RF-213 (P1) — Settings Users/Branding/Integrations missing.** Confirmed by V2 + V3. **Fix:** register routes and build the screens.
13. **RF-094 / RF-180 (P1) — `GET /buyer/standing-orders` → 500.** Likely ALS/forTenant scoping issue under buyer context.
14. **RF-172 (P1) — `POST /orders` upserts existing PENDING order.** Returns the same order ID for the same customer. **Fix:** remove the upsert — always insert a new row.
15. **RF-215 / RF-216 / RF-218 (P1) — Buyer cart, /invoices, dashboard routes broken or missing.**
16. **RF-007 / RF-211 / RF-212 / RF-215 (P1 PARTIAL) — Half-fixes.** Tab-freeze improved but no skeleton; /drivers list renders but /drivers/add 404; /returns tabs render but list empty despite API data; cart UI works locally but POST/GET `/buyer/cart` 404.
17. **RF-008 / RF-015 (P1) — Source-confirmed regressions.** Cron handlers still call `forTenant()` with no ALS context; `createRun()` still emits no WebSocket/push to driver. Not GUI-exercisable but visible in code.

## New ship-blockers (regressions found this run)

1. **NEW-rweb-2 / NEW-v3-2 [P0] — `GET /buyer/orders` → 500.** Every buyer's Orders tab spins forever. Affects 100% of buyer traffic.
2. **NEW-rweb-3 / NEW-v3-3 [P0] — `GET /buyer/invoices` → 500.** Every buyer's Invoices tab spins forever.
3. **NEW-v1-2 / NEW-rweb-1 [P1] — `/customers/*` → 500 in test tenant.** Operator "New Order" flow shows "No customers yet"; blocks RF-074/079/080/083/197 verification and likely affects production tenants too.
4. **NEW-v1-1 [P1] — Frontend hits a stale API host (`routeflowapi-production-d504...`).** Customers page receives 401 from the wrong hostname. Suggests the production frontend bundle was built against an outdated `NEXT_PUBLIC_API_URL`.
5. **NEW-rmob-1 [P1] — "No refresh token" toast blocks all driver payment submission on web.** OPTIONS preflight fires; the actual `POST` to complete-with-payment never goes out. localStorage and sessionStorage both empty for driver tab.
6. **NEW-v2-1 [P2] — Vendor-bill receive adds 1 unit regardless of bill quantity.**
7. **NEW-v2-3 / NEW-rweb-4 / NEW-rweb-5 / NEW-rweb-7 [P2/P3] — Login throttler fires after ~3 attempts and blocks 2+ minutes; `/orders/:id` deep-link redirects to /home; bottom-nav intercepts modal clicks at narrow viewports; active run shows yesterday's `scheduledDate` (TZ offset).**

## Net change vs original audit

The original audit listed **221 findings** with **13 P0 + 55 P1**. After this verification pass: **6 P0s remain unresolved (4 FAIL + 2 BLOCKED), 17 P1s remain unresolved**, and we discovered **two new P0-class regressions** plus a stale-API-host bundle issue. Several "FIXED in Session N" status lines in the audit are not borne out by live behavior (most notably RF-002, marked fixed in Sessions 3 and 5, is still completely dead in the deployed bundle). Net signal: the team has fixed real bugs (RF-001, 003, 073, 075, 077, 147, 176, 084, 085, 167, 200, 204, 217, 219), but every shipping-relevant surface — buyer portal, operator create flows, driver payment, real-time, security — has at least one open P0/P1 blocker. The release is materially worse than the audit suggests because the 500s on /customers, /buyer/orders, /buyer/invoices were not on the original list.

## Required next sprint (priority order)

1. **Restore the three 500-ing endpoints** (`/customers/*`, `/buyer/orders`, `/buyer/invoices`) — these are silent ship-killers and they block re-verification of RF-074/079/080/083/197 and the entire buyer portal.
2. **Rebuild and redeploy the frontend bundle** with the correct `NEXT_PUBLIC_API_URL` (NEW-v1-1).
3. **Wire Socket.IO client** at the Expo router root (RF-002). Re-emit the events `routes.service.createRun()` should already be sending (RF-015).
4. **Block SVG uploads** + add `Content-Disposition: attachment` + `nosniff` to all `/uploads/*` responses (RF-076/157). Purge the three known live XSS payloads.
5. **Fix the Create-form rendering loop** (RF-203) — render synchronously, hydrate lookup data with Suspense.
6. **Fix driver-app refresh-token persistence on web** (NEW-rmob-1). Without it, no payment posts on web.
7. **Money-correctness fixes**: RF-011 (no duplicate of order-linked invoice), RF-012 (recalc on discount/shippingFee), RF-014 (DB-level unique on orderNumber), RF-017 (stock check at order create), NEW-v2-1 (vendor receive quantity).
8. **Buyer-portal routing fixes**: RF-086/087 redirects, RF-094/180 standing-orders 500, RF-215 cart endpoints, RF-216 /invoices deep-link, RF-218 dashboard, RF-013 cart-on-logout.
9. **Settings completion**: RF-090, RF-213, RF-225–227 (Users/Branding/Integrations + Notifications test + Business Profile editability + Invoicing prefix/due-days).
10. **IDOR + cron-context fixes**: RF-081 returns IDOR, RF-008 cron ALS context.
11. **Cover the 7 NOT-COVERED P1s** (RF-004, 005, 006, 009, 016, 018, 019) in a dedicated API/integration test pass — they are race / cron / push-notification flows that pure-GUI verification cannot exercise.
12. **Re-run this verification harness** end-to-end after the above lands. Today's run consumed Phase A→D successfully, so the harness can be re-fired against the next deploy with one command.

— end Phase A–D —

---

# Addendum — Phase E (multi-tab GUI gap-fill)

After the original verdict, three additional workers (M1 driver, M2 auth/blocked, M3 polish) were spawned with strict per-agent dedicated Chrome tabs and GUI-only verification, to cover the 7 NOT-COVERED P1s and re-attempt the BLOCKED P0/P1/P2 set. See [supervisors/l1-coverage-delta.md](supervisors/l1-coverage-delta.md) for the full delta.

## Updated counts (after Phase E)

| Bucket                           | Phase A–D | Phase E delta                                                                                                     | After Phase E                                                                           |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P0 VERIFIED                      | 7         | 0                                                                                                                 | 7                                                                                       |
| P0 FAIL                          | 4         | 0                                                                                                                 | 4 (RF-002, 076, 157, 203)                                                               |
| P0 STILL BLOCKED                 | 2         | 0                                                                                                                 | 2 (RF-074, 197 — now blocked by NEW-m2-1 cross-tab collision instead of /customers 500) |
| P1 VERIFIED                      | ~12       | +3 (RF-004, 079, 083)                                                                                             | ~15                                                                                     |
| P1 FAIL/PARTIAL                  | 17        | +2 escalated from NOT COVERED (RF-016, 018) and +1 from PARTIAL (RF-228)                                          | 20                                                                                      |
| P1 STILL BLOCKED                 | 4         | -1 (RF-079 cleared); -1 (RF-083 cleared); +0                                                                      | 2 (RF-074-adj, RF-080)                                                                  |
| P1 NOT COVERED                   | 7         | -3 closed (RF-004, 016, 018), -2 newly NOT COVERED (RF-005, 006, 019 — blocked by test-data state in Phase E too) | 4 still uncovered (RF-005, 006, 009, 019)                                               |
| P2 BLOCKED → resolved            | 16        | -10 (M3 turned 7 BLOCKED into FAIL, 1 into VERIFIED, 1 into PARTIAL; M2 cleared 1)                                | 6 still blocked (mostly buyer-side)                                                     |
| **NEW regressions (cumulative)** | 9         | **+8** (NEW-m1-1/2/3, m2-1/2/3, m3-1/2)                                                                           | **17**                                                                                  |

## New ship-blockers from Phase E (not in original audit)

1. **NEW-m2-1 [P1]** Operator and driver apps share the same `accessToken` localStorage key. Same-browser concurrent tabs (e.g. an operator opening the driver view in another tab) silently overwrite each other's tokens. **This re-opens RF-077** at a deeper layer than the buyer/operator split.
2. **NEW-m1-1 [P1]** React error #185 white-screen crash on any item-checkbox tap on an already-DELIVERED stop. Driver app effectively unusable for re-opening or auditing past deliveries.
3. **RF-016 (P1)** confirmed broken via GUI: completing the last stop does NOT auto-flip the parent run to COMPLETED. Driver must tap "Mark route complete" — exactly the deadlock the audit flagged.
4. **RF-018 (P1)** confirmed broken: "Forgot?" link is a placeholder ("Self-serve reset is coming soon"). Feature is not built.
5. **RF-214 / RF-221 / RF-223 / RF-224 / RF-225 / RF-226 / RF-227 (all P2/P3)** confirmed broken via GUI in M3's run. The earlier "BLOCKED" status hid genuine failures.

## Verdict — unchanged

**🛑 NO-SHIP.** Phase E expanded coverage but tipped the verdict further negative:

- All four P0 FAIL findings hold.
- The two P0 BLOCKED findings remain unverifiable (root cause shifted from a /customers 500 to NEW-m2-1 cross-tab token collision — both unacceptable).
- Three formerly NOT COVERED P1s are now confirmed FAIL or PARTIAL.
- Eight more new regressions surfaced.
- Polish domain went from "BLOCKED — unknown" to "HOLD — confirmed broken in seven specific places" (RF-214/221/223/224/225/226/227).

The four still-uncovered P1s (RF-005, 006, 009, 019) require either fresh dispatched test data or native mobile testing or controlled race-condition tooling — none feasible in pure GUI on the existing seeded ux-audit tenant. Recommendation: re-seed the tenant with one fresh PENDING stop per driver before the next verification pass, and add a native-mobile leg for RF-009.

## Updated next-sprint priorities (delta)

Add the following to the original priority list:

- **A0 (NEW)** Migrate operator and driver localStorage to per-role keys; add a storage-event listener that prompts re-auth on cross-tab token mutation. Closes NEW-m2-1.
- **A1 (NEW)** Fix the React #185 crash on already-delivered stop interaction (likely an effect re-running off a memoized list whose identity changes on every render). Closes NEW-m1-1.
- **A2** Either (a) implement server-side auto-transition of RouteRun → COMPLETED on last-stop DELIVERED, or (b) close RF-016 in the audit by documenting the manual confirmation as the intended UX. Pick one and stick with it.
- **A3** Build self-service password reset (RF-018) — endpoint + email + UI form.
- **A4** Cluster the seven Settings/Finance/Returns gaps (RF-214/221/223/224/225/226/227) into a single "Settings v2" sprint — they are all small, all in the same tree, and all currently invisible to operators.
- **A5** Re-seed `ux-audit-1777265477001` with one fresh PENDING stop per driver before the next verification pass so RF-005/006/019 become exercisable through the GUI.

— end Phase E —
