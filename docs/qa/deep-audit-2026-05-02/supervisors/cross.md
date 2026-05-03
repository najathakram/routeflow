# CROSS squad — synthesis

## Top 5 product P0/P1

1. **BUG-XR1-4 (P1) — Stale driver token hijacks operator session → redirects to /route**: When both `rf:driver:accessToken` and `rf:op:accessToken` exist in localStorage, `getStoredUser()` can return the driver slot, routing an operator to the driver view and clearing their tokens. Breaks the operator flow entirely. Fix: clear DRIVER_KEYS on successful operator login, or enforce role-preference (OPERATOR wins) in the router guard.

2. **BUG-XR1-3 (P1) — Cross-tab logout not detected — tab B stays authenticated**: No `storage` event listener in `auth-store.ts`, `useSocket.ts`, or `useBuyerSocket.ts`. After logout in tab A, tab B remains fully functional with live tokens until a manual reload — a real session-persistence security gap. Fix: dispatch `StorageEvent` on `logout()` and subscribe in `useAuthStore`.

3. **BUG-XR2-1 (P1) — DIV buttons have no focus ring (keyboard invisible, WCAG 2.4.7)**: Every action button rendered as `<div tabindex="0">` has `outline-style: none; box-shadow: none` on focus. Keyboard-only and switch-access users cannot see what is focused anywhere in the app. Fix: add `focus-visible:ring-2` globally to interactive DIV components.

4. **BUG-XR2-2 (P1) — All form inputs missing aria-label / `<label>` — screen-reader blind**: Nine inputs on `/customers/new` (and likely every form) have `ariaLabel=null`, `id=""`, `hasLabelEl=false`. Screen readers announce nothing useful. Fix: add `aria-label` to every `TextInput`.

5. **BUG-XR1-2 (P2) — Stale buyer token opens orphan buyer socket on operator pages**: `logout()` only clears OP_KEYS and DRIVER_KEYS; BUYER_KEYS persist. `useBuyerSocket` fires on every page mount, creating a live buyer WebSocket connection under the operator's session and leaking buyer identity to the API socket namespace.

## Counts

| Severity | Bugs |
|----------|------|
| P0 | 0 |
| P1 | 4 |
| P2 | 5 |
| P3 | 0 |

## Counts by category

| Category | Bugs |
|----------|------|
| a11y | 3 (BUG-XR2-1, BUG-XR2-2, BUG-XR2-3) |
| security | 2 (BUG-XR1-2, BUG-XR1-3) |
| flow-broken | 1 (BUG-XR1-4) |
| concurrency | 2 (BUG-XR1-1, BUG-XR1-2) |
| ux | 2 (BUG-XR2-4, BUG-XR2-5) |

*(BUG-XR1-2 counted in both security and concurrency; total unique bugs = 9)*

## Verdict: HOLD

Two P1 security/auth defects (stale driver token hijacks operator routing; cross-tab logout gap) and two P1 a11y defects (invisible focus ring; no aria-labels on any form inputs) must be fixed before ship. The auth bugs are confirmed via source-code review on production and cannot be dismissed as environmental.

## Pattern observation

The auth layer (`auth.ts` / `useAuthStore`) was designed for single-role, single-tab use and has no cross-key cleanup or cross-tab signalling — every CROSS bug traces back to that same root gap.

## BLOCKED scenarios (informational)

- cross-1 scenario#1 — order.created Socket.IO push to operator /orders list — auth throttled (429), no operator session available
- cross-1 scenario#2 — buyer dashboard outstanding-balance live update — auth throttled
- cross-1 scenario#3 — driver /route live update on new dispatch — auth throttled
- cross-1 scenario#5 — checkout price tier snapshot vs re-fetch — auth throttled
- cross-2 scenario#4 — RTL text input on /customers/new — auth throttled (no operator session)
- cross-2 scenario#5 — 5000-char paste into order Notes field — auth throttled
- cross-2 scenario#6 — back-button re-submit guard — auth throttled; suspected safe (SPA) but unconfirmed
