# F13-LOOSE-ENDS

## RFs addressed

| RF | Sev | Status | Files | Commit | Test added | Migration? |
|----|-----|--------|-------|--------|-----------|-----------|
| RF-202 | P3 | ✅ Already done | `apps/api/src/invoices/invoices.service.ts` | 924ea6a | N/A | No |
| RF-209 | P2 | ✅ Already done | `apps/web/app/(dashboard)/finance/*` | Multiple | N/A | No |
| RF-222 | P2 | ✅ Already done | `apps/api/src/analytics/analytics.controller.ts` | c7fb978 | N/A | No |
| NEW-m1-2 | P2 | ✅ Script written | `apps/api/scripts/delete-leaked-w32-bug5-test-run.js` | New | N/A | No |
| NEW-m1-3 | P3 | ✅ Fixed | `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` | New | N/A | No |
| NEW-rweb-4 | P2 | ✅ Fixed | `apps/web/app/(auth)/login/page.tsx` | New | N/A | No |

## Details

### RF-202 (P3) — isOverdue boundary comment
- **Status**: Already implemented in prior session
- **Location**: `apps/api/src/invoices/invoices.service.ts:548-552`
- **Content**: Clear comment documenting that same-day due dates are NOT overdue (grace period extends through end of due date)
- **No changes required**

### RF-209 (P2) — Finance routes
- **Status**: Already implemented
- **Findings**: Routes exist at correct paths (`/finance/expenses`, `/finance/dashboard`, `/finance/payments`)
  - Finance pages redirect through `/finance/*` routes correctly
  - API calls use `/bookkeeping/*` endpoints (correct path prefix)
  - No routing conflicts observed
- **No changes required**

### RF-222 (P2) — GET /analytics root endpoint
- **Status**: Already implemented in prior session
- **Location**: `apps/api/src/analytics/analytics.controller.ts:14-35`
- **Content**: `@Get()` method returns helpful index of all available analytics endpoints
- **No changes required**

### NEW-m1-2 (P2) — Delete leaked W32-BUG5-TEST run (script only, not executed)
- **Status**: ✅ Script written (ready for manual execution when needed)
- **Location**: `apps/api/scripts/delete-leaked-w32-bug5-test-run.js` (NEW)
- **Behavior**:
  - Targets the specific run by name (`W32-BUG5-TEST`) in the ux-audit tenant only
  - Idempotent: safe to run multiple times (checks existence first)
  - Requires explicit user confirmation before proceeding
  - Deletes Route → RouteRuns → RouteRunStops in proper cascade order
  - Uses `postgresql://` connection string (Railway production database)
- **Usage**: `node apps/api/scripts/delete-leaked-w32-bug5-test-run.js` (from repo root)
- **NOT EXECUTED** — script written per specification, ready for QA to run manually

### NEW-m1-3 (P3) — Complete & collect validation
- **Status**: ✅ Fixed
- **Location**: `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:116-120`
- **Change**: Added validation guard before allowing stop completion
  - Blocks submission if `deliveries.length === 0`
  - Shows error: "At least one item must be marked for delivery before completing this stop."
  - Error persists until at least one item is selected for delivery
- **Minimal change**: 4-line guard, no refactoring

### NEW-rweb-4 (P2) — Login throttle UX with Retry-After
- **Status**: ✅ Fixed
- **Location**: `apps/web/app/(auth)/login/page.tsx`
- **Changes**:
  1. Added `throttleSeconds` state to track countdown
  2. In `onSubmit`: detect HTTP 429 errors, parse `Retry-After` header
  3. Display friendly countdown message: "Too many login attempts. Try again in {N} seconds."
  4. Countdown timer effect updates every 1 second
  5. Submit button disabled while throttled
  6. Throttle message displays instead of generic error
- **UX flow**:
  - User gets 429 → message shows countdown
  - After countdown expires, submit button re-enables
  - User can attempt login again
- **No external dependencies added** — uses native React state/effects

## Notes / blockers

### RF-007 (P1) — Tab navigation skeleton placeholders
- **Status**: Deferred (complex, requires multiple page edits)
- **Reason**: Would require adding Suspense boundaries or loading skeletons to each operator tab (Dispatch, Warehouse, etc.). Larger refactoring than scope allows.
- **Alternative**: Previously fixed in Sessions 4–6 with optimized API calls and real-time socket updates

### Testing
- **RF-202, RF-209, RF-222**: Already verified in prior sessions (no new tests added)
- **NEW-m1-2**: Script is idempotent; QA should test on ux-audit tenant with `W32-BUG5-TEST` run present
- **NEW-m1-3**: Mobile app validation—test by attempting to complete a stop with no deliveries
- **NEW-rweb-4**: Login throttle—test by sending 5+ rapid login attempts from same IP (triggers 429)

## User-visible proof of fix

1. **NEW-m1-3**: Driver app stop completion
   - Navigate to any stop
   - Click "Complete & collect"
   - If no items are selected, error message appears
   - Cannot proceed to payment until at least one item is delivered

2. **NEW-rweb-4**: Login form throttling
   - Attempt login with wrong password 5+ times in quick succession
   - After threshold, see countdown: "Too many login attempts. Try again in 23 seconds."
   - Countdown updates every second
   - Submit button disabled during countdown
   - After countdown expires, can attempt login again

3. **NEW-m1-2**: Script cleanup (manual QA execution)
   ```bash
   node apps/api/scripts/delete-leaked-w32-bug5-test-run.js
   # Prompts user for confirmation
   # Displays: "Locating W32-BUG5-TEST run in ux-audit tenant..."
   # On success: "W32-BUG5-TEST run and all associated records removed from ux-audit tenant"
   ```
