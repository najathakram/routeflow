import type { ProductUnitLevel } from "@routeflow/types";
import {
  applyUnitToLines,
  type DefaultUnitLine,
  isPendingDefaultUnit,
  keepsDefaultStart,
  mergeResolvedLines,
  refreshUnitsAnswer,
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
  isStaff: true,
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
    // a history pre-fill (DISCOUNTED + discountedPrice at add time) is NOT a shape (SA-626d); a TYPED price sets priceEdited
    expect(isPendingDefaultUnit(line({ discountedPrice: 20, priceType: "DISCOUNTED" }))).toBe(true);
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

describe("SA-626d review: the picker's mount path and the resolver give the SAME line; the async resolve never uses a stale count", () => {
  it("applyUnitToLines on a pending line keeps its count (2 cases = 2 of the default unit) without any extra argument", () => {
    const [, bottle] = buildUnitOptions(
      { unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" },
      [BOTTLE],
      1,
    );
    const two = line({ qty: 24, boxes: 2, pieces: 0 });
    expect(applyUnitToLines([two], "t1", bottle!, false, 1)[0]).toMatchObject({
      unitLabel: "Bottle",
      qty: 2,
    });
    // an explicit choice on a line that is not pending still resets to 1
    const typed = line({ qty: 24, boxes: 2, startOnDefaultUnit: false });
    expect(applyUnitToLines([typed], "t1", bottle!, false, 1)[0]!.qty).toBe(1);
  });

  it("mergeResolvedLines does not overwrite a line whose count changed while the resolve was in flight", () => {
    const before = [line({ qty: 12, boxes: 1 })];
    const done = [{ ...before[0]!, unitLabel: "Bottle", qty: 1, startOnDefaultUnit: false }];
    const cur = [line({ qty: 24, boxes: 2 })]; // a second fast add landed meanwhile
    const merged = mergeResolvedLines(cur, before, done);
    expect(merged[0]).toBe(cur[0]);
  });
});

describe("SA-626d lead folds N2 + N3 (web)", () => {
  const [, bottle] = buildUnitOptions(
    { unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" },
    [BOTTLE],
    1,
  );

  it("N2: a stale picker re-apply of the unit the line ALREADY holds never resets its quantity", () => {
    const [resolved] = applyUnitToLines([line({ qty: 24, boxes: 2 })], "t1", bottle!, false, 1);
    expect(resolved).toMatchObject({ unitLabel: "Bottle", qty: 2 });
    const [again] = applyUnitToLines([{ ...resolved!, qty: 5 }], "t1", bottle!, false, 1);
    expect(again!.qty).toBe(5);
  });

  it("N3: a note typed while the units load survives the merge of the resolved unit", () => {
    const before = [line()];
    const done = applyUnitToLines(before, "t1", bottle!, false, 1);
    const cur = [{ ...before[0]!, note: "leave at back door" } as TestLine];
    const merged = mergeResolvedLines(cur, before, done);
    expect(merged[0]).toMatchObject({ unitLabel: "Bottle", note: "leave at back door" });
  });
});

describe("SA-626g N10 + N9 (web): try again refetches the units answer; the read is staff-only", () => {
  it("a failed subscription read blocks; try again refetches it and the line then resolves", async () => {
    const failed = deps([BOTTLE, CASE_LEVEL], { unitsKnown: false, unitsEnabled: false });
    expect((await resolvePendingDefaultUnits([line()], failed)).blocked).toEqual(["t1"]);
    const refetch = jest.fn(async () => ({ isSuccess: true, flags: ["flag.units_v1"] }));
    const retried = await refreshUnitsAnswer(failed, refetch, "flag.units_v1");
    expect(refetch).toHaveBeenCalledTimes(1);
    const second = await resolvePendingDefaultUnits([line()], retried);
    expect(second.blocked).toEqual([]);
    expect(second.lines[0]!.unitLabel).toBe("Bottle");
  });

  it("a refetch that fails again stays blocked; a known answer / a non-staff caller never refetches", async () => {
    const failed = deps([BOTTLE], { unitsKnown: false, unitsEnabled: false });
    const bad = jest.fn(async () => {
      throw new Error("offline");
    });
    const still = await refreshUnitsAnswer(failed, bad, "flag.units_v1");
    expect((await resolvePendingDefaultUnits([line()], still)).blocked).toEqual(["t1"]);
    const known = jest.fn(async () => ({ isSuccess: true, flags: [] as string[] }));
    await refreshUnitsAnswer(deps([BOTTLE]), known, "flag.units_v1");
    await refreshUnitsAnswer(
      deps([BOTTLE], { isStaff: false, unitsKnown: false }),
      known,
      "flag.units_v1",
    );
    expect(known).not.toHaveBeenCalled();
  });

  it("N9: a non-staff caller makes no read and clears the flag", async () => {
    const d = deps([BOTTLE, CASE_LEVEL], { isStaff: false });
    const { lines, blocked } = await resolvePendingDefaultUnits([line()], d);
    expect(blocked).toEqual([]);
    expect(lines[0]!.startOnDefaultUnit).toBe(false);
    expect(d.getUnits).not.toHaveBeenCalled();
  });
});

/**
 * #2865 case c (SA-632): N taps before the ladder loads are recorded as a PENDING TAP COUNT, never a quantity in a
 * guessed unit. On resolve the line is N x the default unit; a failed load keeps the count and the line pending, so a
 * retry gives N bottles (never cases).
 */
describe("pending tap count (case c)", () => {
  it("3 taps before load -> 3 bottles after (the count, not 3 cases)", async () => {
    const { lines } = await resolvePendingDefaultUnits(
      [line({ pendingTaps: 3, qty: 36, boxes: 3 })],
      deps([BOTTLE, CASE_LEVEL]),
    );
    expect(lines[0]).toMatchObject({ unitLabel: "Bottle", qty: 3, startOnDefaultUnit: false });
    expect(lines[0].pendingTaps).toBeUndefined();
  });

  it("3 taps + a FAILED load: blocked, the line is untouched and still pending with its count; retry -> 3 bottles", async () => {
    const pendingLine = line({ pendingTaps: 3, qty: 36, boxes: 3 });
    const failed = await resolvePendingDefaultUnits([pendingLine], deps(new Error("offline")));
    expect(failed.blocked).toEqual(["t1"]);
    expect(failed.lines[0]).toBe(pendingLine);
    expect(isPendingDefaultUnit(failed.lines[0])).toBe(true);
    const retried = await resolvePendingDefaultUnits(failed.lines, deps([BOTTLE, CASE_LEVEL]));
    expect(retried.lines[0]).toMatchObject({ unitLabel: "Bottle", qty: 3 });
  });

  it("the count wins over any inferred quantity (never derived from a pack-unit qty)", async () => {
    const { lines } = await resolvePendingDefaultUnits(
      [line({ pendingTaps: 2, qty: 24, boxes: 2 })],
      deps([BOTTLE, CASE_LEVEL]),
    );
    expect(lines[0].qty).toBe(2);
  });
});

describe("LOW: a twin-fold never leaves a line stuck pending; M1: reasons say loading vs failed", () => {
  it("resolving a pending line that has a settled twin folds into it and leaves NO pending line", () => {
    const bottleOpt = buildUnitOptions(
      { unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" } as never,
      [BOTTLE, CASE_LEVEL],
      1,
    ).find((o) => o.value === "Bottle")!;
    const twin = line({
      tempId: "t2",
      startOnDefaultUnit: false,
      unitLabel: "Bottle",
      qty: 3,
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
    }); // a unit-sold line: a plain count
    const folded = applyUnitToLines([line({ pendingTaps: 2 }), twin], "t1", bottleOpt, false, 1);
    expect(folded.some(isPendingDefaultUnit)).toBe(false);
    expect(folded).toHaveLength(1);
  });

  it("an unknown units answer is blocked as 'units-unknown' (loading), a failed ladder as 'ladder-failed'", async () => {
    const unknown = await resolvePendingDefaultUnits(
      [line()],
      deps([BOTTLE], { unitsKnown: false }),
    );
    expect(unknown.reasons).toEqual({ t1: "units-unknown" });
    const failed = await resolvePendingDefaultUnits([line()], deps(new Error("offline")));
    expect(failed.reasons).toEqual({ t1: "ladder-failed" });
  });
});

describe("TWIN-FOLD (SA-632): a pending line that folds into a settled twin leaves NO pending line after the merge", () => {
  it("resolve + merge into the CURRENT lines removes the folded line and adds its taps to the twin (2 taps + 3 Bottles = 5)", async () => {
    const twin = line({
      tempId: "t2",
      startOnDefaultUnit: false,
      unitLabel: "Bottle",
      qty: 3,
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
    }); // a unit-sold line: a plain count
    const before = [line({ pendingTaps: 2 }), twin];
    const done = await resolvePendingDefaultUnits(before, deps([BOTTLE, CASE_LEVEL]));
    const merged = mergeResolvedLines(before, before, done.lines, done.folds);
    expect(merged.some(isPendingDefaultUnit)).toBe(false);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ tempId: "t2", unitLabel: "Bottle", qty: 5 });
  });

  it("a tap that landed on the folded line while the ladder loaded is NOT lost: the merge skips, the resolver re-runs on the new count", async () => {
    const twin = line({
      tempId: "t2",
      startOnDefaultUnit: false,
      unitLabel: "Bottle",
      qty: 3,
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
    }); // a unit-sold line: a plain count
    const before = [line({ pendingTaps: 1 }), twin];
    const done = await resolvePendingDefaultUnits(before, deps([BOTTLE, CASE_LEVEL]));
    const cur = [line({ pendingTaps: 2 }), twin]; // a 2nd tap landed during the fetch
    expect(mergeResolvedLines(cur, before, done.lines, done.folds)).toBe(cur); // stale: skipped
    const again = await resolvePendingDefaultUnits(cur, deps([BOTTLE, CASE_LEVEL]));
    const merged = mergeResolvedLines(cur, cur, again.lines, again.folds);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ unitLabel: "Bottle", qty: 5 });
  });
});

