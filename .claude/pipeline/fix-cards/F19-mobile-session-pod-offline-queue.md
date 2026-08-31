# F19 · Mobile session teardown, POD durability, offline queue

**Bug IDs (8):** B01, B02, B111, B136, B137, B140, B143, B150

**Root cause:** Logout tears down tokens and nothing else. The POD scratchpad is a non-persisted store, so an app restart erases photo/signature/age-ID with no warning (B136); the offline queue survives sign-out and replays under the next person's login (B137); GPS tracking outlives the session (B150); the query cache serves the previous tenant's figures (B140); any 4xx or retry-exhausted action is dropped silently on every role and screen (B143, B111).

**Ships as:** One PR. Two confirmations that shape the fix: offlineQueue.ts persists under a SINGLE GLOBAL AsyncStorage key ("routeflow-offline-queue", :62) with no userId/tenantSlug on QueuedAction (:5) — auth is re-attached at DRAIN time by the interceptor, which is precisely the defect. clearQueue (:59) has ZERO call sites — the API to fix this already exists and was never wired. Stamp identity at enqueue, filter at drain, call clearQueue() from logout.

**Files:** store/podStore.ts · store/offlineQueue.ts · hooks/useNetworkSync.ts · lib/auth-store.ts · lib/buyer-session-store.ts · lib/location-tracker.native.ts · app/_layout.tsx

**Together because:** One sessionTeardown() closes B137, B140 and B150 at once, and one persisted failed[] bucket closes B143 and B111's third drop path.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None. Positional predecessor to F20 (same mobile payment.tsx).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F19.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B01  | T1   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B02  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B111 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B136 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B137 | T1   | 0b2c3a0a       | OUT_OF_BOUNDS       |
| B140 | T1   | 0b2c3a0a       | OUT_OF_BOUNDS       |
| B143 | T1   | 0b2c3a0a       | OUT_OF_BOUNDS       |
| B150 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B01 — Mobile “Remember me” does nothing

**Area:** Sign-in · mobile

**Meant to do:** Let the user opt whether the mobile app should keep them signed in / restore their session automatically on next launch, versus requiring login each time.

**Actually does:** Checkbox toggles a local `rememberMe` boolean that only drives its own checkmark render; `onSubmit` calls `login(data.username, data.password)` with no third argument.

**The gap:** Toggling the checkbox has zero effect on session persistence or login behavior — it is purely decorative.

**Evidence:** apps/mobile/app/(auth)/login.tsx:43 (state), :188-198 (toggle UI), :71-93 esp. line 74 `await login(data.username, data.password)` — no other file references rememberMe (grep confirmed).

**Suggested fix:** Either wire rememberMe into the auth store (e.g. choose persistent vs. session-only token storage) or remove the control so the UI doesn't promise a behavior that doesn't exist.

### B02 — Role-picker screen is unreachable

**Area:** Sign-in · mobile

**Meant to do:** Provide a screen for a dual-role user to choose whether to enter the app as Operator or Driver, e.g. right after login.

**Actually does:** The route file exists and renders, but nothing in the app navigates to `/(auth)/role-picker` — confirmed by a repo-wide grep with zero navigation hits. Its own top-of-file comment states this. Role switching instead happens via a 'Drive mode' row in Operator > More (gated on devMode addon + canActAsDriver) and a 'Switch role / Go to operator view' row in the driver menu.

**The gap:** The dedicated role-picker screen is dead code; the real entry points are two separate settings-menu rows, not a picker screen.

**Evidence:** apps/mobile/app/(auth)/role-picker.tsx:13-16 (self-documenting comment); grep for "role-picker" across apps/mobile returns only the file itself; real switches at apps/mobile/app/(operator)/(tabs)/more.tsx:276-288 and apps/mobile/app/(driver)/driver-menu.tsx:64-78.

**Suggested fix:** Delete role-picker.tsx (or link it from somewhere real) to avoid maintaining an unreachable screen.

### B111 — POD photo attach failures are silently swallowed — photo recorded nowhere

**Area:** POD · mobile driver + API + web

**Meant to do:** A photo the driver captures and sees on screen is retrievable by the office after completion, or at minimum flagged as captured-but-undisplayable.

**Actually does:** Three verified drop paths: transcode-fallback file:// URIs are filtered out of the attach set and the completion payload no longer carries photos; a 4xx attach (rasterize failure → BadRequest) is swallowed by an empty catch and permanently dequeued; 3 failed offline replays drop the action. Web then renders no POD block.

**The gap:** Driver sees normal success; office sees a stop visually identical to one with no POD captured — silent evidence loss.

