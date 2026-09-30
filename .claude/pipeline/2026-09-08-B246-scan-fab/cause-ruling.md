# Cause ruling — B246 Option C (scan affordance on the mobile order-edit line list) + B245 pin

Fable 5.1, 2026-09-08, over `cause-brief.md` (S1) and `cause-refutation.md` (S2). Branch
`fix/B246-scan-fab` off master (rf-F25). Owner order: C first (this run), B later (price control over a
paused camera, `ScanOrderSheet` on the edit screen).

## 1. Cause verdict — ACCEPT S2

- Real defect: from the line-list branch of `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`
  (`:838-999`) no control opens a camera; the only mount is inside `ProductPicker` (`:1949-1958`), which owns
  every scan primitive locally (`scanOpen :1758`, `useProductSearch :1784`, the ladder `:1800-1819`, the
  sheets `:1964/:1981`, the toast `:1961`); only `addPickedToDraft :511` lives in the parent.
- Measured path after a price edit: Apply (`:1445`) → "Add product" (`:959`) → barcode icon (`:1890`) →
  cold camera = **3 taps** (4 counting the price chip). The registry's "6" is refuted; the row's evidence line
  must carry the measured count.
- Cold start is universal: `ScanCamera.web.tsx:197` stops every track on unmount; `BarcodeScanner` passes no
  `active`; even `NewOrderScreen`'s `onScanMore` remounts (`ScanOrderSheet.tsx:128-131`). Not this run's
  problem (Option B).
- Handoff-style Option C ("FAB wired to the scan ladder + `addPickedToDraft`") is REFUTED as designed:
  `makeScanHandler` is picker-scoped, `BarcodeScanner` renders no `feedback.action` (ambiguous/miss would
  dead-end), and an ungated FAB re-opens REG-B62 (`tierPriceFor :318-319`, `isSpecial :527`).

## 2. Fix design — the FAB opens the picker in scan mode (one file)

Invariant: on the line-list branch, one tap reaches a live scanner that adds to the draft through the SAME
ladder, sheets, feedback, tier/SPECIAL lock, margin-floor ack (`:1189`) and boxed math (`computeLineSubtotal`)
as today; no new pricing path exists; the affordance is never shown while pricing is not ready, the picker is
open, or the price modal is open.

D1 — `edit-items.tsx` (Sonnet `high` — money-adjacent gating; Opus review):

- `ProductPicker` gains `initialScanOpen?: boolean` and seeds `useState(initialScanOpen ?? false)` for
  `scanOpen` (`:1758`); nothing else inside the picker changes.
- Parent state `pickerScanIntent: boolean`; the existing "Add product" path keeps `false`.
- Mount `components/BarcodeFab.tsx` (unchanged component; call-site precedent `adjust.tsx`,
  `stock-count/[id].tsx`, `adjust-picker.tsx`, `movements.tsx`) in the line-list branch only:
  `hidden={!pricingReady || pickerOpen || priceModalOpen}` (use the screen's actual flags), `onPress` →
  open the picker with `initialScanOpen` true. When the picker closes, reset the intent.
- No change to `addPickedToDraft`, the ladder, `ScanTray`, `ScanOrderSheet`, `NewOrderScreen`,
  `scan-ladder.ts`, `BarcodeScanner*`, `ScanCamera*`.
  Result: Apply → FAB → camera (1 tap after Apply, was 2), a permanent, discoverable scan affordance on the
  list (web parity: permanent scan row `orders/[id]/page.tsx:1341`, zero navigation; web has no camera, so no
  warm-camera obligation here).

## 3. Regression tests

Mobile Jest is pure-logic `.test.ts` in node (`jest.config.js:4/:11`); nothing renders. Behavioural bar:

- REG-B246-A (`apps/mobile/__tests__/edit-items-scan-fab.test.ts`, source-text spec in the style of
  `scan-camera-buffer.test.ts:141-155`): reads `edit-items.tsx` and asserts (1) exactly one `<BarcodeFab`
  mount inside the line-list branch (today **0**, expected **1**), (2) its `hidden` expression references
  the pricing-ready flag AND the picker-open flag AND the price-modal flag, (3) `ProductPicker` declares
  `initialScanOpen` and seeds `scanOpen` from it (today 0 matches). Each assertion fails on a counted value.
- REG-B246-B (pure logic): extract the visibility rule into
  `apps/mobile/lib/scan-fab-visibility.ts` — `scanFabHidden({ pricingReady, pickerOpen, priceModalOpen })`
  — used by D1; test the four rules (hidden until ready = the REG-B62 guard; hidden while picker open; hidden
  while the modal is open; visible otherwise).
- B245 PIN (no REG token, outside the red gate): source-text spec on `ScanCamera.web.tsx` pinning the four
  sequencing sites S1 named (`handleFrame` in `.then()` `:337-338`, `inFlightRef` release in `.finally()`
  `:341-344`, `scanSettled` drain `:248-252`, `playScanCue` `:245`) plus `track.stop()` in the unmount cleanup.
  Discharges B245 as "pinned by source assertion; behavioural coverage needs a web renderer (L-025)".
  Fences: `scan-ladder.test.ts`, `scan-engine.test.ts`, `scan-feedback.test.ts`, and every REG-B62/B60 test in
  `apps/mobile/__tests__` stay green untouched.

## 4. Blast radius (radiusFiles)

`apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`, `apps/mobile/components/BarcodeFab.tsx`
(read), `apps/mobile/lib/scan-ladder.ts` (read), `apps/mobile/lib/scan-fab-visibility.ts` (new), the two
new specs.

## 5. Sibling pattern (file rows, do not fix)

`scanOpen` declared inside a picker/sheet component with no parent-level scan affordance:
`grep -n "useState.*scanOpen\|scanOpen, setScanOpen"` across `apps/mobile/app/**` and
`apps/mobile/components/**`; any screen whose only scanner is inside a modal picker = one row (expected:
purchase-order receive, stock-count picker if it still hides its scanner).

## 6. Data repair — none (UI only)

## 7. Probe plan

`revertFix: true` on `edit-items.tsx` → REG-B246-A red; on `scan-fab-visibility.ts` → REG-B246-B red.
Harness note: no mocks change; the source-text specs read files relative to the repo root — resolve paths
from `__dirname`, never from `process.cwd()`.

## 8. Registry

B246 → this run (Option C; the row's "6 taps" corrected to the measured 3, the B twin stays open as its own
row: "price edit inside the scan flow over a paused camera" — file it if absent). B245 → discharged by the pin.
No UI verify in the engine (no mobile renderer on the host); the owner exercises the FAB on a device after
deploy — say so in the PR.
