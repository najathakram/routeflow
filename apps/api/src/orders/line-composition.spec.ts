/**
 * #2717 M3 (SA-572 I9/I10/I11/I12, SA-579, SA-589): the pure line-composition rules and the
 * order-side writer. A FIXED line is a whole-box line of a RECIPE product whose components are
 * frozen per line (integer pieces). Component price is the NET line subtotal over the line's
 * pieces, stored at 4 dp on the component row only (SA-589) and shown at 2 dp.
 */
import { applyBestPromotion, computeLineSubtotal, displayComponentUnitPrice } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  assertComponentSum,
  buildComponentSnapshots,
  planFixedComposition,
  rescaleComposition,
  snapshotUnitBarcode,
  syncLineCompositions,
  type ComponentProductFacts,
  type RecipeSnapshotPort,
} from "./line-composition";

const A = "prod-a";
const O = "prod-o";
const recipe = { comps: [{ componentProductId: A, qty: 12 }, { componentProductId: O, qty: 12 }], unitsPerPack: 24 };
const line = (o: Partial<Parameters<typeof planFixedComposition>[0]["line"]> = {}) => ({
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  qty: 48,
  ...o,
});

function thrown(fn: () => unknown): { status: number; body: { code?: string } } {
  try {
    fn();
  } catch (e) {
    const err = e as { getStatus(): number; getResponse(): { code?: string } };
    return { status: err.getStatus(), body: err.getResponse() };
  }
  throw new Error("expected a throw");
}

describe("planFixedComposition", () => {
  it("(1) A12+O12 at 24 per pack, 2 boxes -> [{A,24},{O,24}], sum 48", () => {
    const out = planFixedComposition({ recipe, line: line() });
    expect(out).toEqual([
      { componentProductId: A, qty: 24 },
      { componentProductId: O, qty: 24 },
    ]);
    expect(out.reduce((a, c) => a + c.qty, 0)).toBe(48);
  });

  it("(2) loose pieces -> 400 FIXED_WHOLE_BOXES", () => {
    const e = thrown(() => planFixedComposition({ recipe, line: line({ pieces: 5 }) }));
    expect(e.status).toBe(400);
    expect(e.body.code).toBe(API_ERROR_CODES.FIXED_WHOLE_BOXES);
  });

  it("(3) a line with a unitLabel -> 400 COMPOSED_UNIT_LINE", () => {
    const e = thrown(() => planFixedComposition({ recipe, line: line({ unitLabel: "each" }) }));
    expect(e.status).toBe(400);
    expect(e.body.code).toBe(API_ERROR_CODES.COMPOSED_UNIT_LINE);
  });

  it("(4) unitsPerPack != the line's unitsPerBox -> 409 RECIPE_PACK_MISMATCH", () => {
    const e = thrown(() => planFixedComposition({ recipe, line: line({ unitsPerBox: 12 }) }));
    expect(e.status).toBe(409);
    expect(e.body.code).toBe(API_ERROR_CODES.RECIPE_PACK_MISMATCH);
  });
});

describe("assertComponentSum (I12)", () => {
  it("(5) 48 vs [24,23] -> 400 COMPONENT_SUM_MISMATCH; a matching sum passes", () => {
    const e = thrown(() => assertComponentSum(48, [24, 23]));
    expect(e.status).toBe(400);
    expect(e.body.code).toBe(API_ERROR_CODES.COMPONENT_SUM_MISMATCH);
    expect(() => assertComponentSum(48, [24, 24])).not.toThrow();
  });
});

describe("component price is the NET line subtotal over pieces (owner Q1, SA-589, L-226)", () => {
  it("(6) $30 box, 2 boxes, 1 free (BOGO): stored 0.625, shown 0.63; the list basis 1.25 is wrong", () => {
    const promo = applyBestPromotion(
      30,
      [{ id: "bogo", type: "BUY_N_GET_M", value: 1, minQty: 1, scope: "ALL" }],
      { productId: "recipe-p", qtyPieces: 48, qtyUnits: 2, boxes: 2, pieces: 0, unitsPerBox: 24 },
    );
    expect(promo.freeUnits).toBe(1);
    const subtotal = computeLineSubtotal({
      unitPrice: promo.unitPrice,
      qty: 48,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
      freeUnits: promo.freeUnits,
    });
    expect(subtotal).toBe(30);
    const rows = buildComponentSnapshots({
      planned: planFixedComposition({ recipe, line: line() }),
      products: new Map([[A, product(A, "Almond")], [O, product(O, "Oat")]]),
      netSubtotal: subtotal,
      pieces: 48,
    });
    expect(rows.map((r) => r.displayUnitPrice4)).toEqual([0.625, 0.625]);
    expect(displayComponentUnitPrice(rows[0].displayUnitPrice4 as number)).toBe(0.63);
    expect(rows[0].displayUnitPrice4).not.toBe(1.25);
  });

  it("an unrounded float subtotal does not throw (lead condition 2)", () => {
    const rows = buildComponentSnapshots({
      planned: [{ componentProductId: A, qty: 3 }],
      products: new Map([[A, product(A, "Almond")]]),
      netSubtotal: 0.1 + 0.2,
      pieces: 3,
    });
    expect(rows[0].displayUnitPrice4).toBe(0.1);
  });
});

