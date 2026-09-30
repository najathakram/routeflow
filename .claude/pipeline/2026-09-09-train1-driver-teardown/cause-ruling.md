# Cause ruling — train 1: driver session teardown + POD persistence (B111 · B136 · B137 · B140 · B150; B143 = bookkeeping only)

Fable 5.1, 2026-09-09, over `cause-brief.md` (S1) and `cause-refutation.md` (S2, verified at master 1dca1242).
Branch `fix/train1-driver-teardown` off 1dca1242 (rf-registry). Mobile Jest = pure-logic `__tests__/*.test.ts`
(node; source-text specs for UI files; extend `session-expired-wiring.test.ts` and copy
`network-sync-wiring.test.ts`'s mocked-natives shape). B143 is already fixed (F30/R6 queue-drain) → registry only.

## 1. Cause verdicts (accept S2)

- Sign-out seam: `useAuthStore.logout()` (`lib/auth-store.ts:67-70`) awaits `apiLogout()` (which deletes every token,
  `lib/auth.ts:283-293`) and clears in-memory auth only. Survivors: offline queue (`routeflow-offline-queue`,
  device-scoped, + persisted `failedActions`), the module-scope `queryClient` (`app/_layout.tsx:38`, not exported),
  tenant store, `podStore` (in-memory), `runSettlementStore` (in-memory cash tally), `mileageStore`, `routeStore`,
  `delivery-plan-store`, `listUiStore`, `productPickerStore`, the background GPS task (driver start; operator realm
  starts it too and has NO stop site). `clearQueue()` and `tenant-store.clear()` have zero callers. Buyer realm
  already tears down its cart on sign-out (`buyer-session-store.ts:66-71`) — precedent.
- B111: two legs — the `file://` transcode-fallback photo is silently filtered (`payment.tsx:264`, never sent) and
  the bare `catch {}` (`:270-273`) swallows attach failures of `data:` photos. B136: POD scratchpad is in-memory;
  re-attach after a kill appends a DUPLICATE photo (`routes.service.ts:2122-2125`; artifact id = hash of the data
  URL, `pod-artifacts.ts:74-80`). B137: replay always uses the NEW user's token (drain runs only inside auth-gated
  layouts) → misattribution, not an authz bypass. B140: no per-tenant cache key prefix. B150: the tracker already
  exposes a safe stop (`location-tracker.native.ts:91-99`, module-const task name; web stub no-op).

## 2. Rulings on the open product questions

- Q1 queued work on sign-out: KEEP, never drop. Every queued action and every `failedActions` entry is stamped
  `{ userId, tenantId }` at enqueue; the drain replays only entries whose stamp matches the signed-in user, moves
  mismatched entries to `failedActions` with reason `different-user` (never executes them), and the banner lists
  only the current user's failures.
- Q2 tenant slug: KEEP on logout (shared-tablet branded login); everything user-scoped is cleared.
- Q3 POD durability: persist BOTH `podStore` and `runSettlementStore` (same persistence shape as the queue, keyed by
  user+tenant+route/stop); on relaunch the stop screen reconciles against the stop's existing `podPhotoUrls` /
  artifact ids before any re-attach — an artifact the server already holds is never re-sent (no duplicate append).

## 3. Fix design

- **D1 one teardown function (Sonnet high)** `lib/session-teardown.ts` `teardownUserSession({ reason })`, called by
  `useAuthStore.logout()` BEFORE `apiLogout()` (tokens still valid) and by the session-expired path, in this order:
  (1) stop background location (`location-tracker` stop, both realms; idempotent), (2) mark the offline queue's
  owner (no flush attempt — flushing on sign-out is a network gamble; entries stay stamped for the same user),
  (3) `queryClient.clear()` via an exported accessor from `_layout.tsx` (or a small `lib/query-client.ts` module
  the layout imports) — after mutations settle: `queryClient.cancelQueries()` then `clear()`, (4) reset user-scoped
  stores: `podStore`, `runSettlementStore`, `mileageStore`, `routeStore`, `delivery-plan-store`, `listUiStore`,
  `productPickerStore` (each gets/has a `reset()`); tenant store untouched (Q2). Operator home gets a stop call on
  sign-out through the same function (B150 asymmetry).
- **D2 identity-stamped queue (Sonnet high)** `store/offlineQueue.ts` + `lib/queue-drain.ts`: `enqueue` stamps
  `{ userId, tenantId }` from the auth/tenant stores; the drain filters by the current user; mismatches →
  `failedActions` `{ reason: "different-user" }`; `OfflineBanner` shows only the current user's failures. Legacy
  unstamped entries: treated as the current user's ONCE (migration), then stamped.
- **D3 POD + settlement persistence (Sonnet high)** `store/podStore.ts` and `store/runSettlementStore.ts` persist
  (zustand persist / the same storage the queue uses) under a key that includes user+tenant; hydration on launch;
  reconciliation helper `lib/pod-reconcile.ts` `pendingPodArtifacts(local, serverStop)` returns only artifacts absent
  from the server (by artifact id/hash) — the stop screen attaches only those.
- **D4 B111 visibility (Sonnet high)** `payment.tsx`: the `file://` fallback photo is NOT filtered — it is
  converted (read the file to a data URL) or, when that fails, the driver sees an inline error with a retry and the
  capture is kept in `podStore`; the attach `catch` surfaces the error (toast + inline + `failedActions` entry
  via the queue) — never silent. Reuse the existing feedback components.
- Must NOT change: the API/server; B72's tenant binding on POD; the buyer realm; token deletion order in `auth.ts`;
  the queue's replay classification from F30/R6.

## 4. Regression tests (bug-test-plan.md) — REG-B150, REG-B140, REG-B137, REG-B136, REG-B111

## 5. Blast radius: `apps/mobile/lib/{auth-store,auth,session-teardown,queue-drain,pod-reconcile}.ts`,

`app/_layout.tsx` (+ `lib/query-client.ts`), `store/{offlineQueue,podStore,runSettlementStore,mileageStore,routeStore,
delivery-plan-store,listUiStore,productPickerStore}.ts`, `components/OfflineBanner.tsx`,
`app/(driver)/**/payment.tsx`, `app/(driver)/**/photo.tsx`, `app/(operator)/(tabs)/home.tsx`, tests.

## 6. Probes: revert D1 → REG-B150/REG-B140 red; revert D2 stamp → REG-B137 red; revert D3 persist → REG-B136 red;

revert D4 → REG-B111 red.

## 7. Landing: mobile-only (Railway rows SKIPPED); owner device check after the next EAS build; docs follow-up

(B111/B136/B137/B140/B150 done in F19; B143 discharged by bookkeeping; lesson: sign-out is a teardown contract —
every user-scoped store/task registers with it).
