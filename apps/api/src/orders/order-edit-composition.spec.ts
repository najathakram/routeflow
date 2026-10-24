import { captureCompositionCarry } from "./order-edit-composition";
import {
  syncLineCompositions,
  type ComponentProductFacts,
  type RecipeSnapshotPort,
} from "./line-composition";

/**
 * #2717 M3 (SA-591 b, SA-579 case 8): a replace-all edit deletes and re-creates the order's lines.
 * A SURVIVING line must keep its stored recipe stamp and its stored components (rescaled from its
 * own per-box counts, no Recipe read at all, I11); only a NEW line resolves the ACTIVE recipe.
 */
const A = "prod-a";
const O = "prod-o";
const RECIPE_P = "recipe-p";

const oldLine = (o: Record<string, unknown> = {}) => ({
  id: "old-1",
  productId: RECIPE_P,
  status: "PENDING",
  position: 0,
  compositionMode: "FIXED",
  recipeId: "rec-1",
  recipeVersion: 1,
  ...o,
});
const storedRow = (
  orderItemId: string,
  componentProductId: string,
  qty: number,
  position: number,
) => ({
  id: `c-${orderItemId}-${componentProductId}`,
  tenantId: "t-1",
  orderItemId,
  componentProductId,
  qty,
  name: componentProductId,
  unitSku: null,
  unitBarcode: null,
  barcodeSymbology: null,
  displayUnitPrice4: null,
  position,
});

