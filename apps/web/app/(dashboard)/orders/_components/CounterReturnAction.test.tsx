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
let recorded: ((r?: unknown, info?: unknown) => void) | undefined;
jest.mock("@/app/(dashboard)/returns/_components/RecordInlineReturnDialog", () => ({
  RecordInlineReturnDialog: (p: Record<string, unknown>) => {
    dialogProps(p);
    recorded = p.onRecorded as typeof recorded;
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
  it("SA-740: pins the return to THIS sale (sourceOrderId = the sale's order) so a walk-in never matches another receipt", () => {
    render(<CounterReturnAction orderId="o1" />);
    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderId: "o1", sourceOrderId: "o1" }),
    );
  });
  it("passes allowRefund to the dialog and styles the button full-width on a phone", () => {
    render(<CounterReturnAction orderId="o1" />);
    expect(dialogProps).toHaveBeenLastCalledWith(expect.objectContaining({ allowRefund: true }));
    expect(screen.getByRole("button", { name: "Return items" }).className).toMatch(
      /w-full sm:w-auto/,
    );
  });
  it("store credit: names the amount and the customer, and never says to hand money back", () => {
    orderState = { data: { id: "o1", customerId: "c1", customer: { businessName: "Acme Deli" } } };
    const { container } = render(<CounterReturnAction orderId="o1" />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.({}, { resolution: "STORE_CREDIT", amount: 12.4 }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Store credit of $12.40 added to Acme Deli.",
    );
    expect(screen.getByRole("status").textContent).not.toMatch(
      /hand|cash|back to the customer|card/i,
    );
    expect(container.textContent).not.toMatch(/void/i);
  });
  it("store credit with no amount or name still never says to hand money back", () => {
    orderState = { data: { id: "o1", customerId: "c1" } };
    render(<CounterReturnAction orderId="o1" />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.({}, undefined));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Store credit added to the customer's account.",
    );
    expect(screen.getByRole("status").textContent).not.toMatch(/hand|cash|back to the customer/i);
  });
  it("cash refund: repeats the hand-back line", () => {
    render(<CounterReturnAction orderId="o1" />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.({}, { resolution: "REFUND", tender: "CASH", amount: 12.4 }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Hand $12.40 back to the customer.",
    );
  });
  it("W21b: a whole-sale return keeps its success line when the row flips to fully returned", () => {
    const { rerender } = render(<CounterReturnAction orderId="o1" canReturn />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.({}, { resolution: "REFUND", tender: "CASH", amount: 12.4 }));
    // the refetch marks the sale FULL: the component must stay mounted with its success line
    rerender(<CounterReturnAction orderId="o1" canReturn={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Hand $12.40 back to the customer.",
    );
    expect(screen.getByRole("button", { name: "Return items" })).toBeInTheDocument();
  });
  it("W21b: once the dialog closes on a fully returned sale, the button goes but the success line stays", () => {
    const { rerender } = render(<CounterReturnAction orderId="o1" canReturn />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.({}, { resolution: "REFUND", tender: "CASH", amount: 12.4 }));
    rerender(<CounterReturnAction orderId="o1" canReturn={false} />);
    const onClose = dialogProps.mock.calls.at(-1)?.[0].onClose as () => void;
    React.act(() => onClose());
    expect(screen.queryByRole("button", { name: "Return items" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Hand $12.40 back to the customer.",
    );
  });
  it("W21b: a sale that is already fully returned offers no Return items button", () => {
    render(<CounterReturnAction orderId="o1" canReturn={false} />);
    expect(screen.queryByRole("button", { name: "Return items" })).toBeNull();
  });
  it("card refund: repeats the card line", () => {
    render(<CounterReturnAction orderId="o1" />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() => recorded?.({}, { resolution: "REFUND", tender: "CARD", amount: 12.4 }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return recorded. Give $12.40 back on the customer's card at the terminal.",
    );
  });
  it("a saved return with the refund still pending says so and never says to hand money over", () => {
    orderState = { data: { id: "o1", customerId: "c1", customer: { businessName: "Acme Deli" } } };
    render(<CounterReturnAction orderId="o1" />);
    fireEvent.click(screen.getByRole("button", { name: "Return items" }));
    React.act(() =>
      recorded?.({}, { resolution: "REFUND", tender: "CASH", amount: 12.4, pending: true }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Return — refund pending, nothing paid out",
    );
    expect(screen.getByRole("status").textContent).not.toMatch(/\$/);
    expect(screen.getByRole("status").textContent).not.toMatch(/^Return recorded/);
  });
  it("W21b: Done returns focus to the Return items button, not body", () => {
    render(<CounterReturnAction orderId="o1" />);
    const btn = screen.getByRole("button", { name: "Return items" });
    fireEvent.click(btn);
    const evt = new Event("focus", { cancelable: true });
    const onCloseAutoFocus = dialogProps.mock.calls.at(-1)?.[0].onCloseAutoFocus as (
      e: Event,
    ) => void;
    document.body.focus();
    React.act(() => onCloseAutoFocus(evt));
    expect(evt.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn);
  });
});
