import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  holdsStockOrCost,
  isPackIntroduction,
  packIntroChanges,
  packReadingRequiredError,
} from "./pack-intro";

/**
 * SA-946 MUST 1 / MUST 7 (W-867): the ONE pack-introduction rule. A product sold with no pack that
 * gets a pack of N is read as "the thing sold so far is a box of N", so the stored per-piece numbers
 * (stock, reorder levels, cost, open cost lots) are rescaled; prices are never touched (L-332).
 */
const base = {
  unitsPerBox: null as number | null,
  currentStock: "50.000",
  reorderPoint: 4 as number | null,
  reorderQty: 12 as number | null,
  averageCost: "2.0000" as string | null,
  standardCost: "2.5000" as string | null,
};

describe("packIntroChanges (SA-946)", () => {
  it("box reading, blank -> 10: 50 in stock at cost 2.00 becomes 500 at 0.2000", () => {
    const out = packIntroChanges(base, 10, "box");
    expect(out?.product.currentStock).toBe(500);
    expect(out?.product.averageCost).toBe(0.2);
    expect(out?.product.standardCost).toBe(0.25);
    expect(out?.product.reorderPoint).toBe(40);
    expect(out?.product.reorderQty).toBe(120);
  });

  it("scales every OPEN lot's qty, remainingQty and unit cost; leaves a used-up lot alone", () => {
    const out = packIntroChanges(
      {
        ...base,
        stockLots: [
          { id: "open", qty: "30.000", remainingQty: "20.000", unitCost: "1.8000" },
          { id: "spent", qty: "10.000", remainingQty: "0.000", unitCost: "2.4000" },
        ],
      },
      10,
      "box",
    );
    expect(out?.lots).toEqual([{ id: "open", qty: 300, remainingQty: 200, unitCost: 0.18 }]);
  });

  it("rounds cost to 4 dp and stock to 3 dp", () => {
    const out = packIntroChanges(
      { ...base, currentStock: "0.333", averageCost: "1.0000", standardCost: null },
      3,
      "box",
    );
    expect(out?.product.currentStock).toBe(0.999);
    expect(out?.product.averageCost).toBe(0.3333);
    expect(out?.product).not.toHaveProperty("standardCost");
  });

  it("piece reading changes nothing", () => {
    expect(packIntroChanges(base, 10, "piece")).toBeNull();
  });

  it("a pack of 1 (or blank target) converts nothing", () => {
    expect(packIntroChanges(base, 1, "box")).toBeNull();
    expect(packIntroChanges({ ...base, unitsPerBox: 1 }, 1, "box")).toBeNull();
  });

  it("a stored pack of 1 is the same as blank: 1 -> 6 converts", () => {
    expect(packIntroChanges({ ...base, unitsPerBox: 1 }, 6, "box")?.product.currentStock).toBe(300);
  });

  it("a stored pack above 1 is a pack change, not an introduction: nothing converts (replay, N -> M)", () => {
    expect(packIntroChanges({ ...base, unitsPerBox: 10 }, 10, "box")).toBeNull();
    expect(packIntroChanges({ ...base, unitsPerBox: 10 }, 12, "box")).toBeNull();
  });

  it("names a field whose scaled value no longer fits its column instead of clamping it", () => {
    const out = packIntroChanges({ ...base, currentStock: "9000000.000" }, 10, "box");
    expect(out?.overflow).toEqual(["currentStock"]);
  });

  it("zero stock and no cost: nothing to convert but the reorder levels", () => {
    const out = packIntroChanges(
      { ...base, currentStock: "0.000", averageCost: null, standardCost: null },
      10,
      "box",
    );
    expect(out?.product).toEqual({ currentStock: 0, reorderPoint: 40, reorderQty: 120 });
  });
});

describe("isPackIntroduction / holdsStockOrCost / the 409", () => {
  it("is true only for blank or <= 1 to N > 1", () => {
    expect(isPackIntroduction(null, 10)).toBe(true);
    expect(isPackIntroduction(1, 10)).toBe(true);
    expect(isPackIntroduction(0, 10)).toBe(true);
    expect(isPackIntroduction(null, 1)).toBe(false);
    expect(isPackIntroduction(10, 12)).toBe(false);
  });

  it("holds stock or cost when any of stock, a cost or an open lot is non-zero", () => {
    expect(holdsStockOrCost(base)).toBe(true);
    const empty = { ...base, currentStock: "0.000", averageCost: null, standardCost: null };
    expect(holdsStockOrCost(empty)).toBe(false);
    expect(holdsStockOrCost({ ...empty, averageCost: "0.0000" })).toBe(false);
    expect(holdsStockOrCost({ ...empty, standardCost: "0.0100" })).toBe(true);
    expect(holdsStockOrCost({ ...empty, currentStock: "-2.000" })).toBe(true);
    expect(
      holdsStockOrCost({
        ...empty,
        stockLots: [{ id: "l", qty: "5", remainingQty: "5", unitCost: "1" }],
      }),
    ).toBe(true);
  });

  it("PACK_READING_REQUIRED is a 409 carrying the shared code", () => {
    const err = packReadingRequiredError();
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PACK_READING_REQUIRED,
    });
  });
});

describe("negative stock (SA-958: warned and allowed, never blocked)", () => {
  it("a negative stock is rescaled like any other and is not an overflow", () => {
    const out = packIntroChanges({ ...base, currentStock: "-2.000" }, 10, "box");
    expect(out?.product.currentStock).toBe(-20);
    expect(out?.overflow).toEqual([]);
  });
});