**Evidence:** apps/mobile/components/PhotoCapture.tsx:46-70 (catch/no-base64 → onAdd(asset.uri)); apps/mobile/app/(driver)/route/stop/[stopId]/photo.tsx:47 (output="data-url"); apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:257 (data:-only filter), :267-269 (empty catch), :278-293 (completion payload carries signatureUrl but no podPhotoUrls); apps/api/src/routes/routes.service.ts:1497-1526 (ingest failure → null), :1580-1581 (null → BadRequestException); apps/mobile/hooks/useNetworkSync.ts:7,22-24 (MAX_RETRIES drop), :55-56 (4xx dequeue); apps/web/app/(dashboard)/routes/[id]/page.tsx:239-245 (hasAnything → render nothing).

**Suggested fix:** Surface attach failures to the driver (toast + retry) and persist a failed-attach marker on the stop (or fall back to sending the data URL inline on the completion, which ingestPodCapture already handles durably) so the office sees 'photo captured, upload failed' instead of nothing.

### B136 — Driver POD — photo, signature, note, age/ID — lives in a non-persisted store, so an app restart erases it

**Area:** Proof of delivery · mobile driver

**Meant to do:** The Photo, Signature and Note tiles show "✓ captured" and the regulated banner promises a verified recipient with a signature; what the driver captures at the door lands on the delivery record.

**Actually does:** All of it sits in a bare in-memory Zustand store keyed by stop id. Any process eviction blanks the tiles; the stop then completes with no POD and no warning, or dead-ends a regulated stop the driver can no longer satisfy.

**The gap:** Evidence captured at the door is never written to disk before submission, so it vanishes without a trace or a warning.

**Evidence:** apps/mobile/store/podStore.ts:26-31 (plain create(), no persist; header comment "In-memory POD scratchpad") vs apps/mobile/store/offlineQueue.ts:29-30 and apps/mobile/store/mileageStore.ts:27-29, both persisted through AsyncStorage; apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:81-82, :160-162, :279-330; signature.tsx:13-14, :17-23, :48-51 (back arrow and Cancel both discard with no prompt); note.tsx:13-14 and photo.tsx:13-14 (same store); payment.tsx:143-144, :226-237 (regulated gate blocks close), :257-270, :285-289, :306 (clearPod); apps/mobile/lib/pod-gating.ts:24-47; apps/api/src/common/regulated-delivery.ts:157-185; git log -S over podStore shows persist was never added.

**Suggested fix:** Wrap usePodStore in Zustand's persist with createJSONStorage(() => AsyncStorage), mirroring offlineQueue and mileageStore, keyed by stop id and cleared on completion as today; add a discard confirmation to the signature screen's back/Cancel when an unsaved stroke exists.

### B137 — The offline queue survives sign-out — queued driver work replays under the next person's login

**Area:** Offline sync · mobile driver

**Meant to do:** Work captured offline belongs to the driver who captured it: it is sent under that driver's identity on reconnect, or the driver is told it could not be sent.

**Actually does:** Queued actions store only endpoint, method, body and headers, and persist across logout. The next staff session's network listener replays them with its own bearer token and tenant slug, and the server resolves the acting driver from that replaying session.

**The gap:** The queue has no owner — authentication is re-attached at drain time by whoever happens to be signed in.

**Evidence:** apps/mobile/store/offlineQueue.ts:5-14 (QueuedAction has no userId/tenantId; the comment says auth is re-attached by the request interceptor), :59 (clearQueue has no caller outside the store and one Jest mock), :61-66 (persisted to AsyncStorage); apps/mobile/lib/api-client.ts:75-81 (interceptor attaches the current token and X-Tenant-Slug), :127-159 (enqueue on network error); apps/mobile/lib/auth.ts:273-292 and lib/auth-store.ts:67-70 (logout leaves the queue); apps/mobile/hooks/useNetworkSync.ts:66-76 (drains on every online event, and the listener fires on subscribe); mounted at apps/mobile/app/(driver)/_layout.tsx:10 and (operator)/_layout.tsx:50; server side, apps/api/src/routes/routes.controller.ts:185-195 (completeStop gated on role only, no per-driver assignment check) and routes.service.ts:1675-1678 (driver resolved from user.sub).

**Suggested fix:** Stamp userId and tenantSlug on every QueuedAction at enqueue time and refuse to replay entries that do not match the current session (surface them for review instead), and call clearQueue() from logout.

### B140 — Mobile sign-out never clears the query cache — the next tenant sees the previous tenant's figures

**Area:** Auth session · mobile