function txFor(rows: Array<ReturnType<typeof storedRow>> = []) {
  return {
    orderItemComponent: {
      findMany: jest.fn().mockResolvedValue(rows),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    orderItem: { update: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
    recipe: { findFirst: jest.fn() },
  };
}

const facts = (id: string): ComponentProductFacts => ({
  id,
  name: id,
  sku: null,
  unitSku: null,
  barcode: null,
  unitsPerBox: null,
  barcodes: [],
});

describe("captureCompositionCarry / restore", () => {
  it("an order with no FIXED line reads nothing and writes nothing (byte-identical)", async () => {
    const tx = txFor();
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine({ compositionMode: null, recipeId: null, recipeVersion: null })],
      [{ productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    expect(tx.orderItemComponent.findMany).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.orderItemComponent.createMany).not.toHaveBeenCalled();
  });

  it("a surviving FIXED line's new row takes the stored stamp and copies the stored rows, no Recipe read", async () => {
    const tx = txFor([storedRow("old-1", A, 16, 0), storedRow("old-1", O, 8, 1)]);
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine()],
      [{ productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "new-1" },
      data: { compositionMode: "FIXED", recipeId: "rec-1", recipeVersion: 1 },
    });
    const data = tx.orderItemComponent.createMany.mock.calls[0][0].data;
    expect(data).toEqual([
      expect.objectContaining({
        tenantId: "t-1",
        orderItemId: "new-1",
        componentProductId: A,
        qty: 16,
        position: 0,
      }),
      expect.objectContaining({
        tenantId: "t-1",
        orderItemId: "new-1",
        componentProductId: O,
        qty: 8,
        position: 1,
      }),
    ]);
    expect(data[0]).not.toHaveProperty("id");
    expect(tx.recipe.findFirst).not.toHaveBeenCalled();
  });

  it("a line named by sourceLineId takes THAT line's stamp, whatever its position", async () => {
    const tx = txFor([storedRow("old-2", A, 24, 0)]);
    const carry = await captureCompositionCarry(
      tx as never,
      [
        oldLine({ id: "old-1", compositionMode: null, recipeId: null, recipeVersion: null }),
        oldLine({ id: "old-2", position: 1, recipeId: "rec-2", recipeVersion: 2 }),
      ],
      [{ productId: RECIPE_P }, { productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-9", { productId: RECIPE_P, sourceLineId: "old-2" });
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "new-9" },
      data: { compositionMode: "FIXED", recipeId: "rec-2", recipeVersion: 2 },
    });
  });

  it("a named line is claimed by its entry: an id-less entry re-created BEFORE it takes the other line, not the named one (row 352)", async () => {
    const tx = txFor([storedRow("old-1", A, 8, 0), storedRow("old-2", A, 16, 0)]);
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine({ id: "old-1" }), oldLine({ id: "old-2", position: 1 })],
      [
        { productId: RECIPE_P }, // e.g. a new add / the split's new half, ordered before the line it came from
        { productId: RECIPE_P, sourceLineId: "old-1" },
      ],
    );
    // the id-less entry is re-created FIRST: it must not take old-1's slot (the line "new-b" is named for)
    await carry.restore(tx as never, "new-a", { productId: RECIPE_P });
    await carry.restore(tx as never, "new-b", { productId: RECIPE_P, sourceLineId: "old-1" });
    const byLine = Object.fromEntries(
      tx.orderItemComponent.createMany.mock.calls.map((c) => [
        c[0].data[0].orderItemId,
        c[0].data[0].qty,
      ]),
    );
    expect(byLine).toEqual({ "new-a": 16, "new-b": 8 });
  });

  it("two lines of one product at ONE version pair by position order", async () => {
    const tx = txFor([storedRow("old-1", A, 8, 0), storedRow("old-2", A, 16, 0)]);
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine({ id: "old-1" }), oldLine({ id: "old-2", position: 1 })],
      [{ productId: RECIPE_P }, { productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    await carry.restore(tx as never, "new-2", { productId: RECIPE_P });
    const rows = tx.orderItemComponent.createMany.mock.calls.map((c) => c[0].data[0].qty);
    expect(rows).toEqual([8, 16]);
  });

  it("mixed versions of one product, payload count changed, no sourceLineId: never guesses a version", async () => {
    const tx = txFor([storedRow("old-1", A, 8, 0), storedRow("old-2", A, 16, 0)]);
    const carry = await captureCompositionCarry(
      tx as never,
      [
        oldLine({ id: "old-1" }),
        oldLine({ id: "old-2", position: 1, recipeId: "rec-2", recipeVersion: 2 }),
      ],
      [{ productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.orderItemComponent.createMany).not.toHaveBeenCalled();
  });

  it("a cancelled pre-edit line is never carried", async () => {
    const tx = txFor([]);
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine({ status: "CANCELLED" })],
      [{ productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });
});

describe("edit after v2 activates: restore + sync (SA-579 case 8)", () => {
  function syncFixture(tx: ReturnType<typeof txFor>) {
    const port = {
      activeRecipeFor: jest.fn().mockResolvedValue({
        recipeId: "rec-2",
        version: 2,
        unitsPerPack: 24,
        comps: [
          { componentProductId: A, qty: 6 },
          { componentProductId: O, qty: 18 },
        ],
      }),
      recipeById: jest.fn(),
      productFacts: jest
        .fn()
        .mockImplementation(async (ids: string[]) => new Map(ids.map((i) => [i, facts(i)]))),
    } satisfies RecipeSnapshotPort;
    return { port, ctx: { tenantId: "t-1", enabled: true, port } };
  }
  const newLineRow = (o: Record<string, unknown>) => ({
    id: "new-1",
    productId: RECIPE_P,
    boxes: 3,
    pieces: 0,
    unitsPerBox: 24,
    unitLabel: null,
    subtotal: 90,
    compositionMode: null,
    recipeId: null,
    recipeVersion: null,
    product: { id: RECIPE_P, kind: "RECIPE" },
    components: [],
    ...o,
  });

  it("the surviving v1 line (2 -> 3 boxes) is rescaled from its stored per-box counts; the Recipe port is never called", async () => {
    const tx = txFor([storedRow("old-1", A, 16, 0), storedRow("old-1", O, 32, 1)]);
    const { port, ctx } = syncFixture(tx);
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine()],
      [{ productId: RECIPE_P }],
    );
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    const restored = tx.orderItemComponent.createMany.mock.calls[0][0].data;
    tx.orderItem.findMany.mockResolvedValue([
      newLineRow({
        compositionMode: "FIXED",
        recipeId: "rec-1",
        recipeVersion: 1,
        components: restored.map((r: { componentProductId: string; qty: number }) => ({
          componentProductId: r.componentProductId,
          qty: r.qty,
        })),
      }),
    ]);
    tx.orderItemComponent.createMany.mockClear();
    await syncLineCompositions(tx as never, ["new-1"], ctx);
    expect(port.activeRecipeFor).not.toHaveBeenCalled();
    expect(port.recipeById).not.toHaveBeenCalled();
    const data = tx.orderItemComponent.createMany.mock.calls[0][0].data;
    expect(data.map((r: { qty: number }) => r.qty)).toEqual([24, 48]);
    expect(tx.orderItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recipeVersion: 2 }) }),
    );
  });

  it("a NEW line (no counterpart) resolves the ACTIVE recipe and is stamped v2", async () => {
    const tx = txFor([]);
    const { port, ctx } = syncFixture(tx);
    const carry = await captureCompositionCarry(
      tx as never,
      [oldLine()],
      [{ productId: RECIPE_P }],
    );
    // the one pre-edit slot of this product is taken by the surviving line ...
    await carry.restore(tx as never, "new-1", { productId: RECIPE_P });
    tx.orderItem.update.mockClear();
    // ... so a second line of the product has no counterpart
    await carry.restore(tx as never, "new-2", { productId: RECIPE_P });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    tx.orderItem.findMany.mockResolvedValue([newLineRow({ id: "new-2" })]);
    await syncLineCompositions(tx as never, ["new-2"], ctx);
    expect(port.activeRecipeFor).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "new-2" },
      data: { compositionMode: "FIXED", recipeId: "rec-2", recipeVersion: 2 },
    });
  });
});
