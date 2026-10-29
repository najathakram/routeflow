import { readFileSync } from "fs";
import { join } from "path";
import { attachOrderToCollect } from "./order-to-collect";

/**
 * SA-1026 Part A: the staff order detail's `toCollect`, rolled up from the order's invoices through the one rule in
 * invoices/to-collect.ts. Staff only, failing closed: a buyer, customer, driver or buyer pseudo-user gets NO field and NO
 * query. Advisory: a failing read leaves the field out and never fails the order read.
 */
const db = (rows: { status: string; expectedPaymentMethod: string | null }[]) => ({
  invoice: { findMany: jest.fn().mockResolvedValue(rows) },
});
const order = () =>
  ({ id: "o1", tenantId: "t1" }) as { id: string; tenantId: string; toCollect?: string };
const staff = { role: "OPERATOR", type: "STAFF" } as never;

describe("attachOrderToCollect", () => {
  it("an open invoice with an intent reads TO_COLLECT", async () => {
    const d = db([{ status: "SENT", expectedPaymentMethod: "CHECK" }]);
    const o = order();
    await attachOrderToCollect(d as never, o, staff);
    expect(o.toCollect).toBe("TO_COLLECT");
    expect(d.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: "o1", expectedPaymentMethod: { not: null } } }),
    );
  });

  it("a settled invoice with an intent reads NONE; no intent at all reads NONE", async () => {
    const paid = order();
    await attachOrderToCollect(
      db([{ status: "PAID", expectedPaymentMethod: "CHECK" }]) as never,
      paid,
      staff,
    );
    expect(paid.toCollect).toBe("NONE");
    const none = order();
    await attachOrderToCollect(db([]) as never, none, staff);
    expect(none.toCollect).toBe("NONE");
  });

  it("a DRAFT with an intent reads UNKNOWN (shown, never hidden)", async () => {
    const o = order();
    await attachOrderToCollect(
      db([{ status: "DRAFT", expectedPaymentMethod: "CHECK" }]) as never,
      o,
      staff,
    );
    expect(o.toCollect).toBe("UNKNOWN");
  });

  it.each([
    ["a customer", { role: "CUSTOMER" }],
    ["a driver", { role: "DRIVER" }],
    ["a buyer pseudo-user wearing OPERATOR", { role: "OPERATOR", type: "BUYER" }],
  ])("%s gets no field and no query", async (_n, user) => {
    const d = db([{ status: "SENT", expectedPaymentMethod: "CHECK" }]);
    const o = order();
    await attachOrderToCollect(d as never, o, user as never);
    expect("toCollect" in o).toBe(false);
    expect(d.invoice.findMany).not.toHaveBeenCalled();
  });

  it("a failing read leaves the field out and does not throw", async () => {
    const d = { invoice: { findMany: jest.fn().mockRejectedValue(new Error("boom")) } };
    const o = order();
    await expect(attachOrderToCollect(d as never, o, staff)).resolves.toBeUndefined();
    expect("toCollect" in o).toBe(false);
  });
});

describe("the order detail wires it", () => {
  it("orders.service.ts findOne calls attachOrderToCollect and does not select the intent into the buyer-visible include", () => {
    const text = readFileSync(join(__dirname, "orders.service.ts"), "utf8");
    expect(text).toMatch(/attachOrderToCollect\(this\.prisma\.forTenant\(\), order, user\)/);
    expect(readFileSync(join(__dirname, "order-payment-credit-notes.ts"), "utf8")).not.toMatch(
      /expectedPaymentMethod/,
    );
  });
});
