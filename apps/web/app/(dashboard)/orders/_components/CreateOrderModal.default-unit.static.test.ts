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
    expect(submit).toMatch(/mergeResolvedLines\(cur, lineItems, lines\)/);
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

  it("SA-626h: qty handlers (stepper, typed qty, boxes) do NOT shape a line; only a loose-pieces / sell-by choice or a typed price consumes the flag", () => {
    const slice = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b));
    for (const [name, next] of [
      ["const setQty", "const updateQty"],
      ["const updateQty", "const setBoxes"],
      ["const setBoxes", "const setPieces"],
      ["const stepLineUnit", "const addLineItem"],
    ] as const) {
      expect({ name, consumed: /startOnDefaultUnit: false/.test(slice(name, next)) }).toEqual({
        name,
        consumed: false,
      });
    }
    for (const [name, next] of [
      ["const setPieces", "const setUnitQty"],
      ["const setUnitQty", "const setSellBy"],
      ["const setSellBy", "/** The effective price tier"],
      ["const setDiscountedPrice", "const setOverrideReason"],
    ] as const) {
      expect({ name, consumed: /startOnDefaultUnit: false/.test(slice(name, next)) }).toEqual({
        name,
        consumed: true,
      });
    }
    // a merge keeps the flag ONLY for a default-start add to a still-pending line (SA-626d), via keepsDefaultStart
    expect(slice("const merge = (li: LineItem)", "// Built once, outside the updater")).toMatch(
      /startOnDefaultUnit: keepsDefaultStart\(li, opts\?\.startOnDefaultUnit\)/,
    );
  });
});
