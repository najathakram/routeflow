# Plan: in-app pack size — capture `unitsPerBox` where the operator already is

> Authored by Fable 5 on 2026-08-20. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

**Only 19 of 1,743 live products carry a pack size.** Every boxed affordance in this
codebase gates on `unitsPerBox > 1` — boxed price proration, the boxes/pieces qty
inputs, box-aware scanning, stock-count denominations, variant splitting. All of
that machinery is correct and all of it is **dormant** until products actually
carry the field.

A wholesaler is about to update their product data. This feature must be ready so
that pack sizes get captured _as they work_, not in a separate cleanup pass:

1. **At product create/edit** — when the name or unit says "this is packaged" but
   `unitsPerBox` is unset, prompt for it inline.
2. **At the point of sale** — a line-level "sold in a box of N?" affordance in the
   order and invoice builders that PATCHes the product and immediately re-renders
   the line as boxed.

**The parser must keep refusing to guess.** "…5CT - 12Pack" is 12 packs of 5 — two
distinct counts, so it is AMBIGUOUS and we ask rather than assume. Guessing
mis-prices every loose sale of that product, which is worse than leaving it blank.
That refusal behaviour is the single most important thing to preserve.

## Constraints & conventions

- **Stack**: npm + Turbo monorepo. NestJS 11 + Prisma 7 (`apps/api`), Next.js 14
  App Router (`apps/web`), Expo/RN (`apps/mobile`), shared `packages/types`.
- **No migration.** `Product.unitsPerBox Int?` already exists.
- **No new dependencies.**
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.
- **Tests**: Jest. Mobile tests are pure-logic only. No snapshot tests, no Vitest.
- **Money**: never re-derive `qty * unitPrice` for a boxed line — a boxed line
  prices by the BOX and prorates via `computeLineSubtotal`. Setting `unitsPerBox`
  on a product **changes how its existing lines are priced**, which is exactly why
  the affordance must re-render the line and show the operator the new figure.

### Key fact: use the SHARED package, do not mirror

`@routeflow/types` (`packages/types`, `main: ./index.ts`, raw TS) is already a
dependency of **all three apps** (`apps/api`, `apps/web`, `apps/mobile`). The
parser goes there **once**. Do **not** follow the `pricing.ts` triple-mirror
convention here — a subtle parser with refusal semantics is exactly the wrong
thing to keep three hand-synced copies of.

### The existing parser to port (canonical behaviour)

`apps/api/scripts/propose-pack-sizes.mjs` contains `parsePackSizeDetailed(name)`
and `classify(p)`. Port them **verbatim in behaviour**. Its rules, in order:

- Reads `\b(\d{1,4})\s*/\s*[\d.]+\s*(OZ|ML|L|G|MG|LB|KG|CT)\b` FIRST (e.g.
  "12/1.93OZ" = 12 units) — **before** measurements are stripped, because the
  measurement is what identifies it as a pack-of-N.
- Then strips measurements
  (`\b[\d.]+\s*(HOUR|HR|ML|OZ|LB|KG|MG|G|L|CM|MM|IN|FT|%)\b`) so "5 HOUR" and
  "65MG" cannot read as counts.
- Then reads `\b(\d{1,4})\s*[-\s]?\s*(CT|CNT|COUNT|PK|PACK|PCS|PC)\b`.
- Keeps distinct values `> 1` and `<= 1000`. **`packSize` is returned only when
  exactly ONE distinct count survives**; two or more ⇒ `null` + AMBIGUOUS.
- `PACKISH_UNIT = /\b(box|case|carton|pack|pk|ct|dozen|dz|bundle|tray|sleeve|showcase)\b/i`
- `PIECE_UNIT = /^\s*(pcs?|pieces?|ea|each|single|singles|unit|units|bottle|can|stick)\s*$/i`
  — a piece unit means **never propose**: the count in the name describes the case
  the row was broken out of, and a pack size here would divide a piece price by the
  pack and undercharge by that factor.
