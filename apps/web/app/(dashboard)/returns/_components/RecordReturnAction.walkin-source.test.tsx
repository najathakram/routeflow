import * as React from "react";
import { render } from "@testing-library/react";
import { RecordReturnAction } from "./RecordReturnAction";

/**
 * SA-740 (row 190): "Record return" on a WALK-IN's order must send that order as the return's source sale
 * (the server refuses a walk-in quote without one). A named customer's order never pins: their return may
 * spill across orders. The walk-in flag is read from the order the page already has cached.
 */
let orderData: { id: string; customer?: { isWalkIn?: boolean | null } } | undefined;
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true }));
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: orderData }) }));
const dialogProps = jest.fn();
jest.mock("./RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: Record<string, unknown>) => {
    dialogProps(p);
    return null;
  },
}));

beforeEach(() => jest.clearAllMocks());

describe("RecordReturnAction — SA-740 walk-in source sale", () => {
  it("a walk-in's order is sent as the source sale", () => {
    orderData = { id: "o1", customer: { isWalkIn: true } };
    render(<RecordReturnAction customerId="c1" orderId="o1" allowRefund />);
    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderId: "o1", sourceOrderId: "o1" }),
    );
  });

  it.each([
    ["a named customer's order", { id: "o1", customer: { isWalkIn: false } }],
    ["an order whose customer is not loaded", { id: "o1" }],
    ["an order not loaded yet", undefined],
  ])("%s sends no source sale", (_label, data) => {
    orderData = data;
    render(<RecordReturnAction customerId="c1" orderId="o1" allowRefund />);
    expect(dialogProps.mock.calls.at(-1)?.[0]).not.toHaveProperty("sourceOrderId", "o1");
  });

  it("the customer-detail entry (no order) sends none", () => {
    orderData = undefined;
    render(<RecordReturnAction customerId="c1" />);
    expect(dialogProps.mock.calls.at(-1)?.[0].sourceOrderId).toBeUndefined();
  });
});
