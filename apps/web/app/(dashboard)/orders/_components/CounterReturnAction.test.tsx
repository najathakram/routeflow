import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterReturnAction } from "./CounterReturnAction";

/**
 * POS-4: the counter-sale receipt's "Return items" entry point. It reuses the order-detail
 * "Record return" gates (orders_inline_returns add-on + orderActionAccess staff roles) and opens the
 * existing RecordInlineReturnDialog for the sale's own order. No void exists, so none is offered.
 */
let addon = true;
let role: string | undefined = "OPERATOR";
let orderState: { data?: { id: string; customerId: string; customer?: { businessName: string } } } =
  {};
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => addon }));
jest.mock("@/lib/api/orders", () => ({ useOrder: () => orderState }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role } : null }),
}));

const dialogProps = jest.fn();
let recorded: (() => void) | undefined;
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: Record<string, unknown>) => {
    dialogProps(p);
    recorded = p.onRecorded as () => void;
    return p.open ? <div data-testid="dialog-open" /> : null;
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  addon = true;
  role = "OPERATOR";
  orderState = { data: { id: "o1", customerId: "c1", customer: { businessName: "Walk-in" } } };
});

describe("CounterReturnAction", () => {
  it("is hidden without the add-on", () => {
    addon = false;
    const { container } = render(<CounterReturnAction orderId="o1" />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each(["CUSTOMER", "DRIVER", undefined])("is hidden for role %s", (r) => {
    role = r;
    const { container } = render(<CounterReturnAction orderId="o1" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("is hidden while the order is not loaded", () => {
    orderState = {};
    const { container } = render(<CounterReturnAction orderId="o1" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("is visible when add-on, staff role and order all hold, with no Void anywhere", () => {
    const { container } = render(<CounterReturnAction orderId="o1" />);
    expect(screen.getByRole("button", { name: "Return items" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/void/i);
  });
  it("opens the existing dialog for that sale's order", () => {
    render(<CounterReturnAction orderId="o1" />);
    expect(screen.queryByTestId("dialog-open")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    expect(screen.getByTestId("dialog-open")).toBeInTheDocument();
    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, orderId: "o1", customerId: "c1" }),
    );
  });
  it("after a recorded return, tells the clerk to hand the refund back themselves", () => {
    const { container } = render(<CounterReturnAction orderId="o1" />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Stock is back and a credit note was issued. Hand the refund to the customer yourself.",
    );
    expect(container.textContent).not.toMatch(/void/i);
  });
});
