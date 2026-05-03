# RouteFlow deep audit — 2026-05-02

## Headline

**HOLD.** 2 P0s and a confirmed auth-layer regression cluster block ship.

---

## Counts (after cross-squad dedup, env artifacts excluded)

| Severity | New bugs | Notes |
|---|---|---|
| **P0** | **2** | tax math; buyer invoices 400 on `statuses[]` |
| **P1** | **13** | 3 auth-cluster (token priority + incomplete logout + no storage signal counted as 3 distinct fixes) · 4 silent-failure CTAs · 2 a11y systemic · 4 money/flow |
| **P2** | ~10 | misc UX, edge inputs, print, beforeunload |
| **P3** | ~2 | label leaks, hardcoded copy |

Env artifacts (not real product bugs, downstream of auth-cluster + multi-agent shared incognito) were filtered: 4 in BUYER, 3 in OPS, 2 in DRIVER. Code-only-suspected findings (3 in DRIVER) flagged separately; a manual single-tester run is required to upgrade them to confirmed.

---

## Top 10 ship-blockers

1. **BUG-OPS1-2 (P0, money)** — Invoice tax computed at ~15,000% effective rate ($3,369 tax on $22.46 subtotal on INV-2026-0026). Likely `taxAmount = subtotal * taxRate` instead of `subtotal * (taxRate / 100)`, or the DB stores rate as percent-points but service treats as a multiplier. **Fix:** `apps/api/src/invoices/invoices.service.ts` — audit the tax-calc unit; add a unit test that pins the contract.

2. **BUG-B2-1 (P0, flow-broken)** — `GET /api/v1/buyer/invoices?statuses[]=SENT&statuses[]=OVERDUE` returns 400. Buyer Invoices tab is non-functional for every buyer. **Fix:** add `@IsOptional() @IsArray() statuses?: InvoiceStatus[]` with `@Transform` for query-array parsing in the buyer invoices DTO; add e2e for filtered list.

3. **AUTH-CLUSTER (P1, security)** — three distinct fixes inside the same root cause:
   a. `getStoredUser()` / `getActiveAccessToken()` iterate `[OP_KEYS, DRIVER_KEYS, BUYER_KEYS]` so operator silently wins when multiple role tokens coexist (`apps/mobile/lib/auth.ts:92`, `apps/mobile/lib/api-client.ts:37`). Confirmed by 4 workers across 3 squads.
   b. `logout()` clears OP_KEYS + DRIVER_KEYS but **not** BUYER_KEYS — buyer socket leaks under operator session.
   c. No `storage` event listener anywhere — cross-tab logout invisible; tab B stays authenticated until manual reload.
   **Fix:** rewrite `auth.ts` to (i) clear ALL role buckets on every logout, (ii) emit a `StorageEvent`-driven role change, (iii) define a single-source role-preference router guard with explicit precedence rules and unit tests for every combination.

4. **BUG-DRV2-1 (P1, security)** — Driver `accessToken` not persisted to localStorage on web; page refresh kills the session. `apps/mobile/lib/auth-store.ts` driver slice missing the persist middleware applied to op/buyer slices.

5. **BUG-DRV1-3 (P1, money — code-analysis)** — `completeWithPayment()` sends no idempotency key, and the offline-queue persists body but not headers, so adding a key wouldn't survive replay. Server's RF-019 guard never activates → double-charge possible on flaky-network retry. **Fix:** add `Idempotency-Key` middleware to the mutation client; persist headers in offline queue. **Re-verify live** before declaring fixed — code-analysis only.

6. **BUG-OPS1-6 / BUG-W-5 (P1, flow-broken)** — Dispatch run button enabled with no driver assigned; the modal silently fails with no toast or error. **Fix:** disable Dispatch when `driverId === null`; surface API 4xx via toast.

7. **BUG-OPS1-1 (P1, money)** — Confirm-order button enabled on a $0/empty-cart order; click is a silent no-op. **Fix:** disable when `items.length === 0`; show validation hint.

8. **BUG-B1-1 (P1, flow-broken)** — Buyer hooks catch 401 and resolve `[]` → "No products found" with no redirect to `/customer-login`. Same pattern in BUG-B2-5: deep-link to `/invoices/:id` while logged out redirects to marketing `/`, losing intended URL. **Fix:** centralize 401 handling in the buyer query client → `redirect('/customer-login?returnTo=' + currentPath)`.

