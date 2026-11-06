# Web landing 2026-11-03, train aj (merge commit `9dfd480c30`, range `d6d5c56cb1..9dfd480c30`; train PR #4156, train head `4dfc961d20`)

Web paths under `apps/web/` unless they start with `apps/mobile/` or `apps/api/`. Five members: #4148 `1bc04b9457`, #4147 `7c4d435832` (docs only), #4150 `2596cae347` (api only, see `api/landing-2026-11-03-aj.md`), #4151 `929d80453a`, #4152 `8a5019a3a0`. No migration, no new env var, no cron, plan flag or addon gate. Tests are names only; they were not run for this note.

## #4148 `1bc04b9457` opening a card or question never moves the page (owner reports 2026-11-03)

Rule: arriving on `/#section` lands on the section as soon as the page can be laid out, and nothing on the home page scrolls the person to the top.

- `public/site/home.html`: a small inline script moves to the hash target when the page is laid out and re-aligns after each layout change.
- `public/site/js/home-up.js`: the three `once: true` ScrollTriggers (sample cards, founder, pricing grid) use `toggleActions: "play none none none"`, so a trigger created already past its start no longer kills itself inside the first refresh (the `reading 'end'` throw that left the founder section and pricing table hidden on a phone).
- Tests: `app/(marketing)/site-anchor-landing.static.test.ts`; `e2e/36-marketing-site.spec.ts` T20 (not run at merge time; the last commit is a test-only cast fix for a web check-types error).

## #4151 `929d80453a` F14: scan and report dates use the tenant's day

Rule: a date that used to come from the browser clock comes from the business's own day (`useOnTenantToday`, `useTenantTimeZoneQuery` in `lib/tenant-timezone.ts`).

- `lib/scan-invoice-tenant-dates.ts` (new): `fillEmptyDates`, `useFillTenantDates` (one fill per invoice, a cleared date stays cleared); used by `components/ScanInvoiceModal.tsx`.
- `app/(dashboard)/compliance/[categoryId]/_components/CompliancePackPanel.tsx`: the year-to-date range starts empty; `useRangeState` returns a `wait` state (loading, failed with Retry, choose both dates) shown through `RangeWait`; the Purchases and Sales reads stay off until both dates exist (`lib/api/tobacco.ts` gains an `enabled` option).
- Tests: `lib/browser-clock-sites-f14.static.test.ts`, `lib/browser-clock-today.pin.test.ts` (allowlist shrinks by two files), `lib/scan-invoice-tenant-dates.test.ts`, `CompliancePackPanel.zone-wait.test.tsx`.

## #4152 `8a5019a3a0` product finder at /insights (SA-1087 PR-2, W-1125)

Rule: staff find a product and open its insights from one page; behind the existing `flag.analytics`, products only.

- `app/(dashboard)/insights/page.tsx` (title "Product insights", top-bar title "Insights"), `insights/products/[id]/page.tsx`; `components/insights/ProductFinder.tsx` (typeahead, limit 20, plus the camera scan through the barcode resolve ladder; an archived product shows the archived message and does not navigate), `FindInsightsLink.tsx` (the "Look up a product" link on `app/(dashboard)/analytics/page.tsx`), `use-insights-access.ts` (`useInsightsAccess`: operator or admin, `REPORTS`, `flag.analytics`; shared by the link and the palette item; the server stays the authority), `ProductInsightsPanel.tsx`, `app/(dashboard)/products/[id]/ProductInsightsExport.tsx` (fails open when the plan read fails).
- `components/CommandPalette.tsx`: a "Product insights" item. `apps/mobile/lib/route-parity-manifest.ts`: one `/insights` row (web-only).
- Tests: `ProductFinder`, `FindInsightsLink`, `ProductInsightsPanel`, `ProductInsightsExport`, `CommandPalette.insights` (the other `CommandPalette.*` suites stub the access hook). Owed at merge: the Playwright proof at the merging sha on a test tenant; a failed search shows "No products match" (no error line).

## #4147, #4150

- #4147 `7c4d435832`: docs only. #4150: api only.
