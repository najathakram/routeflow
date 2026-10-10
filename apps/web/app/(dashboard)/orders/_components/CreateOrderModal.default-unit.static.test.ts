import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2784 PR-2: source pin for the CreateOrderModal wiring (the component is too heavy to mount for this): the picker tap and a
 * shared-code scan start a NEW line on the default selling unit; a box-only/unit-only scan and every other add path do not.
 * The behaviour itself is pinned in OrderLineUnitPicker.test.tsx and useScanCodeHandler.test.tsx.
 */
const src = readFileSync(join(__dirname, "CreateOrderModal.tsx"), "utf8");

describe("CreateOrderModal default selling unit wiring (#2784)", () => {
  it("the picker tap opts in", () => {
    expect(src).toMatch(
      /addPicked = \(product: any\) => \{[\s\S]*?addLineItem\(product, undefined, \{ startOnDefaultUnit: true \}\);/,
    );
  });

  it("the scan handler forwards the shared-code hint and the row passes the line's flag to the picker", () => {
    expect(src).toMatch(/addLineItem: \(product, level, opts\) => \{/);
    expect(src).toMatch(/addLineItem\(product, level, opts\)/);
    expect(src).toMatch(/startOnDefaultUnit=\{li\.startOnDefaultUnit\}/);
  });

  it("only those two paths set it: the line field is written in addLineItem's newLine from `opts` alone", () => {
    expect(src.match(/startOnDefaultUnit: opts\?\.startOnDefaultUnit/g)).toHaveLength(1);
    expect(src.match(/startOnDefaultUnit: true/g)).toHaveLength(1);
  });

  it("Opus #2865 B1: setLineUnit CONSUMES the flag, so a remount after any unit choice (even the pack) cannot re-apply the default", () => {
    // setLineUnit is the shared writer now (lib/default-unit-line.ts applyUnitToLines): that one function consumes the flag.
    const fn = src.slice(src.indexOf("const setLineUnit"), src.indexOf("const setDiscountedPrice"));
    expect(fn).toMatch(/applyUnitToLines\(prev, tempId, option, refresh,/);
    const lib = readFileSync(
      join(__dirname, "..", "..", "..", "..", "lib", "default-unit-line.ts"),
      "utf8",
    );
    expect(lib).toMatch(/startOnDefaultUnit: false/);
  });

  it("SA-626c: submit resolves every pending line first, blocks when the ladder is unavailable, and submits the resolved lines", () => {
    const submit = src.slice(
      src.indexOf("const submitOrder = ("),
      src.indexOf("const doSubmitOrder = ("),
    );
    expect(submit).toMatch(/lineItems\.some\(isPendingDefaultUnit\)/);
    expect(submit).toMatch(/resolveDefaultUnits\(lineItems\)/);
    expect(submit).toMatch(/blocked\.length/);
    expect(submit).toMatch(/doSubmitOrder\(data, options, lines\)/);
    // a double click while the units load is ignored, and edits made while it waited are kept (merge, not overwrite)
    expect(submit).toMatch(/resolvingRef\.current/);
    expect(submit).toMatch(/mergeResolvedLines\(cur, lineItems, lines, folds\)/);
    const doSubmit = src.slice(
      src.indexOf("const doSubmitOrder = ("),
      src.indexOf("createOrder.mutate("),
    );
    expect(doSubmit).not.toMatch(/lineItems/);
    // N9: the units read is staff-only
    expect(src).toMatch(
      /useDefaultUnitResolver\(\s*lineItems,\s*setLineItems,\s*tierForProduct,\s*isStaffRole\(authUser\?\.role\),?\s*\)/,
    );
  });

  it("Opus #2865 r2: every qty / price handler CONSUMES the flag (qty is total pieces on a boxed line, so the picker cannot guard on it)", () => {
    const slice = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b));
    // #2865 case c: the six qty handlers are one-liners over the pure editors in lib/line-qty-edit.ts, which
    // CONSUME the flag on a settled line and REFUSE a pending one (the same array comes back).
    const editLib = readFileSync(
      join(__dirname, "..", "..", "..", "..", "lib", "line-qty-edit.ts"),
      "utf8",
    );
    for (const [name, call] of [
      ["const setQty", "setQtyOnLines"],
      ["const updateQty", "stepQtyOnLines"],
      ["const setBoxes", "setBoxesOnLines"],
      ["const setPieces", "setPiecesOnLines"],
      ["const setUnitQty", "setUnitQtyOnLines"],
      ["const setSellBy", "setSellByOnLines"],
    ] as const) {
      const handler = src.slice(src.indexOf(name), src.indexOf(name) + 200);
      expect({ name, delegates: handler.includes(`${call}(prev, tempId`) }).toEqual({
        name,
        delegates: true,
      });
    }
    expect(editLib.match(/startOnDefaultUnit: false/g)?.length).toBeGreaterThanOrEqual(6);
    expect(editLib).toMatch(/refusesLineEdit\(target, intent\)\) return lines/);
    for (const [name, next] of [
      ["const stepLineUnit", "const addLineItem"],
      ["const merge = (li: LineItem)", "// Built once, outside the updater"],
      ["const setDiscountedPrice", "const setOverrideReason"],
    ] as const) {
      // a merge keeps the flag ONLY for a default-start add to a still-pending line (SA-626d), and then ONLY counts a tap (SA-632 M2: no box increment)
      const rule = name.startsWith("const merge")
        ? /keepsDefaultStart\(li, opts\?\.startOnDefaultUnit\)\s*\?\s*\{ \.\.\.li, pendingTaps: pendingCount\(li\) \+ 1 \}[\s\S]*startOnDefaultUnit: false/
        : /startOnDefaultUnit: false/;
      expect({ name, consumed: rule.test(slice(name, next)) }).toEqual({
        name,
        consumed: true,
      });
    }
  });

  it("SA-632 H1/H2: setDiscountedPrice refuses a pending line, addLineItem asks the shared scan rule", () => {
    const price = src.slice(
      src.indexOf("const setDiscountedPrice"),
      src.indexOf("const setOverrideReason"),
    );
    expect(price).toMatch(/refusesLineEdit\(li, "price"\)/);
    expect(src).toMatch(/pendingScanDecision\(/);
    expect(src).toMatch(/UNITS_LOADING_SCAN_MESSAGE/);
  });
});