describe("snapshotUnitBarcode (I9, SA-572a ii)", () => {
  it("(7a) a UNIT primary COPIED row prints its code and symbology", () => {
    const p = product(A, "Almond", {
      barcodes: [
        { code: "036000291452", symbology: "UPC_A", level: "BOX", primaryFor: "BOX" },
        { code: "036000291452", symbology: "UPC_A", level: "UNIT", primaryFor: "UNIT" },
      ],
    });
    expect(snapshotUnitBarcode(p)).toEqual({ unitBarcode: "036000291452", barcodeSymbology: "UPC_A" });
  });

  it("(7b) no rows, upb 6, legacy barcode -> the synthesized UNIT COPIED code", () => {
    const p = product(A, "Almond", { barcodes: [], barcode: "4006381333931", unitsPerBox: 6 });
    expect(snapshotUnitBarcode(p)).toEqual({ unitBarcode: "4006381333931", barcodeSymbology: "EAN_13" });
  });

  it("(7c) no code at all -> null barcode, unitSku kept on the row", () => {
    const p = product(A, "Almond", { barcodes: [], barcode: null, unitSku: "ALM-U", sku: "ALM-C" });
    expect(snapshotUnitBarcode(p)).toEqual({ unitBarcode: null, barcodeSymbology: null });
    const rows = buildComponentSnapshots({
      planned: [{ componentProductId: A, qty: 4 }],
      products: new Map([[A, p]]),
      netSubtotal: 4,
      pieces: 4,
    });
    expect(rows[0]).toMatchObject({ unitSku: "ALM-U", unitBarcode: null, barcodeSymbology: null, name: "Almond" });
  });
});

describe("rescaleComposition (I11, L-222)", () => {
  const stored = [{ componentProductId: A, qty: 24 }, { componentProductId: O, qty: 24 }];

  it("(8) 2 -> 3 boxes rescales the STORED composition to [36,36] (no Recipe read)", () => {
    expect(rescaleComposition({ stored, unitsPerPack: 24, boxes: 3 })).toEqual([
      { componentProductId: A, qty: 36 },
      { componentProductId: O, qty: 36 },
    ]);
  });

  it("(9) stored components not divisible by the boxes -> COMPOSITION_CORRUPT (500-class, count only)", () => {
    const corrupt = [{ componentProductId: A, qty: 25 }, { componentProductId: O, qty: 23 }];
    const e = thrown(() => rescaleComposition({ stored: corrupt, unitsPerPack: 24, boxes: 3 }));
    expect(e.status).toBe(500);
    expect(e.body.code).toBe(API_ERROR_CODES.COMPOSITION_CORRUPT);
    expect(JSON.stringify(e.body)).not.toContain(A);
  });
});

