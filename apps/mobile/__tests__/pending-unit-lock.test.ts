import type { ProductUnitLevel } from "@routeflow/types";
import type { LadderProduct } from "@routeflow/pricing";
import type { LineState } from "../lib/cart-line-state";
import {
  isPendingDefaultUnit,
  refusesPendingEdit,
  resolvePendingDefaultUnits,
  type DefaultUnitDeps,
} from "../lib/default-unit-line";

/**
 * #2865 case c (SA-632), mobile: a line with no resolved unit is PENDING and its unit is decided ONCE. Every quantity
 * edit (stepper +/-, typed qty, boxes, pieces, units) is REFUSED IN THE LOGIC on a pending line; only a default-start
 * pick (a picker tap / shared scan) adds to it, as a TAP COUNT. N taps = N of the default unit on resolve.
 */
const lvl = (over: Partial<ProductUnitLevel>) =>
  ({
    id: over.label,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
    ...over,
  }) as ProductUnitLevel;
const BOTTLE = lvl({ label: "Bottle", factorToBase: 1, price: "2.00", isDefaultSelling: true });
const CASE = lvl({ label: "Case", factorToBase: 12, price: "24.00" });
const PRODUCT = {
  unit: "Case",
  unitsPerBox: 12,
  pricePerUnit: "24.00",
} as unknown as LadderProduct;

const pending = (over: Partial<LineState> = {}): LineState => ({
  qty: 12,
  boxes: 1,
  pieces: 0,
  startOnDefaultUnit: 12,
  pendingTaps: 1,
  ...over,
});
const deps = (units: ProductUnitLevel[] | Error): DefaultUnitDeps => ({
  isStaff: true,
  unitsEnabled: true,
  unitsKnown: true,
  getUnits: jest.fn(async () => {
    if (units instanceof Error) throw units;
    return units;
  }),
  productFor: () => PRODUCT,
  tierFor: () => 1,
});

describe("isPendingDefaultUnit (the shared predicate)", () => {
  it("a flagged, untouched line is pending; a settled, shaped or operator-priced one is not", () => {
    expect(isPendingDefaultUnit(pending())).toBe(true);
    expect(isPendingDefaultUnit(pending({ startOnDefaultUnit: undefined }))).toBe(false);
    expect(isPendingDefaultUnit(pending({ priceSource: "operator", unitPrice: 20 }))).toBe(false);
    expect(isPendingDefaultUnit(pending({ qty: 24 }))).toBe(false); // flag no longer equals qty
  });
});

describe("refusesPendingEdit", () => {
  it("refuses EVERY edit on a pending line (stepper, typed, boxes, pieces), with no default-start flag", () => {
    expect(refusesPendingEdit(pending(), false, "OPERATOR")).toBe(true);
    expect(refusesPendingEdit(pending(), undefined, "OPERATOR")).toBe(true);
  });

  it("lets a STAFF default-start pick (picker tap / shared scan) add to a pending line", () => {
    expect(refusesPendingEdit(pending(), true, "OPERATOR")).toBe(false);
    expect(refusesPendingEdit(pending(), true, "TENANT_ADMIN")).toBe(false);
  });

  it("a non-staff 'default start' never adds to a pending line either (they never start pending)", () => {
    expect(refusesPendingEdit(pending(), true, "DRIVER")).toBe(true);
  });

  it("never refuses a settled line or a line that does not exist yet", () => {
    expect(refusesPendingEdit(undefined, false, "OPERATOR")).toBe(false);
    expect(refusesPendingEdit(pending({ startOnDefaultUnit: undefined }), false, "OPERATOR")).toBe(
      false,
    );
  });
});

describe("pending tap count (case c)", () => {
  it("3 taps before load -> 3 Bottles after (the COUNT, not 3 cases)", async () => {
    const { items, blocked } = await resolvePendingDefaultUnits(
      { p1: pending({ pendingTaps: 3, qty: 36, boxes: 3, startOnDefaultUnit: 36 }) },
      deps([BOTTLE, CASE]),
    );
    expect(blocked).toEqual([]);
    expect(items.p1).toMatchObject({ unitLabel: "Bottle", qty: 3 });
    expect(items.p1.startOnDefaultUnit).toBeUndefined();
    expect(items.p1.pendingTaps).toBeUndefined();
  });

  it("3 taps + a FAILED load: blocked, the line is untouched and still pending with its count; retry -> 3 Bottles", async () => {
    const line = pending({ pendingTaps: 3, qty: 36, boxes: 3, startOnDefaultUnit: 36 });
    const failed = await resolvePendingDefaultUnits({ p1: line }, deps(new Error("offline")));
    expect(failed.blocked).toEqual(["p1"]);
    expect(failed.items.p1).toBe(line);
    expect(isPendingDefaultUnit(failed.items.p1)).toBe(true);
    const retried = await resolvePendingDefaultUnits(failed.items, deps([BOTTLE, CASE]));
    expect(retried.items.p1).toMatchObject({ unitLabel: "Bottle", qty: 3 });
  });

  it("refusesPendingEdit tracks the line's lifecycle: pending refuses, a FAILED load keeps refusing, a successful retry allows", async () => {
    const line = pending({ pendingTaps: 2, qty: 24, boxes: 2, startOnDefaultUnit: 24 });
    expect(refusesPendingEdit(line, false, "OPERATOR")).toBe(true); // pending
    const failed = await resolvePendingDefaultUnits({ p1: line }, deps(new Error("offline")));
    expect(failed.blocked).toEqual(["p1"]);
    expect(refusesPendingEdit(failed.items.p1, false, "OPERATOR")).toBe(true); // failed: still refuses
    const retried = await resolvePendingDefaultUnits(failed.items, deps([BOTTLE, CASE]));
    expect(retried.blocked).toEqual([]);
    expect(refusesPendingEdit(retried.items.p1, false, "OPERATOR")).toBe(false); // settled: allows
    expect(retried.items.p1).toMatchObject({ unitLabel: "Bottle", qty: 2 });
  });
});
