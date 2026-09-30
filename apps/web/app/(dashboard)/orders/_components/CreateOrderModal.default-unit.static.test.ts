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
    const fn = src.slice(src.indexOf("const setLineUnit"), src.indexOf("const setDiscountedPrice"));
    expect(fn).toMatch(/startOnDefaultUnit: false/);
  });
});
