# m2

| RF     | Status      | Evidence (≤ 30 words)                                                                                                                                                                            |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RF-009 | ⚠️ PARTIAL  | No push/notification/token API call on operator web login. Zero calls to register-push-token endpoint. Graceful web no-op; native untestable.                                                    |
| RF-018 | ⚠️ PARTIAL  | "Forgot?" link on staff login triggers modal: "Please contact your dispatcher to reset your password. Self-serve reset is coming soon." No API call fired.                                       |
| RF-074 | ⛔ BLOCKED  | M1 driver tabs continuously overwrite shared accessToken localStorage key, preventing stable operator session. Customer create returns "Forbidden resource".                                     |
| RF-197 | ⛔ BLOCKED  | Same as RF-074 — cannot create/delete customer due to shared localStorage session collision with M1 worker.                                                                                      |
| RF-079 | ✅ VERIFIED | "Tax exempt" toggle visible in New Customer form (Billing section, between Currency and Delivery Window). DOM confirmed via screenshot.                                                          |
| RF-080 | ⛔ BLOCKED  | Operator customer list unreachable due to M1/M2 localStorage collision. Cannot test bulk-select UI.                                                                                              |
| RF-083 | ✅ VERIFIED | Driver token (ux_driver_b, DRIVER role) navigating to /customers immediately redirects to /route. No customer PII exposed to driver role.                                                        |
| RF-228 | ⚠️ PARTIAL  | Two operator sessions coexist in same browser (M1+M2). No server-side kickout. Last writer wins in localStorage; React in-memory state persists briefly. No "session invalidated" message shown. |

## Failures

### RF-018 — Self-service password reset absent

Repro: Staff & Drivers login → enter company code → click "Forgot?"
Expected: Email-based reset flow with API call to /auth/request-password-reset.
Got: Modal: "Please contact your dispatcher to reset your password. Self-serve reset is coming soon." Zero API requests fired. No email path exists.
Suspected cause: Feature not implemented; placeholder UX only.
Proposed fix: Implement /auth/request-password-reset endpoint and email delivery; wire "Forgot?" to email input → API call → confirmation copy.

### RF-009 — Push notifications not registered on web

Repro: Login as operator on Expo web build, observe network panel.
Expected: Graceful skip OR attempt to call save-push-token endpoint.
Got: Zero network calls to any push/notification/token endpoint post-login.
Suspected cause: Expo push notifications unsupported on web; app correctly skips registration.
Proposed fix: PARTIAL acceptable — web can't get APNs/FCM tokens. Add explicit platform guard comment. Verify native mobile path registers tokens correctly.

### RF-228 — No concurrent session limit

Repro: Two tabs logged in as operator (same credentials), perform action on original tab after second login.
Expected: Original session revoked or warned "You've been signed in elsewhere."
Got: Both sessions coexist. M1 driver sessions overwrite accessToken in localStorage; original tab retains in-memory React auth state until next navigation. No server-side session invalidation, no user notification.
Suspected cause: No server-side token revocation; localStorage last-write-wins.
Proposed fix: Implement server-side token revocation or short-lived token rotation; add storage event listener in app to detect cross-tab token changes and prompt re-auth.

### RF-074 / RF-197 — DELETE /customers: BLOCKED by env

Repro: Operator creates new customer, attempts delete.
Got: Cannot maintain stable operator session — M1 driver worker continuously overwrites shared accessToken in localStorage (same origin, same key). POST /customers returns "Forbidden resource" toast when driver token is active.
Note: /customers page loads (HTTP 200, empty list) with correct operator token. No 500. Pure session contention between workers.

### RF-080 — Bulk delete customers: BLOCKED

Same root cause as RF-074 — cannot reach /customers list with stable operator session to observe bulk-select UI.

## Adjacent bugs noticed

- NEW-m2-1 [P1] Operator and driver apps share `accessToken` localStorage key on same origin — concurrent tabs cause silent cross-role session overwriting with no error or warning to user.
- NEW-m2-2 [P2] POST /customers toast shows "Forbidden resource" with no HTTP status detail — error copy too generic; should be "Unauthorized — insufficient role" or similar.
- NEW-m2-3 [P3] Programmatic DOM value set does not trigger React onChange in customer form — save silently no-ops; only keyboard type events work for form submission.