describe("N3 (SA-632): a settle on the PACK keeps the tap count (N taps = N packs, never one)", () => {
  const taps3 = () => line({ pendingTaps: 3 }); // 3 default-start taps on a case-packed line (12 per case)
  const THREE_PACKS = { boxes: 3, pieces: 0, qty: 36, startOnDefaultUnit: false };

  it("no flagged non-pack default on the ladder: 3 taps -> 3 PACKS (3 cases), not one", async () => {
    const noDefault = [lvl({ label: "Bottle", factorToBase: 1, price: "2.00" }), CASE_LEVEL];
    const { lines } = await resolvePendingDefaultUnits([taps3()], deps(noDefault));
    expect(lines[0]).toMatchObject(THREE_PACKS);
    expect(lines[0].pendingTaps).toBeUndefined();
    expect(lines[0].unitLabel).toBeUndefined(); // still the pack
  });

  it("units OFF (known): 3 taps -> 3 PACKS", async () => {
    const { lines } = await resolvePendingDefaultUnits(
      [taps3()],
      deps([BOTTLE], { unitsEnabled: false }),
    );
    expect(lines[0]).toMatchObject(THREE_PACKS);
  });

  it("a role that never sells by a unit (not staff): 3 taps -> 3 PACKS", async () => {
    const { lines } = await resolvePendingDefaultUnits(
      [taps3()],
      deps([BOTTLE], { isStaff: false }),
    );
    expect(lines[0]).toMatchObject(THREE_PACKS);
  });

  it("startLineOnDefault with no default option offered settles on the pack with the count too", () => {
    const out = startLineOnDefault(
      taps3(),
      [lvl({ label: "Bottle", factorToBase: 1, price: "2.00" })],
      1,
    );
    expect(out).toMatchObject(THREE_PACKS);
  });

  it("a plain (non-case) line: 3 taps -> qty 3; ONE tap is unchanged (one pack)", async () => {
    const plain = (taps: number) =>
      line({
        pendingTaps: taps,
        unitsPerBox: undefined,
        boxes: undefined,
        pieces: undefined,
        qty: 1,
      });
    const three = await resolvePendingDefaultUnits(
      [plain(3)],
      deps([BOTTLE], { unitsEnabled: false }),
    );
    expect(three.lines[0]).toMatchObject({ qty: 3, startOnDefaultUnit: false });
    const one = await resolvePendingDefaultUnits(
      [plain(1)],
      deps([BOTTLE], { unitsEnabled: false }),
    );
    expect(one.lines[0]).toMatchObject({ qty: 1 });
  });
});
