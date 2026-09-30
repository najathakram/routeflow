# Discovery — PR-4 · `@routeflow/pricing` (one compiled money module)

Status: APPROVED
Scale: major · ui: false · Branch: `refactor/imp-01-pricing-package`

## Problem, and whose it is

Money math is duplicated three times (export counts are export statements per `grep -c '^export '`):
`apps/api/src/common/pricing.ts` (778 lines, 34 exports),
`apps/web/lib/pricing.ts` (843, 39 exports) and `apps/mobile/lib/pricing.ts` (862, 40 exports),
plus `apps/api/src/utils/pricing.ts` (64 lines: `getTierPrice`, `TIER_FIELDS`, `TierField`,
`cascadeTierPrices` — inlined into both client mirrors). The three mirrors are byte-identical from
`computeCategoryTax` onward (promotions, tax, margins, zero-price guard, upsell, `formatQtySplit`)
and differ only by two client-only additions (`roundUnitCost` in web+mobile, `effectiveQty` in
mobile) and one TypeScript-only widening (mobile's `prorateLineSubtotal(storedSubtotal: number |
null | undefined)`; all three bodies already coerce with `Number(x) || 0`). Parity is asserted
mechanically — `pricing-parity.spec.ts` imports all four files by relative path, a "mirror parity"
describe inside `pricing.spec.ts` compares the Promotions block text, and `turbo.json:57-71`
hand-adds the client files to the API test cache key — machinery that exists only because there
are copies. Whose: the owner (every invoice, order and cart total) — a divergence between mirrors
is an over/under-charge that no single test suite owns. Frequency: every pricing change (three
edits, one parity fix-up).

## Cost today

~2,500 lines of duplicated money code; a cross-package spec + a turbo cache hack to police it;
the architecture review's P0 🔴. `CLAUDE.md` already warns that re-deriving `qty * unitPrice` for a
boxed line over-charges by `unitsPerBox` — a class of bug that copies invite.

## Current workaround and why it fails

"Keep all three mirrors in sync" (CLAUDE.md money discipline) + the parity spec. It catches
divergence after the fact, per function, only for the fixtures someone wrote; it does not remove
the copies.

## Why now

The DB items are done (PR-1…3); this is the largest cross-app build change and the DB-backed
lane/gates are in place to catch a Docker regression. Web unit tests (PR-9) will target this
package rather than a mirror.

## If we ship nothing

Every future pricing rule lands three times or drifts; the parity machinery grows.

## Success signal + baseline

- `git ls-files | grep -E "^(apps/api/src/(common|utils)|apps/web/lib|apps/mobile/lib)/pricing\.ts$"` → 0 (baseline 4).
- `grep -rn "pricing-parity\|mirror parity" apps turbo.json` → 0 (baseline: spec + fixtures + turbo block + describe).
- One Jest suite in `packages/pricing` owns every pricing test; the golden table from the old
  fixtures passes against the package (baseline: fixtures assert three copies agree).
- Both production images build and boot (`local:up`), `local:validate:features` money math green.

## Who else is affected

- **The API runtime**: `nest build` emits `require("@routeflow/pricing")` verbatim; `node dist/main.js`
  cannot load `.ts` (`trip-grouping.ts:9-14` — why the API keeps local copies today). The package
  must ship compiled JS (`dist/`), unlike every existing `packages/*`.
- Build graph: `turbo` `build`/`test` already `dependsOn: ^build`; `check-types` does not — the
  package's `.d.ts` must exist before any app typechecks → build on `postinstall`.
- Docker: both builders `COPY packages/ packages/` before building; the API runner copies
  `/app/packages` from the builder (dist rides along); web's standalone bundle inlines it.
- Mobile: Metro resolves `@routeflow/*` by an explicit map (`metro.config.js`); Jest maps
  `@routeflow/types` to a mock — the new package gets a **real** source mapping.
- Importers: api 46 (+5 utils), web 30 (`@/lib/pricing` only), mobile 43 (five relative depths +
  `__tests__/round-unit-cost.test.ts` importing `../../web/lib/pricing`).
- `apps/api/src/inventory/costing.ts` stays separate by design (`COST_DP = 4`, Decimal); comment-only
  references to `common/pricing` in 6 API files are updated to name the package.

## Symptom or root cause?

Root cause: three copies. The review's "merge the two intra-API copies" was a mis-read — the
`utils` file is not a copy; it is the tier-price module the clients inline.

## Strongest objection

"Keep the API's local copy (the repo's convention for `trip-grouping`/`shipping`) and share only
web+mobile." That leaves two sources of truth for money and keeps the parity machinery. The
convention exists because no package has a build step; giving this one a build step removes the
reason.

## Reuse

`packages/typescript-config/base.json` (NodeNext, strict); `apps/api/package.json` jest block +
`apps/mobile/jest.config.js` mapper slot; the parity fixtures (`pricing-parity.fixtures.ts`) as
golden tests; lessons L-009/L-010 (Turbo), L-028/L-032/L-038 (lockfile proofs), L-034 (forced
first run), L-008 (scope).
