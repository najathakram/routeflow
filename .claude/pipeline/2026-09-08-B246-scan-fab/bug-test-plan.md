# Bug test plan — B246 Option C (+ B245 pin)

Design of record: `cause-ruling.md` §2 (read with this plan). Mobile Jest = `apps/mobile/__tests__/**/*.test.ts`,
node environment, pure logic — nothing renders (`apps/mobile/jest.config.js:4,11`). Source-text specs resolve
paths from `__dirname` (never `process.cwd()`), in the style of `apps/mobile/__tests__/scan-camera-buffer.test.ts:141-155`.

## Red gate (must fail TODAY on its own wrong value)

### T1 — `apps/mobile/__tests__/edit-items-scan-fab.test.ts` (source-text) — REG-B246

Reads `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` as text.

- T1a `REG-B246 line list mounts exactly one BarcodeFab`: count of `<BarcodeFab` occurrences OUTSIDE the
  `ProductPicker` function body (split the file at the `function ProductPicker` declaration; count in the
  parent part). Today **0**; after **1**.
- T1b `REG-B246 the FAB is hidden while pricing is not ready, the picker is open, or the price modal is open`:
  the `hidden={…}` expression on that mount references all three flags (use the names the screen actually
  uses — the test author reads them from the file and pins them literally). Today **0** matches; after **1**.
- T1c `REG-B246 ProductPicker opens in scan mode on request`: `initialScanOpen` appears in the
  `ProductPicker` props type AND in the `useState(` initialiser of `scanOpen`. Today **0**; after **2**.
- T1d `REG-B246 the FAB opens the picker with scan intent`: the FAB's `onPress` handler sets the picker open
  AND the scan intent (two state setters, or one setter with both values) — pin by regex on the handler body.

### T2 — `apps/mobile/__tests__/scan-fab-visibility.test.ts` (pure logic) — REG-B246

Imports `scanFabHidden` from `apps/mobile/lib/scan-fab-visibility.ts` (new). Cases:
`{pricingReady:false, pickerOpen:false, priceModalOpen:false}` → hidden (the REG-B62 guard);
`{true,true,false}` → hidden; `{true,false,true}` → hidden; `{true,false,false}` → visible.
Today the module does not exist (import fails); after: four passing rules. The engine treats a missing
module as structural red — T1 carries the behavioural bar.

### Red-gate record (what actually went red, 2026-09-08)

- The gate's **new-test set is exactly two files**: `apps/mobile/__tests__/edit-items-scan-fab.test.ts` (T1)
  and `apps/mobile/__tests__/scan-fab-visibility.test.ts` (T2). The gate command
  `npx jest --runInBand -t "REG-B246"` selects only those; no other file carries a REG token.
- `apps/mobile/__tests__/scan-camera-web-sequencing.test.ts` (T3/B245) is **not part of the gate**. All five
  of its tests pin behaviour that already exists in `components/ScanCamera.web.tsx`, so they were **green
  before the fix** and stayed green; B245 carries **no code change** in this package and contributes **zero
  red-gate coverage**. It lands as a pin/discharge, not a fix, and must not be rewritten to fail.
- **T2's red was produced by a test-phase stub.** `apps/mobile/lib/scan-fab-visibility.ts` did not exist in
  the repo's pre-change state; the test phase authored a signature-only stub returning `undefined` so the
  import would resolve, and all four T2 cases failed on that placeholder rather than on any wrong value the
  bug itself produced. T2 therefore proves wiring, not behaviour — **T1 carried the behavioural bar**, and
  all four of its cases failed on the real, unmodified `edit-items.tsx`'s own counted values
  (`<BarcodeFab` 0, `initialScanOpen` 0, `pickerScanIntent` 0).
- T1b additionally pins `hidden={scanFabHidden(` on the mount, so the T2 module cannot ship dead beside an
  inline copy of the rule.

## Pins (no REG token, outside the red gate)

### T3 — `apps/mobile/__tests__/scan-camera-web-sequencing.test.ts` (source-text) — B245 pin

Reads `apps/mobile/components/ScanCamera.web.tsx`: `handleFrame` call inside a `.then(` block; the
`inFlightRef.current = false` (or equivalent release) inside `.finally(`; the `scanSettled` drain; `playScanCue(`
call; `track.stop()` inside the unmount cleanup. Five assertions, each a count ≥ 1. Discharges B245 as "pinned
by source assertion (L-025: web platform branches are untested unless something runs that platform)".

**Gate exclusion (recorded for the harness-integrity check, 2026-09-08 red-gate remediation):** all five
tests in this file are **green by design today** — they pin behaviour that already exists in
`ScanCamera.web.tsx`, so they must NOT be rewritten to fail. The red gate for this run is
`npx jest --runInBand -t "REG-B246"`, which selects only the two REG-B246 files
(`edit-items-scan-fab.test.ts`, `scan-fab-visibility.test.ts`); no title in this file carries a REG token,
so nothing here is counted as a new red test. B245 is therefore a **discharge/pin, not a fix** — no code
change is pending for it in this package, and it contributes no red-gate coverage.
Titles of the `scanSettled` / `playScanCue` pins were reworded to "is called at least once": both are bare
occurrence counts over the file and assert no ordering or per-outcome coverage.

### Fences (existing, untouched, must stay green)

`apps/mobile/__tests__/scan-ladder.test.ts`, `scan-engine.test.ts`, `scan-feedback.test.ts`,
`scan-camera-buffer.test.ts`, and every test titled `REG-B194` (`sale-line-fold.test.ts`).
B62 and B60 are referenced only in source/test comments — no test title carries a `REG-B62` or
`REG-B60` token — so they are not fences and nothing selects them.

## Harness notes (the engine's harness-integrity check verifies this list)

No mocks or fixtures change: the fix adds props/state and one pure module; no import of a native module is
added to `edit-items.tsx` beyond `components/BarcodeFab` (already imported by four screens). The source-text
specs must tolerate prettier line-wrapping (regexes span whitespace with `\s*`).
