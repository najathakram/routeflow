import type { ProductUnitLevel } from "@routeflow/types";
import { pendingResolveKey } from "@routeflow/pricing";
import type { LadderProduct } from "@routeflow/pricing";
import type { LineState } from "../lib/cart-line-state";
import {
  isPendingDefaultUnit,
  mergeResolvedDefaults,
  refusesLineEdit,
  scanDecisionFor,
  scanMapsToDefault,
  startLineOnDefault,
  settleOnPack,
  isPendingTap,
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
const deps = (
  units: ProductUnitLevel[] | Error,
  over: Partial<DefaultUnitDeps> = {},
): DefaultUnitDeps => ({
  isStaff: true,
  unitsEnabled: true,
  unitsKnown: true,
  getUnits: jest.fn(async () => {
    if (units instanceof Error) throw units;
    return units;
  }),
  productFor: () => PRODUCT,
  tierFor: () => 1,
  ...over,
});

describe("isPendingDefaultUnit (the shared predicate)", () => {
  it("a flagged, untouched line is pending; a settled, shaped or operator-priced one is not", () => {
    expect(isPendingDefaultUnit(pending())).toBe(true);
    expect(isPendingDefaultUnit(pending({ startOnDefaultUnit: undefined }))).toBe(false);
    expect(isPendingDefaultUnit(pending({ priceSource: "operator", unitPrice: 20 }))).toBe(false);
    expect(isPendingDefaultUnit(pending({ qty: 24 }))).toBe(false); // flag no longer equals qty
  });
});

describe("refusesLineEdit (the shared refusal rule, at the handler level)", () => {
  it("refuses EVERY edit on a pending line: stepper increment (M3), typed qty, units total, and a typed PRICE (H1)", () => {
    for (const intent of ["increment", "qty", "unit", "price"] as const) {
      expect(refusesLineEdit(pending(), intent)).toBe(true);
    }
  });

  it("lets a default-unit TAP add to a pending line", () => {
    expect(refusesLineEdit(pending(), "tap")).toBe(false);
  });

  it("never refuses a settled line or a line that does not exist yet", () => {
    for (const intent of ["increment", "qty", "unit", "price", "tap"] as const) {
      expect(refusesLineEdit(undefined, intent)).toBe(false);
      expect(refusesLineEdit(pending({ startOnDefaultUnit: undefined }), intent)).toBe(false);
    }
  });
});

describe("scanDecisionFor (H2: a scan landing on a pending line)", () => {
  it("a scan that maps to the DEFAULT unit (shared code) is a tap; a DIFFERENT level is refused, not counted", () => {
    expect(scanDecisionFor(pending(), true)).toBe("tap");
    expect(scanDecisionFor(pending(), false)).toBe("refuse");
  });

  it("a settled or absent line takes the scan as usual", () => {
    expect(scanDecisionFor(pending({ startOnDefaultUnit: undefined }), false)).toBe("add");
    expect(scanDecisionFor(undefined, false)).toBe("add");
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

  it("refusesLineEdit tracks the line's lifecycle: pending refuses, a FAILED load keeps refusing, a successful retry allows", async () => {
    const line = pending({ pendingTaps: 2, qty: 24, boxes: 2, startOnDefaultUnit: 24 });
    expect(refusesLineEdit(line, "qty")).toBe(true); // pending
    const failed = await resolvePendingDefaultUnits({ p1: line }, deps(new Error("offline")));
    expect(failed.blocked).toEqual(["p1"]);
    expect(refusesLineEdit(failed.items.p1, "qty")).toBe(true); // failed: still refuses
    const retried = await resolvePendingDefaultUnits(failed.items, deps([BOTTLE, CASE]));
    expect(retried.blocked).toEqual([]);
    expect(refusesLineEdit(retried.items.p1, "qty")).toBe(false); // settled: allows
    expect(retried.items.p1).toMatchObject({ unitLabel: "Bottle", qty: 2 });
  });

  it("M2: taps count only; the line's own quantity is never touched (3 taps on a 1-case line -> 3 Bottles, never 3 cases)", async () => {
    const line = pending({ pendingTaps: 3 }); // qty 12 / 1 case, flag 12: the quantity did not move
    const { items } = await resolvePendingDefaultUnits({ p1: line }, deps([BOTTLE, CASE]));
    expect(items.p1).toMatchObject({ unitLabel: "Bottle", qty: 3 });
  });

  it("M1: an unknown units answer is 'units-unknown' (loading), a failed ladder 'ladder-failed'; neither settles the line", async () => {
    const unknown = await resolvePendingDefaultUnits(
      { p1: pending() },
      deps([BOTTLE], { unitsKnown: false }),
    );
    expect(unknown.reasons).toEqual({ p1: "units-unknown" });
    expect(isPendingDefaultUnit(unknown.items.p1)).toBe(true);
    const failed = await resolvePendingDefaultUnits({ p1: pending() }, deps(new Error("x")));
    expect(failed.reasons).toEqual({ p1: "ladder-failed" });
  });

  it("retry keeps the count: a failed load then a working one ends at exactly N default units", async () => {
    const line = pending({ pendingTaps: 4 });
    const failed = await resolvePendingDefaultUnits({ p1: line }, deps(new Error("x")));
    expect(failed.items.p1.pendingTaps).toBe(4);
    const ok = await resolvePendingDefaultUnits(failed.items, deps([BOTTLE, CASE]));
    expect(ok.items.p1).toMatchObject({ unitLabel: "Bottle", qty: 4 });
  });

  it("an async resolve never overwrites a tap that landed meanwhile (the tap count differs)", async () => {
    const before = { p1: pending({ pendingTaps: 1 }) };
    const done = (await resolvePendingDefaultUnits(before, deps([BOTTLE, CASE]))).items;
    const cur = { p1: pending({ pendingTaps: 2 }) }; // a 2nd tap landed while this resolved
    expect(mergeResolvedDefaults(cur, before, done)).toBe(cur);
    const same = { p1: pending({ pendingTaps: 1 }) };
    expect(mergeResolvedDefaults(same, before, done).p1).toMatchObject({ unitLabel: "Bottle" });
  });

  it("N1: a tap that lands DURING the ladder fetch is not lost: the stale merge skips, the resolver re-runs, N+1 default units", async () => {
    const before = { p1: pending({ pendingTaps: 1 }) };
    const done = (await resolvePendingDefaultUnits(before, deps([BOTTLE, CASE]))).items;
    const cur = { p1: pending({ pendingTaps: 2 }) }; // the 2nd tap landed while the ladder loaded
    expect(mergeResolvedDefaults(cur, before, done)).toBe(cur); // the stale resolve is skipped...
    // ...and the resolver key changed with the tap count, so it runs again on the current line
    const key = (m: Record<string, LineState>) =>
      pendingResolveKey(
        Object.entries(m).map(([id, l]) => ({ id, count: l.pendingTaps ?? l.qty })),
      );
    expect(key(cur)).not.toBe(key(before));
    const again = (await resolvePendingDefaultUnits(cur, deps([BOTTLE, CASE]))).items;
    expect(mergeResolvedDefaults(cur, cur, again).p1).toMatchObject({
      unitLabel: "Bottle",
      qty: 2,
    });
  });

  it("F3: repeat scans of the SAME code that created the pending line are taps, however a later lookup flags them (3 manual scans -> 3 Bottles)", async () => {
    // scan 1 (flagged default) created the line; scans 2 and 3 resolve from a row that does not flag it (dflt false)
    const created = pending({ pendingTaps: 1, pendingCode: "012345678905" });
    for (const dflt of [true, false]) {
      expect(isPendingTap(created, dflt, "012345678905", "OPERATOR")).toBe(true);
    }
    expect(scanMapsToDefault(created, false, "0012345678905")).toBe(true); // the same label, EAN-13 form
    let line = created;
    for (let n = 0; n < 2; n++) {
      expect(isPendingTap(line, false, "012345678905", "OPERATOR")).toBe(true);
      line = { ...line, pendingTaps: (line.pendingTaps ?? 1) + 1 };
    }
    expect(line.pendingTaps).toBe(3);
    const { items } = await resolvePendingDefaultUnits({ p1: line }, deps([BOTTLE, CASE]));
    expect(items.p1).toMatchObject({ unitLabel: "Bottle", qty: 3 });
  });

  it("F3: a DIFFERENT code on a pending line, a settled line and a non-staff role are NOT taps", () => {
    const created = pending({ pendingTaps: 1, pendingCode: "012345678905" });
    expect(isPendingTap(created, false, "999999999994", "OPERATOR")).toBe(false);
    expect(scanDecisionFor(created, scanMapsToDefault(created, false, "999999999994"))).toBe(
      "refuse",
    );
    expect(isPendingTap(pending({ startOnDefaultUnit: undefined }), true, "x", "OPERATOR")).toBe(
      false,
    );
    expect(isPendingTap(created, true, "012345678905", "DRIVER")).toBe(false);
  });

  describe("N3: a settle on the PACK keeps the tap count (N taps = N packs, never one)", () => {
    const taps3 = () => pending({ pendingTaps: 3 }); // 12 per case, qty 12 / 1 case, flag 12
    const THREE_PACKS = { boxes: 3, pieces: 0, qty: 36 };

    it("no flagged non-pack default on the ladder: 3 taps -> 3 PACKS (3 cases)", async () => {
      const noDefault = [lvl({ label: "Bottle", factorToBase: 1, price: "2.00" }), CASE];
      const { items } = await resolvePendingDefaultUnits({ p1: taps3() }, deps(noDefault));
      expect(items.p1).toMatchObject(THREE_PACKS);
      expect(items.p1.pendingTaps).toBeUndefined();
      expect(items.p1.unitLabel).toBeUndefined(); // still the pack
    });

    it("units OFF (known): 3 taps -> 3 PACKS", async () => {
      const { items } = await resolvePendingDefaultUnits(
        { p1: taps3() },
        deps([BOTTLE], { unitsEnabled: false }),
      );
      expect(items.p1).toMatchObject(THREE_PACKS);
    });

    it("a role that never sells by a unit (not staff): 3 taps -> 3 PACKS", async () => {
      const { items } = await resolvePendingDefaultUnits(
        { p1: taps3() },
        deps([BOTTLE], { isStaff: false }),
      );
      expect(items.p1).toMatchObject(THREE_PACKS);
    });

    it("startLineOnDefault with no default option settles on the pack with the count; one tap is unchanged", () => {
      const noDefault = [lvl({ label: "Bottle", factorToBase: 1, price: "2.00" })];
      expect(startLineOnDefault(taps3(), PRODUCT, noDefault, 1)).toMatchObject(THREE_PACKS);
      expect(settleOnPack(pending({ pendingTaps: 1 }), 12)).toMatchObject({ boxes: 1, qty: 12 });
    });

    it("a plain (non-case) line: 3 taps -> qty 3", () => {
      const plain = { qty: 1, startOnDefaultUnit: 1, pendingTaps: 3 } as LineState;
      expect(settleOnPack(plain, null)).toMatchObject({ qty: 3 });
      expect(settleOnPack(plain, null).boxes).toBeUndefined();
    });
  });
});
