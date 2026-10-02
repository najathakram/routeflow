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

  it("SA-632 refusal, per handler: every qty-changing handler goes through editItemLine (the shared refusal) and setLinePrice refuses the price", () => {
    const src = screen();
    for (const head of [
      "const removeOne = ",
      "const setBoxes = ",
      "const setPieces = ",
      "const setUnits = ",
      "const setQty = ",
    ]) {
      expect({ head, guarded: /editItemLine\(/.test(body(src, head)) }).toEqual({
        head,
        guarded: true,
      });
    }
    expect(body(src, "const setSellBy = ")).toMatch(/refusesLineEdit\(m\[id\], "unit"\)/);
    expect(body(src, "const setLinePrice = ")).toMatch(/refusesLineEdit\(prev, "price"\)/); // H1
  });

  it("H2/M3 + F3: addOne is the pure applyAddToItems (decided on the ref, re-applied on the latest lines) and returns false on a refusal", () => {
    const add = body(screen(), "const addOne = ", 3500);
    expect(add).toMatch(
      /const input = \{ id, level, dflt, viaRow, code, role: userRole, upb, prefill \};/,
    );
    expect(add).toMatch(
      /if \(applyAddToItems\(itemsRef\.current, input\) === itemsRef\.current\) return false;/,
    );
    expect(add).toMatch(/setItems\(\(m\) => applyAddToItems\(m, input\)\)/);
    expect(screen()).toMatch(/add: \(id: string\) => addOne\(id, undefined, "BOX", true, true\)/); // M3: the row "+"
    expect(body(screen(), "const finishAccept: ", 1500)).toMatch(/opts\?\.code\)/); // F3: the creating code travels
  });

  it("H2/F4: a refused scan returns refusedScanOutcome(scanOpen) BEFORE bumpScanned: not counted, not 'Added', one message", () => {
    const fin = body(screen(), "const finishAccept: ", 1500);
    const refusal = fin.indexOf("refusedScanOutcome(scanOpen)");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(fin.indexOf("bumpScanned(product.id)"));
    expect(fin).toMatch(/if \(!addOne\(/);
    expect(screen()).not.toMatch(/showToast\(UNITS_LOADING_SCAN_MESSAGE\)/); // the toast lives in the adapter, once
  });

  it("case d (SA-632): Confirm is disabled + busy only while a line is LOADING; a failed line's press is the retry and STOPS", () => {
    const src = screen();
    expect(src).toMatch(/anyLineLoading\(items, unitStatusFor\)/);
    expect(src).toMatch(/disabled=\{!canSave \|\| anyUnitLoading\}/);
    expect(src).toMatch(
      /accessibilityState=\{\{ disabled: !canSave \|\| anyUnitLoading, busy: anyUnitLoading \}\}/,
    );
    const i = src.indexOf("await settleBeforeConfirm(items, resolveDefaultUnits)");
    expect(i).toBeGreaterThan(0);
    const after = src.slice(i, i + 900);
    expect(after).toMatch(/settled\.kind === "blocked"[\s\S]*showToast\(UNITS_BLOCKED_MESSAGE\)/);
    expect(after).toMatch(/settled\.kind === "stop"\) return endSubmit\(\)/);
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
});
