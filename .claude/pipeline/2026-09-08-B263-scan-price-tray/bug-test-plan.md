# Bug test plan — B263 (price edit inside the scan flow, paused camera)

Design of record: `cause-ruling.md` §2. Mobile Jest = `apps/mobile/__tests__/**/*.test.ts`, node, pure logic;
source-text specs read files relative to `__dirname` and tolerate prettier wrapping (`\s*`). Every REG test
states the value it fails on TODAY, and each oracle sits in its OWN `it` so Jest's stop-at-first-failing-expect
cannot mask an oracle in the red run (red-gate audit 2026-09-08).

## Red gate (REG-B263)

### T1 — `apps/mobile/__tests__/price-override.test.ts` (pure) — REG-B263-A

Imports `applyPriceOverride` and `needsMarginAck` from `apps/mobile/lib/price-override.ts` (new).

- `applyPriceOverride({ unitPrice: 10, boxes: 2, pieces: 3, unitsPerBox: 12, freeUnits: 1, … }, { unitPrice: 12.345, reason: "negotiated" })`
  → four separate `it`s: `unitPrice === 12.35` (roundMoney); `overrideReason === "negotiated"`;
  boxes/pieces/freeUnits unchanged; `lineTotal === computeLineSubtotal(...)` for the new price (= 15.44).
  TODAY: the module is a signature-only stub → each fails on `undefined` against a concrete expected value.
- T1b (source pin, scoped to the LIST-branch `<PriceOverrideModal …/>` element, split at `function ProductPicker`):
  (i) the mount routes through `applyPriceOverride(` (today 0, expected ≥ 1); (ii) the mount no longer writes
  `unitPrice: newPrice` (today PRESENT — the bug's own wrong source text). The rounding lives INSIDE
  `applyPriceOverride` per D2, so this pins the hand-off, NOT a redundant `roundMoney(` in the JSX.
- `needsMarginAck(item, 9.99, floor 10)` → true; `(item, 10, 10)` → false — TODAY no helper.

### T2 — `apps/mobile/__tests__/edit-items-scan-price.test.ts` (source-text) — REG-B263-B

Reads `edit-items.tsx`, splits at `function ProductPicker`. Asserts, one `it` each: (a) exactly one
`<PriceOverrideModal` mount INSIDE the picker part (today 0); (b) the picker's `<BarcodeScanner` carries an
`active={` prop (today 0); (c) that `active` expression is the NEGATED picker state — matches
`/^\s*!\s*pickerPriceEditItem\b/`, so the inverted polarity `active={pickerPriceEditItem}` fails (today "");
(d) the picker's own `<PriceOverrideModal` element wires `onSave` through `applyPriceOverride(` (today "").

### T3 — `apps/mobile/__tests__/barcode-scanner-active.test.ts` (source-text) — REG-B263-C

Reads `components/BarcodeScanner.tsx` and `.web.tsx` COMMENT-STRIPPED (block + whole-line `//`), so no
assertion can be satisfied by prose. Each host, one `it` each: forwards `active` into the `<ScanCamera` open
tag (today 0); the feedback-pill JSX window (from `{feedback ? (`) reads `feedback.action` (today 0); that
window binds `onPress` to the action's own `.onPress` (today 0).

## Pins (outside the red gate)

- `PIN-B263-D4` (`edit-items-scan-price.test.ts`, own describe, NO REG-B263 id so `jest -t "REG-B263"` cannot
  select it): `canEditPrice={!isDriver && order.status !== "CANCELLED"}` on the list branch is unchanged — D4
  says it is explicitly untouched, so this pin PASSES today and must keep passing. It is a no-change
  regression pin, not a requirement.
- Existing: `scan-ladder.test.ts`, `scan-engine.test.ts`, `scan-feedback.test.ts`, `scan-camera-buffer.test.ts`,
  `scan-camera-web-sequencing.test.ts`, `edit-items-scan-fab.test.ts`, `scan-fab-visibility.test.ts`,
  `barcode-fab-props.test.ts`, `order-item-diff.test.ts`, `scan-tray.test.ts` — all untouched, all green.

## Harness notes

No mocks change. `lib/price-override.ts` imports `roundMoney`/`computeLineSubtotal` from `@routeflow/pricing`
(already a mobile dependency — check `apps/mobile/package.json`). Source-text specs must not match comments:
count JSX tags (`<PriceOverrideModal`), not words, and strip comments where a bare identifier is asserted.

## Red-gate status (2026-09-08, after remediation)

`cd apps/mobile && npx jest __tests__/price-override.test.ts __tests__/edit-items-scan-price.test.ts
__tests__/barcode-scanner-active.test.ts --runInBand -t "REG-B263"` → **18 failed / 0 passed / 1 skipped**
(the skipped one is `PIN-B263-D4`). Unfiltered: 18 failed / 1 passed / 19 total.
