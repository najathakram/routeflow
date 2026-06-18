# F8-OPERATOR-UI

## Plan

- **Router architecture**: Mobile app uses Expo Router file-based routing under `apps/mobile/app/`. Operator surfaces live under `(operator)/` with a `(tabs)/` group for bottom-nav screens. Parenthetical groups are transparent in URLs — `(operator)/(tabs)/invoices/[id].tsx` resolves to `/(operator)/invoices/:id`.
- **Web app**: Next.js file-based routing under `apps/web/app/(dashboard)/`. Create-form paths like `/customers/create`, `/products/create`, `/invoices/create` had no page files — they fell through to Next.js 404 while `AuthGuard` kept the spinner alive (~15s) then the RouteGuard redirected to `/dashboard`.
- **Returns empty state (RF-212)**: Default filter was `PENDING`. API statuses include `PENDING`, `APPROVED`, `IN_TRANSIT`, `RECEIVED`, `REFUNDED`, `REJECTED`, `CANCELLED`. The filter chip "Processed" sent `status=PROCESSED` which matches no records. Fixed by defaulting to `ALL` and aligning filter options to real API statuses.
- **Settings tabs (RF-090, RF-213)**: Single-screen settings converted to a four-tab layout (General | Users | Branding | Integrations) using a horizontal chip strip tab bar within the same `index.tsx` — no new routes needed.
- **Timezone (NEW-rweb-7)**: `new Date(isoString)` parses midnight UTC as the previous day in negative-offset timezones. Fix: slice the `YYYY-MM-DD` portion and parse with `/` separators so JS treats it as local time. Applied to both driver and operator home screens.
- **Optimize stops (RF-205)**: Already correctly calls `useOptimizeTemplate` → `POST /routes/:id/optimize`. No change needed.
- **Orders + invoice deep-links (RF-188, NEW-rweb-5)**: Both `(operator)/(tabs)/invoices/[id].tsx` and `(operator)/(tabs)/orders/[id].tsx` already exist and resolve correctly through Expo Router's group-transparent URLs. The web equivalents also exist. No code changes needed.

## RFs Addressed

| RF         | Sev | Status             | Files Changed                                                                                                                         | Commit                                                                                                | Test Added | Migration? |
| ---------- | --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| RF-203     | P0  | ✅ Fixed           | `apps/web/app/(dashboard)/customers/create/page.tsx` (new), `products/create/page.tsx` (new), `invoices/create/page.tsx` (new)        | fix(operator-ui): RF-203 add missing web create-form redirect pages                                   | —          | No         |
| RF-090     | P1  | ✅ Fixed           | `apps/mobile/app/(operator)/settings/index.tsx`                                                                                       | fix(operator-ui): RF-090 add Users tab to Settings                                                    | —          | No         |
| RF-213     | P1  | ✅ Fixed           | `apps/mobile/app/(operator)/settings/index.tsx`                                                                                       | fix(operator-ui): RF-213 add Branding + Integrations tabs to Settings                                 | —          | No         |
| RF-188     | P1  | ⚠️ Already present | `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx` exists                                                                          | —                                                                                                     | —          | No         |
| RF-211     | P1  | ✅ Fixed           | `apps/mobile/app/(operator)/drivers/add.tsx` (new)                                                                                    | fix(operator-ui): RF-211 add /drivers/add redirect to /drivers/new                                    | —          | No         |
| RF-212     | P1  | ✅ Fixed           | `apps/mobile/app/(operator)/returns/index.tsx`                                                                                        | fix(operator-ui): RF-212 fix returns empty state — default ALL filter, align chip IDs to API statuses | —          | No         |
| RF-205     | P1  | ⚠️ Already present | `apps/mobile/app/(operator)/routes/[id].tsx` calls `POST /routes/:id/optimize`                                                        | —                                                                                                     | —          | No         |
| NEW-rweb-5 | P2  | ⚠️ Already present | `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx` resolves via group-transparent URL                                                | —                                                                                                     | —          | No         |
| NEW-rweb-7 | P2  | ✅ Fixed           | `apps/mobile/app/(driver)/route/index.tsx`, `apps/mobile/app/(operator)/(tabs)/home.tsx`, `apps/mobile/utils/dateLocalParse.ts` (new) | fix(operator-ui): NEW-rweb-7 parse scheduledDate as local calendar date to avoid UTC-offset shift     | —          | No         |

## Notes / Blockers

- RF-090 and RF-213 are implemented as an in-screen tabbed layout (chip tabs) rather than separate routes. This avoids deep-link complexity and keeps the Settings screen as a single Expo Router file.
- The `useAdminUsers` hook and `useToggleUserStatus` already existed in `admin.ts` — no new API hooks needed. The "Reset password" button is replaced with an "Activate/Deactivate" toggle as the API has `/users/:id/status` but no `/users/:id/reset-password` endpoint exposed in the mobile client.
- For RF-203 on web: the `redirect()` call in Next.js server components fires immediately (no spinner) and takes the user to the correct modal-opening URL. The `/routes/create` page already existed with a proper form.
- RF-188 and NEW-rweb-5 deep-links are already functional in the mobile app via Expo Router's group-transparent URL resolution. If the original audit tested a stale build this may have appeared broken.
- RF-205 "Optimize stops" — the button calls `handleOptimize()` → `optimizeMut.mutate(id)` → `POST /routes/${id}/optimize`. This was already correct. No change needed.
- NEW-rweb-7 fix also added `apps/mobile/utils/dateLocalParse.ts` as a reusable utility for future callers.

## User-Visible Proof of Fix

| Fix             | Before                                                                                                | After                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| RF-203          | `/customers/create`, `/products/create`, `/invoices/create` → 15s spinner → redirects to `/dashboard` | Instant redirect to `/customers?action=new`, `/products?action=new`, `/invoices/new` — modal opens immediately |
| RF-090 + RF-213 | Settings has one tab (General only)                                                                   | Settings has four tabs: General, Users (with role badges + activate/deactivate), Branding, Integrations        |
| RF-211          | `/drivers/add` → 404                                                                                  | `/drivers/add` → instant redirect to `/drivers/new` form                                                       |
| RF-212          | Returns list defaults to PENDING filter; APPROVED/IN_TRANSIT returns invisible                        | Returns list defaults to ALL; all statuses visible; filter chips match real API statuses                       |
| NEW-rweb-7      | Active run card shows "THURSDAY, APR 29" (yesterday) for a Friday run in UTC-5                        | Shows "FRIDAY, APR 30" — date extracted before timezone conversion                                             |
