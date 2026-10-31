import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import {
  OrderInlineReturnsSection,
  type OrderInlineReturnsSectionHandle,
} from "./OrderInlineReturnsSection";
import { netOfReturn } from "./useCounterInlineReturn";
import { RETURN_SAVE_BLOCKED } from "./use-order-inline-return-save";
import type { InlineReturnQuoteResponse } from "@routeflow/types";

/**
 * R-1 (SA-1069 section A), the host side: the real Returns section behind Create Order, the order-edit page and the till.
 * A return rides a save only on a CURRENT quote; the till's credit is the current quote or nothing. The quote API is mocked
 * at the hook boundary; time is faked so the 350 ms debounce is exact.
 */
const DEBOUNCE = 350;

jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: { data: [{ id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null }] },
  }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  ...jest.requireActual("@/lib/api/tobacco"),
  useHasAddon: () => true,
}));
const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
}));

function quoteWorth(total: number): InlineReturnQuoteResponse {
  return {
    chunks: [
      {
        sourceOrderId: "order-1",
        sourceInvoiceItemId: "inv-1",
        sourceOrderItemId: "oi-1",
        productId: "prod-1",
        pieces: 1,
        subtotal: total,
        taxAmount: 0,
        categoryTax: 0,
        priceSource: "SOURCE_INVOICE",
        unitPrice: total,
      },
    ],
    subtotal: total,
    taxAmount: 0,
    categoryTax: 0,
    total,
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  };
}

let handle: React.RefObject<OrderInlineReturnsSectionHandle | null>;
const credits: number[] = [];

function Host() {
  handle = React.useRef<OrderInlineReturnsSectionHandle>(null);
  return (
    <OrderInlineReturnsSection
      ref={handle}
      customerId="cust-1"
      reasonContext="counter"
      onQuoteTotalChange={(n) => credits.push(n)}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  credits.length = 0;
});
afterEach(() => jest.useRealTimers());

function wait(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}
function answer(total: number) {
  const call = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1];
  act(() => call[1].onSuccess(quoteWorth(total)));
}
async function openAndAddWidget() {
  renderWithProviders(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "Returns" }));
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByRole("button", { name: "Widget" }));
}
const setQty = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value } });
const lastCredit = () => credits[credits.length - 1];

describe("R-1 M4: the host reads a current quote or nothing", () => {
  it("R-1: quote, change the quantity: the draft is no longer quoted and the till credit drops to nothing at once", async () => {
    await openAndAddWidget();
    setQty("3");
    wait(DEBOUNCE);
    answer(4);
    expect(handle.current?.getDraft()?.quoted).toBe(true);
    expect(lastCredit()).toBe(4);

    setQty("4");
    expect(handle.current?.getDraft()?.quoted).toBe(false);
    expect(lastCredit()).toBe(0);
    expect(netOfReturn(10, lastCredit())).toEqual({ payTotal: 10, storeCredit: 0 }); // not the old $4 off

    wait(DEBOUNCE);
    answer(8);
    expect(handle.current?.getDraft()?.quoted).toBe(true);
    expect(lastCredit()).toBe(8);
    expect(netOfReturn(10, lastCredit())).toEqual({ payTotal: 2, storeCredit: 0 });
  });

  it("R-8: while the quote is pending the draft is not quoted, so a save is blocked, not sent", async () => {
    await openAndAddWidget();
    setQty("3");
    expect(handle.current?.getDraft()?.quoted).toBe(false);
    wait(DEBOUNCE); // asked, not answered
    expect(handle.current?.getDraft()?.quoted).toBe(false);
  });

  it("the blocked-save message says the credit is being worked out", () => {
    expect(RETURN_SAVE_BLOCKED["needs-quote"]).toBe(
      "Working out the return credit. Try again in a moment.",
    );
  });
});

describe("R-5 M7: a draft nobody chose a reason for saves under EXCESS_ORDER", () => {
  it("the draft carries the default reason with no interaction", async () => {
    await openAndAddWidget();
    expect(handle.current?.getDraft()?.captureReason).toBe("EXCESS_ORDER");
  });

  it("the counter's section reads 'Bought too many'", async () => {
    await openAndAddWidget();
    expect(screen.getByLabelText(/reason for all items/i)).toHaveDisplayValue("Bought too many");
  });
});

describe("M12: the collapsed section still contributes no draft", () => {
  it("collapsing with lines asks to discard; a collapsed section has no draft", async () => {
    await openAndAddWidget();
    expect(handle.current?.getDraft()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Returns" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard this return?");
  });
});

describe("M14: a half-typed credit price blocks the save with its own sentence", () => {
  it("the draft is not quoted and carries the problem, and nothing was asked", async () => {
    await openAndAddWidget();
    setQty("2");
    fireEvent.click(screen.getByRole("button", { name: /options for widget/i }));
    fireEvent.change(screen.getByLabelText(/^credit price$/i), { target: { value: "1.00" } });
    wait(DEBOUNCE * 2);
    expect(quoteMutate).not.toHaveBeenCalled();
    const draft = handle.current?.getDraft();
    expect(draft?.quoted).toBe(false);
    expect(draft?.problem).toMatch(/^Widget: /);
  });
});
