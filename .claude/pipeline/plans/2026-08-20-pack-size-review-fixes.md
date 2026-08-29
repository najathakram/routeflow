# Plan: pack-size review fixes — 2 blockers, 6 majors, 3 minors

> Authored by Fable 5 on 2026-08-20. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

An Opus review with adversarial verification found 11 confirmed defects in the
in-app pack-size feature currently sitting **uncommitted in the working tree** on
branch `fix/batch-followup-gaps`. Two are blockers: one silently multiplies a line
total by the pack size, and one defeats the parser's central promise that it
refuses to guess. Fix all 11.

The feature's whole value is that it **never guesses about money**. Two of these
defects break exactly that, so weight the specs toward the refusal cases.

## Constraints & conventions

- Work on the EXISTING uncommitted changes; do not revert or rewrite them wholesale.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.
- **Tests**: Jest. Parser specs live in `apps/api/src/common/pack-size.spec.ts`
  (`packages/types` has no Jest runner — a spec placed there silently never runs).
  Mobile pure-logic specs in `apps/mobile/__tests__/`. No snapshot tests, no Vitest.
- **Money**: `computeLineSubtotal` / `normalizeBoxesPieces` from the app's
  `lib/pricing.ts` are the only line-maths helpers. Never add a second path.
- No new dependencies. No migration.
- **Every fix needs a spec that fails without it.**

## Work packages

File lists are DISJOINT.

### WP1 — BLOCKER: double-apply multiplies the line by unitsPerBox

- **files:** `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`
- **brief:** Three related defects in one file.

  **(a) BLOCKER — re-entrancy (keydown ~1699, `applyPackSize` ~731).**
  The Enter handler calls `applyPackSize(li)` with no in-flight guard; only the
  Apply button is disabled by `setPackSize.isPending`. `applyPackSize` is `async`,
  and after the await it deliberately re-reads the row from `lineItemsRef.current`
  (a stale-closure fix). So a double-tap of Enter fires two PATCHes, and the second
  continuation reads the **already-converted** row and converts it again: a $30
  product at qty 3 (subtotal $90) becomes 36 boxes / 432 pieces, **subtotal
  $1,080** — and because `before === after` on that second pass the toast reads
  _"Line total unchanged ($1,080.00)"_. An explicit all-clear on a 12x overcharge.
  **Fix:** make `applyPackSize` itself re-entrant-safe. Add a **per-line** ref guard
  (`useRef<Set<string>>` of tempIds) that bails immediately on re-entry, AND bail
  when the post-await row already has `unitsPerBox > 1`. Also gate the Enter branch
  on `!setPackSize.isPending`. A pending-flag check alone is insufficient — the
  second keydown may carry an older render's closure — so the ref guard is required.
  Key it per line, never globally, or a legitimate conversion of a DIFFERENT line
  gets silently dropped.

  **(b) MAJOR — the before/after preview is provably constant (~1734, ~768).**
  `packSizeConversion` maps the typed qty to BOXES, so `after === before` by
  construction and the operator is always told "Line total stays $X". Meanwhile the
  line's PIECE basis silently multiplies by `n`, which changes the order total for
  any regulated line carrying per-unit category tax.
  **Fix:** stop showing a subtotal comparison that cannot differ. Show what actually
  changes: quantity `qty` → `qty × n` pieces, and per-piece price `unitPrice` →
  `unitPrice / n`. If the line is regulated (`li.trackedCategoryId`), say per-unit
  category tax will be recalculated on the new piece count. Phrase it as what the
  conversion means — "3 → 3 cases (36 pieces)" — not as a reassurance that nothing
  changed.

  **(c) MAJOR — parses the composed display name (~273).**
  `packSizeSuggestionFor` feeds `"<Parent> - <Variant>"` into `suggestPackSize`, so
  a variant line is classified from the PARENT's packaging text and can be assigned
  the parent's count at HIGH confidence in one click. This also diverges from the
  backfill script and the product forms, which parse the bare `Product.name`.
  **Fix:** carry the product's OWN name onto `LineItem` when it is added
  (`product.variantName ?? product.name`) plus `product.unitSku`, and pass that to
  `suggestPackSize`. Keep the composed display name for the rendered label only.

### WP2 — BLOCKER: the parser misses plural count suffixes

- **files:** `packages/types/pack-size.ts`, `apps/api/src/common/pack-size.spec.ts`, `apps/api/scripts/propose-pack-sizes.mjs`
- **brief:** The count regex is
  `/\b(\d{1,4})\s*[-\s]?\s*(CT|CNT|COUNT|PK|PACK|PCS|PC)\b/g`. The trailing `\b`
  makes plural suffixes invisible: **"CTS", "PKS", "PACKS", "COUNTS" do not match.**
  So in a nested-packaging name like **"…5CT - 12Packs"** only the `5` is seen and
  the parser returns `packSize: 5` at HIGH confidence instead of refusing as
  AMBIGUOUS. That defeats the feature's central guarantee and mis-prices every loose
  sale of that product.
  **Fix in BOTH copies** (the `.mjs` is a labelled mirror and must stay behaviourally
  identical):
  ```
  /\b(\d{1,4})\s*[-\s]?\s*(?:CT|CNT|COUNT|PK|PACK|PC)S?\b/g
  ```
  `PCS` is then covered by `PC` + `S?`. The suffix group becomes **non-capturing**,
  so check every `m[1]` / `m[2]` use in both files before assuming indices hold.
  ⚠️ Add a comment recording that the existing 812-product backfill proposal was
  generated **before** this fix and may therefore have classified a nested-packaging
  name as a single confident count. Do not otherwise change the script's behaviour.
