# G1

## Plan

- **Root cause identified**: In the Expo web bundle, navigating to `/routes/create`, `/customers/create`, `/products/create`, or `/invoices/create` triggers the `[id].tsx` dynamic segment (since no static `create.tsx` existed). Each detail screen calls `useAdminRoute("create")` / `useCustomer("create")` etc., which fire `GET /routes/create` → 404. After React Query exhausts retries, `isLoading` is `false` but `data` is `undefined`. The `if (isLoading || !data)` spinner guard never clears → permanent spinner with "Route" / "Customer" / "Product" / "Invoice" header.
- **Primary fix — static route files**: Added explicit `create.tsx` files at each problematic path (`routes/create.tsx`, `customers/create.tsx`, `products/create.tsx`, `(tabs)/invoices/create.tsx`). These files re-export the corresponding `new.tsx` default export. In Expo Router, static segment files always win over `[id]` dynamic segments, so the form renders immediately with zero API calls.
- **Secondary fix — defensive guard in `[id].tsx`**: Added `isCreateAlias` check + `useEffect` redirect in each of the four `[id].tsx` detail screens. If "create" somehow reaches the detail screen (e.g. hot-reload race, stale bundle), the query is disabled via `enabled: !!id` (empty string passed instead of "create") and the user is redirected to `new.tsx` via `router.replace`.
- **Invoice `new.tsx` added**: The invoices flow had no `new.tsx` equivalent in mobile. Created `(tabs)/invoices/new.tsx` with a minimal form (customer ID + notes) so the `create.tsx` re-export has something to point to.
- **Tests added**: 31 new unit tests in `__tests__/operator-create-forms.test.ts` covering: create-alias detection logic, query-enabled guard, `buildProductPayload` validation, `emptyProductForm`/`emptyCustomerForm` synchronous init, route/invoice name validation — all confirming the create flows are synchronous and data-fetch-free. All 43 mobile tests pass.

## RFs addressed

| RF     | Sev | Status | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Commit                                                              | Test added                                      | Migration? |
| ------ | --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| RF-203 | P1  | Fixed  | `apps/mobile/app/(operator)/routes/create.tsx` (new), `apps/mobile/app/(operator)/customers/create.tsx` (new), `apps/mobile/app/(operator)/products/create.tsx` (new), `apps/mobile/app/(operator)/(tabs)/invoices/create.tsx` (new), `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx` (new), `apps/mobile/app/(operator)/routes/[id].tsx` (guard), `apps/mobile/app/(operator)/customers/[id].tsx` (guard), `apps/mobile/app/(operator)/products/[id].tsx` (guard), `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx` (guard) | `fix(operator-ui): RF-203 — Expo Create forms render synchronously` | Yes — `__tests__/operator-create-forms.test.ts` | No         |

## Notes / blockers

- The `apps/web` already had its own fix for RF-203 (commit `f3c568b`) via Next.js redirect pages — the Expo surface needed a separate fix since it uses Expo Router, not Next.js.
- Invoice creation on mobile is intentionally minimal (customer ID + notes) since the full multi-line invoice editor lives in the web app. The mobile form exists to unblock the spinner; operators who need advanced invoice editing use the web.
- No API changes required; all fixes are in the Expo app routing layer.
- The `jest.config.js` already existed but `devDependencies` (`jest`, `jest-expo`, `@testing-library/react-native`, `babel-jest`) were added. The test config uses `ts-jest` + Node environment (no JSX transform needed) following the same pattern as existing tests.

## User-visible proof of fix

Navigating to `/routes/create`, `/customers/create`, `/products/create`, or `/invoices/create` in the Expo web bundle now renders the corresponding create form immediately with interactive input fields — no spinner.