- `classify` confidence ladder: `PIECE_UNIT` (never propose) → `AMBIGUOUS`
  (>1 distinct count) → `HIGH` (packSize AND (packish unit OR a piece-level
  `unitSku`)) → `MEDIUM` (packSize only) → `LOW` (packish unit, no count) → null.

## Work packages

File lists are DISJOINT.

### WP1 — shared parser + specs

- **files:** `packages/types/pack-size.ts`, `packages/types/index.ts`, `apps/api/src/common/pack-size.spec.ts`
- **brief:** Port the parser into `packages/types/pack-size.ts` as typed TS and
  re-export it from `index.ts`. Exports:
  ```ts
  export type PackSizeConfidence = "HIGH" | "MEDIUM" | "LOW" | "AMBIGUOUS" | "PIECE_UNIT";
  export interface PackSizeParse {
    packSize: number | null;
    counts: number[];
  }
  export interface PackSizeSuggestion {
    packSize: number | null;
    counts: number[];
    confidence: PackSizeConfidence | null;
    /** Operator-facing reason, e.g. "Two different counts in the name (5 and 12)
     *  — tell us which one the price is for." Never phrased as a guess. */
    reason: string | null;
  }
  export function parsePackSizeDetailed(name: string | null | undefined): PackSizeParse;
  export function suggestPackSize(input: {
    name?: string | null;
    unit?: string | null;
    unitSku?: string | null;
    unitsPerBox?: number | null;
  }): PackSizeSuggestion;
  ```
  `suggestPackSize` returns `confidence: null` when `unitsPerBox` is already set
  (> 1) — nothing to suggest — so every caller can ask unconditionally.
  **`packages/types` has no test runner** (its `test` script is `tsc --noEmit`), so
  the spec lives in `apps/api/src/common/pack-size.spec.ts` and imports from
  `@routeflow/types`.
- **spec:** exhaustive, because this is the whole feature's foundation:
  - `"12/1.93OZ"` → 12. `"24PK"`, `"12 CT"`, `"10 COUNT"`, `"12-CT"` → their counts.
  - `"5 HOUR ENERGY"` → null (measurement, not a count). `"65MG"` → null.
  - **`"…5CT - 12Pack"` → `packSize: null`, `counts: [5, 12]`, `AMBIGUOUS`** — the
    single most important case. It must never resolve to 5 or 12.
  - A `PIECE_UNIT` unit (`"pcs"`, `"each"`, `"bottle"`) → `PIECE_UNIT`, never a
    proposal, even when the name contains a clean count.
  - `HIGH` vs `MEDIUM`: same name, with and without a packish unit / `unitSku`.
  - Counts of `1`, `0`, and `> 1000` are rejected.
  - `unitsPerBox` already set → `confidence: null`.
- Add a header comment in `apps/api/scripts/propose-pack-sizes.mjs` naming
  `packages/types/pack-size.ts` as the canonical implementation (the `.mjs` script
  runs standalone under plain node and cannot import TS, so its copy stays — but
  it must be labelled as a mirror, not a second source of truth). **Do not change
  the script's behaviour.**

### WP2 — web: capture it in the product form

- **files:** `apps/web/app/(dashboard)/products/[id]/page.tsx`, `apps/web/app/(dashboard)/products/create/page.tsx`, `apps/web/components/PackSizePrompt.tsx`
- **brief:** A small shared `PackSizePrompt` component, used by both the create and
  edit forms. When `suggestPackSize()` returns a confidence and `unitsPerBox` is
  unset, show an inline, dismissible prompt beneath the unit/name fields:
  - `HIGH`/`MEDIUM` → "Looks like this is sold in a box of **12**. Set pack size?"
    with a one-click accept and an editable number.
  - `AMBIGUOUS` → state the conflict and ask, never pre-fill:
    "This name mentions two counts (5 and 12). Which one is a box?" with an empty
    input. **Never guess.**
  - `LOW` → a quiet "How many pieces in a box?" with an empty input.
  - `PIECE_UNIT` → show **nothing**. A piece-priced row must not be turned boxed.
    It writes through the existing product create/update mutation — no new endpoint.

