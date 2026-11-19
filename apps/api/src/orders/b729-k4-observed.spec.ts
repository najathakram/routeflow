/**
 * B729 / SA-1170 K4 + K6: the rows of the case table that run through the real order code (not the mocked buyer controller).
 *  - :68 / :67 the fold of a split onto a stored line (mergeIntoStoredLine, the one stored-line merge rule);
 *  - :71 a buyer edit entry carrying `pieces` is SA-1161's coded 400, through the real service;
 *  - :72 (K6) a fold with no stored line and no live pack: is a line of qty 24 present?
 */
import { mergeIntoStoredLine } from "./stored-line-merge";
import { foldMergeItems } from "./merge-items";
import { buildOrdersService, customerPayload } from "./testing/orders-service-harness";

describe("B729 K4: the fold of a split onto a stored snapshot-12 line", () => {
  const line = { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 };

  it("{qty 24, boxes 2} folds to 36 (the stale-cart shape still works)", () => {
    const r = mergeIntoStoredLine({
      line,
      add: { qty: 24, boxes: 2, pieces: 0 },
      livePack: 0,
      bare: "sellingUnits",
      output: "keep",
    } as never);
    expect(r).toMatchObject({ ok: true, qty: 36 });
  });

  it("{qty 3, boxes 2} (the contradictory split) is what the buyer guard now stops: unguarded it adds 24", () => {
    const r = mergeIntoStoredLine({
      line,
      add: { qty: 3, boxes: 2, pieces: 0 },
      livePack: 0,
      bare: "sellingUnits",
      output: "keep",
    } as never);
    expect(r).toMatchObject({ ok: true, qty: 36 }); // 12 + 24: the F3 overbill the guard prevents
  });

  it("{qty 24, boxes 2} onto a snapshot-6 line is PACK_MISMATCH", () => {
    const r = mergeIntoStoredLine({
      line: { qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 },
      add: { qty: 24, boxes: 2, pieces: 0 },
      livePack: 0,
      bare: "sellingUnits",
      output: "keep",
    } as never);
    expect(r).toMatchObject({ ok: false, reason: "PACK_MISMATCH" });
  });
});

describe("B729 K6: a self-consistent split with no stored line and no live pack", () => {
  it("keeps a line of qty 24 (observed: not dropped)", () => {
    const out = foldMergeItems([], [{ productId: "plain", qty: 24, boxes: 2, pieces: 0 }], {
      liveUnitsPerBoxByProductId: new Map([["plain", 0]]),
    } as never);
    const total = out.items
      .filter((i) => i.productId === "plain")
      .reduce((n, i) => n + Number(i.qty ?? 0), 0);
    expect(total).toBe(24);
  });
});

describe("B729 K4 :71: a buyer edit entry with pieces is SA-1161's coded 400 (real service)", () => {
  it("refuses {pieces: 3} before any read-for-write or write", async () => {
    const h = await buildOrdersService();
    (h.prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: "ord-1",
      customerId: "c1",
      status: "PENDING",
      lineItems: [],
    });
    (h.prisma.forTenant().customer.findFirst as jest.Mock).mockResolvedValue({ id: "c1" });
    await expect(
      h.service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "plain", orderItemId: "li-1", qty: 3, pieces: 3 }] } as never,
        customerPayload as never,
        { buyerLineIds: true },
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: "BUYER_EDIT_INPUT_NOT_ALLOWED" },
    });
    expect(h.prisma.orderItem.createMany).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });
});
