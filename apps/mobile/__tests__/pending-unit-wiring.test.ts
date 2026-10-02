import { readFileSync } from "fs";
import { join } from "path";
import { isUnitPending } from "@routeflow/pricing";
import { isPendingDefaultUnit } from "../lib/default-unit-line";

/**
 * #2865 (SA-632) wiring pins for the OLD native screen (hybrid ruling: logic refusals + Confirm state only, no new
 * lock UI or notice). The behaviour itself is pinned at the shared-rule level in pending-unit-lock.test.ts; these pins
 * only prove the screen CALLS the shared rules.
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const screen = () => read("components/NewOrderScreen.tsx");
const body = (src: string, head: string, len = 1800) => {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(0);
  const next = src.indexOf("\n  const ", at + head.length);
  return src.slice(at, next > 0 ? Math.min(next, at + len) : at + len);
};

describe("pending-unit wiring (mobile, old native screen)", () => {
  it("M5: no new lock UI or notice on the old native screen", () => {
    for (const f of [
      "components/QtyStepper.tsx",
      "components/CartStepperRow.tsx",
      "components/ProductRow.tsx",
      "components/BoxedQtyBand.tsx",
      "components/CartRow.tsx",
      "components/new-order/CartModal.tsx",
      "components/NewOrderScreen.tsx",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/PendingUnitNotice|pendingUnitFor|pendingUnit=|\blocked=\{/);
    }
  });

  it("SA-632 refusal, per handler: every qty-changing handler refuses a PENDING line IN THE LOGIC through the shared rule", () => {
    const src = screen();
    for (const head of [
      "const removeOne = ",
      "const setBoxes = ",
      "const setPieces = ",
      "const setUnits = ",
      "const setSellBy = ",
      "const setQty = ",
      "const setLinePrice = ",
    ]) {
      expect({ head, guarded: /refusesLineEdit\(/.test(body(src, head)) }).toEqual({
        head,
        guarded: true,
      });
    }
    expect(body(src, "const setLinePrice = ")).toMatch(/refusesLineEdit\(prev, "price"\)/); // H1
  });

  it("H2/M3: addOne refuses through the shared rules (row '+' via the row, a different-level scan via the scan rule) and returns whether it added", () => {
    const add = body(screen(), "const addOne = ", 3500);
    expect(add).toMatch(
      /viaRow\s*\?\s*refusesLineEdit\(cur, "increment"\)\s*:\s*scanDecisionFor\(cur, scanMapsToDefault\(cur, dflt, code\)\) === "refuse"/,
    );
    expect(add).toMatch(/if \(refuses\(itemsRef\.current\[id\]\)\) return false;/);
    expect(add).toMatch(/pendingTaps: pendingTapCount\(m\[id\]!, upb\) \+ 1/); // M2: a tap only counts
    expect(screen()).toMatch(/add: \(id: string\) => addOne\(id, undefined, "BOX", true, true\)/); // M3: the row "+"
  });

  it("H2: a refused scan is NOT counted or toasted 'Added': finishAccept returns before bumpScanned", () => {
    const fin = body(screen(), "const finishAccept: ", 1500);
    const refusal = fin.indexOf("UNITS_LOADING_SCAN_MESSAGE");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(fin.indexOf("bumpScanned(product.id)"));
    expect(fin).toMatch(/if \(!addOne\(/);
  });

  it("case d (SA-632): Confirm is disabled + busy only while a line is LOADING; a failed line's press is the retry and STOPS", () => {
    const src = screen();
    expect(src).toMatch(/unitStatusFor\(id, l\) === "loading"/);
    expect(src).toMatch(/disabled=\{!canSave \|\| anyUnitLoading\}/);
    expect(src).toMatch(
      /accessibilityState=\{\{ disabled: !canSave \|\| anyUnitLoading, busy: anyUnitLoading \}\}/,
    );
    // the press that resolved a pending line returns before submitting (the user presses Confirm again)
    const i = src.indexOf("await resolveDefaultUnits(items)");
    expect(i).toBeGreaterThan(0);
    const after = src.slice(i, i + 1400);
    expect(after.indexOf("if (blocked.length)")).toBeGreaterThan(0);
    expect(after).toMatch(
      /Object\.values\(items\)\.some\(isPendingDefaultUnit\)\) return endSubmit\(\)/,
    );
  });

  it("web and mobile share ONE predicate (the mobile wrapper calls isUnitPending)", () => {
    expect(read("lib/default-unit-line.ts")).toMatch(/isUnitPending\(/);
    const line = { qty: 3, startOnDefaultUnit: 3 };
    expect(isPendingDefaultUnit(line)).toBe(isUnitPending({ startOnDefaultUnit: 3, qty: 3 }));
    expect(isPendingDefaultUnit({ ...line, qty: 4 })).toBe(
      isUnitPending({ startOnDefaultUnit: 3, qty: 4 }),
    );
  });

  it("M4: the pure rules live in @routeflow/pricing; the mobile adapter imports them instead of redefining", () => {
    const lib = read("lib/default-unit-line.ts");
    for (const name of [
      "pendingResolvePlan",
      "mayMergeResolved",
      "pendingScanDecision",
      "refreshUnitsAnswerShared",
    ]) {
      expect(lib).toMatch(new RegExp(name));
    }
    expect(read("hooks/useDefaultUnitResolver.ts")).toMatch(/pendingStatus\(/);
  });

  it("N1: the resolver effect is keyed on each pending line's TAP COUNT (pendingResolveKey), not a quantity", () => {
    const hook = read("hooks/useDefaultUnitResolver.ts");
    expect(hook).toMatch(/pendingResolveKey\(/);
    expect(hook).toMatch(/count: l\.pendingTaps \?\? l\.qty/);
    expect(hook).not.toMatch(/\$\{id\}:\$\{l\.qty\}/);
  });

  it("F3: addOne records the creating scan's code and counts a repeat of it as a tap (the sheet's manual entry uses the SAME rule as the search box)", () => {
    const add = body(screen(), "const addOne = ", 3500);
    expect(add).toMatch(/code\?: string/);
    expect(add).toMatch(/isPendingTap\(m\[id\], dflt, code, userRole\)/);
    expect(add).toMatch(/line\.pendingCode = code/);
    expect(body(screen(), "const finishAccept: ", 1500)).toMatch(/opts\?\.code\)/);
  });

  it("F4: a refused scan raises EXACTLY ONE toast (no second error pill beside it)", () => {
    const src = screen();
    expect(src.match(/showToast\(UNITS_LOADING_SCAN_MESSAGE\)/g)?.length).toBe(1);
    const fin = body(src, "const finishAccept: ", 1500);
    const refusal = fin.slice(fin.indexOf("if (!addOne("), fin.indexOf("bumpScanned(product.id)"));
    expect(refusal).toMatch(/return undefined;/);
    // with the sheet open the message is the sheet's own pill (the app toast sits under its Modal); never both layers
    expect(refusal).toMatch(
      /if \(scanOpen\) return \{ feedback: \{ kind: "error", text: UNITS_LOADING_SCAN_MESSAGE \} \};/,
    );
    expect(refusal.indexOf("if (scanOpen)")).toBeLessThan(refusal.indexOf("showToast("));
  });
});
