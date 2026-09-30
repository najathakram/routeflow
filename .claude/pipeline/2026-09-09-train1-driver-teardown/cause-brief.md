# Train 1 cause brief — driver session teardown + POD persistence (F19)

Root: C:/ClaudeCode/routeflow, master 7a248bd1. Read-only. All line numbers verified against
files on disk at this sha (bug-registry evidence was NOT trusted blind — re-checked below).

## 1. Per-row status

**B111 — POD photo attach failures swallowed. STILL VALID, evidence partly stale.**
Current code path: `apps/mobile/components/PhotoCapture.tsx:46-70` — a transcode failure in
`emit()` falls back to `onAdd(asset.uri)` (a `file://` URI, not `data:`). At
`apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:264` the attach loop filters
`(pod?.photoUrls ?? []).filter(p => p.startsWith("data:"))` — the `file://` fallback is silently
excluded, never attached, never surfaced. At `payment.tsx:265-277`, `attachPodMut.mutateAsync`
(→ `apps/mobile/lib/api/routes.ts:372-379` `useAttachPodArtifact`, POST
`/route-runs/:id/stops/:stopId/pod-artifact`) is wrapped in a bare `catch { /* must proceed
either way */ }`. Server-side, `apps/api/src/routes/routes.service.ts:2089-2091` 400s with
`BadRequestException("dataUrl must be a data:image/... URL")`, and `ingestPodDataUrl`
(`routes.service.ts:2008-2036`) also returns `null` on a rasterize failure inside the
_completion_ ingest path (`ingestPodCapture`, `:2040-2056`) — a different, non-throwing path used
by `completeStop`/`completeWithPayment`. **The registry's cited `useNetworkSync.ts:22-24/55-56`
drop path is now STALE** — that generic-queue silent-drop was fixed by the F30/R6 batch (see §4).
But this call is a direct foreground `apiClient.post`, not routed through `drainQueue` — an
_online_ 4xx here never reaches `failedActions`/`OfflineBanner`; it dies in payment.tsx's empty
catch with zero persistence. An _offline_ attach does get auto-enqueued by the response
interceptor (`apps/mobile/lib/api-client.ts:150-185`) and, if it later 4xxs on replay, now DOES
land in `failedActions` and alerts — so the offline leg of B111 is now partially mitigated by
B143's fix; the "online, or transcode-fallback, or B111 pre-B143 report" legs are not.

**B136 — POD store not persisted. STILL VALID, matches report almost exactly.**
`apps/mobile/store/podStore.ts:26-31` — plain `create<PodState>((set) => ...)`, no
`persist`/`AsyncStorage`, comment "In-memory POD scratchpad" (line 27). Contrast
`apps/mobile/store/offlineQueue.ts:40-96` and `apps/mobile/lib/tenant-store.ts`, both persisted.
Consumed at `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`, `signature.tsx`, `note.tsx`,
`photo.tsx:8,13-14`, `payment.tsx:150-151,236-240,313`. No change since the report; unaffected by
the F30/R6 offline-queue work (that batch never touches `podStore`).

**B137 — offline queue survives sign-out, replays under next login. STILL VALID.**
`apps/mobile/store/offlineQueue.ts:6-16` — `QueuedAction` carries `id, endpoint, method, body,
headers?, timestamp, retries`; no `userId`/`tenantId` field, comment at :12 "Auth is re-attached
by the request interceptor" confirmed true at `apps/mobile/lib/api-client.ts:77-82` (attaches
_current_ token/tenant slug, not the token active when the action was enqueued).
`clearQueue` (`offlineQueue.ts:34,71`) has **zero callers** repo-wide outside the store's own
definition (grepped `apps/mobile/**/*.ts(x)`, excluding `__tests__`) — `auth.ts:274-294`'s
`logout()` never calls it. Drain still fires on every reconnect (`useNetworkSync.ts:87-96`),
mounted at `(driver)/_layout.tsx` and `(operator)/_layout.tsx`. Server side,
`apps/api/src/routes/routes.controller.ts:186-197` `completeStop` is `@Roles(OPERATOR, DRIVER)`
only — no per-driver assignment check at the controller — but `routes.service.ts:2225-2232`
(`completeStop`) and the `completeWithPayment` twin DO bind the acting driver from
`user.sub`/`run.driverId` (B72 guard) before ingest. So a replayed queue entry executes as
whichever driver is signed in when the drain fires, and the server accepts it as that driver's
legitimate action — money/POD attribution error, not an authorization bypass.

