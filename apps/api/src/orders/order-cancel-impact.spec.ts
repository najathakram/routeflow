import { cancelImpact } from "./order-cancel-impact";

describe("cancelImpact (SA-133/B785: deliveredQty is a cumulative column, unchanged by the evidence-basis move)", () => {
  it("sums a two-visit line's RECOMPUTED cumulative deliveredQty (6 + 4 = 10), blocking the cancel", async () => {
    const prisma = {
      forTenant: () => ({
        order: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: "o1", status: "PARTIALLY_DELIVERED", orderNumber: "SO-1" }),
        },
        invoice: { findMany: jest.fn().mockResolvedValue([]) },
        orderItem: {
          // deliveredQty: 10 is what SA-133's recompute lands on after two visits (6 at one
          // stop, 4 at another) — this function must keep summing it exactly as before.
          findMany: jest.fn().mockResolvedValue([{ qty: 10, deliveredQty: 10 }]),
        },
      }),
    };
    const creditNotes = { previewOrderCreditRelease: jest.fn().mockResolvedValue([]) };

    const impact = await cancelImpact(
      { prisma: prisma as any, creditNotes: creditNotes as any },
      "o1",
    );

    expect(impact.deliveredUnits).toBe(10);
    expect(impact.canCancel).toBe(false); // goods have left the warehouse -- cancel refused
  });
});
