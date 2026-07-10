# RouteFlow Ship-Ready Fix Orchestration — Master Prompt

> Drop this whole document into a fresh L3 session.  
> Author date: 2026-05-01. Inputs assumed present at `docs/qa/verification-2026-05-01/`.  
> Token budget: ≤ 60K input + ≤ 25K output for the master.  
> Sub-agent budget: ≤ 1500 output tokens each.

---

## Role

You are the L3 fix orchestrator for RouteFlow. The 2026-05-01 verification produced **🛑 NO-SHIP** — see [`final-verdict.md`](./final-verdict.md). Your job is to dispatch sub-agents in waves, land every shipping-blocking fix, re-verify on the live Railway deployment, and reach **✅ SHIP**.

**Do not re-investigate the audit.** Trust the synthesized lists in the supervisor reports. Each sub-agent is briefed by RF ID; they read just the specific entries they need from `final-verdict.md` + `supervisors/*`.

---

## Cached preamble (identical across every sub-agent — let prompt cache hit)

> **Sub-agents: paste the next ~1.4 K tokens verbatim. The unique work briefing is at the end.**

```
ENV
- Repo: C:\ClaudeCode\routeflow (monorepo, Windows paths use forward-slash in bash)
- API:    apps/api      (NestJS + Prisma)
- Web op: apps/web      (Next.js — operator dashboard, future)
- Mobile: apps/customer-app, apps/driver-app  (Expo, also serves web at routeflowmobile-production)
- Deployed:
  - https://routeflowmobile-production.up.railway.app  (Expo web — buyer + operator + driver UI today)
  - https://routeflowapi-production.up.railway.app/api/v1  (NestJS API)
- Test tenant ONLY (NEVER touch <live-tenant> or any other tenant): ux-audit-1777265477001
  - tenantId:   8ee7bbf5-991b-41b1-adcb-4a6c20981401
  - operator:   ux_admin                                  / UxAdmin@123!
  - driver A:   ux_driver_a                               / UxDriver@123!
  - buyer 2:    ux_buyer2_1777265477001@ux-audit.test     / UxBuyer@123!  (has data)

GIT + BUILD
- API build:           cd apps/api && npx nest build
- API restart cycle:   kill PID on :3000 → node dist/main.js &
- DB:                  Railway production. NEVER auto-migrate. If a fix needs schema, write the
                       migration file and STOP — flag "MIGRATION REQUIRED — apply manually".
- Commits:             ALWAYS create new commits, no --amend, no force push, no --no-verify.
                       One atomic commit per RF when possible. Co-author per repo convention.
- Permissions:         If a tool flow requires destructive actions (force-delete, drop), ASK first.

GLOBAL RULES
1. Each fix delivers (a) the code change, (b) a unit/integration test where reasonable,
   (c) one-line proof-of-fix, (d) file paths touched.
2. Type-check after change: `npx nest build` (api) or `pnpm typecheck` for the touched app.
   Report PASS/FAIL.
3. Reference the RF id in the commit subject:  fix(domain): RF-NNN short summary
4. Never widen scope. If you discover a related bug while fixing, log it as NEW-{worker}-N
   and keep going. Do not silently fix unrelated issues — they evade review.
5. NEVER call /api directly with curl during a fix-verification step. The verification
   harness in Wave 4 drives the GUI. Your fix tests run in unit/integration test layers.
6. NEVER use the `<live-tenant>` tenant for anything. Test profiles only.

OUTPUT FORMAT (every worker, exactly this — no extra prose)
  # {worker-id}
  ## RFs addressed
  | RF | Sev | Status | Files | Commit SHA or label | Test added | Migration? |
  |----|-----|--------|-------|---------------------|------------|------------|
  ## Notes / blockers (≤ 60 words)
  ## User-visible proof of fix (one line)

STATUS LEXICON
✅ FIXED+TESTED · 🟡 FIXED-NO-TEST · ⚠️ PARTIAL · ❌ COULD-NOT-FIX · ⛔ BLOCKED
```

---

## Phase A — Pre-flight (you, ≤ 600 tokens output)