**B140 — mobile sign-out never clears the query cache. STILL VALID.**
`apps/mobile/app/_layout.tsx:38` — `const queryClient = new QueryClient();` at module scope, no
`defaultOptions`. `apps/mobile/lib/auth-store.ts:67-70` `logout()` = `await apiLogout(); set({
user: null, isAuthenticated: false, activeRole: null })` — touches nothing else.
`apps/mobile/lib/tenant-store.ts:82-85` has a `clear()` that deletes the persisted slug and resets
state, but it too has **zero callers** (grepped every `useTenantStore` import; only `setSlug`/
`initialize`/field reads are ever called). `apps/mobile/app/(customer)/sellers.tsx` remains the
app's only `qc.clear()` call site (buyer realm, not staff).

**B143 — offline replay silently drops 4xx/retry-exhausted. FIXED on master; registry stale.**
`apps/mobile/hooks/useNetworkSync.ts` no longer contains the cited drop logic at :22-25/:55-57 —
it now delegates to `apps/mobile/lib/queue-drain.ts` (NEW file, header comment cites
"F30 / REG-B196 / REG-B143 / REG-B111"). `drainQueue()` (`queue-drain.ts:138-181`) classifies
every entry into `delivered` / `retriedIds` / `failedActions` — a non-retriable 4xx or an entry at
`retries >= MAX_RETRIES` (3) is pushed to `failedActions` with a `reason` string and
`deps.notifyFailed` fires (never a bare dequeue). `offlineQueue.ts:73-81` persists
`failedActions` (capped `MAX_FAILED_ACTIONS = 50`, :19,80) through the same `persist`/AsyncStorage
wrapper as the queue. `components/OfflineBanner.tsx` (NEW) renders a standing, tap-to-review badge
mounted by `(driver)/_layout.tsx` and `(operator)/_layout.tsx`; `useNetworkSync.ts:78-81` also
fires one `alertInfo` per drain via `describeFailedDrain`. This closes the "indistinguishable from
success" gap the report describes. **The bug-registry row is still `state: queued`** — this is a
documentation/registry staleness issue, not a code gap; S2/S3 should treat B143 as effectively
closed by the (undischarged) F30/R6 work and focus verification on whether any residual gap
remains (see caveat below) rather than redesigning it.
Caveat: `driver-payments.guard.ts:43-45` throws `ForbiddenException` (403), which the classifier's
`status >= 400 && status < 500` still counts as a non-retriable failure lint correctly — so a
403 from a since-disabled driver-payments addon also lands in `failedActions`, which is the
correct (loud) behavior, not a residual bug.

**B150 — sign-out never stops background GPS. STILL VALID, matches report exactly.**
`apps/mobile/lib/location-tracker.native.ts:6-7` — module-global `TASK_NAME`/`activeRunId`.
`startLocationTracking` (:48-89) / `stopLocationTracking` (:91-99). Call sites (grepped, excluding
tests): `startLocationTracking` — `(driver)/route/index.tsx:136,195` and
`(operator)/(tabs)/home.tsx:583` (3 total, confirming the report); `stopLocationTracking` — only
`(driver)/route/index.tsx:138`, inside a `useEffect` keyed on `active?.id`
(`route/index.tsx:134-140`) with **no cleanup return function** — it only reacts to the run
disappearing, never to unmount or an auth change. `driver-menu.tsx:86` "Sign out" →
`useAuthStore().logout()`, which (per B140 above) never touches location tracking.
Server side, `apps/api/src/drivers/drivers.service.ts:93-116` `recordLocation(userId, dto)`
resolves the driver row from `userId` alone and writes `driverId`/`runId=dto.runId` with no check
that `dto.runId` is that driver's _currently active_ run — confirmed present, matches the
verifier's note: a still-running task from a prior session can write `DriverLocation` rows tagged
with a stale `activeRunId` under a newly signed-in driver's bearer token.

