# Plan: Preserve per-line fields in mobile qty set/decrement setters

**Status:** PLANNED
**Scale:** small-major (pure logic + rewiring across 2 files, money-adjacent)

## Context

In RouteFlow's Expo mobile app (`apps/mobile`), order/invoice line state is a map
`{ [productId]: LineState }`. The **increment** path preserves per-line fields (a one-time
`unitPrice` override, a per-line `note`) via the pure helper `incrementLine` in
`apps/mobile/lib/sale-line.ts` (it spreads `...prev`). But the **set** and **decrement**
paths rebuild the line object from scratch and silently DROP `unitPrice`/`note`/`noteOpen`.

Concretely: in the new-order cart sheet, a user sets a price override on a line, then types a
new quantity (wired to `setQty`) — the override vanishes. Same class of bug on the − button
(`removeOne`) and on the boxed Boxes/Loose-pieces steppers (`setBoxes`/`setPieces`).

Fix: add pure `...prev`-preserving counterparts to `sale-line.ts` and route the buggy
in-component setters through them. No behavior change other than field preservation and the
existing line-removal-at-zero semantics.

This is a precursor to a follow-up "typed quantity input" feature that wires typed input into
these same setters, so correctness here matters.

## Current state (verified)

### `apps/mobile/lib/sale-line.ts` (full current contents)

Exports `interface SaleLineQty { qty?: number; boxes?: number | null; pieces?: number | null }`
and `incrementLine<T extends SaleLineQty>(prev, isBoxed, unitsPerBox)` which returns
`{ ...prev, qty, boxes?, pieces? }`. The file's header comment explains both mobile
sale-builders previously rebuilt lines and wiped price/note on increment; `...prev` fixed it.

### `apps/mobile/components/NewOrderScreen.tsx`

`LineState` (L129-143): `{ qty: number; boxes?: number; pieces?: number; unitPrice?: number; note?: string; noteOpen?: boolean }`.

Four buggy setters (all drop `unitPrice`/`note`/`noteOpen`):

- `removeOne` (L532-557): boxed branch returns `{ ...m, [id]: { qty: boxes*upb + pieces, boxes, pieces } }` (L547); loose branch `{ ...m, [id]: { qty } }` (L555). Deletes line when total hits 0. Guards `if (!prev) return m;`.
- `setBoxes` (L559-573): `prev = m[id] ?? { qty: 0 }`; returns `{ ...m, [id]: { qty, boxes: b, pieces } }` (L572); deletes when qty 0.
- `setPieces` (L575-589): `prev = m[id] ?? { qty: 0 }`; returns `{ ...m, [id]: { qty, boxes, pieces: pcs } }` (L588); deletes when qty 0.
- `setQty` (L591-601): `q = Math.max(0, Math.floor(qty))`; deletes when q 0; else returns `{ ...m, [id]: { qty: q } }` (L600). **Comment says "clear boxes/pieces so server doesn't recompute" — that intent must be preserved (setLineQty clears them).** Wired to the cart sheet typed qty input via `onChangeQty={setQty}` (L1436).

The good setter for reference: `addOne` (~L512-520) uses `incrementLine(prev, isBoxed, upb)` and spreads `...prev`.

### `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx`

`LineState` (L89): `{ qty: number; boxes?: number; pieces?: number; unitPrice?: number }` (NO note/noteOpen here).

One buggy setter:

- `removeOne` (L310-330): boxed branch `next[id] = { qty: boxes*upb + pieces, boxes, pieces }` (L322); loose branch `next[id] = { qty }` (L326); deletes at 0. Guards `if (!prev) return m;`.

The good setter: `addOne` (L293-308) uses `incrementLine(prev, isBoxed, upb)`.

## Work packages

### WP1 — Add preserving helpers to `sale-line.ts` + tests

**Files:** `apps/mobile/lib/sale-line.ts`, `apps/mobile/__tests__/sale-line.test.ts` (edit both).

Add these four pure helpers below `incrementLine`. Keep the generic `<T extends SaleLineQty>`
signature so both LineState shapes (with/without note) work and all other fields ride along
via `...prev`. `null` return ⇒ caller removes the line.

