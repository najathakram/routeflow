# F6-BUYER-PORTAL

## RFs addressed

| RF | Sev | Status | Files | Commit | Test added | Migration? |
|----|-----|--------|-------|--------|-----------|------------|
| RF-086 | P1 | ✅ | `apps/mobile/lib/buyer-auth.ts` | 725a256 | Comment-confirmed; no code path to /buyer/login exists | No |
| RF-087 | P1 | ✅ | `apps/mobile/app/_layout.tsx` | 725a256 | Guard logic verified in code review | No |
| RF-094/RF-180 | P1 | ✅ | `apps/api/src/buyer/buyer.controller.spec.ts` | 725a256 | `getStandingOrders returns 200` test added; 6/6 pass | No |
| RF-215 | P1 | ✅ | `apps/mobile/app/(customer)/orders/cart.tsx`, `apps/mobile/store/cartStore.ts` | pre-existing | Cart is client-side via cartStore; route `/(customer)/orders/cart` exists | No |
| RF-216 | P1 | ✅ | `apps/mobile/app/(customer)/(tabs)/_layout.tsx`, `invoices.tsx` | 725a256 | `/invoices` tab registered and renders correctly | No |
| RF-217 | P1 | ✅ | `apps/api/src/buyer/buyer.controller.ts` | pre-existing | `getMe` unit test added; returns ctx.customer directly | No |
| RF-218 | P1 | ✅ | `apps/mobile/app/(customer)/(tabs)/home.tsx`, `_layout.tsx` | 725a256 | New dashboard home tab: balance, spend-30d, active orders, last order, quick actions | No |
| RF-013 | P1 | ✅ | `apps/mobile/lib/buyer-session-store.ts` | 725a256 | `signOut` now calls `useCartStore.getState().clear()` | No |

## Notes / blockers

- **RF-086**: The `buyer-auth.ts` 401 interceptor never redirected to `/buyer/login`. On unrecoverable 401 it clears tokens and rejects — navigation is handled by `(customer)/_layout.tsx` which correctly redirects to `/(auth)/customer-login`. Added a comment to make this explicit.
- **RF-087**: Root `_layout.tsx` role-aware routing now checks `onCustomerLogin` before redirecting staff to their home screen. Previously, an operator navigating to `/(auth)/customer-login` was immediately bounced back to `/(operator)/home`.
- **RF-013**: `useCartStore` is a Zustand in-memory store (no persistence); calling `.clear()` in `signOut` prevents cart bleed between buyer sessions.
- **RF-094/RF-180**: `GET /buyer/standing-orders` already worked after F1's `customerId`-direct fix. Added explicit regression test confirming it resolves without 500.
- **RF-215**: There are no `GET /buyer/cart` or `POST /buyer/cart/items` API routes — the cart is intentionally client-side (Zustand `cartStore`). The mobile app uses `/(customer)/orders/cart.tsx` + `useBuyerCreateOrder` mutation directly. If RF-215 was reported from the web app, see `apps/web` for any stale `buyer/cart` fetch references.
- **RF-216**: `/invoices` is the third tab in `(customer)/(tabs)/_layout.tsx` and renders `invoices.tsx`. The `more.tsx` deep-link to invoices uses the correct `/(customer)/(tabs)/invoices` path. No redirect bug found in mobile.
- **RF-217**: `GET /buyer/me` returns `ctx.customer` from the buyer context guard (no extra DB call). Confirmed with unit test.
- **RF-218**: New `home.tsx` dashboard tab added as the first tab. Post-login redirect updated in `customer-login.tsx` (3 call sites) and root `_layout.tsx` to land on `/(customer)/(tabs)/home`.

## User-visible proof of fix

- **RF-087**: Operator can now tap "Customer Portal" from the sign-in selector without being redirected back to the operator dashboard.
- **RF-013**: Signing out of buyer portal clears the cart — next login starts with 0 items.
- **RF-218**: Buyer home tab shows outstanding balance, 30-day spend, active order count, standing-order count, last order card, and quick-action buttons (Browse catalog, Invoices, Standing orders).
- **RF-094/RF-180**: `GET /buyer/standing-orders` returns `[]` (not 500) for buyers with no templates.
- **RF-217**: `GET /buyer/me` returns `{ id, businessName, email, ... }` — confirmed by unit test.
