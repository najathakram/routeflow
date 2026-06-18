# DRIVER squad — synthesis

## Top 5 product P0/P1 (after filtering env + code-only suspected)

1. **Token priority race — operator masks driver session** (BUG-DRV1-2 / BUG-DRV2-5, DEDUPLICATED)
   `getActiveAccessToken()` and `getStoredUser()` both iterate `[OP_KEYS, DRIVER_KEYS]` — operator token always wins when both exist in shared localStorage. Confirmed by four workers across squads. Driver tab renders operator dashboard; driver API calls carry op JWT. `apps/mobile/lib/api-client.ts` line 37, `apps/mobile/lib/auth.ts` line 92. Concrete repro in both workers.

2. **Driver token not persisted to localStorage on web** (BUG-DRV2-1)
   After successful driver login, `rf:driver:accessToken` is absent from localStorage (`Object.keys(localStorage).filter(k=>k.includes('driver'))` returns `[]`). Page refresh loses session and redirects to marketing home. Concrete repro: DRIVER-2 worker. `apps/mobile/lib/auth-store.ts` driver slice missing `persist` middleware. Standalone bug independent of token-priority race.

3. **0-stop route run — driver permanently stuck, cannot complete** (BUG-DRV1-5)
   `TodaysRoute` renders "Mark route complete" only when `!nextStop && done > 0`. Zero-stop runs satisfy `nextStop=null` but `done=0`, so the button never appears. Run stays `IN_PROGRESS` indefinitely. `apps/mobile/app/(driver)/route/index.tsx` line 304. Code-analysis finding — classified P1 SUSPECTED per audit rules.

4. **completeWithPayment never sends idempotency key — double-charge risk** (BUG-DRV1-3)
   `payment.tsx` line 131 passes no `idempotencyKey` to `mutateAsync()`. `offlineQueue` persists body only, not headers, so even if a key were added it would not survive replay. Server's RF-019 guard never activates. On network drop + replay, stop can be double-committed. `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` + `apps/mobile/lib/api-client.ts`. Code-analysis — P1 SUSPECTED (money path).

5. **Standing tab mislabeled — shows driver Orders screen, not standing-order schedule** (BUG-DRV2-3)
   `apps/mobile/app/(driver)/_layout.tsx` maps the "orders" screen to tab title "Standing". `orders.tsx` renders a delivery orders list with status chips, not standing-order templates. Misleads drivers daily. Code-analysis — P1 SUSPECTED (core navigation broken by description).

---

## Counts

| Severity | Product bugs | Env artifacts | Code-only suspected |
| -------- | ------------ | ------------- | ------------------- |
| P0       | 0            | 0             | 0                   |
| P1       | 2            | 0             | 3                   |
| P2       | 2            | 0             | 0                   |
| P3       | 1            | 2             | 0                   |

Notes:

- P1 product = token priority race (concrete repro x2 workers) + driver token not persisted (concrete repro)
- P1 code-only suspected = 0-stop stuck, idempotency missing, Standing tab mislabeled
- P2 product = Cash drawer stub (BUG-DRV2-4), Standing tab label (BUG-DRV2-3 treated as P2 product because the tab exists but shows wrong screen — navigable, not crashed; moved to P2 given no hard blocker)
- P3 product = static "CASH RECEIVED" label (BUG-DRV1-4)
- P3 env = raw ThrottlerException display (BUG-DRV1-1 / BUG-DRV2-2 deduplicated) — triggered only under artificial rate-limit conditions from shared test IP; real user unlikely to hit 5 attempts in 5 min — env artifact

Deduplication applied: BUG-DRV1-1 = BUG-DRV2-2 (throttle message, 1 bug counted); BUG-DRV1-2 = BUG-DRV2-5 (token priority race, 1 bug counted).

---

## Counts by category (product only)

| Category    | Count                                              |
| ----------- | -------------------------------------------------- |
| security    | 2 (token priority race, token not persisted)       |
| flow-broken | 1 (0-stop stuck)                                   |
| money       | 1 (idempotency missing)                            |
| ux          | 2 (Standing tab wrong, CASH RECEIVED static label) |
| empty-state | 1 (cash drawer stub)                               |

---

## Verdict: HOLD

Token not persisted to localStorage (BUG-DRV2-1) and the operator-masks-driver token race (BUG-DRV1-2 / BUG-DRV2-5) together mean a driver on the web app cannot reliably maintain an authenticated session. These are session-breaking bugs on the primary test surface. The idempotency gap on the payment path is a financial-integrity risk. All three must be fixed before ship.

---

## Pattern observation

Authentication layer has two compounding defects — token not written durably and wrong token returned when two roles coexist — that together make the web driver app non-functional for any session that shares a browser with an operator login.

---

## Env / code-only-suspected (informational, not ship-blockers)

- BUG-DRV1-1 / BUG-DRV2-2 — raw ThrottlerException message: triggered only by shared-IP throttling during concurrent worker sessions; real-world driver unlikely to hit 5 login attempts in 5 min; severity downgraded to env artifact for this audit
- BUG-DRV1-5 — 0-stop stuck: code-analysis only; 0-stop routes are an edge case requiring deliberate operator misconfiguration; P1 SUSPECTED, recommend fix before next release but not blocking current ship window if cannot be live-verified
- BUG-DRV1-3 — idempotency key missing: code-analysis only; risk is real on flaky networks but requires offline-queue replay to manifest; P1 SUSPECTED, fix in parallel with session bugs
- BUG-DRV2-3 — Standing tab label: DRIVER-2 cites source code directly (\_layout.tsx title='Standing' → orders screen); low ambiguity; P1 SUSPECTED for UX but product may intentionally repurpose tab — needs PM sign-off before treating as bug
