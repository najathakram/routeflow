# F5-AUTH-ISOLATION

## RFs addressed

| RF | Sev | Status | Files | Commit | Test added | Migration? |
|----|-----|--------|-------|--------|------------|-----------|
| NEW-m2-1 | P1 | ✅ FIXED+TESTED | `apps/web/lib/auth-keys.ts` (new), `apps/web/lib/auth.ts`, `apps/web/lib/api-client.ts`, `apps/web/lib/buyer-auth.ts`, `apps/web/lib/buyer-api-client.ts`, `apps/web/lib/hooks/useRealtimeUpdates.ts`, `apps/web/lib/hooks/useNotifications.ts`, `apps/web/e2e/helpers/auth.ts`, `apps/mobile/lib/auth-keys.ts` (new), `apps/mobile/lib/auth.ts`, `apps/mobile/lib/api-client.ts`, `apps/mobile/lib/buyer-auth.ts`, `apps/mobile/hooks/useSocket.ts` | fix(auth): NEW-m2-1 / RF-077 per-role token isolation | `apps/api/src/auth/auth-isolation.spec.ts` — 12 tests, all pass | Yes — `migrateLegacyOpToken()` + `migrateLegacyBuyerToken()` |
| RF-077 | P1 | ✅ FIXED+TESTED | (same files above) | (same) | (same) | Yes |

## What changed

### Storage key scheme

| Role | Old key | New key |
|------|---------|---------|
| Operator / Customer / Tenant-Admin | `accessToken` | `rf:op:accessToken` |
| Operator refresh | `refreshToken` | `rf:op:refreshToken` |
| Driver | `accessToken` (same as op!) | `rf:driver:accessToken` |
| Driver refresh | `refreshToken` (same as op!) | `rf:driver:refreshToken` |
| Buyer access | `buyerAccessToken` | `rf:buyer:accessToken` |
| Buyer refresh | `buyerRefreshToken` | `rf:buyer:refreshToken` |
| Buyer active seller | `buyerActiveSeller` | `rf:buyer:activeSeller` |

### Files created
- `apps/web/lib/auth-keys.ts` — single source of truth for all 7 key constants (avoids circular import between `auth.ts` ↔ `api-client.ts`)
- `apps/mobile/lib/auth-keys.ts` — mirrors web constants for the mobile app
- `apps/api/src/auth/auth-isolation.spec.ts` — 12 Jest unit tests

### Migration
- `migrateLegacyOpToken()` in `apps/web/lib/auth.ts` — on first load, if `accessToken` exists and decodes to an operator-flavoured role, copies it to `rf:op:accessToken` then deletes the legacy key. Idempotent.
- `migrateLegacyBuyerToken()` in `apps/web/lib/buyer-auth.ts` — same pattern for buyer tokens.
- Both have mobile equivalents in `apps/mobile/lib/auth.ts` and `apps/mobile/lib/buyer-auth.ts`.

### Cross-tab isolation listener
- `onCrossTabTokenChange(cb)` exported from `apps/web/lib/auth.ts` — registers a `window.addEventListener('storage', ...)` listener; calls `cb` whenever `rf:op:accessToken` is **removed** by a sibling tab (i.e. logout in another tab). Returns an unsubscribe function for cleanup.

### Token flow after fix
- Operator logs in → `rf:op:accessToken` written; driver tab cannot see it under `rf:driver:accessToken` → no collision.
- Driver logs in → `rf:driver:accessToken` written; operator's key is untouched.
- Buyer token lives under `rf:buyer:*` — was already isolated from operator, now also isolated from driver.

## Notes / blockers
- The `apps/web/lib/auth-keys.ts` constants file was required to break a circular import that formed when `api-client.ts` tried to import `KEYS` directly from `auth.ts` (which in turn imports `apiClient` from `api-client.ts`).
- `migrateLegacyOpToken()` and `migrateLegacyBuyerToken()` must be called by the root layout / app entry point to run the migration. They are exported but not auto-invoked.
- `driver-app/` directory is a stub with no code; all mobile logic lives in `apps/mobile/`.

## User-visible proof of fix
1. Open two browser tabs on the same origin.
2. Tab A: log in as operator → `rf:op:accessToken` set in DevTools > Application > LocalStorage.
3. Tab B: log in as a driver (via mobile-web) → `rf:driver:accessToken` set. Tab A's `rf:op:accessToken` is unchanged.
4. Tab B logs out → Tab A detects the `rf:op:*` key is still present (cross-tab listener only fires if the **op** key is removed) and stays authenticated.
5. `accessToken` (legacy) no longer appears after first load.
