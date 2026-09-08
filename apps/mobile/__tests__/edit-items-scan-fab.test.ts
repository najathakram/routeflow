/**
 * B246 Option C / T1 (REG-B246) — `edit-items-scan-fab.test.ts`
 *
 * `cause-ruling.md` §1/§2: on the order-edit line-list branch of
 * `edit-items.tsx`, no control opens a camera today — the only scan
 * primitive lives inside `ProductPicker`, reached only through "Add
 * product". The fix mounts `components/BarcodeFab` in the line-list branch,
 * gated (REG-B62) behind `pricingReady`/`showPicker`/`priceEditItem`, and
 * teaches `ProductPicker` to open pre-armed for scanning via a new
 * `initialScanOpen` prop.
 *
 * Source-text spec in the style of `scan-camera-buffer.test.ts:141-155`:
 * nothing renders under mobile Jest (`jest.config.js:4/:11`), so this reads
 * `edit-items.tsx` as text and pins counted values, never a rendered tree.
 * Paths resolve from `__dirname`, never `process.cwd()`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(operator)",
  "(tabs)",
  "orders",
  "[id]",
  "edit-items.tsx",
);
const source = readFileSync(SCREEN_PATH, "utf8");

// The line-list branch is everything OUTSIDE `ProductPicker` — it owns
// every scan primitive today (cause-ruling.md §1, `:1737` onward). Splitting
// here is how T1a/T1b (parent) and T1c (picker) each look only at their own
// half instead of an accidental match on the other side.
const splitIndex = source.indexOf("function ProductPicker");

const parentSrc = source.slice(0, splitIndex === -1 ? source.length : splitIndex);
const pickerSrc = source.slice(splitIndex);

// The FAB's JSX mount, if present in the parent branch — captured as a
// bounded, non-greedy window up to its self-closing `/>` so hidden/onPress
// can be inspected without a full JSX parser. Empty string when absent
// (today), which is itself what makes every sub-assertion below fail red.
const fabBlockMatch = parentSrc.match(/<BarcodeFab\b[\s\S]{0,1500}?\/>/);
const fabBlock = fabBlockMatch ? fabBlockMatch[0] : "";

describe("edit-items.tsx line-list scan FAB (REG-B246)", () => {
  it("REG-B246: mounts exactly one BarcodeFab on the line-list branch, outside ProductPicker", () => {
    // Today: no control on the line list opens a camera (cause-ruling.md
    // §1) — zero mounts. After the fix: exactly one, in the parent branch.
    const parentMounts = parentSrc.match(/<BarcodeFab\b/g) ?? [];
    expect(parentMounts.length).toBe(1);
  });

  it("REG-B246: the FAB stays hidden while pricing is not ready, the picker is open, or the price modal is open", () => {
    // REG-B62: the picker is the only place a line gets priced, so nothing
    // scan-shaped may act before pricingReady — plus the two states that
    // already own the screen's attention (`showPicker`, `priceEditItem`).
    // The rule itself lives in `lib/scan-fab-visibility.ts` (T2). Pin that
    // the mount routes `hidden` THROUGH it, so the module cannot ship dead
    // beside an inline copy of the same expression.
    expect(fabBlock).toMatch(/hidden=\{\s*scanFabHidden\(/);

    const hiddenMatch = fabBlock.match(/hidden=\{([\s\S]*?)\}/);
    const hiddenExpr = hiddenMatch ? hiddenMatch[1] : "";
    expect(hiddenExpr).toMatch(/pricingReady/);
    expect(hiddenExpr).toMatch(/showPicker/);
    expect(hiddenExpr).toMatch(/priceEditItem/);
  });

  it("REG-B246: ProductPicker opens in scan mode on request via initialScanOpen", () => {
    // Today: `scanOpen` (`:1758`) always starts `false` — no `initialScanOpen`
    // prop exists anywhere in ProductPicker. After: it appears once in the
    // props type and once seeding the `scanOpen` useState initializer.
    const declaresPropType = /initialScanOpen\??:\s*boolean/.test(pickerSrc);
    const seedsUseState = /useState\([^)]*initialScanOpen[^)]*\)/.test(pickerSrc);
    const matchCount = (declaresPropType ? 1 : 0) + (seedsUseState ? 1 : 0);
    expect(matchCount).toBe(2);
  });

  it("REG-B246: the FAB opens the picker with scan intent (picker-open AND scan-intent both set)", () => {
    // cause-ruling.md §2, D1: the FAB's own `onPress` opens the picker (the
    // existing `setShowPicker(true)`) AND arms the new `pickerScanIntent`
    // state so ProductPicker mounts with `initialScanOpen` true — two state
    // setters (or one carrying both values), not just re-opening the plain
    // "Add product" path.
    //
    // Scoped to `fabBlock` (the FAB's own JSX mount, not the whole parent
    // branch) so the test fails when either setter lives somewhere else —
    // e.g. on the pre-existing "Add product" Pressable — and so it fails
    // when the trigger is wired through `onScanned` instead of a tap
    // (`onPress`) that owns opening the picker itself.
    expect(parentSrc).toMatch(
      /const \[\s*pickerScanIntent\s*,\s*setPickerScanIntent\s*\]\s*=\s*useState/,
    );
    expect(fabBlock).toMatch(/onPress=\{/);
    expect(fabBlock).toMatch(/setPickerScanIntent\(\s*true\s*\)/);
    expect(fabBlock).toMatch(/setShowPicker\(\s*true\s*\)/);
    expect(fabBlock).not.toMatch(/onScanned=/);
  });

  it("REG-B246: BarcodeFab honours onPress before opening its own scanner", () => {
    // A screen that supplies `onPress` must never also trigger BarcodeFab's
    // own camera overlay — otherwise the FAB opens a first, discardable
    // scanner before the picker's own (see cause-ruling.md §2).
    const fabSource = readFileSync(join(__dirname, "..", "components", "BarcodeFab.tsx"), "utf8");
    expect(fabSource).toMatch(/onPress\?\s*:/);
    expect(fabSource).toMatch(
      /if\s*\(\s*onPress\s*\)\s*\{\s*onPress\(\);\s*return;?\s*\}[\s\S]*?setScanOpen\(\s*true\s*\)/,
    );
  });

  it("REG-B246: pickerScanIntent is reset when the picker closes so the plain Add product path opens cold", () => {
    // If either reset were dropped, every subsequent "Add product" tap
    // would open the picker with the camera already running (build-plan.md
    // P1.3) — pin both resets, that the picker seeds off `pickerScanIntent`,
    // and that only the FAB ever arms it.
    const pickerMountMatch = parentSrc.match(/<ProductPicker\b[\s\S]*?\/>/);
    const pickerBlock = pickerMountMatch ? pickerMountMatch[0] : "";

    const onPickMatch = pickerBlock.match(/onPick=\{([\s\S]*?)\n\s{10}\}\}/);
    const onPickBody = onPickMatch ? onPickMatch[1] : "";
    expect(onPickBody).toMatch(/setPickerScanIntent\(\s*false\s*\)/);

    const onCloseMatch = pickerBlock.match(/onClose=\{([\s\S]*?)\}\}/);
    const onCloseBody = onCloseMatch ? onCloseMatch[1] : "";
    expect(onCloseBody).toMatch(/setPickerScanIntent\(\s*false\s*\)/);

    expect(pickerBlock).toMatch(/initialScanOpen=\{pickerScanIntent\}/);

    const armCount = (parentSrc.match(/setPickerScanIntent\(\s*true\s*\)/g) ?? []).length;
    expect(armCount).toBe(1);
  });
});
