import { OrderStatus, UserRole } from "@prisma/client";
import { BUYER_EDIT_CLOSED_STATUSES, computeEditWindow } from "./edit-window";
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
    expect(computeEditWindow({ status: "REFUSED" }, UserRole.CUSTOMER)).toEqual({
      editable: false,
      editableUntil: null,
      closedReason: "STATUS",
    });
  });

  it("a dispatched order is still closed by DISPATCHED for a buyer", () => {
    expect(computeEditWindow({ status: "OUT_FOR_DELIVERY" }, UserRole.CUSTOMER).closedReason).toBe(
      "DISPATCHED",
    );
  });

  it("staff keep editing a REFUSED order", () => {
    expect(computeEditWindow({ status: "REFUSED" }, UserRole.OPERATOR).editable).toBe(true);
    expect(computeEditWindow({ status: "REFUSED" }).editable).toBe(true);
  });

  it("the buyer-facing sentence for REFUSED is the refused one, and needs no lookup", async () => {
    const service = {} as never;
    expect(await buyerEditClosedMessage(service, { status: "REFUSED" } as never)).toBe(
      REFUSED_ORDER_MESSAGE,
    );
    expect(REFUSED_ORDER_MESSAGE).toMatch(/refused/i);
  });
});