### WP3 — web: capture it at the point of sale

- **files:** `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`, `apps/web/lib/api/pack-size.ts`
- **brief:** In the order builder's line rows, when a selected product has
  `unitsPerBox` unset **and** `suggestPackSize` returns something other than
  `PIECE_UNIT`/null, show a quiet inline link on the line: **"Sold in a box?"**.
  Opening it takes a number, PATCHes the product via the existing product-update
  hook, and **re-renders that line as boxed** using the existing cases/pieces
  inputs (see the `sellBy` toggle and the boxes/pieces inputs already in this file).
  - ⚠️ **Show the operator the price change.** Setting `unitsPerBox` switches the
    line from `qty × unitPrice` to BOX-price proration; the line total will change.
    Surface the new line total in the confirmation, do not silently re-price.
  - Invalidate the product queries so every other open surface picks the change up.
  - `lib/api/pack-size.ts` holds the small mutation wrapper + any shared helper so
    WP2 and WP3 do not duplicate it.

### WP4 — mobile: both surfaces

- **files:** `apps/mobile/components/PackSizeSheet.tsx`, `apps/mobile/app/(operator)/products/[id]/edit.tsx`, `apps/mobile/app/(operator)/products/new.tsx`, `apps/mobile/lib/pack-size-logic.ts`, `apps/mobile/__tests__/pack-size-logic.test.ts`
- **brief:** Mirror WP2 and WP3 on mobile using the `FormSheet` convention. The
  product create/edit screens get the same prompt (same rules, including showing
  nothing for `PIECE_UNIT` and never pre-filling `AMBIGUOUS`). Put any
  presentation-shaping logic — turning a `PackSizeSuggestion` into the prompt's
  copy and initial input value — in `lib/pack-size-logic.ts` and **unit-test it**;
  the parser itself is already tested in WP1 and must not be re-implemented.
- **spec:** `__tests__/pack-size-logic.test.ts` — asserts `AMBIGUOUS` yields an
  EMPTY initial value (never 5, never 12), `PIECE_UNIT` yields no prompt at all,
  and `HIGH`/`MEDIUM` pre-fill the parsed count.

## Acceptance criteria

1. `parsePackSizeDetailed` and `suggestPackSize` live in `packages/types` as the
   single shared implementation, consumed by all three apps. No copy is added to
   `apps/*/lib`.
2. **`"…5CT - 12Pack"` resolves to `packSize: null` / `AMBIGUOUS` everywhere**, and
   no UI ever pre-fills a value for it. A spec pins this.
3. A `PIECE_UNIT` product never receives a pack-size proposal on any surface.
4. `"5 HOUR ENERGY"` and `"65MG"` produce no count.
5. Product create and edit prompt for a pack size when one is suggested and
   `unitsPerBox` is unset, on both web and mobile, writing through the existing
   product mutation with no new endpoint.
6. The order builder offers a line-level "Sold in a box?" that PATCHes the product,
   re-renders the line as boxed, and **shows the resulting line total before/after**
   rather than silently re-pricing.
7. `apps/api/scripts/propose-pack-sizes.mjs` is labelled as a mirror of the
   canonical parser and its behaviour is unchanged.
8. No migration, no new dependencies, no changes to existing route paths.

## Verification commands

From the repo root:

- `npm run verify` — Turbo `check-types`, `lint`, `test`.

Lint must report **0 errors**; all suites pass.

## Risks & rollback

- **The parser is the whole feature.** If it guesses, it silently mis-prices real
  sales. Weight the spec toward refusal cases, not happy paths — a false null costs
  one prompt, a false positive costs money on every loose sale of that product.
- **Setting `unitsPerBox` re-prices existing lines** on any open builder. That is
  intended, but it must be visible; a silent total change is the failure mode to
  avoid in review.
- `packages/types` has no Jest runner — the spec must live in `apps/api`, or it will
  silently never run.
- **Rollback**: every affordance is additive UI over an existing nullable column.
  Removing the prompts leaves the data already captured intact and correct.