- **spec:** pin `"…5CT - 12Packs"` → `packSize: null`, `counts: [5, 12]`, `AMBIGUOUS`;
  `"Widget - 5cts"` → 5; `"24 PACKS"` → 24. Every existing singular case must still pass.

### WP3 — mobile: fractional entry writes the meaningless unitsPerBox = 1

- **files:** `apps/mobile/components/PackSizeSheet.tsx`, `apps/mobile/lib/product-form.ts`, `apps/mobile/__tests__/pack-size-logic.test.ts`
- **brief:** `parsePackSize` compares **before** flooring (`n <= 1`, then
  `Math.floor(n)`), so `"1.5"` passes the guard and returns `1` — exactly the
  meaningless value the guard exists to reject, and one the web surface refuses
  outright. `apps/mobile/lib/product-form.ts:190` has the identical
  compare-then-floor flaw.
  **Fix:** floor first, then validate, in both places:
  ```ts
  const n = Math.floor(Number(t));
  if (!Number.isFinite(n) || n < 2 || n > 1000) return null;
  ```
- **spec:** `"1.5"`, `"1"`, `"0"`, `"1001"`, `"abc"`, `""` all rejected; `"12"` → 12.

### WP4 — mobile: the sheet can never appear on create, and nags on edit

- **files:** `apps/mobile/app/(operator)/products/new.tsx`, `apps/mobile/app/(operator)/products/[id]/edit.tsx`
- **brief:** Two defects.
  **(a)** `new.tsx` passes the form's DEFAULT unit `"ea"`, which `suggestPackSize`
  classifies as `PIECE_UNIT` — so the pack-size sheet **can never appear on mobile
  create at all**. An untouched placeholder must not act as an operator assertion
  that the row is piece-priced. Either default `emptyProductForm().unit` to `""`
  (keeping "ea, kg, box" as the input's placeholder), or track whether the operator
  edited the Unit field and pass `unit: unitTouched ? payload.unit : null`.
  **(b)** `edit.tsx` interposes a blocking sheet on the SAVE path with no memory of
  "Skip", so it re-interrupts every subsequent save of the same product. Remember
  the decline for the session (a `Set` of product ids, or a `name|unit` key) and
  suppress it thereafter.

### WP5 — the price re-basing is invisible on the product forms

- **files:** `apps/web/app/(dashboard)/products/[id]/page.tsx`, `apps/web/components/PackSizePrompt.tsx`
- **brief:** Accepting the prompt on a product EDIT form re-bases the stored price
  from per-piece to per-case, and **no per-piece figure is shown before the operator
  commits**: `perUnitHint` (~923) gates on the SAVED `product.unitsPerBox`, not the
  draft, so the "≈ $x / unit" line only appears after the save. Separately, a
  variant's bare stored `name` is just the flavour, so a count living in the parent
  name never prompts on the main capture surface (~1841).
  **Fix:** show the resulting per-piece price inside the prompt itself before
  acceptance (`unitPrice / n`), and switch `perUnitHint` to the DRAFT
  (`activeUnitsPerBox`) so it updates live. For a variant, parse the parent name
  together with the variant name so a parent-borne count is still offered — with the
  AMBIGUOUS refusal fully intact.

## Acceptance criteria

1. Double-tapping Enter (or Apply) converts the line **once**; a second attempt while
   one is in flight, or on a row already carrying `unitsPerBox > 1`, is refused. No
   path can produce a line multiplied by `n`. The guard is keyed per line.
2. No UI shows "Line total unchanged" for a conversion that changed the piece basis;
   the disclosure states the real change (qty → cases/pieces, per-piece price).
3. `"…5CT - 12Packs"` → `packSize: null` / `AMBIGUOUS` in BOTH the TS parser and the
   `.mjs` mirror, with specs. `"Widget - 5cts"` → 5. All existing cases still pass.
4. The order builder classifies a variant line from the product's OWN name, not the
   composed "Parent - Variant" display string.
5. `"1.5"` can never write `unitsPerBox = 1` on mobile, in either code path.
6. The pack-size sheet is reachable on mobile product create, and a skipped prompt
   does not re-interrupt the next save of the same product.
7. The per-piece price is visible before accepting on the product edit form.
8. `npm run verify` green, 0 lint errors.

## Verification commands

From the repo root: `npm run verify`

## Risks & rollback

- WP1(a) is the one that must not be got wrong: a guard that is too aggressive
  silently drops a legitimate conversion of a DIFFERENT line. Key it per tempId.
- WP2 changes a regex used by a script that produced a live 812-product proposal.
  Fix the regex in both copies; change nothing else about the script.
- Every change is UI or pure logic over an existing nullable column; reverting the
  working tree restores the previous state with no data implications.