**Meant to do:** Signing out ends the session; the next sign-in on that device shows only the newly authenticated user's tenant data.

**Actually does:** The module-scoped QueryClient survives logout. Untenanted keys such as ["analytics","revenue",from,to] and ["reports","ar-aging"] with a 120-second staleTime serve one tenant's cached numbers into the next session with no refetch.

**The gap:** Tokens and Zustand state are cleared on logout; the cache holding the actual tenant data is not, and its keys carry no tenant identity.

**Evidence:** apps/mobile/app/_layout.tsx:38 (QueryClient created at module scope with no defaults); apps/mobile/lib/auth-store.ts:67-70 and lib/auth.ts:273-292 (neither touches the cache); apps/mobile/lib/api/admin.ts:886-895, :980-993, :1046-1059 — 12 keys at staleTime 120_000 between :818 and :982, none tenant-scoped; apps/mobile/lib/api/addons.ts:24-29 carries an in-repo comment stating the QueryClient is module-scoped and nothing clears it on logout, with the tenant-scoped mitigation applied only there (:43); apps/mobile/app/(customer)/sellers.tsx:48 is the app's only qc.clear(); apps/mobile/lib/tenant-store.ts:81-84 (clear() has zero callers).

**Suggested fix:** Call queryClient.clear() from the staff logout path (export the client from _layout.tsx or hold it in a ref the auth store can reach), and wire useTenantStore.clear() into logout so a stale slug cannot re-key the next session.

### B143 — Offline replay silently drops any 4xx or retry-exhausted action, on every role and every screen

**Area:** Offline queue · mobile all roles

**Meant to do:** Anything done offline either syncs on reconnect or the user is told it failed — the persisted queue and the "N actions queued" badge promise exactly that.

**Actually does:** drainQueue dequeues permanently on any 4xx response and after three failed retries, with no toast, no log and no failed-actions list; the store has no failed bucket to inspect later. For a queued stop completion that means the client shows the stop delivered while the server row stays pending with no POD and no payment.

**The gap:** The badge decrements identically for a synced action and a discarded one, so a lost mutation is indistinguishable from a successful one.

**Evidence:** apps/mobile/hooks/useNetworkSync.ts:22-25 (retries >= MAX_RETRIES → dequeue, no toast), :55-57 (400-499 → dequeue, no toast), :36 (the only showToast in the function, for the CANCELLED-run case), :51, :58; apps/mobile/store/offlineQueue.ts:5-15 (no failure field), :26, :49 (dequeue is a plain filter); apps/mobile/lib/api-client.ts:119-159 (the interceptor enqueues any non-FormData mutating request on a genuine network error, so the scope is app-wide); apps/mobile/app/(driver)/_layout.tsx:10,17 (a passive count is the only queue UI); apps/mobile/lib/api/routes.ts:289-303 (a completion carries podPhotoUrls, signatureUrl and payment on one JSON POST); 403/404 sources that reach this branch: apps/api/src/routes/driver-payments.guard.ts:41-46 and routes.service.ts:1424.

**Suggested fix:** Keep a persisted failed[] bucket in the offline store instead of dropping, surface it as an "N actions failed to sync — review" row beside the queued badge, and show the server's rejection message per action with a retry/discard choice.

### B150 — Driver sign-out never stops the background GPS task — tracking outlives the session

**Area:** Driver GPS tracking · mobile

**Meant to do:** Tapping Sign Out ends location sharing — the persistent notification promises tracking only "while you deliver".

**Actually does:** Logout clears every token bucket but never calls stopLocationTracking; the OS task and its foreground notification keep running until the app is force-quit.

**The gap:** Teardown lives only in a route-screen effect keyed on the active run id; no auth-change or unmount path ever stops the task.

**Evidence:** apps/mobile/lib/location-tracker.native.ts:5-6 (module-global TASK_NAME/activeRunId), :48-71 (startLocationUpdatesAsync with the foreground-service copy), :93-101 (stopLocationTracking); apps/mobile/app/(driver)/route/index.tsx:132-139 (the only stop call site, an effect on active?.id with no cleanup function); apps/mobile/lib/auth-store.ts:67-70 and :97-104 (neither logout nor the session-expired handler stops it); apps/mobile/lib/auth.ts logout(); apps/mobile/app/(driver)/driver-menu.tsx:86; across apps/mobile, startLocationTracking has 3 call sites and stopLocationTracking exactly 1.

**Suggested fix:** Call stopLocationTracking() inside useAuthStore.logout and the session-expired handler, and reset the module-global activeRunId there so no stale run id survives a session change.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
