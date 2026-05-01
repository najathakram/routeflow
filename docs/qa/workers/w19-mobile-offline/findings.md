# W19 — Mobile Offline Queue & Sync Audit Findings

## Summary
QA audit of the RouteFlow mobile offline queue and sync system identified **6 significant bugs** affecting data consistency, user experience, and error recovery.

---

## Findings

### W19-001 — Unbounded Queue Growth
- **Severity:** P1
- **File:** `apps/mobile/store/offlineQueue.ts:33-44`
- **Issue:** The offline queue has no maximum size limit. A device that remains offline indefinitely will accumulate unlimited queued actions in AsyncStorage, potentially exhausting device storage.
- **Evidence:** No size check before appending to queue; no TTL on queued items.
- **Fix:** Implement a maximum queue size (e.g., 500 items) and discard oldest items when exceeded. Also add a TTL (e.g., 24h) to remove stale items.

---

### W19-002 — Silent Discard of Non-Retriable Client Errors
- **Severity:** P1
- **File:** `apps/mobile/hooks/useNetworkSync.ts:32-33`
- **Issue:** When a queued action fails with a 4xx client error (e.g., 404 for a deleted stop, 409 for a conflict), it is silently dequeued without notifying the user. The driver is never informed that their action failed and was abandoned.
- **Evidence:** Comment on line 31 acknowledges this ("CRIT-05: Discard non-retriable client errors"), but there is no user notification.
- **Impact:** Example: Driver completes a stop offline → operator cancels that stop while offline → queue replays → 404 error → silent discard → driver never knows their completion was rejected.
- **Fix:** Notify the user via toast/banner. Store failed actions separately so they can be reviewed or retried with operator intervention.

---

### W19-003 — POD Store Not Persisted Across App Crashes
- **Severity:** P2
- **File:** `apps/mobile/store/podStore.ts:16-36`
- **Issue:** The POD store (photos, signature, notes for a stop) is in-memory only (no AsyncStorage persistence). If the app crashes after the driver captures a signature but before completing the stop, all POD data is lost.
- **Evidence:** No `persist()` middleware, unlike `offlineQueue.ts` and `mileageStore.ts`.
- **Impact:** Driver captures signature, app crashes, relaunches → signature is gone → driver must re-sign.
- **Fix:** Wrap `usePodStore` with Zustand's `persist()` middleware and AsyncStorage.

---

### W19-004 — No User Feedback on Sync Failures
- **Severity:** P2
- **File:** `apps/mobile/hooks/useNetworkSync.ts:12-42`
- **Issue:** The sync hook silently discards failed actions with no toast, alert, or banner feedback. The driver has no visibility into whether queued actions succeeded or failed on replay.
- **Evidence:** No `showToast()` calls on errors or MAX_RETRIES exceeded.
- **Impact:** Bad offline UX. Driver doesn't know if "3 actions queued" actually replayed successfully.
- **Fix:** Call `showToast()` when actions are abandoned (4xx or MAX_RETRIES exceeded). Show summary feedback.

---

### W19-005 — Dependency Array Triggers Repeated Effect Registration
- **Severity:** P1
- **File:** `apps/mobile/hooks/useNetworkSync.ts:44-53`
- **Issue:** The `useEffect` dependency array includes `[queue]`. Since `drainQueue()` calls `incrementRetry()` which updates queue state, the effect re-runs every time an item is retried, causing the NetInfo listener to be re-registered repeatedly.
- **Evidence:** Each retry increments the queue state, triggering the effect to re-register the listener.
- **Impact:** Wasteful listener re-registration on each retry. Creates fragility if `syncing.current` is ever cleared externally.
- **Fix:** Remove `queue` from the dependency array. Register the listener once. Read queue state inside the listener callback, not from the effect closure.

---

### W19-006 — No Backoff on Retry Attempts
- **Severity:** P2
- **File:** `apps/mobile/hooks/useNetworkSync.ts:35-36`
- **Issue:** Items that fail with retriable errors (5xx, network errors) are retried immediately with no backoff strategy. If the device regains partial connectivity (WiFi connected but no internet), the sync hook will repeatedly attempt to send all queued items immediately, consuming data and battery.
- **Evidence:** `incrementRetry()` is called, but retry is attempted again immediately on next sync trigger (next NetInfo event).
- **Impact:** Aggressive retry on weak connectivity drains battery and hammers server.
- **Fix:** Implement exponential backoff (1s, 2s, 4s delays). Add per-item retry timestamp to prevent immediate re-attempts.

---

## Non-Issues (As Designed)

### ✓ Queue Persistence
The offline queue correctly uses AsyncStorage and survives app restarts.

### ✓ Queue Replay Order
Actions are replayed in FIFO order (insertion order preserved).

### ✓ Mileage Store Persistence
Correctly persisted to AsyncStorage.

### ✓ Server-Side Conflict Detection
Server rejects duplicate stop completions with BadRequestException (400). Mobile client treats as 4xx and discards (though silently — see W19-002).

---

## Summary Table

| ID | Severity | Category | Fix |
|---|---|---|---|
| W19-001 | P1 | Data Loss | Max queue size + TTL |
| W19-002 | P1 | UX | Notify user on permanent failure |
| W19-003 | P2 | Data Loss | Persist POD store |
| W19-004 | P2 | UX | Show toast on failures |
| W19-005 | P1 | Reliability | Fix effect dependency array |
| W19-006 | P2 | Performance | Add exponential backoff |