## 2. Shared teardown seam

`useAuthStore.logout()` (`apps/mobile/lib/auth-store.ts:67-70`) is the **only** driver/operator
sign-out entry point (`driver-menu.tsx:86`, and the operator equivalents). Its full body:
`await apiLogout()` (server POST `/auth/logout`, best-effort; `apps/mobile/lib/auth.ts:274-294`
clears every SecureStore token bucket incl. buyer) then `set({ user: null, isAuthenticated: false,
activeRole: null })`. That is the entire teardown. Everything below outlives it:

- **Offline queue** (`store/offlineQueue.ts`) — persisted to AsyncStorage, `clearQueue` uncalled (B137).
- **Failed-actions list** (`offlineQueue.ts` `failedActions`) — same store, same gap; a failed
  action recorded under driver A stays visible/actionable after driver B signs in on the device.
- **Query cache** (`app/_layout.tsx:38` module-scope `QueryClient`) — never cleared (B140).
- **Tenant store** (`lib/tenant-store.ts`) — `clear()` exists, uncalled; slug/branding survive.
- **POD scratchpad** (`store/podStore.ts`) — in-memory only; survives logout (and is lost on
  process kill regardless — B136). Not cleared by logout, but also not disk-durable, so exposure
  is "next driver on the same device before app restart," a narrower window than the others.
- **Background GPS task** (`lib/location-tracker.native.ts` module-global `TASK_NAME`) — B150.
- **Mileage store** (`store/mileageStore.ts`) — persisted (mobile.md line ~119), not checked by
  any row here but same shape as podStore/offlineQueue; worth a sibling-sweep item for S2.
  No store or task in `apps/mobile` currently subscribes to a logout/auth-change event; `auth-store`
  exposes no hook for other modules to register teardown (contrast `registerStaffSessionExpiredHandler`
  in `api-client.ts:94-97`, which IS such a hook, but only auth-store itself calls it — nothing
  downstream of logout uses that pattern).

## 3. POD persistence story