describe("syncLineCompositions (order side)", () => {
  function fixture(
    opts: {
      mode?: "on" | "off";
      existing?: boolean;
      boxes?: number;
      stamped?: boolean;
      cancelled?: boolean;
    } = {},
  ) {
    const boxes = opts.boxes ?? 2;
    const lineRow = {
      id: "li-1",
      productId: "recipe-p",
      boxes,
      pieces: 0,
      unitsPerBox: 24,
      unitLabel: null,
      subtotal: 30,
      compositionMode: opts.existing || opts.stamped ? "FIXED" : null,
      recipeId: opts.existing || opts.stamped ? "rec-1" : null,
      recipeVersion: opts.existing || opts.stamped ? 1 : null,
      product: { id: "recipe-p", kind: "RECIPE" },
      components: opts.existing
        ? [
            { componentProductId: A, qty: 24 },
            { componentProductId: O, qty: 24 },
          ]
        : [],
    };
    const tx = {
      orderItem: {
        findMany: jest.fn().mockResolvedValue([lineRow]),
        update: jest.fn().mockResolvedValue({}),
      },
      orderItemComponent: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const port: RecipeSnapshotPort = {
      recipeById: jest.fn().mockResolvedValue({
        recipeId: "rec-1",
        version: 1,
        unitsPerPack: 24,
        // existing: differs from the stored rows (12+12 per box) so a re-read is detectable
        comps: opts.existing
          ? [{ componentProductId: A, qty: 6 }, { componentProductId: O, qty: 18 }]
          : recipe.comps,
      }),
      activeRecipeFor: jest.fn().mockResolvedValue({
        recipeId: "rec-2",
        version: 2,
        unitsPerPack: 24,
        comps: opts.existing
          ? [{ componentProductId: A, qty: 20 }, { componentProductId: O, qty: 4 }]
          : recipe.comps,
      }),
      productFacts: jest.fn().mockResolvedValue(
        new Map([[A, product(A, "Almond")], [O, product(O, "Oat")]]),
      ),
    };
    const ctx = { tenantId: "t-1", enabled: (opts.mode ?? "on") === "on", port };
    return { tx, port, ctx };
  }

  it("(15) mode off: a RECIPE line stays plain, byte-identical (no read, no write)", async () => {
    const { tx, port, ctx } = fixture({ mode: "off" });
    await syncLineCompositions(tx as never, ["li-1"], ctx);
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
    expect(tx.orderItemComponent.createMany).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(port.activeRecipeFor).not.toHaveBeenCalled();
  });

  it("a new FIXED line: components written with the parent's tenantId, line stamped v2", async () => {
    const { tx, ctx } = fixture();
    await syncLineCompositions(tx as never, ["li-1"], ctx);
    const data = tx.orderItemComponent.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(2);
    expect(data.every((r: { tenantId: string; orderItemId: string }) => r.tenantId === "t-1" && r.orderItemId === "li-1")).toBe(true);
    expect(data.map((r: { qty: number }) => r.qty)).toEqual([24, 24]);
    expect(data[0].displayUnitPrice4).toBe(0.625);
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: { compositionMode: "FIXED", recipeId: "rec-2", recipeVersion: 2 },
    });
  });

  it("(8) an existing v1 line resized 2 -> 3 boxes rescales from the stored rows and never reads a Recipe", async () => {
    const { tx, port, ctx } = fixture({ existing: true, boxes: 3 });
    await syncLineCompositions(tx as never, ["li-1"], ctx);
    expect(port.recipeById).not.toHaveBeenCalled();
    expect(port.activeRecipeFor).not.toHaveBeenCalled();
    const data = tx.orderItemComponent.createMany.mock.calls[0][0].data;
    expect(data.map((r: { qty: number }) => r.qty)).toEqual([36, 36]);
    expect(tx.orderItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recipeVersion: 2 }) }),
    );
  });

  it("(5) I12 in the writing tx: a planner sum that does not match the line's pieces throws before any write", async () => {
    const { tx, port, ctx } = fixture();
    (port.activeRecipeFor as jest.Mock).mockResolvedValue({
      recipeId: "rec-2",
      version: 2,
      unitsPerPack: 24,
      comps: [{ componentProductId: A, qty: 12 }, { componentProductId: O, qty: 11 }],
    });
    await expect(syncLineCompositions(tx as never, ["li-1"], ctx)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.COMPONENT_SUM_MISMATCH },
    });
    expect(tx.orderItemComponent.createMany).not.toHaveBeenCalled();
  });

  it("a line stamped v1 with no rows yet (a merge-moved line) is planned from v1, never the ACTIVE v2", async () => {
    const { tx, port, ctx } = fixture({ stamped: true });
    await syncLineCompositions(tx as never, ["li-1"], ctx);
    expect(port.recipeById).toHaveBeenCalledWith("rec-1");
    expect(port.activeRecipeFor).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.orderItemComponent.createMany).toHaveBeenCalledTimes(1);
  });

  it("a line struck to 0 boxes (cancelled) drops its components instead of failing", async () => {
    const { tx, ctx } = fixture({ existing: true, boxes: 0 });
    await syncLineCompositions(tx as never, ["li-1"], ctx);
    expect(tx.orderItemComponent.deleteMany).toHaveBeenCalledWith({
      where: { orderItemId: "li-1", tenantId: "t-1" },
    });
    expect(tx.orderItemComponent.createMany).not.toHaveBeenCalled();
  });

  it("a RECIPE line with no ACTIVE recipe stays plain", async () => {
    const { tx, port, ctx } = fixture();
    (port.activeRecipeFor as jest.Mock).mockResolvedValue(null);
    await syncLineCompositions(tx as never, ["li-1"], ctx);
    expect(tx.orderItemComponent.createMany).not.toHaveBeenCalled();
  });

  it("an empty id list is a no-op (never an unscoped many-write)", async () => {
    const { tx, ctx } = fixture();
    await syncLineCompositions(tx as never, [], ctx);
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
  });
});

function product(
  id: string,
  name: string,
  o: Partial<ComponentProductFacts> = {},
): ComponentProductFacts {
  return {
    id,
    name,
    sku: null,
    unitSku: null,
    barcode: null,
    unitsPerBox: null,
    barcodes: [],
    ...o,
  };
}
