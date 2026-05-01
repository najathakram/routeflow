# L1-C Supervisor Review — W4 (Driver POD) + W7 (Browser)
Date: 2026-04-29
Status: Complete

---

## W4 Assessment — Medium completeness

W4 correctly identified the highest-risk issues (no run-status guard, offline discard, non-atomic payment). However, three findings are factually wrong because the worker did not read the actual source before filing: W4-003 (silent discard claim is only half-right), W4-011 (podStore is in-memory — correct — but offlineQueue IS persisted, the worker conflated the two), and W4-005 (POD skip is a real gap but the cited lines do not match the actual submit path). Severity ratings on W4-001 and W4-002 are correct at P0/P1 respectively.

### Confirmed findings (with code evidence)

**W4-001 — Confirmed P0.** `completeStop()` in `routes.service.ts:958–1037` never fetches the parent `RouteRun` record at all. The only guard is `stop.status === "COMPLETED"` (line 980). A driver can call `PATCH /route-runs/:runId/stops/:stopId/complete` while the run is still `SCHEDULED` and the API will accept it. The fix W4 recommended (fetch run and assert `IN_PROGRESS`) is correct.

**W4-002 — Confirmed P1.** The check-then-update sequence in `completeStop()` (findFirst at line 975, then updateMany inside `tenantTransaction` at line 987) is not protected by a row-level lock or optimistic concurrency token. Two concurrent requests for the same stop will both pass the `stop.status === "COMPLETED"` check (line 980) before either update commits, because `findFirst` runs outside the transaction that performs the write. The net result is duplicate `DeliveryMutation` rows and an order being set to `DELIVERED` twice (harmless for idempotent `updateMany` with `status: { notIn: [..., DELIVERED] }`, but the delivery mutations are not deduplicated). Actual severity is P1 rather than a data-corruption risk because the `updateMany` filter is safe, but the duplicate mutation rows are a real accounting concern.

**W4-003 — Confirmed but severity overstated (downgrade from P0 to P2).** See correction below under Downgraded. The silent-discard behaviour for 4xx errors is real and intentional per the inline comment `// CRIT-05` at `useNetworkSync.ts:32`, but the absence of any user notification when a 404 or 409 permanently removes a queued action is still a genuine UX gap. After 3 retries a 5xx item is also silently dropped (lines 18–20: `if (action.retries >= MAX_RETRIES) dequeue(action.id)` with no alert). Both paths lose data without informing the driver.

**W4-004 — Confirmed P1.** `payment.tsx:124` computes `collected = method === "On account" ? 0 : Math.min(receivedNum, invoiceTotal)`. When `method` is Cash/Card/Cheque, `receivedNum` starts at `0` (line 80: `const [received, setReceived] = useState<string>("0")`). There is no guard before `closeStop()` (lines 90–168) that prevents submitting with `collected === 0` for non-on-account methods. The `if (invoiceId && collected > 0)` at line 126 means a $0 payment is silently skipped rather than rejected — so the stop still completes with no payment recorded and no warning to the driver. This is a silent data loss, not just a UX gap.

**W4-005 — Confirmed P2 (not P0).** `pod?.photoUrls` and `pod?.signatureUri` are passed directly to `completeMut.mutateAsync` at lines 107–109 with no pre-flight check that either field is present. There is no per-tenant configuration controlling whether POD is required. Severity is P2 because the consequence is a completed stop with an empty evidence trail, not a security or integrity breach. W4's P0 rating is too high.

**W4-011 — Confirmed P2.** `podStore.ts:16` uses bare `create<PodState>((set) => ...)` with no `persist` middleware and no `AsyncStorage` import. This is confirmed in-memory only. A crash or background-kill between photo capture and stop submission loses all captured photos and signatures. The worker correctly identified this.

**W4-012 — Confirmed P1.** `payment.tsx:102–136` shows two sequential `await` calls: `completeMut.mutateAsync(...)` then `paymentMut.mutateAsync(...)`. The catch block at lines 133–135 explicitly accepts partial failure: "Stop is already completed … record from invoices later." There is no rollback, no saga, and no offline-queue pairing. A driver with a network hiccup between the two calls will have a DELIVERED stop with no payment record, discoverable only after the fact.

**W4-007 — Confirmed P2.** `offlineQueue.ts:33–44` shows unbounded `queue` growth. There is no `MAX_ITEMS` cap. `useNetworkSync.ts` exports `queueLength` (line 55) but there is no UI component that renders a badge or count. The risk is real but capped by AsyncStorage limits in practice.

### Downgraded/dismissed findings