9. **BUG-XR2-1 (P1, a11y)** — Action `<div tabindex=0>` buttons have `outline-style: none; box-shadow: none` on focus globally. WCAG 2.4.7 fail; keyboard / switch-access users cannot see focus anywhere. **Fix:** restore `focus-visible:ring-2 ring-offset-2` on the shared button primitive.

10. **BUG-XR2-2 (P1, a11y)** — Form `TextInput`s on `/customers/new` (and likely all forms) have `ariaLabel=null` and no associated `<label>`. WCAG 1.3.1 / 4.1.2 fail; screen readers announce nothing. **Fix:** add `aria-label` (or `accessibilityLabel` for RN-Web) to every TextInput; lint rule to prevent regression.

---

## Cross-cutting patterns

1. **Auth plumbing was designed for one role × one tab.** Five distinct symptoms across all four squads trace back to a single missing abstraction: a role-aware session manager that owns all storage keys, signals across tabs, and applies an explicit precedence on conflicts. Without that, every patch is whack-a-mole. Treat the auth refactor as a single tracked effort, not 3 line-level fixes.

2. **Silent backend rejections.** $0 orders, driverless dispatches, `statuses[]` 400, catalog 401, deep-link unauth — all swallow errors at the data-hook boundary and render empty/idle states. CTAs are cosmetically enabled with no pre-validation. Pattern fix: shared error toast on every mutation 4xx, plus `disabled` props derived from validation state.

3. **Money-path edges lack guards.** Tax unit mismatch, $0 orders accepted, payment idempotency missing, no upper-bound on price/qty, hardcoded 2025-06-01 payment date. Money-touching code needs a checklist: validated input range, server-truth re-fetch, idempotency, audit log.

4. **A11y regressed at the CSS layer.** Global focus-style strip + missing aria-labels are systemic, not isolated. One CSS reset commit and one lint rule recover most of WCAG-AA.

5. **/auth/login throttling masks a real test-environment gap.** 6 of 8 workers hit 429 from the shared IP and fell back to code analysis. The product behavior is fine; the audit setup needs IP rotation or a per-worker dedicated browser context for future runs. Three P1-suspected findings (idempotency, 0-stop stuck, Standing tab) need a clean single-tester pass to upgrade to CONFIRMED.

---

## Required next sprint (priority order)

1. **P0 fixes + e2e** (≤ 2 days)
   - Tax math unit + invariant test on `(subtotal, rate) → tax`.
   - Buyer invoices DTO accepts `statuses[]`; e2e covering all filter combos.

2. **Auth-layer refactor** (3-5 days, single tracked effort)
   - Single source-of-truth session manager.
   - Logout clears every role bucket.
   - `StorageEvent`-based cross-tab logout.
   - Explicit role-precedence guard, unit-tested for all role-pair combos.
   - Persist driver slice to localStorage.

3. **Money-path hardening** (2-3 days)
   - Idempotency-Key middleware in mutation client + offline-queue header preservation.
   - Disabled/validation states on every money-touching CTA.
   - Toast on every 4xx.

4. **A11y baseline restore** (1-2 days)
   - Global focus-visible utility on button primitive.
   - aria-label everywhere; eslint-plugin-jsx-a11y enforcement.
   - Pending-badge contrast ≥ 4.5:1.

5. **Verify code-only-suspected P1s with a clean single-tester pass** (≤ 1 day)
   - 0-stop run stuck.
   - Payment idempotency double-charge under offline replay.
   - Standing tab actually renders Orders.

6. **P2 backlog** (sprint 2)
   - Print stylesheet on `/invoices/:id`.
   - `beforeunload` on dirty Create forms.
   - ThrottlerException UX polish (friendly "too many attempts, try again in N min").
   - Hardcoded date placeholders.
   - Deep-link route registration for `/invoices/:id` and `/orders` (Expo).
   - Cash drawer feature: ship or hide the tab.

---

## Test-environment debt for next audit

- 6/8 workers were partially blocked by `/auth/login` IP throttling. Allocate per-worker isolated browser contexts (separate Chrome profiles or per-worker Railway preview origins) for the next audit, or temporarily raise throttle for a known QA IP allowlist.
- Multi-agent shared `localStorage` produced ~9 false-P0/P1 entries that the supervisors had to reclassify as env artifacts. Per-worker incognito session isolation is non-negotiable next time.

---

## Cleanup obligation

Workers were instructed to tag every dummy entity `QA-<worker-id>-…`. A cleanup sweep over customers, products, routes, orders, and invoices matching `/^QA-/` is required before declaring this audit closed. See cleanup section in this report's directory.
