import { OrderStatus, UserRole } from "@prisma/client";
import { BUYER_EDIT_CLOSED_REASONS } from "@routeflow/types";
import { BUYER_EDIT_CLOSED_STATUSES, buyerEditClosed, computeEditWindow } from "./edit-window";
import { REFUSED_ORDER_MESSAGE, buyerEditClosedMessage } from "./order-carrier-guard";

/** W-1189: a REFUSED order is closed to the buyer, and says so in its own words. */
describe("buyer edit window and REFUSED (W-1189)", () => {
  it("REFUSED is in the closed list, beside the dispatched statuses", () => {
    expect([...BUYER_EDIT_CLOSED_STATUSES].sort()).toEqual(
      [
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.PARTIALLY_DELIVERED,
        OrderStatus.DELIVERED,
        OrderStatus.REFUSED,
      ].sort(),
    );
  });

  it("a buyer's REFUSED order is not editable and is closed by STATUS, not by dispatch", () => {
    expect(computeEditWindow({ status: "REFUSED" }, UserRole.CUSTOMER, [])).toEqual({
      editable: false,
      editableUntil: null,
      closedReason: "STATUS",
    });
  });

  it("a dispatched order is still closed by DISPATCHED for a buyer", () => {
    expect(
      computeEditWindow({ status: "OUT_FOR_DELIVERY" }, UserRole.CUSTOMER, []).closedReason,
    ).toBe("DISPATCHED");
  });

  it("staff keep editing a REFUSED order", () => {
    expect(computeEditWindow({ status: "REFUSED" }, UserRole.OPERATOR, []).editable).toBe(true);
    expect(computeEditWindow({ status: "REFUSED" }, undefined, []).editable).toBe(true);
  });

  it("the buyer-facing sentence for REFUSED is the refused one, and needs no lookup", async () => {
    const service = {} as never;
    expect(await buyerEditClosedMessage(service, { status: "REFUSED" } as never)).toBe(
      REFUSED_ORDER_MESSAGE,
    );
    expect(REFUSED_ORDER_MESSAGE).toMatch(/refused/i);
  });
});

/**
 * SA-1544 P-5 (REG-B63 extended): the buyer window is closed while the order holds a live delivered line, by ONE predicate
 * read by the write gate and the descriptor; a reopened order holding none stays buyer-editable (master).
 */
describe("buyer edit window and a reopened order that holds delivered goods (SA-1544 P-5)", () => {
  const delivered = [{ status: "PENDING", deliveredQty: 4 }];

  it("the predicate: closed for a delivered line on a CONFIRMED order, open with none, open when the delivered line is cancelled", () => {
    expect(buyerEditClosed({ status: "CONFIRMED" }, delivered)).toBe(true);
    expect(buyerEditClosed({ status: "CONFIRMED" }, [{ status: "PENDING", deliveredQty: 0 }])).toBe(
      false,
    );
    expect(
      buyerEditClosed({ status: "CONFIRMED" }, [{ status: "CANCELLED", deliveredQty: 4 }]),
    ).toBe(false);
    expect(buyerEditClosed({ status: "CONFIRMED" }, undefined)).toBe(false);
    expect(buyerEditClosed({ status: "DELIVERED" }, [])).toBe(true); // the status list still closes by itself
  });

  it("the descriptor says not editable for that buyer, closed by DELIVERED_LINES (never STATUS = 'cancelled', never dispatch); staff stay open", () => {
    expect(computeEditWindow({ status: "CONFIRMED" }, UserRole.CUSTOMER, delivered)).toEqual({
      editable: false,
      editableUntil: null,
      closedReason: "DELIVERED_LINES", // SA-1546 10.3; wrong value: "STATUS" (the chip reads it as "Order cancelled")
    });
    // the kept reasons: REFUSED is STATUS (W-1189), a dispatched status is DISPATCHED
    expect(
      computeEditWindow({ status: "REFUSED" }, UserRole.CUSTOMER, delivered).closedReason,
    ).toBe("STATUS");
    expect(
      computeEditWindow({ status: "OUT_FOR_DELIVERY" }, UserRole.CUSTOMER, delivered).closedReason,
    ).toBe("DISPATCHED");
    expect(computeEditWindow({ status: "CONFIRMED" }, UserRole.CUSTOMER, []).editable).toBe(true);
    expect(computeEditWindow({ status: "CONFIRMED" }, UserRole.OPERATOR, delivered).editable).toBe(
      true,
    );
    expect(
      computeEditWindow({ status: "CONFIRMED" }, UserRole.TENANT_ADMIN, delivered).editable,
    ).toBe(true);
  });

  it("SA-1546 10.3: the shared wire union has the three reasons, and every reason the server returns is in it", () => {
    expect([...BUYER_EDIT_CLOSED_REASONS]).toEqual(["DISPATCHED", "STATUS", "DELIVERED_LINES"]);
    const seen = [
      computeEditWindow({ status: "CONFIRMED" }, UserRole.CUSTOMER, delivered).closedReason,
      computeEditWindow({ status: "OUT_FOR_DELIVERY" }, UserRole.CUSTOMER, []).closedReason,
      computeEditWindow({ status: "REFUSED" }, UserRole.CUSTOMER, []).closedReason,
      computeEditWindow({ status: "CANCELLED" }, UserRole.CUSTOMER, []).closedReason,
    ];
    for (const r of seen) expect(BUYER_EDIT_CLOSED_REASONS).toContain(r);
  });

  it("the buyer-facing sentence does not say 'out for delivery' on a CONFIRMED order, and still names a change request", async () => {
    const service = { featureConfig: { get: async () => null }, prisma: {} } as never;
    const message = await buyerEditClosedMessage(service, {
      status: "CONFIRMED",
      tenantId: "t",
      lineItems: delivered,
    } as never);
    expect(message).not.toMatch(/out for delivery/i); // wrong value: the dispatched sentence
    expect(message).toMatch(/change request/i);
  });

  it("an order that really is out for delivery keeps its own sentence", async () => {
    const service = { featureConfig: { get: async () => null }, prisma: {} } as never;
    const message = await buyerEditClosedMessage(service, {
      status: "OUT_FOR_DELIVERY",
      tenantId: "t",
      lineItems: delivered,
    } as never);
    expect(message).toMatch(/out for delivery/i);
  });
});
