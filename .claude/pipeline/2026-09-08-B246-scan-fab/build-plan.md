# Build plan — B246 Option C (scan FAB on the mobile order-edit line list) + B245 pin

Mode `bugfix`, scale `minor`. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25`, branch
`fix/B246-scan-fab` (off master; merge `origin/master` before landing). Design of record `cause-ruling.md`
§2; tests `bug-test-plan.md`. Option-B bookkeeping: no map/lessons/ledger edits in this run. Never run
Playwright or Expo; no UI verify on this host (no mobile renderer) — say so in the PR.

## Packages

### P1 — the fix (Sonnet `high`; Opus review)

Files: `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`, `apps/mobile/lib/scan-fab-visibility.ts` (new).

1. `apps/mobile/lib/scan-fab-visibility.ts`: `export function scanFabHidden(s: { pricingReady: boolean; pickerOpen: boolean; priceModalOpen: boolean }): boolean` — hidden unless `pricingReady && !pickerOpen && !priceModalOpen`. Pure, no imports.
2. `ProductPicker` (same file, ~`:1758`): add `initialScanOpen?: boolean` to its props; `const [scanOpen, setScanOpen] = useState(initialScanOpen ?? false)`. Nothing else inside the picker changes.
3. Parent: `const [pickerScanIntent, setPickerScanIntent] = useState(false)`; pass `initialScanOpen={pickerScanIntent}` to `<ProductPicker>`; when the picker closes (its existing `onClose`/dismiss path) reset the intent to `false`. The existing "Add product" button keeps opening the picker with intent `false`.
4. Line-list branch (~`:838-999`, the non-picker branch only): render `<BarcodeFab hidden={scanFabHidden({ pricingReady, pickerOpen, priceModalOpen })} onPress={() => { setPickerScanIntent(true); <open the picker exactly as "Add product" does>; }} />` using the screen's real flag names (the pricing-ready flag that guards `tierPriceFor`/`isSpecial` — REG-B62; the picker-open state; the `PriceOverrideModal` visibility state). Match the `BarcodeFab` props used by `adjust.tsx` / `movements.tsx`; keep it draggable as it is; do not add a second scanner component.
5. Do NOT touch: `addPickedToDraft`, the ladder, `makeScanHandler`, `ScanTray`, `ScanOrderSheet`, `NewOrderScreen`, `scan-ladder.ts`, `BarcodeScanner*`, `ScanCamera*`, `PriceOverrideModal`, the margin-floor ack (`:1189`), tier/SPECIAL lock, `computeLineSubtotal` usage.

### TP-MOBILE — tests (Sonnet `medium`)

Files: `apps/mobile/__tests__/edit-items-scan-fab.test.ts`, `apps/mobile/__tests__/scan-fab-visibility.test.ts`, `apps/mobile/__tests__/scan-camera-web-sequencing.test.ts`. Implement `bug-test-plan.md` T1, T2, T3 exactly; REG token `REG-B246` only on T1/T2 titles; T3 carries none.

## Gates

Per round: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`; `cd apps/mobile && npx jest __tests__/edit-items-scan-fab.test.ts __tests__/scan-fab-visibility.test.ts __tests__/scan-camera-web-sequencing.test.ts __tests__/scan-ladder.test.ts --runInBand`.
Final: `cd apps/mobile && npx jest --silent`; `npm run lint -w apps/mobile`; `node scripts/validate-lessons.mjs`.
Red gate: `cd apps/mobile && npx jest --runInBand -t "REG-B246"` must FAIL before P1 (T1 counts 0 where 1 is expected).

## Pipeline args

See `pipeline-args.json` (mode bugfix; radiusFiles from `cause-ruling.md` §4; siblingPatterns §5; probe §7).

## Landing (Lead)

Commit with trailer `Bookkeeping-Follow-Up: pending` → merge origin/master → regen api/mobile/pricing reports → campaign-check → hook push → draft PR `fix(mobile): scan FAB on the order-edit line list opens the picker in scan mode (B246 option C)` → window → both Railway rows terminal (mobile change: api/web likely SKIPPED — a mobile-only diff deploys nothing; the E2E proof is the mobile Jest + the owner's device check) → docs follow-up (B246 row: "6 taps" corrected to 3, Option B twin filed/kept open; B245 discharged by pin; lesson if any; code map for edit-items + lib/scan-fab-visibility).