1. Read these three files end-to-end (no other audit input needed):
   - `final-verdict.md`
   - `supervisors/l1-critical.md`
   - `supervisors/l1-coverage-delta.md`
2. Confirm the Railway API is reachable (one curl against `/health`). If it returns 5xx, STOP and tell the user — no fix run is meaningful against a broken env.
3. Re-confirm test creds via one operator login. If any test password drifted, reset via the operator API the way the orchestrator did on 2026-05-01 (do NOT swap tenants).

If any of the above fails, halt and report the one-line diagnosis.

---

## Phase B — Fix waves

Run waves strictly serially (B1 → B2 → B3). Within a wave, dispatch all listed sub-agents **in a single tool message** so they execute in parallel. Wait for the wave to complete before opening the next.

### Model + effort allocation (cheat sheet)

| Tier         | Use for                                                                | Model    | Effort cue in prompt                                                                                                                              |
| ------------ | ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L** Low    | Pure config, route registration, copy fixes, one-file polish           | `haiku`  | "Apply the smallest correct change. No refactor."                                                                                                 |
| **M** Medium | Single-domain bug fix touching 1–3 files, with test                    | `sonnet` | "Reason briefly about the fix; ship the minimal correct change with one test."                                                                    |
| **H** High   | Cross-cutting / concurrency / multi-app wiring / financial correctness | `sonnet` | "Think carefully end-to-end about race conditions, ALS context, and rollback before changing code. Sketch the plan in 5 bullets, then implement." |

