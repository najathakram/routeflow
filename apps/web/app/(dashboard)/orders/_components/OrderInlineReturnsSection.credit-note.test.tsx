import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { OrderInlineReturnsSection } from "./OrderInlineReturnsSection";
import type { InlineReturnQuoteResponse } from "@routeflow/types";

// W-712 (SA-929): on the order create/edit host the inline return's credit is held for its OWN
// carrying order first, so the quote note must never promise "the next order".
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true }));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({ data: undefined }),
}));
const PRODUCT = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [PRODUCT] } }) }));
const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));

const QUOTE: InlineReturnQuoteResponse = {
  chunks: [
    {
      sourceOrderId: "o-1",
      sourceInvoiceItemId: "ii-1",
      sourceOrderItemId: "oi-1",
      productId: "prod-1",
      pieces: 5,
      subtotal: 11.2,
      taxAmount: 1.2,
      categoryTax: 0,
      priceSource: "SOURCE_INVOICE",
      unitPrice: 2.24,
    },
  ],
  subtotal: 11.2,
  taxAmount: 1.2,
  categoryTax: 0,
  total: 12.4,
  productBreakdown: {},
  canRefund: false,
  paidInFull: false,
  paidMethods: [],
  paidWithStoreCredit: false,
  customerIsWalkIn: false,
};

it("order create/edit: the credit note says the credit goes toward this order, not the next one", async () => {
  renderWithProviders(<OrderInlineReturnsSection customerId="cust-1" />);
  fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByText("Widget"));
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
  act(() => quoteMutate.mock.calls[0][1].onSuccess(QUOTE));
  expect(
    await screen.findByText(
      "$12.40 is added as store credit for the customer and goes toward this order when you save.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/next order/i)).toBeNull();
});
