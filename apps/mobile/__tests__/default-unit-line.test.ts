import type { ProductUnitLevel } from "@routeflow/types";
import type { LineState } from "../lib/cart-line-state";
import {
  applyUnitOption,
  isPendingDefaultUnit,
  isStaffRole,
  refreshUnitsAnswer,
  keepsDefaultStart,
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
  unitsKnown: true,
  isStaff: true,
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

  it("the units feature off (staff): there is no ladder, the pack is the only unit", async () => {
    const d = deps([BOTTLE], { unitsEnabled: false });
    const { items, blocked } = await resolvePendingDefaultUnits({ p1: flagged() }, d);
    expect(blocked).toEqual([]);
    expect(items.p1!.startOnDefaultUnit).toBeUndefined();
    expect(d.getUnits).not.toHaveBeenCalled();
  });

  it("the units answer still loading (staff): nothing is resolved and the line is blocked (loading is not 'off')", async () => {
    const d = deps([BOTTLE], { unitsEnabled: false, unitsKnown: false });
    const { items, blocked } = await resolvePendingDefaultUnits({ p1: flagged() }, d);
    expect(blocked).toEqual(["p1"]);
    expect(items.p1!.startOnDefaultUnit).toBe(1);
  });

  it("(SA-626f) STAFF: a 403 or any error on the units read BLOCKS, never falls back to the pack", async () => {
    for (const e of [
      Object.assign(new Error("forbidden"), { response: { status: 403 } }),
      Object.assign(new Error("boom"), { response: { status: 500 } }),
      new Error("Network Error"),
    ]) {
      const { items, blocked } = await resolvePendingDefaultUnits({ p1: flagged() }, deps(e));
      expect(blocked).toEqual(["p1"]);
      expect(items.p1!.unitLabel).toBeUndefined();
    }
  });

  it("(SA-626f) DRIVER / non-staff: never starts on a default unit and makes NO read (the pack is the only legal driver line)", async () => {
    const d = deps([BOTTLE, ...CASE_ONLY], { isStaff: false });
    const { items, blocked } = await resolvePendingDefaultUnits({ p1: flagged() }, d);
    expect(blocked).toEqual([]);
    expect(items.p1!.unitLabel).toBeUndefined();
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

describe("SA-626c rulings A + B (owner ruling): a remembered price never decides the unit; fast adds keep their count", () => {
  const history = (over: Partial<LineState> = {}): LineState => ({
    qty: 1,
    startOnDefaultUnit: 1,
    unitPrice: 20, // a remembered PACK price (history is keyed by product only, it carries no unit)
    priceSource: "history",
    ...over,
  });

  it("A: a remembered pack price does not hold the line on the pack: it starts on the default unit at that unit's normal price", async () => {
    expect(isPendingDefaultUnit(history())).toBe(true);
    const { items } = await resolvePendingDefaultUnits(
      { p1: history() },
      deps([BOTTLE, ...CASE_ONLY]),
    );
    expect(items.p1).toMatchObject({ unitLabel: "Bottle", unitBasePrice: 2 });
    expect(items.p1!.unitPrice).toBeUndefined();
    expect(items.p1!.priceSource).toBeUndefined();
  });

  it("A: a price the operator TYPED still shapes the line (stays as-is, not pending)", () => {
    expect(isPendingDefaultUnit(history({ priceSource: "operator" }))).toBe(false);
  });

  it("A: a buyer who actively picks the pack keeps the pack (the choice consumes the flag)", async () => {
    const [pack] = buildUnitOptions(product, [BOTTLE], 1);
    const chosen = applyUnitOption(flagged(), pack!);
    const { items } = await resolvePendingDefaultUnits(
      { p1: chosen },
      deps([BOTTLE, ...CASE_ONLY]),
    );
    expect(items.p1).toBe(chosen);
    expect(items.p1!.unitLabel).toBeUndefined();
  });

  it("B (boxed, qty = total pieces): two fast adds = 2 cases = 2 of the default unit, never a pack", async () => {
    const twoCases = flagged({ qty: 24, boxes: 2, pieces: 0, startOnDefaultUnit: 24 });
    const { items } = await resolvePendingDefaultUnits(
      { p1: twoCases },
      deps([BOTTLE, ...CASE_ONLY]),
    );
    expect(items.p1).toMatchObject({ unitLabel: "Bottle", qty: 2 });
  });

  it("B (not boxed, qty = count): three fast adds = 3 of the default unit", async () => {
    const d = deps([BOTTLE, ...CASE_ONLY], { productFor: () => ({ ...product, unitsPerBox: 1 }) });
    const { items } = await resolvePendingDefaultUnits(
      { p1: flagged({ qty: 3, startOnDefaultUnit: 3 }) },
      d,
    );
    expect(items.p1).toMatchObject({ unitLabel: "Bottle", qty: 3 });
  });

  it("B: the flag FOLLOWS a pending line on a default-start add, and is consumed by anything else", () => {
    expect(keepsDefaultStart(undefined, true, "OPERATOR")).toBe(true); // a new line
    // (SA-626f) only STAFF lines are ever flagged: a DRIVER / customer / unknown role never starts on a default unit
    expect(keepsDefaultStart(undefined, true, "OPERATOR")).toBe(true);
    expect(keepsDefaultStart(undefined, true, "TENANT_ADMIN")).toBe(true);
    expect(keepsDefaultStart(undefined, true, "DRIVER")).toBe(false);
    expect(keepsDefaultStart(undefined, true, "CUSTOMER")).toBe(false);
    expect(keepsDefaultStart(undefined, true, undefined)).toBe(false);
    expect(isStaffRole("OPERATOR")).toBe(true);
    expect(isStaffRole("DRIVER")).toBe(false);
    expect(keepsDefaultStart(flagged({ qty: 12, startOnDefaultUnit: 12 }), true, "OPERATOR")).toBe(
      true,
    ); // a 2nd fast add
    expect(keepsDefaultStart(flagged({ qty: 5, startOnDefaultUnit: 1 }), true, "OPERATOR")).toBe(
      false,
    ); // edited meanwhile
    expect(keepsDefaultStart(flagged(), false, "OPERATOR")).toBe(false); // a box-only code never follows
    expect(keepsDefaultStart({ qty: 1 }, true, "OPERATOR")).toBe(false); // an existing un-flagged line stays as it was
  });
});

describe("SA-626d: the history pre-fill is not an operator shape; the unit price scales from the TIER pack price", () => {
  const PIECE = lvl({ label: "Bottle", factorToBase: 1, price: null, isDefaultSelling: true }); // derives from the pack
  const prefilled = (): LineState => ({
    qty: 1,
    startOnDefaultUnit: 1,
    unitPrice: 20, // remembered PACK price (below the $24 tier price)
    priceSource: "history",
  });

  it("(3) the default unit's price derives from the TIER pack price ($24 / 12 = $2.00), never from the remembered $20", async () => {
    const { items } = await resolvePendingDefaultUnits(
      { p1: prefilled() },
      deps([PIECE, ...CASE_ONLY]),
    );
    expect(items.p1!.unitLabel).toBe("Bottle");
    expect(items.p1!.unitBasePrice).toBe(2);
  });

  it("(4) an explicit pack pick re-applies the remembered pack price, and any other unit choice drops it", async () => {
    const { items } = await resolvePendingDefaultUnits(
      { p1: prefilled() },
      deps([PIECE, ...CASE_ONLY]),
    );
    const [pack] = buildUnitOptions(product, [PIECE], 1);
    const back = applyUnitOption(items.p1!, pack!);
    expect(back.unitLabel).toBeUndefined();
    expect(back).toMatchObject({ unitPrice: 20, priceSource: "history" });
    expect(back.startOnDefaultUnit).toBeUndefined();
    // an operator-typed price is NOT stashed: it is cleared by a unit choice exactly as before
    const typed = applyUnitOption({ qty: 1, unitPrice: 9, priceSource: "operator" }, pack!);
    expect(typed.unitPrice).toBeUndefined();
  });
});

describe("SA-626d review: the sheet's mount path and the resolver give the SAME line", () => {
  const PIECE = lvl({ label: "Bottle", factorToBase: 1, price: null, isDefaultSelling: true });
  const OTHER = lvl({ label: "Pack6", factorToBase: 6, price: "12.00" });
  const opts = buildUnitOptions(product, [PIECE, OTHER], 1);
  const bottle = opts.find((o) => o.value === "Bottle")!;
  const pack6 = opts.find((o) => o.value === "Pack6")!;
  const pack = opts.find((o) => o.value === "")!;

  it("a pending line with 2 fast adds keeps its count when the sheet applies the unit (qty 24 pieces = 2 cases)", () => {
    const pending = flagged({ qty: 24, boxes: 2, pieces: 0, startOnDefaultUnit: 24 });
    expect(applyUnitOption(pending, bottle, 12).qty).toBe(2);
    expect(applyUnitOption(flagged({ qty: 3, startOnDefaultUnit: 3 }), bottle, 1).qty).toBe(3);
  });

  it("an explicit choice on a line that is NOT pending still resets to 1, and the pack always restores qty 1", () => {
    expect(applyUnitOption({ qty: 5 }, bottle, 12).qty).toBe(1);
    expect(applyUnitOption(flagged({ qty: 24, startOnDefaultUnit: 24 }), pack, 12).qty).toBe(1);
  });

  it("the remembered pack price survives default unit -> another unit -> pack", () => {
    const start = applyUnitOption(
      { qty: 1, startOnDefaultUnit: 1, unitPrice: 20, priceSource: "history" },
      bottle,
      12,
    );
    const other = applyUnitOption(start, pack6, 12);
    expect(other.packUnitPrice).toBe(20);
    expect(applyUnitOption(other, pack, 12)).toMatchObject({
      unitPrice: 20,
      priceSource: "history",
    });
  });
});

describe("SA-626d lead folds N2 + N3", () => {
  const opts = buildUnitOptions(product, [BOTTLE], 1);
  const bottle = opts.find((o) => o.value === "Bottle")!;

  it("N2: a stale picker/sheet re-apply of the unit the line ALREADY holds never resets its quantity", () => {
    const resolved: LineState = {
      qty: 5,
      unitLabel: "Bottle",
      unitBasePrice: 2,
      unitFactor: 1,
      note: "n",
    };
    const again = applyUnitOption(resolved, bottle, 12);
    expect(again.qty).toBe(5);
    expect(again.unitLabel).toBe("Bottle");
    expect(again.note).toBe("n");
  });

  it("N3: a note typed while the units load survives the merge of the resolved unit", () => {
    const before = { p1: flagged() };
    const done = { p1: { ...applyUnitOption(before.p1, bottle, 12) } };
    const cur = { p1: { ...before.p1, note: "leave at back door", noteOpen: true } as LineState };
    const merged = mergeResolvedDefaults(cur, before, done);
    expect(merged.p1).toMatchObject({
      unitLabel: "Bottle",
      note: "leave at back door",
      noteOpen: true,
    });
  });
});

describe("SA-626g N10: 'try again' on the blocked message REFETCHES the units answer", () => {
  it("a failed subscription read blocks; try again refetches it and the line then resolves", async () => {
    const failed = deps([BOTTLE, ...CASE_ONLY], { unitsKnown: false, unitsEnabled: false });
    const first = await resolvePendingDefaultUnits({ p1: flagged() }, failed);
    expect(first.blocked).toEqual(["p1"]);

    const refetch = jest.fn(async () => ({ isSuccess: true, flags: ["flag.units_v1"] }));
    const retried = await refreshUnitsAnswer(failed, refetch, "flag.units_v1");
    expect(refetch).toHaveBeenCalledTimes(1);
    const second = await resolvePendingDefaultUnits({ p1: flagged() }, retried);
    expect(second.blocked).toEqual([]);
    expect(second.items.p1!.unitLabel).toBe("Bottle");
  });

  it("a refetch that fails again keeps the line blocked (never the pack); a known answer is not refetched; non-staff never refetch", async () => {
    const failed = deps([BOTTLE], { unitsKnown: false, unitsEnabled: false });
    const bad = jest.fn(async () => {
      throw new Error("offline");
    });
    const still = await refreshUnitsAnswer(failed, bad, "flag.units_v1");
    expect((await resolvePendingDefaultUnits({ p1: flagged() }, still)).blocked).toEqual(["p1"]);

    const known = jest.fn(async () => ({ isSuccess: true, flags: [] as string[] }));
    await refreshUnitsAnswer(deps([BOTTLE]), known, "flag.units_v1");
    await refreshUnitsAnswer(
      deps([BOTTLE], { isStaff: false, unitsKnown: false }),
      known,
      "flag.units_v1",
    );
    expect(known).not.toHaveBeenCalled();
  });
});
