import type { ProductUnitLevel } from "@routeflow/types";
import {
  applyUnitToLines,
  type DefaultUnitLine,
  isPendingDefaultUnit,
  keepsDefaultStart,
  mergeResolvedLines,
  resolvePendingDefaultUnits,
  startLineOnDefault,
} from "./default-unit-line";
import { buildUnitOptions } from "./unit-options";

/**
 * SA-626c (tier 1 money), web: the default unit belongs to the LINE. A line flagged `startOnDefaultUnit` (picker tap,
 * shared-code scan, multi-match pick) must hold the default unit (Bottle $2.00) BEFORE the order is submitted, even if
 * the row's unit picker never mounted or the ladder had not loaded when the line was added. NEVER the case by default.
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
type TestLine = DefaultUnitLine & { productName: string };
const BOTTLE = lvl({ label: "Bottle", factorToBase: 1, price: "2.00", isDefaultSelling: true });
const CASE_LEVEL = lvl({ label: "Case", factorToBase: 12, price: "24.00" });

const line = (over: Record<string, unknown> = {}): TestLine => ({
  tempId: "t1",
  productId: "p1",
  productName: "Soda",
  unit: "Case",
  unitsPerBox: 12,
  qty: 12,
  boxes: 1,
  pieces: 0,
  listPrice: 24,
  unitPrice: 24,
  priceType: "STANDARD" as const,
  startOnDefaultUnit: true,
  tierPrices: { pricePerUnit: "24.00" } as never,
  ...over,
});
const deps = (units: ProductUnitLevel[] | Error, over = {}) => ({
  unitsEnabled: true,
  unitsKnown: true,
  getUnits: jest.fn(async () => {
    if (units instanceof Error) throw units;
    return units;
  }),
  tierFor: () => 1,
  ...over,
});

describe("isPendingDefaultUnit", () => {
  it("is true only for a flagged line the operator has not shaped", () => {
    expect(isPendingDefaultUnit(line())).toBe(true);
    expect(isPendingDefaultUnit(line({ startOnDefaultUnit: false }))).toBe(false);
    expect(isPendingDefaultUnit(line({ unitLabel: "Case" }))).toBe(false);
    expect(isPendingDefaultUnit(line({ priceEdited: true }))).toBe(false);
    expect(isPendingDefaultUnit(line({ discountedPrice: 20, priceType: "DISCOUNTED" }))).toBe(
      false,
    );
  });
});

describe("resolvePendingDefaultUnits: submit before the row's units loaded", () => {
  it("(1) a shared scan / picker tap: the flagged line resolves to Bottle at $2.00, flag consumed", async () => {
    const { lines, blocked } = await resolvePendingDefaultUnits(
      [line()],
      deps([BOTTLE, CASE_LEVEL]),
    );
    expect(blocked).toEqual([]);
    expect(lines[0]).toMatchObject({
      unitLabel: "Bottle",
      unitPrice: 2,
      qty: 1,
      startOnDefaultUnit: false,
    });
  });

  it("(2) a BOX-only code is never flagged: the line stays on the case at $24", async () => {
    const l = line({ startOnDefaultUnit: false });
    const { lines } = await resolvePendingDefaultUnits([l], deps([BOTTLE, CASE_LEVEL]));
    expect(lines[0]).toBe(l);
    expect(lines[0]!.unitPrice).toBe(24);
  });

  it("(3) two flagged lines both resolve", async () => {
    const { lines } = await resolvePendingDefaultUnits(
      [line(), line({ tempId: "t2", productId: "p2" })],
      deps([BOTTLE, CASE_LEVEL]),
    );
    expect(lines.map((l) => l.unitLabel)).toEqual(["Bottle", "Bottle"]);
  });

  it("(4) resolving twice (or the picker mounting afterwards) never changes an already-resolved unit", async () => {
    const first = (await resolvePendingDefaultUnits([line()], deps([BOTTLE, CASE_LEVEL]))).lines;
    const second = (await resolvePendingDefaultUnits(first, deps([BOTTLE, CASE_LEVEL]))).lines;
    expect(second[0]).toBe(first[0]);
    expect(startLineOnDefault(first[0]!, [BOTTLE, CASE_LEVEL], 1)).toBe(first[0]);
  });

  it("nothing flagged as the default: the flag clears and the line stays on the pack (a legitimate pack start)", async () => {
    const { lines, blocked } = await resolvePendingDefaultUnits([line()], deps([CASE_LEVEL]));
    expect(blocked).toEqual([]);
    expect(lines[0]).toMatchObject({ startOnDefaultUnit: false, unitPrice: 24 });
    expect(lines[0]!.unitLabel).toBeUndefined();
  });

  it("units cannot be loaded: BLOCKED and untouched, never silently sent as the case", async () => {
    const l = line();
    const { lines, blocked } = await resolvePendingDefaultUnits([l], deps(new Error("offline")));
    expect(blocked).toEqual(["t1"]);
    expect(lines[0]).toBe(l);
  });

  it("the units answer still loading is not 'off': blocked, nothing resolved", async () => {
    const l = line();
    const d = deps([BOTTLE], { unitsEnabled: false, unitsKnown: false });
    const { lines, blocked } = await resolvePendingDefaultUnits([l], d);
    expect(blocked).toEqual(["t1"]);
    expect(lines[0]).toBe(l);
    expect(d.getUnits).not.toHaveBeenCalled();
  });

  it("the units feature off: no ladder, the flag clears and the pack is the only unit", async () => {
    const d = deps([BOTTLE], { unitsEnabled: false });
    const { lines, blocked } = await resolvePendingDefaultUnits([line()], d);
    expect(blocked).toEqual([]);
    expect(lines[0]!.startOnDefaultUnit).toBe(false);
    expect(d.getUnits).not.toHaveBeenCalled();
  });

  it("an unlisted (ad-hoc) line has no ladder: never fetched, flag simply cleared", async () => {
    const d = deps([BOTTLE]);
    const { lines } = await resolvePendingDefaultUnits([line({ isUnlisted: true })], d);
    expect(d.getUnits).not.toHaveBeenCalled();
    expect(lines[0]!.startOnDefaultUnit).toBe(false);
  });
});

describe("applyUnitToLines is the ONE writer of a chosen unit (the picker's onChange and the default start)", () => {
  it("folds into a twin line of the same product+unit", () => {
    const [, bottle] = buildUnitOptions(
      { unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" },
      [BOTTLE],
      1,
    );
    const a = line({ tempId: "a" });
    const twin = line({
      tempId: "b",
      unitLabel: "Bottle",
      unit: "Bottle",
      unitsPerBox: undefined,
      qty: 3,
      startOnDefaultUnit: false,
    });
    const out = applyUnitToLines([a, twin], "a", bottle!, false, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tempId: "b", unitLabel: "Bottle", qty: 4 });
  });
});

describe("mergeResolvedLines: an async resolve never overwrites what the operator did meanwhile", () => {
  it("applies the resolved line only to a line that is still pending", () => {
    const before = [line({ tempId: "a" }), line({ tempId: "b" })];
    const done = [
      { ...before[0]!, unitLabel: "Bottle", startOnDefaultUnit: false },
      { ...before[1]!, unitLabel: "Bottle", startOnDefaultUnit: false },
    ];
    const cur = [line({ tempId: "a" }), line({ tempId: "b", startOnDefaultUnit: false, qty: 24 })];
    const merged = mergeResolvedLines(cur, before, done);
    expect(merged[0]!.unitLabel).toBe("Bottle");
    expect(merged[1]).toBe(cur[1]);
  });
});

describe("SA-626c rulings A + B and SA-626d (owner rulings): a remembered price never decides the unit", () => {
  const PIECE = lvl({ label: "Bottle", factorToBase: 1, price: null, isDefaultSelling: true }); // derives from the pack
  const remembered = (over: Record<string, unknown> = {}): TestLine =>
    line({
      priceType: "DISCOUNTED" as never,
      discountedPrice: 20, // a remembered PACK price below the $24 tier price
      unitPrice: 20,
      ...over,
    });

  it("A: a history-prefilled (DISCOUNTED) line is still pending: the pre-fill is not an operator shape", () => {
    expect(isPendingDefaultUnit(remembered())).toBe(true);
    expect(isPendingDefaultUnit(remembered({ priceEdited: true }))).toBe(false); // a price the operator TYPED shapes it
  });

  it("A + 3: it starts on the default unit at the TIER-derived price ($24 / 12 = $2.00), the remembered $20 dropped", async () => {
    const { lines } = await resolvePendingDefaultUnits([remembered()], deps([PIECE, CASE_LEVEL]));
    expect(lines[0]).toMatchObject({
      unitLabel: "Bottle",
      unitPrice: 2,
      startOnDefaultUnit: false,
    });
    expect(lines[0]!.discountedPrice).toBeUndefined();
  });

  it("4: an explicit pack pick afterwards re-applies the remembered pack price", async () => {
    const { lines } = await resolvePendingDefaultUnits([remembered()], deps([PIECE, CASE_LEVEL]));
    const [pack] = buildUnitOptions(
      { unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" },
      [PIECE],
      1,
    );
    const back = applyUnitToLines(lines, "t1", pack!, false, 1);
    expect(back[0]!.unitLabel).toBeUndefined();
    expect(back[0]).toMatchObject({ unitPrice: 20, discountedPrice: 20, priceType: "DISCOUNTED" });
  });

  it("B (boxed, qty = total pieces): two fast adds = 2 cases = 2 of the default unit", async () => {
    const two = line({ qty: 24, boxes: 2, pieces: 0 });
    const { lines } = await resolvePendingDefaultUnits([two], deps([BOTTLE, CASE_LEVEL]));
    expect(lines[0]).toMatchObject({ unitLabel: "Bottle", qty: 2 });
  });

  it("B (not boxed): three fast adds = 3 of the default unit", async () => {
    const three = line({ unitsPerBox: undefined, boxes: undefined, pieces: undefined, qty: 3 });
    const { lines } = await resolvePendingDefaultUnits([three], deps([BOTTLE, CASE_LEVEL]));
    expect(lines[0]).toMatchObject({ unitLabel: "Bottle", qty: 3 });
  });

  it("B: a second default-start add to a pending line keeps the flag; an edited, un-flagged or box-only add consumes it", () => {
    expect(keepsDefaultStart(line(), true)).toBe(true);
    expect(keepsDefaultStart(line({ priceEdited: true }), true)).toBe(false);
    expect(keepsDefaultStart(line({ startOnDefaultUnit: false }), true)).toBe(false);
    expect(keepsDefaultStart(line(), false)).toBe(false);
  });
});
