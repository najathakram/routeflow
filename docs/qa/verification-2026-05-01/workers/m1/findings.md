# m1

| RF | Status | Evidence (≤ 30 words) |
|-----|--------|----------------------|
| RF-004 | ✅ VERIFIED | ux_driver_b navigating to ux_driver_a stop UUID `07c4bc82-…` shows "Stop not found. It may have been removed from your route." — access correctly denied. |
| RF-005 | ⛔ BLOCKED | All driver stops in ux-audit tenant are DELIVERED. Cannot enter payment flow to test offline disconnect. See NEW-m1-1. |
| RF-006 | ⛔ BLOCKED | All driver stops are DELIVERED. "Complete & collect" button present but no-ops (no API call fires). Items can't be checked due to React crash #185. |
| RF-016 | ⚠️ PARTIAL | Route does NOT auto-flip on last stop delivery. Driver must manually tap "Mark route complete" → confirms modal → UI transitions to next run. Server-side status verified only by IN_PROGRESS list disappearing. |
| RF-019 | ⛔ BLOCKED | All stops DELIVERED. Cannot reach payment submission screen for double-tap test. |

## Failures

### RF-016 — Route auto-complete behavior

**Repro**: Driver B had 1/1 stops Delivered. Route status still showed "On route". "Mark route complete" button required.

**Expected (RF spec)**: ParentRouteRun auto-flips to COMPLETED when last stop is completed.

**Got**: Route stays IN_PROGRESS after last stop delivered. "All stops done! 1 of 1 delivered" + "Mark route complete" CTA shown. Only after driver manually taps and confirms does the run complete.

**Suspected cause**: Server-side auto-complete hook either missing or not triggered by stop status change alone; UI correctly reflects server state.

**Proposed fix**: Add a server-side trigger that auto-transitions RouteRun to COMPLETED when all stops reach DELIVERED, or document manual confirmation as intended design.

## Adjacent bugs noticed

- NEW-m1-1 [P1] React crash (Error #185 — maximum update depth exceeded) on clicking any item checkbox on an already-DELIVERED stop; page goes white. Repro: ux_driver_b → delivered stop → tap any item checkbox. Console: `Minified React error #185`. This blocks RF-005, RF-006, RF-019.
- NEW-m1-2 [P2] ux_driver_b has a second run (W32-BUG5-TEST, 0 stops, Scheduled) that surfaced after completing Route B — zero-stop run could be accidentally started by driver.
- NEW-m1-3 [P3] "Complete & collect" on a DELIVERED stop silently no-ops when items unchecked; no validation message shown and no API call fired.
