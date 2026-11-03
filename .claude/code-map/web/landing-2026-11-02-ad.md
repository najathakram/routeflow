# Web landing 2026-11-02, train ad (merge commit `9e782a5dfc`, range `4b2516c9f2..9e782a5dfc`; train PR #4138, train head `c5bd1f3231`)

Web paths under `apps/web/` unless they start with `scripts/`, `apps/api/`, `apps/mobile/` or `packages/`. Five members: #4123 `ee89a943d8`, #4135 `2d8ff74596`, #4137 `325d19ddde`, #4127 `f4e630e6b9` (web copy only on this side), #4136 `2267cc2a9d` (docs only). The api side is in `api/landing-2026-11-02-ad.md`. No migration, no new env var, no cron, plan flag or addon gate. Tests are names only; they were not run for this note.

## #4123 `ee89a943d8` product insights page and panel (SA-1087 PR-1, W-654; closes #2119)

- `components/insights/ProductInsightsPanel.tsx`, `insights-format.ts`, `lib/api/product-insights.ts` (new): one product's sales insights, ported from the saved branch (tip `901a74a862`). `app/(dashboard)/insights/products/[id]/page.tsx` (new) hosts it; the finder and `/insights` index are PR-2.
- One CSV path: the panel renders master's `ProductInsightsExport` (its own From/To dates); the tip's own download hook is gone. `products/[id]/FullInsightsLink.tsx` (new) shows "Full insights" only to an operator or admin whose plan has `flag.analytics` and who holds `REPORTS`; it lives in `ProductInsightsExport` (`hideFullLink` turns it off on the insights page) because `products/[id]/page.tsx` sits at its size-ratchet cap.
- Gating: `lib/plan-gated-nav.ts` puts `/insights` in `PLAN_GATED_NAV` (`flag.analytics`); `lib/portal-routing.ts` adds it to `OPERATOR_PATH_PREFIXES` (buyers are sent away); `_components/nav-config.ts` `navLabelForPath` maps `/insights` to the Analytics entry.
- `apps/mobile/lib/route-parity-manifest.ts`: one `webOnly` row for the new page (the row train aa lacked).
- Tests: `FullInsightsLink.test.tsx`, `ProductInsightsPanel.test.tsx`, `insights-format.test.ts`, `ProductInsightsExport.test.tsx`, `plan-gated-nav.test.ts`, `portal-routing.test.ts`, `PlanGateBoundary.test.tsx`.

## #4137 `325d19ddde` Quick Edit shows a cleared tier as blank (SA-1092)

- `app/(dashboard)/products/page.tsx`: the tier cell uses the normal view's test (`parseFloat(String(val)) > 0`), so a stored 0 reads blank with "Add"; a clear still sends "0"; Undo of a price typed into a blank cell sends `oldValue || "0"` (the server reads "" as unchanged). Detail form, variant dialog and Retail untouched.
- Tests: `products/products-list-tier-cell.test.tsx` (QT-1..QT-5). Playwright at 1440, 768 and 390 was not run (review-b gate item).

## #4135 `2d8ff74596` site wording

- Eight static files under `public/site`: landing meta and price line ("Up to 100 customers."), Pricing heading and trimmed Starter card, footer first column "Explore" on seven pages. No script, config or test change; `scripts/sync-site-port.mjs` re-run changes nothing further.

## #4127 (web side), #4136

- `lib/credit-note-error-copy.ts`, `lib/generic-toast-copy.ts` (+ tests): the order-bound refusal reads "That is more than this order was billed. $X is left to give back. To free up room, void a credit note or cancel a return.", and says none is left rather than $0.00. #4136: docs only.
