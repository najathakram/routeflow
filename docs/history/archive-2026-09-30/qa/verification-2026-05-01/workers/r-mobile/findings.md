# r-mobile

Headline: ⚠️ FLOW DEGRADED — Login, route navigation, stop entry, and payment UI all reachable; payment submission blocked by missing refresh token on web.

| Step                                 | Status | Notes                                                                                                                                                 |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Resize 375x667 + navigate sign-in | ✅     | Window resized; /sign-in loaded; "Staff & Drivers" option visible                                                                                     |
| 1b. Select Staff & Drivers           | ✅     | Company code screen shown correctly                                                                                                                   |
| 1c. Enter tenant + credentials       | ⚠️     | Rate-limited (ThrottlerException 429) on first attempt; backed off 90s; succeeded on retry                                                            |
| 2. Confirm driver runs/routes screen | ✅     | Landed on /route — "Today's Route · UX Route A (assigned) · On route"                                                                                 |
| 3. Find today's Route A run          | ✅     | UX Route A present and assigned; status "On route"; 5 stops visible                                                                                   |
| 4. Tap "Start run"                   | ⚠️     | Run already "On route" from prior QA session; no "Start run" button shown                                                                             |
| 5. Open first stop                   | ✅     | Stop 1/5 "UX Empty Cafe" opened; $207.72 due; items list + POD section visible                                                                        |
| 5b. Mark items delivered             | ⚠️     | Item radio buttons not toggleable (display-only); "Complete & collect" CTA proceeds to payment                                                        |
| 6. Signature capture                 | ⚠️     | Signature button visible in POD section; not tested (skipped to payment flow)                                                                         |
| 7. Record CASH payment $208          | ❌     | Payment UI opened; $208 entered; "Receive payment & close" shows "No refresh token" toast; only OPTIONS 204 preflight seen in network — no POST fired |
| 8. Verify stop COMPLETED/DELIVERED   | ⚠️     | Route list already shows stop "Delivered" (pre-existing); stop detail still re-enterable — state mismatch                                             |

## Anomalies (NEW findings)

- **NEW-rmob-1 [P1]** "No refresh token" blocks all payment submission on web — "Receive payment & close" (Cash, $208) consistently shows toast "No refresh token"; app fires only CORS OPTIONS preflight (204), never the real POST to `/api/v1/route-runs/{id}/stops/{id}/complete`. localStorage and sessionStorage are both empty; refresh token is not persisted on web. Reproduces 100%.
- **NEW-rmob-2 [P2]** Stop item checkboxes are non-interactive (display-only) — The 9 item radio buttons on the stop detail screen do not respond to tap/click; no visual state change on interaction. Items appear decorative rather than functional on web viewport.
- **NEW-rmob-3 [P2]** Route list shows all stops "Delivered" but stop detail still fully interactive — Route summary shows "All stops done! 5/5 delivered" yet tapping any stop opens the full delivery workflow (unchecked items, Complete & collect, Skip stop, Partial return). Stop state inconsistent between list view and detail view.
- **NEW-rmob-4 [P3]** "Start run" step missing — run pre-started, no fresh run available — ux_driver_a's route already in "On route" from prior QA seed. Happy path "Start run" could not be exercised; no UI path visible to reset or create a fresh run.
- **NEW-rmob-5 [P3]** Rate limit hit on first login (ThrottlerException: Too Many Requests) — First sign-in returned 429. 90s backoff per spec; succeeded on retry. Rate limiter fires quickly (~5 req/5 min).
- **NEW-rmob-6 [P3]** expo-notifications web warning on every page load — Console warning: "Listening to push token changes is not yet fully supported on web." Not user-visible; push notification listener wires up unnecessarily on web.

## Blockers

**Step 7 (Cash payment)**: "No refresh token" — stop completion is fully blocked at payment submission. App cannot refresh auth on web (no persistent storage in incognito tab context); only OPTIONS preflight fires, never the POST.
