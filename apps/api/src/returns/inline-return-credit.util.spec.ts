import { sumInlineReturnCredit } from "./inline-return-credit.util";

describe("sumInlineReturnCredit (design.md §4 N-5)", () => {
  it("sums creditSubtotal+creditTax+creditCategoryTax across RECEIVED/REFUNDED INLINE returns", async () => {
    const tx = {
      return: {
        findMany: jest.fn().mockResolvedValue([
          { creditSubtotal: 28, creditTax: 2, creditCategoryTax: 0 }, // RECEIVED, no CN yet — HIGH-1 gap
          { creditSubtotal: 10, creditTax: 0, creditCategoryTax: 2.5 }, // REFUNDED (issued)
        ]),
      },
    };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(42.5);
    expect(tx.return.findMany).toHaveBeenCalledWith({
      where: { orderId: "ord-1", kind: "INLINE", status: { in: ["RECEIVED", "REFUNDED"] } },
      select: { creditSubtotal: true, creditTax: true, creditCategoryTax: true },
    });
  });

  it("HIGH-1: counts a RECEIVED row's committed credit even before refundAmount/heldAmount is ever set (the capture→issue gap)", async () => {
    // Exactly what capture() writes on the SAME create as a DRIVER_CAP hold or a plain
    // (not-yet-issued) RECEIVED row: creditSubtotal/Tax/CategoryTax populated,
    // refundAmount/heldAmount still null.
    const tx = {
      return: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ creditSubtotal: 20, creditTax: 0, creditCategoryTax: 0 }]),
      },
    };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(20);
  });

  it("is 0 when the order has no inline returns at all", async () => {
    const tx = { return: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(0);
  });

  it("excludes PENDING (not yet captured), REJECTED (declined), and CANCELLED rows", async () => {
    const tx = {
      return: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => {
          // The query itself scopes to RECEIVED/REFUNDED — assert the where-shape excludes
          // the other three statuses by construction rather than by a JS-side filter.
          expect(where.status).toEqual({ in: ["RECEIVED", "REFUNDED"] });
          return [];
        }),
      },
    };
    await expect(sumInlineReturnCredit(tx, "ord-1")).resolves.toBe(0);
  });
});
