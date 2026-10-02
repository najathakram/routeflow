import { readFileSync } from "fs";
import { join } from "path";
import { isUnitPending } from "@routeflow/pricing";
import { isPendingDefaultUnit } from "../lib/default-unit-line";

/**
 * #2865 case c (SA-632) wiring pins: every mobile qty surface locks while a line is pending (disabled + busy +
 * labelled), the notice has a real Retry button, and the submit gate refuses a pending line whose ladder failed (case d).
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("pending-unit lock wiring", () => {
  it("QtyStepper / CartStepperRow disable +/- and the input while locked, with busy state", () => {
    for (const f of ["components/QtyStepper.tsx", "components/CartStepperRow.tsx"]) {
      const src = read(f);
      expect(src).toMatch(/disabled=\{locked\}/);
      expect(src).toMatch(/editable=\{!locked\}/);
      expect(src).toMatch(/busy: locked/);
    }
  });

  it("every row that renders a qty control threads the pending state", () => {
    expect(read("components/ProductRow.tsx")).toMatch(/locked=\{!!pendingUnit\}/);
    expect(read("components/BoxedQtyBand.tsx")).toMatch(/locked=\{!!pendingUnit\}/);
    const cart = read("components/CartRow.tsx");
    expect(cart.match(/locked=\{!!pendingUnit\}/g)?.length).toBeGreaterThanOrEqual(4);
    expect(read("components/new-order/CartModal.tsx")).toMatch(/pendingUnit=\{pendingUnitFor\?\./);
    const screen = read("components/NewOrderScreen.tsx");
    expect(screen.match(/pendingUnit=\{pendingUnitFor\(p\.id, line\)\}/g)?.length).toBe(2);
    expect(screen).toMatch(/pendingUnitFor=\{pendingUnitFor\}/);
  });

  it("the failure copy is a readable error plus a real Retry button", () => {
    const src = read("components/PendingUnitNotice.tsx");
    expect(src).toMatch(/Couldn't load the selling units\./);
    expect(src).toMatch(/accessibilityRole="button"/);
    expect(src).toMatch(/loading units/);
  });

  it("case d: submit is blocked while a line is PENDING with its ladder unresolved", () => {
    const src = read("components/NewOrderScreen.tsx");
    const i = src.indexOf("await resolveDefaultUnits(items)");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 200)).toMatch(/if \(blocked\.length\)/);
  });

  it("web and mobile share ONE predicate (the mobile wrapper calls isUnitPending)", () => {
    expect(read("lib/default-unit-line.ts")).toMatch(/isUnitPending\(/);
    const line = { qty: 3, startOnDefaultUnit: 3 };
    expect(isPendingDefaultUnit(line)).toBe(isUnitPending({ startOnDefaultUnit: 3, qty: 3 }));
    expect(isPendingDefaultUnit({ ...line, qty: 4 })).toBe(
      isUnitPending({ startOnDefaultUnit: 3, qty: 4 }),
    );
  });

  it("SA-632 refusal, per handler: every qty-changing handler on the screen refuses a PENDING line IN THE LOGIC", () => {
    const src = read("components/NewOrderScreen.tsx");
    const starts = [
      "const addOne = ",
      "const removeOne = ",
      "const setBoxes = ",
      "const setPieces = ",
      "const setUnits = ",
      "const setSellBy = ",
      "const setQty = ",
    ];
    for (const head of starts) {
      const at = src.indexOf(head);
      expect(at).toBeGreaterThan(0);
      // the handler's own body: up to the next top-level handler declaration
      const next = src.indexOf("\n  const ", at + head.length);
      const body = src.slice(at, next > 0 ? next : at + 1500);
      expect({ handler: head, guarded: /refusesPendingEdit\(/.test(body) }).toEqual({
        handler: head,
        guarded: true,
      });
    }
    // only the default-start pick may add to a pending line (as a tap); the stepper "+" is refused
    expect(src).toMatch(/refusesPendingEdit\(m\[id\], dflt, userRole\)/);
  });

  it("case d on mobile (SA-632): Confirm is disabled + busy while ANY line is pending (the shared predicate)", () => {
    const src = read("components/NewOrderScreen.tsx");
    expect(src).toMatch(
      /const anyUnitPending = Object\.values\(items\)\.some\(isPendingDefaultUnit\)/,
    );
    expect(src).toMatch(/disabled=\{!canSave \|\| anyUnitPending\}/);
    expect(src).toMatch(
      /accessibilityState=\{\{ disabled: !canSave \|\| anyUnitPending, busy: anyUnitPending \}\}/,
    );
  });
});
