import type { ProductUnitLevel } from "@routeflow/types";
import type { LineState } from "../lib/cart-line-state";
import {
  applyUnitOption,
  isPendingDefaultUnit,
  mergeResolvedDefaults,
  resolvePendingDefaultUnits,
  startLineOnDefault,
} from "../lib/default-unit-line";
import { buildUnitOptions, unitPriceBase } from "../lib/unit-options";

/**
 * SA-626c (tier 1 money): the default unit belongs to the LINE, not to a mounted sheet. A line that is flagged
 * `startOnDefaultUnit` (a shared-code scan, a picker "+", the "Which one?" sheet) must hold the default unit
 * (Bottle $2.00) BEFORE the tray's Confirm can submit it, even if the cart sheet (UnitPickerRow) never opened.
 */
const product = { unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" };
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
const CASE_ONLY = [lvl({ label: "Case", factorToBase: 12, price: "24.00" })];

const flagged = (over: Partial<LineState> = {}): LineState => ({
  qty: 1,
  startOnDefaultUnit: 1,
  ...over,
});
const deps = (units: ProductUnitLevel[] | Error, over = {}) => ({
  unitsEnabled: true,
  getUnits: jest.fn(async () => {
    if (units instanceof Error) throw units;
    return units;
  }),
  productFor: () => product,
  tierFor: () => 1,
  ...over,
});

describe("isPendingDefaultUnit", () => {
  it("is true only while the flag still matches the untouched qty and no operator price exists", () => {
    expect(isPendingDefaultUnit(flagged())).toBe(true);
    expect(isPendingDefaultUnit({ qty: 2, startOnDefaultUnit: 1 })).toBe(false);
    expect(isPendingDefaultUnit(flagged({ unitPrice: 5 }))).toBe(false);
    expect(isPendingDefaultUnit(flagged({ priceSource: "operator" }))).toBe(false);
    expect(isPendingDefaultUnit({ qty: 1 })).toBe(false);
  });
});

describe("startLineOnDefault / resolvePendingDefaultUnits (tray Confirm with the sheet never opened)", () => {
  it("(1) a shared scan: the flagged line resolves to the default unit at $2.00", async () => {
    const { items, blocked } = await resolvePendingDefaultUnits(
      { p1: flagged() },
      deps([BOTTLE, ...CASE_ONLY]),
    );
    expect(blocked).toEqual([]);
    expect(items.p1).toMatchObject({
      unitLabel: "Bottle",
      unitBasePrice: 2,
      unitFactor: 1,
      qty: 1,
    });
    expect(items.p1!.startOnDefaultUnit).toBeUndefined();
    expect(unitPriceBase(items.p1!, 24)).toBe(2);
  });

  it("(2) a BOX-only code is never flagged, so the line stays on the case at $24", async () => {
    const line: LineState = { qty: 1 };
    const { items } = await resolvePendingDefaultUnits({ p1: line }, deps([BOTTLE, ...CASE_ONLY]));
    expect(items.p1).toBe(line);
    expect(unitPriceBase(items.p1!, 24)).toBe(24);
  });

  it("(3) a picker '+' (flag set on add) resolves to the default unit too", async () => {
    const { items } = await resolvePendingDefaultUnits(
      { a: flagged(), b: flagged() },
      deps([BOTTLE, ...CASE_ONLY]),
    );
    expect(items.a!.unitLabel).toBe("Bottle");
    expect(items.b!.unitLabel).toBe("Bottle");
  });

  it("(4) opening the sheet afterwards does not change an already-resolved unit", async () => {
    const { items } = await resolvePendingDefaultUnits(
      { p1: flagged() },
      deps([BOTTLE, ...CASE_ONLY]),
    );
    const resolved = items.p1!;
    expect(isPendingDefaultUnit(resolved)).toBe(false);
    const again = startLineOnDefault(resolved, product, [BOTTLE, ...CASE_ONLY], 1);
    expect(again).toBe(resolved);
  });

  it("a product with no flagged default clears the flag and stays on the pack (a legitimate pack start)", async () => {
    const { items, blocked } = await resolvePendingDefaultUnits({ p1: flagged() }, deps(CASE_ONLY));
    expect(blocked).toEqual([]);
    expect(items.p1!.unitLabel).toBeUndefined();
    expect(items.p1!.startOnDefaultUnit).toBeUndefined();
  });

  it("units cannot be loaded: the line is BLOCKED and left untouched, never silently sent as the case", async () => {
    const line = flagged();
    const { items, blocked } = await resolvePendingDefaultUnits(
      { p1: line },
      deps(new Error("offline")),
    );
    expect(blocked).toEqual(["p1"]);
    expect(items.p1).toBe(line);
  });

  it("the units feature off: there is no ladder, the pack is the only unit", async () => {
    const d = deps([BOTTLE], { unitsEnabled: false });
    const { items, blocked } = await resolvePendingDefaultUnits({ p1: flagged() }, d);
    expect(blocked).toEqual([]);
    expect(items.p1!.startOnDefaultUnit).toBeUndefined();
    expect(d.getUnits).not.toHaveBeenCalled();
  });

  it("a flagged line whose product record is missing is blocked, not guessed", async () => {
    const { blocked } = await resolvePendingDefaultUnits(
      { p1: flagged() },
      deps([BOTTLE], { productFor: () => undefined }),
    );
    expect(blocked).toEqual(["p1"]);
  });
});

describe("applyUnitOption is the ONE writer of a chosen unit (the sheet's onChange and the add-time default)", () => {
  it("a unit option sets label/base price/factor, resets qty to 1 and consumes the flag; the pack clears them", () => {
    const [pack, bottle] = buildUnitOptions(product, [BOTTLE], 1);
    const onBottle = applyUnitOption(flagged({ boxes: 1, pieces: 2, unitPrice: 9 }), bottle!);
    expect(onBottle).toMatchObject({
      unitLabel: "Bottle",
      unitBasePrice: 2,
      unitFactor: 1,
      qty: 1,
    });
    expect(onBottle.boxes).toBeUndefined();
    expect(onBottle.pieces).toBeUndefined();
    expect(onBottle.unitPrice).toBeUndefined();
    expect(onBottle.startOnDefaultUnit).toBeUndefined();
    const back = applyUnitOption(onBottle, pack!);
    expect(back.unitLabel).toBeUndefined();
    expect(back.unitBasePrice).toBeUndefined();
  });
});

describe("mergeResolvedDefaults: an async resolve never overwrites what the buyer did meanwhile", () => {
  it("applies the resolved line only to a line that is still pending at the same qty", () => {
    const before = { a: flagged(), b: flagged() };
    const done = {
      a: { ...flagged(), unitLabel: "Bottle", startOnDefaultUnit: undefined } as LineState,
      b: { ...flagged(), unitLabel: "Bottle", startOnDefaultUnit: undefined } as LineState,
    };
    const cur = { a: flagged(), b: { qty: 3 } as LineState }; // b was edited while resolving
    const merged = mergeResolvedDefaults(cur, before, done);
    expect(merged.a!.unitLabel).toBe("Bottle");
    expect(merged.b).toBe(cur.b);
  });
});