Capture: `podStore.ts` in-memory (photos as `data:` URLs when captured via `photo.tsx`
`output="data-url"`, or `file://` URIs when captured via `payment.tsx`'s inline `PhotoCapture`
with default `output="uri"` — two different capture paths feed the same store with two different
URI shapes, which is _why_ the `.filter(p => p.startsWith("data:"))` in payment.tsx:264 silently
drops the file:// shape). App kill/relaunch: `podStore` has no persist middleware → total loss,
no warning, gate re-checks on next mount find nothing (B136). Server acceptance: two endpoints —
`POST /route-runs/:id/stops/:stopId/pod-artifact` (`routes.controller.ts:226-236` →
`routes.service.ts:2064-2130+`, one artifact per JSON call, idempotent per `artifactId`, 400s on
a non-data-URL, 403s a driver not bound to the run) and the inline `signatureUrl`/`podPhotoUrls`
fields on `completeStop`/`completeWithPayment` (ingested via `ingestPodCapture`,
`routes.service.ts:2040-2056`, which never throws — a rasterize failure there falls back to
storing the raw data URL, not to `null`-and-fail). B111's swallowed failure never surfaces to the
driver on either path: the pre-attach loop's catch is silent, and a stop closes successfully
regardless (`payment.tsx:174` `closeStop` proceeds past both `catch` blocks unconditionally).

## 4. Offline queue mechanics

Shape: `QueuedAction {id, endpoint, method, body?, headers?, timestamp, retries}` — no identity
fields. Replay: `useNetworkSync.ts` on `NetInfo` online transition → `runDrain` → a
route-cancellation short-circuit (RF-170, not the B143/B111 path) → `queue-drain.ts#drainQueue`.
Classification: success → `delivered`; `status 400-499` (excluding 409
`MERGE_IN_PROGRESS`/503 `LOCK_UNAVAILABLE`, treated as retriable lock contention) → `failedActions`
with a `reason` string, persisted + alerted, never silently dropped; anything else (5xx, network/
timeout) → `retriedIds`, requeued with `retries++`; `retries >= MAX_RETRIES` (3) on next drain →
`failedActions` without a retry attempt. Identity: none stored per action — replay always uses
_whichever_ token/tenant-slug `api-client.ts`'s request interceptor attaches at replay time
(B137). Retry-exhausted and 4xx no longer "vanish" (B143 fixed); they persist and surface via
`OfflineBanner` + a one-shot `alertInfo`.

## 5. Risks / unknowns for S2 to refute

- Is there a way to stop `expo-task-manager`'s background task from outside the screen that
  started it — i.e., does calling `stopLocationTracking()` from `auth-store.logout()` work
  reliably given the task was registered by a different module instance, or does it need the
  task name only (module-global `TASK_NAME`, so should be safe, but not verified against a live
  device in this pass)?
- Does `queryClient.clear()` race an in-flight mutation mid-logout (e.g. a stop completion still
  resolving)? Not verified — no test found exercising clear-during-mutation.
- Does `SecureStore`/`AsyncStorage` hold anything per-user beyond the token buckets already swept
  by `auth.ts:274-294`? `offlineQueue`, `podStore`(no), `tenant-store`, `mileageStore` all use
  device-scoped (not user-scoped) keys — clearing them on logout is a behavior change (multi-user
  same-device households/dispatch tablets lose tenant slug too), which S3 will need to weigh.
- B137's fix (stamp `userId`/`tenantId` per action + refuse replay under a mismatched session) is
  a schema change to `QueuedAction` — needs a migration path for already-persisted queues from
  pre-fix installs (AsyncStorage rows with no such field).
- Confirm whether any other native background task (push token registration, socket reconnect)
  has the same outlives-logout shape — out of scope for this brief's 6 rows but a natural
  sibling-sweep candidate.

## 6. First-cut shared-function grouping for one PR

- **Group A — "stop everything on sign-out" (B137, B140, B150, and B136's exposure window):**
  all four are fixed by extending `useAuthStore.logout()` (`auth-store.ts:67-70`) into a single
  teardown call: `stopLocationTracking()`, `useOfflineQueue.getState().clearQueue()` (+ decide
  fate of `failedActions`), `queryClient.clear()` (needs the client reachable from the store —
  today it's local to `_layout.tsx:38`), `useTenantStore.getState().clear()`, and
  `usePodStore.getState()` reset-all. One function, one call site, one set of tests — natural to
  land together.
- **Group B — POD attach visibility (B111 residual + B136 persistence):** B111's remaining online/
  transcode-fallback swallow could route through the _same_ `failedActions`/`OfflineBanner`
  mechanism B143 already built (make the direct `attachPodMut` foreground call go through
  `drainQueue`-style classification, or synthesize a `FailedActionRecord` on its catch) —
  shares `queue-drain.ts`/`offlineQueue.ts` with B143, so touches files B143 already fixed.
  B136 (persist `podStore`) is independent — a `zustand/persist` wrap, same idiom as
  `offlineQueue.ts`/`mileageStore.ts` — but should land in the same PR as the B111 visibility fix
  since both touch the POD capture screens and both are "make POD durable end to end."
- **B143 needs no further code** — only a registry bookkeeping close-out (the map already
  documents it; the bug row does not). Flag this explicitly to S3/the landing coordinator so it
  isn't re-implemented.
