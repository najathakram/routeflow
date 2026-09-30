/**
 * B264 / B265 / B266 — three B246 siblings, same shape: the screen mounts
 * `ProductPickerSheet` (which owns its own scanner behind a local `scanOpen`)
 * but offers no scan entry outside it. Fix mirrors the established sibling
 * pattern already used by `movements.tsx` / `adjust-picker.tsx` / stock-count
 * — a `BarcodeFab` resolving through `resolveProductByCode`, feeding the SAME
 * product-selection path the picker's own `onSelect` already uses (never a
 * second, parallel apply path) — rather than `edit-items.tsx`'s bespoke
 * pre-armed-picker pattern, which needs picker-level support the shared
 * `ProductPickerSheet` component doesn't expose.
 *
 * Source-text spec in the style of `edit-items-scan-fab.test.ts`: nothing
 * renders under mobile Jest (`jest.config.js` — `testEnvironment: "node"`),
 * so this reads each screen as text and pins the wiring, never a rendered
 * tree. Paths resolve from `__dirname`, never `process.cwd()`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("purchase-orders/record.tsx scan affordance (REG-B264)", () => {
  const SCREEN_PATH = join(__dirname, "..", "app", "(operator)", "purchase-orders", "record.tsx");
  const source = readFileSync(SCREEN_PATH, "utf8");

  it("REG-B264: mounts exactly one BarcodeFab, as a sibling of FormSheet (not inside its scrolling children)", () => {
    // TODAY: zero BarcodeFab mounts — the only scan primitive lives inside
    // ProductPickerSheet, reached only via the "Select product…" tap.
    expect((source.match(/<BarcodeFab\b/g) ?? []).length).toBe(1);
    // FormSheet's `children` render inside its own internal ScrollView — an
    // absolutely-positioned FAB mounted there would scroll away with the form
    // instead of floating fixed. It must be a SIBLING of <FormSheet>, i.e.
    // outside its closing tag, inside a Fragment.
    const fabAt = source.indexOf("<BarcodeFab");
    const formSheetCloseAt = source.indexOf("</FormSheet>");
    expect(fabAt).toBeGreaterThan(-1);
    expect(formSheetCloseAt).toBeGreaterThan(-1);
    expect(fabAt).toBeGreaterThan(formSheetCloseAt);
  });

  it("REG-B264: a scanned code resolves through resolveProductByCode and feeds the SAME apply path the picker's onSelect uses", () => {
    const onScannedBody = (source.match(
      /const onScanned = async \(code: string\) => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    expect(onScannedBody).toMatch(/resolveProductByCode<AdminProduct>\(/);
    expect(onScannedBody).toMatch(/if \(result\.archived\)/);
    expect(onScannedBody).toMatch(/showToast\(archivedMessage\(result\.product\)\)/);
    expect(onScannedBody).toMatch(/applyPickedProduct\(result\.product\)/);

    // Both the picker's onSelect and the scan handler call the SAME function
    // — never two independent copies of the field-fill logic.
    const onSelectBlock = (source.match(/onSelect=\{\(p\) => \{[\s\S]*?\n\s*\}\}/) ?? [""])[0];
    expect(onSelectBlock).toMatch(/applyPickedProduct\(p\)/);
    // Two CALLS (the declaration reads `applyPickedProduct = (`, not
    // `applyPickedProduct(`, so it doesn't match this pattern itself).
    expect((stripComments(source).match(/applyPickedProduct\(/g) ?? []).length).toBe(2);
  });

  it("REG-B264: the FAB hides while either picker sheet is open", () => {
    const fabBlock = (source.match(/<BarcodeFab\b[\s\S]{0,200}?\/>/) ?? [""])[0];
    expect(fabBlock).toMatch(/hidden=\{productPickerOpen \|\| supplierPickerOpen\}/);
  });

  it("REG-F4: applyPickedProduct routes the cost-prefill decision through nextUnitCost, keyed on the OUTGOING product id", () => {
    // Behavior (scan A then scan B never bills B at A's cost) is unit-tested
    // in purchase-receive-logic.test.ts — this pins the WIRING: the isNewProduct
    // comparison must run BEFORE setProductId reassigns it, and the decision
    // must go through the shared helper, not a re-derived inline ternary.
    const applyBody = (source.match(
      /const applyPickedProduct = \(p: AdminProduct\) => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    const isNewAt = applyBody.indexOf("isNewProduct = p.id !== productId");
    const setProductIdAt = applyBody.indexOf("setProductId(p.id)");
    expect(isNewAt).toBeGreaterThan(-1);
    expect(setProductIdAt).toBeGreaterThan(-1);
    expect(setProductIdAt).toBeGreaterThan(isNewAt);
    expect(applyBody).toMatch(/nextUnitCost\(cur, isNewProduct, prefill\)/);
  });
});

describe("invoices/[id]/edit.tsx scan affordance (REG-B265)", () => {
  const SCREEN_PATH = join(
    __dirname,
    "..",
    "app",
    "(operator)",
    "(tabs)",
    "invoices",
    "[id]",
    "edit.tsx",
  );
  const source = readFileSync(SCREEN_PATH, "utf8");

  it("REG-B265: mounts exactly one BarcodeFab, as a sibling of FormSheet, in continuous mode", () => {
    // TODAY: zero BarcodeFab mounts — the only scan primitive lives inside
    // ProductPickerSheet, reached only via "Add item".
    expect((source.match(/<BarcodeFab\b/g) ?? []).length).toBe(1);
    const fabBlock = (source.match(/<BarcodeFab\b[\s\S]{0,200}?\/>/) ?? [""])[0];
    // Invoice edit is a multi-line builder — BarcodeFab's own doc calls this
    // exact shape out ("order/invoice builders") as the continuous use case,
    // so the operator can scan several lines without re-tapping the FAB.
    expect(fabBlock).toMatch(/\bcontinuous\b/);
    expect(fabBlock).toMatch(/hidden=\{pickerOpen\}/);

    const fabAt = source.indexOf("<BarcodeFab");
    const formSheetCloseAt = source.indexOf("</FormSheet>");
    expect(fabAt).toBeGreaterThan(-1);
    expect(formSheetCloseAt).toBeGreaterThan(-1);
    expect(fabAt).toBeGreaterThan(formSheetCloseAt);
  });

  it("REG-B265: a scanned code resolves through resolveProductByCode and feeds the SAME addCatalogLine path a tapped pick uses", () => {
    const onScannedBody = (source.match(
      /const onScanned = async \(code: string\): Promise<ScanOutcome> => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    expect(onScannedBody).toMatch(/resolveProductByCode<AdminProduct>\(/);
    expect(onScannedBody).toMatch(/if \(result\.archived\)/);
    expect(onScannedBody).toMatch(/addCatalogLine\(result\.product\)/);
    // The picker's own onSelect is the pre-existing addCatalogLine reference
    // (unchanged) — never a second, parallel line-adding function.
    expect(source).toMatch(/onSelect=\{addCatalogLine\}/);
  });

  it("REG-F1: onScanned returns a ScanOutcome on every path — continuous mode needs feedback per scan, not a toast", () => {
    // TODAY (the bug): mounted `continuous`, so the scanner overlay stays up
    // between scans (BarcodeFab.tsx's own overlay, zIndex 2000) and BarcodeScanner
    // reads the handler's RETURN VALUE to show it — a bare `return;` (what a
    // single-shot ProductPickerSheet's ownscanned can get away with, since ITS
    // setScanOpen(false) makes a fallback toast visible) leaves every scan
    // silent here. Fixed: every path returns { feedback: { kind, text } },
    // never a toast for the scan outcome itself.
    const onScannedBody = (source.match(
      /const onScanned = async \(code: string\): Promise<ScanOutcome> => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    expect(onScannedBody).toMatch(/feedback:\s*\{\s*kind:/);
    expect(onScannedBody).not.toMatch(/showToast\(/);
    // Every branch (archived / added / not-found) returns, not just one.
    expect(
      (onScannedBody.match(/kind: "added"|kind: "error"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("customers/[id]/standing-orders/new.tsx scan affordance (REG-B266)", () => {
  const SCREEN_PATH = join(
    __dirname,
    "..",
    "app",
    "(operator)",
    "customers",
    "[id]",
    "standing-orders",
    "new.tsx",
  );
  const source = readFileSync(SCREEN_PATH, "utf8");

  it("REG-B266: mounts exactly one BarcodeFab, as a sibling of FormSheet, in continuous mode", () => {
    // TODAY: zero BarcodeFab mounts — the only scan primitive lives inside
    // ProductPickerSheet, reached only via "Add product".
    expect((source.match(/<BarcodeFab\b/g) ?? []).length).toBe(1);
    const fabBlock = (source.match(/<BarcodeFab\b[\s\S]{0,200}?\/>/) ?? [""])[0];
    // A standing order is a multi-line template builder — same continuous
    // rationale as the invoice editor (REG-B265).
    expect(fabBlock).toMatch(/\bcontinuous\b/);
    expect(fabBlock).toMatch(/hidden=\{pickerOpen\}/);

    const fabAt = source.indexOf("<BarcodeFab");
    const formSheetCloseAt = source.indexOf("</FormSheet>");
    expect(fabAt).toBeGreaterThan(-1);
    expect(formSheetCloseAt).toBeGreaterThan(-1);
    expect(fabAt).toBeGreaterThan(formSheetCloseAt);
  });

  it("REG-B266: a scanned code resolves through resolveProductByCode and feeds the SAME addLine path a tapped pick uses", () => {
    const onScannedBody = (source.match(
      /const onScanned = async \(code: string\): Promise<ScanOutcome> => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    expect(onScannedBody).toMatch(/resolveProductByCode<AdminProduct>\(/);
    expect(onScannedBody).toMatch(/if \(result\.archived\)/);
    expect(onScannedBody).toMatch(/addLine\(result\.product\)/);

    // Both the picker's onSelect and the scan handler call the SAME function
    // — the inline qty-increment-or-append logic was extracted into `addLine`
    // rather than duplicated for the scan path.
    const onSelectBlock = (source.match(/onSelect=\{\(product\) => \{[\s\S]*?\n\s*\}\}/) ?? [
      "",
    ])[0];
    expect(onSelectBlock).toMatch(/addLine\(product\)/);
    // Two CALLS (the declaration reads `addLine = (`, not `addLine(`, so it
    // doesn't match this pattern itself).
    expect((stripComments(source).match(/addLine\(/g) ?? []).length).toBe(2);
  });

  it("REG-F1: onScanned returns a ScanOutcome on every path — continuous mode needs feedback per scan, not a toast", () => {
    // Same finding as REG-B265's twin test (invoices/[id]/edit.tsx) — this
    // screen is ALSO mounted `continuous`.
    const onScannedBody = (source.match(
      /const onScanned = async \(code: string\): Promise<ScanOutcome> => \{[\s\S]*?\n {2}\};/,
    ) ?? [""])[0];
    expect(onScannedBody).toMatch(/feedback:\s*\{\s*kind:/);
    expect(onScannedBody).not.toMatch(/showToast\(/);
    expect(
      (onScannedBody.match(/kind: "added"|kind: "error"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
