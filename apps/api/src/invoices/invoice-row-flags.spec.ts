import { listRowFlags } from "./invoice-row-flags";

/** SA-1026: the one row-flag helper the invoice list and detail share (paidAtSale + the derived toCollect state). */
describe("listRowFlags", () => {
  it("carries paidAtSale and the derived toCollect state from the stored row", () => {
    const row = {
      status: "SENT",
      expectedPaymentMethod: "CHECK",
      total: 10,
      order: { counterSale: false },
    };
    expect(listRowFlags(row as never)).toMatchObject({
      toCollect: "TO_COLLECT",
      paidAtSale: false,
    });
    expect(listRowFlags({ ...row, expectedPaymentMethod: null } as never).toCollect).toBe("NONE");
    expect(listRowFlags({ ...row, status: "PAID" } as never).toCollect).toBe("NONE");
  });
});
