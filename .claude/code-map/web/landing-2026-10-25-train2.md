# Web landing 2026-10-25, train 2 (#3764 `6970f9d73`, #3783 `d25cf5e64`; merge `be47146b3`)

Paths under `apps/web/`. Window = `6395541ab..be47146b3`. Tests not indexed. Api part: `api/landing-2026-10-25-train2.md`.

## #3783 `d25cf5e64` browser-clock today moves to the tenant's day at 7 sites (SA-964 §4)
- `lib/tenant-timezone.ts` gains `useOnTenantToday(apply, enabled?)`: seeds a date field ONCE when the tenant zone resolves (`apply` writes only into an empty field; the field starts empty so nothing is shown or saved on the browser's day while loading) and returns the tenant's day, or `undefined` while unknown.
- Prefill-and-save sites: `finance/expenses/new/page.tsx` (single, mileage, bulk rows; submit asks for a date if still empty), `deliveries/new/page.tsx`, `routes/page.tsx` run dialog, `routes/templates/[id]/page.tsx` run dialog (Dispatch and Send wait for a date).
- Display sites: `vendor-bills/[id]/page.tsx` overdue flag, `customers/_components/AuthorizationsTab.tsx` and `orders/_components/LicenseGuardModal.tsx` expiry (unknown zone: the server judges), the routes list "Today" label.
- Pin (OP-7): `lib/browser-clock-today.pin.test.ts` counts browser-clock idioms per file, shrink-only. Left in its baseline: `vendor-bills/page.tsx` (open PR #3742), the buyer licenses page (a buyer token cannot read /settings), and the prefills outside §4's ten.

## #3764 `6970f9d73` neutral coded 409 copy
- `lib/generic-toast-copy.ts`: toast copy for `PRODUCT_CHANGED_CONCURRENTLY` ("This product changed while you were saving it. Reload it and try again.").