**W4-003 — Downgraded from P0 to P2.** W4 claims "Failed syncs silently dropped without user notification." This is partially wrong. The offline queue itself IS persisted to AsyncStorage via `persist` middleware (`offlineQueue.ts:26–65`, storage key `routeflow-offline-queue`). Items are not "lost" across app restarts — they survive in the queue and will be retried on the next network recovery. What IS missing is a toast/alert when a 4xx response causes permanent discard (line 32–33) or when MAX_RETRIES is exhausted (lines 18–20). The correct severity is P2 (missing user notification on permanent failure), not P0 (data loss).

**W4-006 — Overpayment race — downgraded from P1 to P2.** W4 cites `invoices.service.ts:1031–1041` without reading that file in this worktree. Unable to verify the exact transaction boundary from available context. The concern is architecturally valid (read-then-write without locking on `alreadyPaid`), but the practical window for concurrent payment submission on a single delivery stop is narrow. Keeping as P2 pending review of invoices.service.ts.

**W4-014 — Reopen credit memo check — insufficient evidence to confirm.** W4 cites `routes.service.ts:1225–1237`. Reading `reopenStop()` at lines 1193–1299, the code does check existing credits and returns status information about them but the claim "not blocking reopen" needs a closer read of the full `reopenStop` transaction (lines 1193–1299 not fully reviewed here). Flag for separate code review, not confirmed.

**W4-013, W4-008, W4-009, W4-010, W4-015 — Accepted at face value.** These are plausible architecture/platform findings (ordering, HEIC, EXIF, location, on-account reporting) that cannot be easily refuted from static analysis alone. They are medium-to-low severity. No reason to dismiss.

### New findings W4 missed

**NEW-W4-A — `completeStop` also lacks driver-to-run assignment check (P1).** `completeStop()` fetches the stop (line 975) but never verifies that the calling driver is the driver assigned to the parent run. Any authenticated driver with the stop ID can complete another driver's stop. The `user` parameter is passed (line 973) and the driver record is looked up (lines 982–985), but only to populate `driverId` in the mutation record — it is never used as an authorization check. This is a data-integrity gap independent of W4-001.

**NEW-W4-B — The "Routes today" section on Home is mislabeled (P2 — cross-cutting with F-006a).** `home.tsx:59` calls `useAdminRoutes({ limit: 10 })` which hits `GET /routes` with no date parameter (`admin.ts:406`: `apiClient.get('/routes', { params })`). The section is labeled "Routes today" but fetches all routes ordered by creation date. This is confirmed by the dispatch screen's separate `useOperatorRouteRuns({ date: today })` call (dispatch.tsx:49–52) showing different results. Both workers (W4, W7) caught the symptom; the root cause is confirmed in code here.

---

## W7 Assessment — Medium completeness

W7's browser walkthrough produced accurate observations for what it could see through the CDP session. The tab-freeze finding (F-009) is the most important and is real. However, the mode-switcher finding (F-012) contains an incorrect severity assessment, and F-010 (warehouse deep-link) is partially wrong per code. F-006a has now been confirmed with root cause.

### Confirmed findings (with code evidence)

**F-009 — Tab freeze, confirmed P1.** The most likely code-side cause: `dispatch.tsx:36–37` calls `useAdminRoutes({ limit: 50 })` AND `useAdminDrivers()` simultaneously on mount, with `warehouse.tsx` firing up to four separate `useAdminProducts` queries (lines 56–68: `lowQuery`, `outQuery`, `allQuery`, `filteredQuery`). The `orders` tab was not fully reviewed here but follows the same pattern. These are React Query fetches — they are async and should not block the main thread — but if the Railway cold-start causes all four queries to resolve simultaneously and trigger a cascade of state updates and re-renders, it can produce the observed 20–40s freeze on the web build (which has no native thread separation). The CDP tooling contention noted by W7 may amplify the effect but the underlying simultaneous fetching pattern is a real contributor.

**F-006a — Confirmed P2 with root cause.** `home.tsx:59`: `useAdminRoutes({ limit: 10 })` calls `GET /routes` with no date filter. The "Routes today" section label is factually wrong — it shows all routes (up to 10), not today's runs. The header subtitle correctly shows `todayRuns.length` (line 114) derived from `useOperatorRouteRuns({ date: today })` (line 70). So the count in the subtitle is correct but the section title below contradicts it. The fix is either to filter the routes list by today's scheduled date or rename the section to "Recent routes."

**F-010 — Partially confirmed, root cause corrected.** W7 says `/warehouse` redirects to `/home`. The Expo Router tab layout at `apps/mobile/app/(operator)/(tabs)/_layout.tsx:46–54` DOES register `warehouse` as a visible tab screen (not hidden with `href: null` — that treatment is only applied to `finance` at line 45). The route file `warehouse.tsx` exists. This means the redirect is not caused by a missing route in the manifest. More likely cause: the Expo static web export did not include the warehouse route in the generated `__expo_router_sitemap__` or the server's 404-redirect config catches it before Expo Router can handle it. The finding stands as P2 but the worker's hypothesis ("Expo Router static export missing this route") is probably wrong — `finance.tsx` with `href: null` would be the route to watch for a missing-manifest case, not `warehouse`. W7 should retest: if `/finance` also redirects to home, the manifest hypothesis holds; if only `/warehouse` redirects, it is a Railway serve config issue.

