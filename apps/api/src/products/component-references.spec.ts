import { recipeReferenceGroupers } from "./recipe-references";

/**
 * #2717 M3 (SA-579 S3, case 28): a product that a frozen document component row names
 * (OrderItemComponent / InvoiceItemComponent.componentProductId, RESTRICT FKs) is REFERENCED, so
 * bulk delete and clear-all soft-delete it (isActive false) instead of hard-deleting it and hitting
 * P2003. A document component row is never deleted to make a product delete succeed. The real-PG
 * proof is the F2 lane (orders/invoices/products db specs); this pins the classifier input.
 */
const grouper = (rows: Array<Record<string, string>>) => ({
  groupBy: jest.fn().mockResolvedValue(rows),
});
const db = (over: Record<string, unknown> = {}) => ({
  recipe: grouper([]),
  recipeComponent: grouper([]),
  orderItemComponent: grouper([]),
  invoiceItemComponent: grouper([]),
  ...over,
});
const referencedBy = async (
  groupers: ReturnType<typeof recipeReferenceGroupers>,
  ids: string[],
) => {
  const out = new Set<string>();
  for (const g of groupers) {
    for (const r of await g.groupBy({ by: ["productId"], where: { productId: { in: ids } } })) {
      if (r.productId) out.add(r.productId);
    }
  }
  return out;
};

describe("recipeReferenceGroupers covers document component rows", () => {
  it("a product named only by an ORDER component row is referenced", async () => {
    const d = db({ orderItemComponent: grouper([{ componentProductId: "p1" }]) });
    expect([...(await referencedBy(recipeReferenceGroupers(d as never), ["p1", "p2"]))]).toEqual([
      "p1",
    ]);
    expect(d.orderItemComponent.groupBy).toHaveBeenCalledWith({
      by: ["componentProductId"],
      where: { componentProductId: { in: ["p1", "p2"] } },
    });
  });

  it("a product named only by an INVOICE component row is referenced", async () => {
    const d = db({ invoiceItemComponent: grouper([{ componentProductId: "p2" }]) });
    expect([...(await referencedBy(recipeReferenceGroupers(d as never), ["p1", "p2"]))]).toEqual([
      "p2",
    ]);
  });

  it("no component rows: nothing extra is referenced", async () => {
    expect((await referencedBy(recipeReferenceGroupers(db() as never), ["p1"])).size).toBe(0);
  });

  it("an empty id list never queries the component tables", async () => {
    const d = db();
    await referencedBy(recipeReferenceGroupers(d as never), []);
    expect(d.orderItemComponent.groupBy).not.toHaveBeenCalled();
    expect(d.invoiceItemComponent.groupBy).not.toHaveBeenCalled();
  });

  it("a client without the component delegates (an older stub) still works", async () => {
    const legacy = { recipe: grouper([]), recipeComponent: grouper([]) };
    await expect(referencedBy(recipeReferenceGroupers(legacy as never), ["p1"])).resolves.toEqual(
      new Set(),
    );
  });
});
