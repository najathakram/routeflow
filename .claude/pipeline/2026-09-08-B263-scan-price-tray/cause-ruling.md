# Cause ruling — B263 (B246 option B: price edit inside the scan flow over a paused camera)

Fable 5.1, 2026-09-08, over `cause-brief.md` (S1) and `cause-refutation.md` (S2). Branch
`fix/B263-scan-price-tray` off master eb2b815e (rf-F25). Option C (#668) is on master.

## 1. Cause verdict — ACCEPT S2, with its corrections

- Wrong behaviour TODAY on `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`: from a live
  scan, changing the scanned line's price and scanning the next item costs **5 taps and 2 camera
  lifecycles** (close scanner → leave picker → price chip → Apply → FAB → cold camera). S1's "4" is refuted;
  no REG test may assert 4.
- Diverging line: `edit-items.tsx:806` `{showPicker ? <ProductPicker/> : <>line list</>}` — every price
  affordance (chip `:937/:1279`, margin-floor block `:1220-1228`, `PriceOverrideModal` `:734-748`) is
  structurally exclusive with the picker. The camera dies from LEAVING the picker, not from opening a control:
  `ProductPickerSheet` (`:1998`) and `InlineCreateProductSheet` (`:2015`) already stack over the live camera,
  and the scanner is an inline `absoluteFill` swap, not a Modal (`:1982`).
- Registry's suggested host (`ScanOrderSheet`/`ScanTray` on the edit screen) is REFUTED: a second scan
  engine, `TrayRow` lacks price/floor/lock and omits `freeUnits`, and `overridable` is live at
  `NewOrderScreen.tsx:1325` so a shared tray control would be a no-op there. The row's `files:` frontmatter
  (`ScanOrderSheet.tsx`) is wrong; the fix lives in the edit screen and `BarcodeScanner`.
- Money: `canEditPrice` (`:922`) matches web's order edit (`:1272/:2661`), web's create modal and the server
  DTO (`update-order-items.dto.ts:71-91` — no tier lock, no floor, optional reason; DRIVER/CUSTOMER stripped
  at `orders.service.ts:3099-3125`). **No SPECIAL gate is added.** The real money gap: `PriceOverrideModal`
  writes the typed price without `roundMoney` (`:1409`) where web's `PriceEditRow` rounds (`page.tsx:772-777`).
- Independent HIGH defect found: `BarcodeScanner` (native `:90-101`, web `:76-87`) never renders
  `ScanFeedback.action`, so the picker's scanner can never hand an ambiguous/create scan to `onAmbiguous`/
  `onCreate` (`scan-ladder.ts:106/:149`); `paused` at `edit-items.tsx:1990` is therefore always false. Same
  file, same shape as this fix → **folded in** (its own REG), not filed.

## 2. Fix design (all mobile; Sonnet builds, Opus reviews; money helper Opus)

Invariant: while the picker is open, a just-scanned line's price can be changed WITHOUT leaving the picker
and without a camera remount; the price write is byte-identical to the list-branch path (`unitPrice` rounded
with `roundMoney`, `overrideReason`, margin-floor ack, tier/SPECIAL handling as today — no new gate); the
camera is paused (`active=false`, tracks kept) while the price sheet is up and resumes when it closes.

- **D1 `components/BarcodeScanner.tsx` + `.web.tsx`**: accept `active?: boolean` (default `true`) and
  forward it to `<ScanCamera active={active && !paused}>`; render `feedback.action` as the pill button
  exactly as `ScanOrderSheet.tsx:171-184` does (label from `action.label`, `onPress` → `action.onPress`).
  No other behaviour change; the four other `BarcodeFab`/scanner mounts keep working (`active` defaults true).
- **D2 `lib/price-override.ts` (new, pure)**: `applyPriceOverride(item, { unitPrice, reason })` → the new
  draft item with `unitPrice: roundMoney(unitPrice)`, `overrideReason: reason`, `lineTotal` via
  `computeLineSubtotal` (boxes/pieces preserved, `freeUnits` preserved). Both hosts (list branch and picker
  branch) call it. `PriceOverrideModal`'s apply path uses it (fixes the missing rounding).
- **D3 `edit-items.tsx`**: inside the picker branch, after a successful scan-add the scan feedback card gets
  an "Edit price" affordance (reuse the existing feedback surface the picker shows for the added line; if none
  renders a line, add a compact "last added: <name> · <price> · Edit price" strip above the scanner);
  tapping it opens the SAME `PriceOverrideModal` (rendered in the picker branch too, state
  `pickerPriceEditItem`) over the live-but-paused camera (`<BarcodeScanner active={!pickerPriceEditItem} …>`);
  Apply → `applyPriceOverride` → `updateDraftItem` (the same setter the list branch uses) → modal closes →
  camera resumes. The margin-floor ack for the picker path reuses the existing ack logic (`:1189` area)
  extracted into `lib/price-override.ts` as `needsMarginAck(item, newPrice, floor)` if it is not already pure.
  Result: scan → Edit price → Apply → scan next = **2 taps, 0 remounts**.
- **D4** Untouched: `ScanCamera.*`, `ScanOrderSheet`, `ScanTray`, `NewOrderScreen`, `scan-ladder.ts`,
  `addPickedToDraft`, `canEditPrice`, the server, `BarcodeFab`.

## 3. Regression tests (mobile Jest = pure-logic node; see bug-test-plan.md)

- REG-B263-A (pure) `applyPriceOverride` rounds and preserves boxes/pieces/freeUnits — today the helper does
  not exist (import fails) AND the modal's inline apply writes `12.345` unrounded (source pin on `:1409`).
- REG-B263-B (source-text, counted) the picker branch mounts `PriceOverrideModal` (today 0, expected 1) and
  passes `active={!pickerPriceEditItem}` to `BarcodeScanner` (today 0).
- REG-B263-C (source-text) `BarcodeScanner.tsx` and `.web.tsx` render `feedback.action` (today 0 each) and
  forward `active` to `ScanCamera` (today 0 each).
- Pins: `scan-ladder.test.ts`, `scan-engine`, `scan-feedback`, `edit-items-scan-fab`, `barcode-fab-props`,
  `order-item-diff`, `scan-tray` stay green; no SPECIAL gate appears (`canEditPrice` unchanged, source pin).

## 4. Blast radius

`apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`, `apps/mobile/components/BarcodeScanner.tsx`,
`apps/mobile/components/BarcodeScanner.web.tsx`, `apps/mobile/lib/price-override.ts` (new),
`apps/mobile/components/ScanCamera.tsx` + `.web.tsx` (read: `active` semantics), `apps/mobile/lib/scan-ladder.ts` (read).

## 5. Sibling pattern (file rows, do not fix)

Other price writes that skip `roundMoney` on mobile: grep `unitPrice:\s*(parseFloat|Number)\(` under
`apps/mobile/**`; other scanner hosts that ignore `feedback.action`.

## 6. Data repair — none (unrounded prices already written are display-level cents; the server rounds on

invoice — verify in review; if not, file a row, do not backfill here).

## 7. Probe plan

`revertFix: true` on `edit-items.tsx` → REG-B263-B red; on `BarcodeScanner.tsx` → REG-B263-C red; on
`lib/price-override.ts` → REG-B263-A red. Harness: source-text specs resolve paths from `__dirname`.

## 8. Registry

B263 → this run (files corrected to edit-items + BarcodeScanner; "4 taps" never asserted; measured 5 → 2).
The action-pill dead end is part of this fix's proof (REG-B263-C) — note it in B263's discharge evidence.
The PriceOverrideModal rounding gap → note in the same evidence (fixed here). No UI verify on this host;
owner device check after the next EAS build.