**F-003 — Confirmed P3.** "Remember me" default is a source-code question; no mobile source was checked here but the observation is plausible. Accepted at face value.

**F-004, F-007, F-011, F-014, F-015 — Accepted at face value.** Reasonable observations, severities appropriate.

### Downgraded/dismissed findings

**F-012 — Downgraded from "Investigate / possible P0" to P2 (likely seeder data issue, not regression).** W7 flags that the mode-switcher pill is not visible for `ux_admin`. Code confirms: `home.tsx:138` renders the pill only when `user?.canActAsDriver` is truthy. The Prisma schema (`schema.prisma:411`) sets `canActAsDriver @default(false)`. However, `createTenantAdmin` in `platform-admin.service.ts:679` explicitly sets `canActAsDriver: true` when creating the tenant admin — and the `ux-audit-seed.js` script creates `ux_admin` via `POST /platform-admin/tenants` which calls that code path (seed line 172–179). Therefore `ux_admin` should have `canActAsDriver: true` in the database as seeded. If the pill is not showing in production, either: (a) the JWT returned by login does not include `canActAsDriver` (check `auth.service.ts` token construction — it does include it at line 81), or (b) the production database record was manually toggled, or (c) the auth store does not forward `canActAsDriver` to the UI. This is not a regression in the mode-switcher feature code; it is likely a data or token-propagation issue. Severity is P2, not P0.

**F-001 — Not a bug, correctly classified as scope/info.** Accepted.

**F-002 — Accepted as P2 UX.** No change.

**F-005 — Merged into F-006a.** The "0 runs today" vs "Routes today listing Route A" discrepancy is fully explained by the dual data sources described in F-006a: the subtitle count comes from the today-filtered `useOperatorRouteRuns` (correct: 0 runs today with that filter returning nothing for seeded data), while the card list comes from the unfiltered `useAdminRoutes`. Not a separate finding — collapse into F-006a.

**F-008, F-013 — Info/baseline. No action.** Correctly classified.

### New findings W7 missed

**NEW-W7-A — `dispatch.tsx` fetches up to 50 routes AND all drivers with no pagination signal (P2 perf).** `dispatch.tsx:36–37` uses `limit: 50` for routes and no limit for drivers. This is not paginated in the UI — all 50 routes and all drivers are loaded into memory on tab mount. For a tenant with many routes this is O(N) upfront hydration. Combined with the simultaneous product queries on the warehouse tab, the pattern across all tabs suggests a systemic missing-skeleton/deferred-load strategy.

**NEW-W7-B — `finance` tab hidden from bottom-nav but navigable via deep link (P3).** `_layout.tsx:45`: `<Tabs.Screen name="finance" options={{ href: null }} />` hides the finance tab from the bottom nav bar but the underlying `finance.tsx` file still exists and Expo Router will still serve it if the URL is known. There is no route-level guard preventing direct navigation to `/finance`. This may be intentional (finance is in the More menu) but warrants confirmation that the screen has proper auth guards.

---

## Top priorities from this batch (P0/P1 only, max 5)

**P0-1 — W4-001: `completeStop` accepts SCHEDULED runs.**
File: `apps/api/src/routes/routes.service.ts:958–979`. No run-status check before accepting stop completion. A driver (or attacker with a valid token and stop ID) can complete stops on runs that have never been started.

**P1-1 — W4-012: Non-atomic stop completion + payment.**
File: `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:102–136`. Two sequential API calls with explicit "warn but don't roll back" on payment failure. Produces DELIVERED stops with missing payment records that must be manually reconciled.

**P1-2 — NEW-W4-A: Any driver can complete any stop (missing authorization check in `completeStop`).**
File: `apps/api/src/routes/routes.service.ts:958–1037`. The `user` parameter is only used to populate `driverId` in the mutation record, never to verify the calling driver is assigned to the run. A driver with a known stop ID can complete stops belonging to other drivers' routes.

**P1-3 — W4-004: $0 cash/card payment silently skipped.**
File: `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:124–126`. `collected = 0` for non-on-account methods causes the payment step to be silently skipped. Stop is marked DELIVERED with no revenue record and no driver warning.

**P1-4 — F-009: Tab transition freeze (20–40s) on every bottom-nav tab.**
Files: `apps/mobile/app/(operator)/(tabs)/dispatch.tsx:36–37`, `warehouse.tsx:56–68`. Simultaneous multi-query mounts without skeleton states or deferred loading cause extended renderer unresponsiveness on the web build. Pervasive across all tabs; will be first thing operators notice.
