# G2

## Diagnosis (3-5 bullets)

- **Root cause 1 (buyer socket key mismatch):** `useBuyerSocket.ts` read the buyer JWT from the legacy `"buyerAccessToken"` key (lines 31, 34). After the NEW-m2-1 / RF-077 token-isolation work, `buyer-auth.ts` persists the buyer token to `BUYER_KEYS.accessToken` = `"rf:buyer:accessToken"`. The legacy key is empty on a fresh login, so `token` was always `null`, and `io()` was never called.

- **Root cause 2 (Google OAuth callback writes wrong keys):** `google-callback.tsx` (the deep-link safety-net handler for web) wrote buyer tokens to `"buyerAccessToken"` and staff tokens to the flat `"accessToken"` keys — the pre-RF-077 legacy keys — instead of `BUYER_KEYS.accessToken`, `OP_KEYS.accessToken`, or `DRIVER_KEYS.accessToken`. Any user who authenticated via Google on web would land with tokens in the legacy slots, which the socket hooks (and API client interceptor) don't read.

- **Root cause 3 (operator/driver hooks correct, but only after initial render):** `useSocket.ts` correctly uses `OP_KEYS.accessToken` / `DRIVER_KEYS.accessToken` after the RF-077 update. The wiring in `(operator)/_layout.tsx` and `(driver)/_layout.tsx` is correct — `useSocket()` is called at layout mount with `user` as the effect dependency. No issue on the operator/driver path for normal username+password login.

- **No missing layout wiring:** All three role layouts call the appropriate socket hook at the correct level: operator → `useSocket()`, driver → `useSocket()`, buyer → `useBuyerSocket()`. The gateway on the API side rooms users correctly by role from the JWT `role` claim, so no API changes are required.

- **`creditNote.created` event unhandled in buyer hook:** The gateway emits `creditNote.created` to `customer:{id}` rooms but `useBuyerSocket` had no handler, so credit note state in the buyer portal would never auto-refresh. Added handler as part of this fix.

## RFs addressed

| RF     | Sev | Status | Files                                                                               | Commit                                                                   | Test added                                          | Migration? |
| ------ | --- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- | ---------- |
| RF-002 | P0  | Fixed  | `apps/mobile/hooks/useBuyerSocket.ts`, `apps/mobile/app/(auth)/google-callback.tsx` | fix(realtime): RF-002 — wire Socket.IO at Expo router root for all roles | Yes — `apps/mobile/__tests__/socket-wiring.test.ts` | No         |

## Notes / blockers

- The operator and driver socket wiring (`useSocket`) was already correct for username+password login flows. Only the buyer hook and the Google OAuth fallback handler were broken.
- The `migrateLegacyBuyerToken()` function in `buyer-auth.ts` correctly moves `"buyerAccessToken"` → `"rf:buyer:accessToken"` on first app start, but this migration only runs when `getStoredBuyer()` is called during `initialize()`. If a user had an existing session from before the RF-077 rollout AND never restarted the app, they would have been migrated. New logins go directly to the namespaced key via `buyerLogin()`. The Google OAuth fallback path was the only new-session path that still wrote to the legacy slot.
- The `expo-secure-store` package (native-only) is correctly mocked out for the jest test environment. Tests run against the web (localStorage) path; the native path follows identical logic.
- No Railway migration required — no schema changes, API gateway untouched.

## User-visible proof of fix

1. **Buyer portal:** After logging in as a buyer (email+password or Google OAuth on web), Socket.IO now establishes a WSS connection to `tenant:{tenantId}:customer:{userId}`. When the operator changes an order status, the buyer's order list and dashboard update in real time without pull-to-refresh.
2. **Operator portal:** Already working; confirmed by reviewing `(operator)/_layout.tsx` and `useSocket` key usage.
3. **Driver portal:** Already working; confirmed by reviewing `(driver)/_layout.tsx` and `useSocket` key usage with `DRIVER_KEYS.accessToken`.
4. **Test evidence:** `apps/mobile/__tests__/socket-wiring.test.ts` — 8 tests covering: operator token read (namespaced key), driver token read (namespaced key), no-connect when token absent, no cross-role key fallback, buyer token read (namespaced key), regression guard for legacy `buyerAccessToken` key, no-connect when buyer is null. All 12 tests in the mobile test suite pass.
