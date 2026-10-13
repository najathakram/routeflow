/**
 * B1220 — every direct caller of `decideScanResult` must handle `pick-from-list` (2+ fuzzy
 * matches). Before the fix they fell through to `result.product` (the first match) and wrote it.
 * Source-text guard (mobile Jest renders nothing): each caller must pass a `pick` handler to
 * `runScanDecision`, mount the shared sheet, and never commit `result.product` ahead of the
 * decision.
 */
import { readFileSync } from "fs";
import { join } from "path";

const A = (...p: string[]) => join(__dirname, "..", ...p);
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CALLERS: Array<[string, string]> = [
  ["adjust.tsx", A("app", "(driver)", "route", "stop", "[stopId]", "adjust.tsx")],
  ["invoices/[id]/edit.tsx", A("app", "(operator)", "(tabs)", "invoices", "[id]", "edit.tsx")],
  [
    "standing-orders/new.tsx",
    A("app", "(operator)", "customers", "[id]", "standing-orders", "new.tsx"),
  ],
  ["stock-count/[id].tsx", A("app", "(operator)", "products", "stock-count", "[id].tsx")],
  ["purchase-orders/record.tsx", A("app", "(operator)", "purchase-orders", "record.tsx")],
  ["vendor-bills/new.tsx", A("app", "(operator)", "vendor-bills", "new.tsx")],
  ["ProductPickerSheet.tsx", A("components", "ProductPickerSheet.tsx")],
];

const NAV_SCREENS: Array<[string, string]> = [
  ["products/scan.tsx", A("app", "(operator)", "products", "scan.tsx")],
  ["products/adjust-picker.tsx", A("app", "(operator)", "products", "adjust-picker.tsx")],
  ["movements.tsx", A("app", "(operator)", "movements.tsx")],
];

describe("navigation scan screens list 2+ matches instead of opening the first (B1220)", () => {
  it.each(NAV_SCREENS)("%s", (_n, path) => {
    const src = strip(readFileSync(path, "utf8"));
    expect(src).toMatch(/decision\.kind === "pick-from-list"/);
    expect(src).toMatch(/matchPicker\.open\(/);
    expect(src).toMatch(/<ScanMatchPickerSheet\b/);
  });
});

describe("pick-from-list is handled by every decideScanResult caller (B1220)", () => {
  it.each(CALLERS)("%s", (_name, path) => {
    const src = strip(readFileSync(path, "utf8"));
    expect(src).toMatch(/useScanMatchPicker[<(]/);
    expect(src).toMatch(/<ScanMatchPickerSheet\b/);
    // runScanDecision(...) receives the picker's `open` as its `pick` option.
    expect(src).toMatch(/pick:\s*\w+\.open/);
  });

  it.each(CALLERS)(
    "%s consumes runScanDecision's result, not a suggestion-only branch",
    (_n, path) => {
      const src = strip(readFileSync(path, "utf8"));
      // The old shape handled ONLY `confirm-suggestion` and then added `result.product`, which
      // wrote the first of several matches. The decision must be run for every kind and its
      // boolean result consumed.
      expect(src).not.toMatch(/if \(decision\.kind === "confirm-suggestion"\)/);
      expect(src).toMatch(/(if \(\s*!?\s*|=\s*)runScanDecision\(/);
    },
  );

  it("the picker sheet and hook exist and commit only through onChoose", () => {
    const sheet = readFileSync(A("components", "ScanMatchPickerSheet.tsx"), "utf8");
    expect(sheet).toMatch(/onPress=\{\(\) => onChoose\(m\)\}/);
    expect(sheet).toMatch(/Cancel/);
  });
});

describe("B1220 nit — a prompt is neutral feedback, not an error", () => {
  const SCREENS: Array<[string, string]> = [
    ["invoices/[id]/edit.tsx", A("app", "(operator)", "(tabs)", "invoices", "[id]", "edit.tsx")],
    [
      "standing-orders/new.tsx",
      A("app", "(operator)", "customers", "[id]", "standing-orders", "new.tsx"),
    ],
  ];
  const THREE: Array<[string, string]> = [
    ...SCREENS,
    ["stock-count/[id].tsx", A("app", "(operator)", "products", "stock-count", "[id].tsx")],
  ];
  it.each(THREE)("%s returns info (not error) feedback for the prompt", (_n, path) => {
    const src = strip(readFileSync(path, "utf8"));
    expect(src).toMatch(/kind: "info", text: promptText\(decision\)/);
    expect(src).not.toMatch(/kind: "error", text: promptText/);
  });

  it.each(["BarcodeScanner.tsx", "BarcodeScanner.web.tsx"])("%s renders info neutrally", (f) => {
    const src = strip(readFileSync(A("components", f), "utf8"));
    expect(src).toContain("information-circle");
    expect(src).toContain("feedbackInfo");
  });

  it.each(SCREENS)("%s fires the neutral info haptic on the prompt path", (_n, path) => {
    const src = strip(readFileSync(path, "utf8"));
    expect(src).toMatch(/import \{ scanHaptic \} from "[./]*lib\/haptics"/);
    expect(src).toContain('scanHaptic("info")');
    expect(src).not.toContain('scanHaptic("error")');
  });

  it("adjust.tsx carries the B1220 lone-fuzzy comment once", () => {
    const raw = readFileSync(
      A("app", "(driver)", "route", "stop", "[stopId]", "adjust.tsx"),
      "utf8",
    );
    expect(raw.match(/B1220: a lone fuzzy match/g)).toHaveLength(1);
  });
});
