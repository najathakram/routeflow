import { sumInlineReturnCredit } from "./inline-return-credit.util";

describe("sumInlineReturnCredit (design.md §4 N-5)", () => {
  it("sums refundAmount (issued) and heldAmount (driver-cap held) across non-cancelled INLINE returns", async () => {
    const tx = {
      return: {
        findMany: jest.fn().mockResolvedValue([
          { refundAmount: 30, heldAmount: null },
          { refundAmount: null, heldAmount: 12.5 },
        ]),
      },
    };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(42.5);
    expect(tx.return.findMany).toHaveBeenCalledWith({
      where: { orderId: "ord-1", kind: "INLINE", status: { not: "CANCELLED" } },
      select: { refundAmount: true, heldAmount: true },
    });
  });

  it("is 0 when the order has no inline returns at all", async () => {
    const tx = { return: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(0);
  });

  it("ignores a row whose credit has not settled to either field yet (still PENDING/capturing)", async () => {
    const tx = {
      return: { findMany: jest.fn().mockResolvedValue([{ refundAmount: null, heldAmount: null }]) },
    };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(0);
  });
});