```ts
/**
 * Decrement a line by one unit (one piece, or one BOX for a boxed product),
 * preserving every other field (unitPrice / note / noteOpen). Returns null when
 * the line should be removed (reaches empty).
 */
export function decrementLine<T extends SaleLineQty>(
  prev: T,
  isBoxed: boolean,
  unitsPerBox: number,
): (T & { qty: number }) | null {
  if (isBoxed) {
    const boxes = Math.max(0, (prev.boxes ?? 0) - 1);
    const pieces = prev.pieces ?? 0;
    if (boxes === 0 && pieces === 0) return null;
    return { ...prev, qty: boxes * unitsPerBox + pieces, boxes, pieces };
  }
  const qty = Math.max(0, (prev.qty ?? 0) - 1);
  if (qty === 0) return null;
  return { ...prev, qty };
}

/**
 * Set a plain (non-box) qty. Preserves other fields but explicitly CLEARS
 * boxes/pieces so the server does not recompute qty from a stale box split
 * (preserving setQty's original intent). Returns null when qty resolves to 0.
 */
export function setLineQty<T extends SaleLineQty>(
  prev: T,
  qty: number,
): (Omit<T, "boxes" | "pieces"> & { qty: number }) | null {
  const q = Math.max(0, Math.floor(qty));
  if (q === 0) return null;
  const rest = { ...prev };
  delete rest.boxes;
  delete rest.pieces;
  return { ...rest, qty: q };
}

/**
 * Set the box count on a boxed line, preserving other fields and loose pieces.
 * Returns null when the line reaches empty (0 boxes + 0 pieces).
 */
export function setLineBoxes<T extends SaleLineQty>(
  prev: T,
  boxes: number,
  unitsPerBox: number,
): (T & { qty: number; boxes: number; pieces: number }) | null {
  const b = Math.max(0, Math.floor(boxes));
  const pieces = prev.pieces ?? 0;
  const qty = b * unitsPerBox + pieces;
  if (qty === 0) return null;
  return { ...prev, qty, boxes: b, pieces };
}

/**
 * Set the loose-pieces count on a boxed line, preserving other fields and boxes.
 * Returns null when the line reaches empty (0 boxes + 0 pieces).
 */
export function setLinePieces<T extends SaleLineQty>(
  prev: T,
  pieces: number,
  unitsPerBox: number,
): (T & { qty: number; boxes: number; pieces: number }) | null {
  const pcs = Math.max(0, Math.floor(pieces));
  const boxes = prev.boxes ?? 0;
  const qty = boxes * unitsPerBox + pcs;
  if (qty === 0) return null;
  return { ...prev, qty, boxes, pieces: pcs };
}
```

**Tests** — add a describe block per helper to `sale-line.test.ts` (Jest, pure logic). Cover:

- `decrementLine`: loose line 3→2 preserves `unitPrice`/`note`/`noteOpen`; loose 1→null;
  boxed removes one box keeping loose pieces + fields; boxed with 0 boxes + 0 pieces → null;
  boxed 1 box 0 pieces → null.
- `setLineQty`: sets qty preserving `unitPrice`/`note`; CLEARS `boxes`/`pieces`
  (assert `"boxes" in result === false`); qty 0 → null; floors fractional; negative → null.
- `setLineBoxes`: sets boxes, recomputes qty (boxes\*upb + pieces), preserves pieces + fields;
  0 boxes + 0 pieces → null; keeps loose pieces.
- `setLinePieces`: sets pieces, recomputes qty, preserves boxes + fields; 0/0 → null.

### WP2 — Rewire `NewOrderScreen.tsx` setters

**File:** `apps/mobile/components/NewOrderScreen.tsx` (only). Depends on WP1 (import the helpers).
Import `decrementLine, setLineQty, setLineBoxes, setLinePieces` from `../lib/sale-line`
(alongside the existing `incrementLine` import).

Rewrite the four setters to route through the helpers, keeping map add/delete semantics:

- `removeOne` (L532-557): guard `if (!prev) return m;`, then `const line = decrementLine(prev, isBoxed, upb); if (!line) { delete } else { set }`.
- `setBoxes` (L559-573): `const prev = m[id] ?? { qty: 0 }; const line = setLineBoxes(prev, boxes, upb); null→delete else set`.
- `setPieces` (L575-589): analogous with `setLinePieces(prev, pieces, upb)`.
- `setQty` (L591-601): `const prev = m[id] ?? { qty: 0 }; const line = setLineQty(prev, qty); null→delete else set`. (Preserves the boxes/pieces-clearing behavior via setLineQty.)

Do not change any other logic (snapshot retention, prefill, etc. are untouched — those live in `addOne`, not these setters).

### WP3 — Rewire `invoices/new.tsx` removeOne

**File:** `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx` (only). Depends on WP1.
Import `decrementLine` from `../../../../lib/sale-line` (match the existing `incrementLine`
import path in this file). Rewrite `removeOne` (L310-330) to guard `if (!prev) return m;` then
`const line = decrementLine(prev, isBoxed, upb); if (!line) delete next[id]; else next[id] = line; return next;`.

## Acceptance criteria

1. `sale-line.ts` exports `decrementLine`, `setLineQty`, `setLineBoxes`, `setLinePieces`, all
   spreading `...prev` (except setLineQty which additionally clears boxes/pieces).
2. All four NewOrderScreen setters and invoices/new `removeOne` route through the helpers; a
   line's `unitPrice`/`note`/`noteOpen` survive a decrement, a qty type-set, and a box/piece set.
3. Line-removal-at-zero behavior is unchanged (line deleted from the map when it reaches empty).
4. `setLineQty` still clears `boxes`/`pieces` (server-recompute intent preserved).
5. New Jest tests pass; existing `incrementLine` tests untouched and passing.

## Verify commands (run from repo root)

- `npm run check-types -w apps/mobile` (`tsc --noEmit`)
- `npm run test -w apps/mobile` (jest — includes sale-line.test.ts + regression)
- `npm run lint -w apps/mobile` (eslint; ensure no unused-var from any destructure)