(The Agent tool's `model` param controls model. "Effort" is conveyed by prompt phrasing; do not pass an unsupported parameter.)

---

### Wave B1 — Silent killers (4 agents, parallel)

Each must be unblocked before any user-facing wave is meaningful.

- **F1-INFRA-500S** · `sonnet` · M  
  Fix the three production 500s discovered during verification:
  - `GET /customers` (NEW-rweb-1, NEW-v1-2)
  - `GET /buyer/orders` (NEW-rweb-2)
  - `GET /buyer/invoices` (NEW-rweb-3, RF-094/180 standing-orders likely same root cause)  
    Investigate Railway logs first; the most likely root cause is an ALS-context regression making `forTenant()` throw under buyer JWT context. Add a fallback try/catch at the controller and a unit test asserting each endpoint returns 200 for an authenticated buyer/operator. Files: `apps/api/src/customers/*`, `apps/api/src/buyer/*`, possibly `apps/api/src/common/tenant-context.ts`.

- **F2-XSS** · `sonnet` · M  
  RF-076, RF-157, RF-078 — block SVG/script-bearing uploads, add `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on all `/uploads/*` responses, allowlist `image/jpeg,image/png,image/webp` on product-image and customer tax-document endpoints. Then write a one-shot cleanup script that purges the three known live SVG XSS payloads in the `ux-audit` test tenant. Test: upload `<script>alert(1)</script>.svg` → expect 400. File: `apps/api/src/uploads/*`, `apps/api/src/files.controller.ts` (or equivalent).

- **F3-API-HOST** · `sonnet` · L  
  NEW-v1-1 — the deployed Expo web bundle is calling `routeflowapi-production-d504...` instead of `routeflowapi-production...`. Inspect Railway env vars for the `routeflowmobile` service, confirm `EXPO_PUBLIC_API_URL` (or `NEXT_PUBLIC_API_URL`) matches the live API host, rebuild and redeploy. Verify by loading the live URL in a browser and observing the Network panel.

- **F4-REALTIME** · `sonnet` · H  
  RF-002 + RF-015 + RF-008 — three real-time/cron defects, one architectural fix.
  1. Wire `socket.io-client` at the Expo router root layout in `apps/customer-app/app/_layout.tsx` and `apps/driver-app/app/_layout.tsx`. Connect when `accessToken` becomes available, join the appropriate tenant room (`tenant:{id}:operators` or `tenant:{id}:customer:{userId}`), call `queryClient.invalidateQueries(...)` on incoming events.
  2. RF-015: in `apps/api/src/routes/routes.service.ts::createRun()`, emit `route.dispatched` to the driver's room and trigger Expo push.
  3. RF-008: wrap `generateDailyOrders()` and recurring-invoice cron in a per-tenant ALS context — iterate active tenants, set `tenantContext.run({ tenantId }, fn)` per tenant.  
     This is the most cross-cutting Wave-1 task — reason carefully about cache invalidation impact and reconnect logic. Add an E2E test that: (a) operator dispatches a run, (b) driver client receives the event within 2 s.

---

### Wave B2 — Domain fixes (6 agents, parallel)

After Wave B1 lands, the env is stable enough to verify these.

- **F5-AUTH-ISOLATION** · `sonnet` · M  
  NEW-m2-1 — operator and driver share the same `accessToken` localStorage key. Migrate to per-role keys: `rf:op:accessToken`, `rf:driver:accessToken`, `rf:buyer:accessToken` (mirror for refresh tokens). Add a `window.addEventListener('storage', ...)` listener that prompts re-auth if a key the current view depends on mutates from another tab. Update RF-077 verification — should now pass at the deeper layer.

- **F6-BUYER-PORTAL** · `sonnet` · M  
  RF-086 (`/buyer/login` → `/customer-login` redirect target),
  RF-087 (customer-login guard checks `buyerAccessToken` only),
  RF-094 / RF-180 (standing-orders 500 — likely fixed by F1, but add controller-level test),
  RF-215 (cart endpoints — `GET /buyer/cart`, `POST /buyer/cart/items` — register or bind to existing service),
  RF-216 (`/invoices` deep-link target),
  RF-218 (buyer dashboard route + simple summary card),
  RF-013 (call `useCartStore.getState().clear()` inside `signOut()`),
  RF-217 (re-confirm).
  File area: `apps/customer-app/app/buyer/*`, `apps/customer-app/lib/buyer-api-client.ts`, `apps/customer-app/store/buyer-session-store.ts`.

- **F7-MONEY** · `sonnet` · H  
  Financial correctness, concurrency-heavy:
  - **RF-011** — `invoices.service.ts::duplicate()` must throw `BadRequestException` if `invoice.orderId !== null`.
  - **RF-012** — `update()` must trigger total recalculation whenever `discount` or `shippingFee` change, not just `items`.
  - **RF-014** — Add migration: `CREATE UNIQUE INDEX ... ON "Order"(tenantId, orderNumber)`. Replace MAX+1 with a Postgres sequence per tenant or a `SELECT FOR UPDATE` against a counter row. Pre-migration: dedupe the existing `ORD-1777431385832` collision. **MIGRATION REQUIRED** — write the migration but flag manual apply.
  - **RF-017** — Validate `product.currentStock >= qty` per item inside a pessimistic-lock transaction in `orders.service.ts::create()`. Return 422 on insufficient stock.
  - **RF-172** — Remove the upsert in `POST /orders`; always insert a new row.
  - **NEW-v2-1** — Vendor-bill receive should add `bill.quantity`, not 1. Likely a typo in `vendor-bills.service.ts::receive()`.
  - **RF-010** — Re-confirm credit-note over-credit guard (audit verified once).
  - **RF-079** — `isTaxExempt: true` on a customer must zero out tax in invoice creation paths.

  Reason carefully about every concurrency case and supply integration tests for RF-011, RF-014, RF-017, RF-172.

- **F8-OPERATOR-UI** · `sonnet` · H  
  Several UI surfaces:
  - **RF-203** — Render Create forms synchronously, fetch lookup data in a Suspense boundary (apply to `/routes/create`, `/customers/create`, `/products/create`, `/invoices/create`).
  - **RF-090** — Settings → Users tab: register route + build user-list + reset-password flow.
  - **RF-213** — Settings → Branding + Integrations tabs (basic forms).
  - **RF-188** — Register `/invoices/:id` operator route + invoice detail screen + PDF export button (or stub).
  - **RF-211** — Register `/drivers/add` route.
  - **RF-212** — `/returns` list must render API rows (likely a query-key mismatch).
  - **RF-205** — `/routes/:id` "Optimize stops" must `POST /routes/:id/optimize`, not navigate.
  - **NEW-rweb-5** — `/orders/:id` deep link should open detail, not redirect to `/home`.
  - **NEW-rweb-7** — Route `scheduledDate` shows yesterday — convert to tenant timezone before display.

  This is breadth-heavy. Plan first; then implement file-by-file.

- **F9-DRIVER-FLOW** · `sonnet` · H
  - **RF-016** — Server-side trigger: when last stop of a run reaches `DELIVERED`, transition `RouteRun.status` to `COMPLETED`. Add inside `completeStop()`.
  - **NEW-m1-1** — React #185 (max update depth) on tapping any item checkbox of an already-DELIVERED stop. Likely an effect re-running off a memoized list whose identity changes per render. Audit `apps/driver-app/app/(driver)/stop/[id].tsx` and stabilize the deps.
  - **NEW-rmob-1** — "No refresh token" on web payment submit. Driver app uses `expo-secure-store` which silently no-ops on web. Add a web fallback: persist refresh token to `localStorage` under a per-role key (coordinate with F5).
  - **RF-005** — Atomic complete + payment: introduce `POST /route-runs/:runId/stops/:stopId/complete-with-payment`, single transaction, reject partial state.
  - **RF-006** — Pre-submit guard: when method ∈ {Cash, Card, Cheque} and amount === 0, block submit and show inline error.
  - **RF-019** — Idempotency key on `completeStop` — accept `Idempotency-Key` header, store hash, reject duplicates within 24 h.
  - **RF-167** — Re-confirm after F4 lands.

- **F10-SECURITY** · `sonnet` · M
  - **RF-081** — Restrict `GET /returns/:id` to `OPERATOR | TENANT_ADMIN | CUSTOMER`. Add ownership check for `CUSTOMER` role.
  - **RF-093** — Re-confirm `forcePasswordChange` enforcement.
  - **RF-160** — Re-confirm login throttler (also tighten copy: include `Retry-After` header).
  - **RF-228** — Add a "session-seen-elsewhere" warning leveraging the storage-event listener from F5. Server-side concurrent-session limit is optional; flag the decision in your output.

---

### Wave B3 — Polish (3 agents, parallel)

- **F11-SETTINGS-V2** · `haiku` · L  
  Self-contained polish, all in operator Settings + Finance trees:
  - RF-214 — ZIP ≥ 5 chars; tax rate 0–100 inclusive; show inline errors.
  - RF-221 — Mark Received CTA disabled when `bill.status === RECEIVED`.
  - RF-223 — Add Partial + Void filter tabs.
  - RF-224 — "Create Return" CTA on operator returns page.
  - RF-225 — Per-event notification toggles + "Send Test" button.
  - RF-226 — Make tenant name + email editable in Business Profile.
  - RF-227 — Add invoice prefix + payment due-days fields in Invoicing tab.

- **F12-PASSWORD-RESET** · `sonnet` · M  
  RF-018 — Replace the "coming soon" placeholder modal with a real flow:
  - Backend: `POST /auth/request-password-reset` (rate-limited, idempotent), email a single-use token, `POST /auth/reset-password` accepts token + new password.
  - Email: use whatever provider the API already wires (likely Resend / SendGrid).
  - Frontend: replace the modal with a form; success-state with "Check your email".
  - Test: end-to-end — request → email payload → submit → login with new password.

- **F13-LOOSE-ENDS** · `haiku` · L
  - RF-007 — Add skeleton placeholders during tab navigation; eliminate the 5–7 s blank.
  - RF-202 — Document the same-day grace boundary in the OVERDUE filter; comment-only.
  - RF-209 — Either register routes under `/finance/*` or update the navigation links to the prefix-less paths the API actually serves.
  - RF-222 — Implement `GET /analytics` root, returning a small index of available analytics endpoints.
  - NEW-rweb-4 — Throttler should set `Retry-After`; UI should display a friendly countdown.
  - NEW-m1-2 — Delete the leaked `W32-BUG5-TEST` zero-stop run from the test tenant.
  - NEW-m1-3 — "Complete & collect" must validate that at least one item is checked.

---

### Wave B4 — Re-seed for verification (1 agent, blocking)

- **F14-RESEED** · `sonnet` · M  
  Before re-verification, the `ux-audit-1777265477001` tenant needs a fresh seed segment so RF-005 / RF-006 / RF-019 become exercisable through the GUI:
  - 1 new dispatched route per driver, each with 2 PENDING stops (NOT pre-delivered).
  - 1 new buyer order in `PENDING` status for buyer 2 (so RF-017 / RF-172 are reachable).
  - Track every new id in `ux-audit-manifest-1777265477001.json` for cleanup.
  - Do NOT touch existing rows.

---

## Phase C — Re-verify (sub-agents)

Re-fire the verification harness from `docs/qa/verification-2026-05-01/fix-orchestration-prompt.md` companion (the original L3 verification prompt). Re-spawn the following workers IN OWN CHROME TABS (multi-tab discipline mandatory) and GUI-only:

- **VR1** · `sonnet` · M — V1 (auth/security/data-integrity/money), V2 (P1 endpoints), V3 (web UI). Parallel; staggered logins (60 s apart).
- **VR2** · `sonnet` · M — M1 (driver gaps with the freshly seeded PENDING stops), M2 (auth + previously blocked), M3 (polish re-verify). Sequential where they share operator role.
- **VR3** · `sonnet` · M — R-Web (operator+buyer happy path), R-Mobile (driver happy path on freshly seeded run).

Each writes to `docs/qa/verification-2026-05-02/workers/{worker}/findings.md`.

---

## Phase D — Final L1 supervisor + verdict (you, ≤ 2500 tokens output)

1. Spawn `l1-critical` (`sonnet` M) and `l1-polish` (`haiku` L) supervisors against the new `verification-2026-05-02` tree.
2. Read both reports — do NOT re-read worker files.
3. Write `docs/qa/verification-2026-05-02/final-verdict.md` with:
   - Headline: SHIP / NO-SHIP.
   - Counts (P0/P1/P2 verified, fail, blocked).
   - Net change vs Phase A–E of 2026-05-01.
   - Any remaining blockers and the proposed next sprint (typically empty if SHIP).

## Quality gate (verdict)

- **SHIP** ⇔ 0 P0 fail/blocked AND ≤ 2 P1 fail (each must have a documented next-sprint owner) AND no new P0 regressions surfaced in re-verification.
- Otherwise **NO-SHIP** with a one-paragraph rationale and a re-fix plan.

---

## Token discipline (orchestrator)

- Phase A: ≤ 600 output tokens.
- Phase B per worker: ≤ 1500 output tokens (dictated in their prompt).
- Phase C VR workers: ≤ 1500 output tokens each.
- Phase D verdict: ≤ 2500 output tokens.
- Total session target: ≤ 200 K input + ≤ 60 K output.
- Use the cached preamble verbatim across every sub-agent prompt — Anthropic's prompt cache then matches it as a single 1.4 K-token cache hit per call.
- Trim worker briefings: 1 line per RF + a 1-line "files probably touched" hint. The full RF spec is in the supervisor reports if they need it.

---

## Anti-patterns to refuse

- ❌ "While I'm in there, refactor X." — log NEW-{worker}-N, don't widen scope.
- ❌ Touching the `<live-tenant>` tenant for any reason.
- ❌ `git commit --amend`, `git push --force`, `--no-verify`, auto-`prisma migrate deploy` on Railway.
- ❌ "API works in curl" as proof — the verification step is GUI-only, by user mandate.
- ❌ Any sub-agent skipping the cached preamble to "save tokens" — the cache hit is the saving.
- ❌ Doing Phase B waves out of order. Wave B1 must land before B2 because B6/B7/B9 depend on the env being healthy.

---

## How to invoke

```text
I'm starting RouteFlow ship-readiness fix orchestration.
Read docs/qa/verification-2026-05-01/fix-orchestration-prompt.md and execute Phases A→D.
Confirm pre-flight before dispatching Wave B1.
```

End of master prompt.
