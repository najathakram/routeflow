import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { RecordReturnAction } from "./RecordReturnAction";

let hasAddon = true;
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => hasAddon }));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({ data: undefined }),
  useOrders: () => ({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } } }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: jest.fn(), isPending: false }),
  useCaptureInlineReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  hasAddon = true;
});

describe("RecordReturnAction", () => {
  it("renders nothing when the tenant lacks the orders_inline_returns add-on", () => {
    hasAddon = false;
    renderWithProviders(<RecordReturnAction customerId="cust-1" customerName="Acme Foods" />);
    expect(screen.queryByRole("button", { name: /record return/i })).not.toBeInTheDocument();
  });

  it("renders the button and opens the dialog when the add-on is granted", () => {
    renderWithProviders(<RecordReturnAction customerId="cust-1" customerName="Acme Foods" />);
    const button = screen.getByRole("button", { name: /record return/i });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.getByText(/what came back/i)).toBeInTheDocument();
  });
});
