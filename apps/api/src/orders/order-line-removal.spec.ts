import { NotFoundException } from "@nestjs/common";
import { writeLineRemoval } from "./order-line-removal";

/**
 * #2563 (SA-507b): a per-line diff removal writes only a line of the order being edited —
 * `{ id, orderId }`, never a bare id — and a miss is a 404 (thrown inside the edit's tx).
 */
describe("writeLineRemoval (#2563)", () => {
  const tx = (count: number) => ({
    orderItem: {
      updateMany: jest.fn().mockResolvedValue({ count }),
      deleteMany: jest.fn().mockResolvedValue({ count }),
    },
  });

  it("a strike-off zeroes the line, scoped to this order", async () => {
    const db = tx(1);
    await writeLineRemoval(db, "ord-1", "li-1", "strike-off");
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: "li-1", orderId: "ord-1" },
      data: {
        status: "CANCELLED",
        qty: 0,
        subtotal: 0,
        boxes: null,
        pieces: null,
        promoFreeUnits: null,
      },
    });
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it("a hard delete is scoped to this order", async () => {
    const db = tx(1);
    await writeLineRemoval(db, "ord-1", "li-1", "delete");
    expect(db.orderItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "li-1", orderId: "ord-1" },
    });
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it.each(["strike-off", "delete"] as const)(
    "%s of a line id NOT on this order is a 404",
    async (mode) => {
      await expect(writeLineRemoval(tx(0), "ord-1", "li-foreign", mode)).rejects.toThrow(
        NotFoundException,
      );
    },
  );
});
