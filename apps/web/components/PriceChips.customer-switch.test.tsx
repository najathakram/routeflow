import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { PriceChips } from "./PriceHistory";
import type { PriceHistoryResponse } from "@/lib/api/price-history";

/**
 * Money: after "Change customer" in the order builder (lines kept) the chips must NEVER show the previous
 * customer's prices: tapping one would put A's price on B's order. The shared history hook must not carry
 * placeholder data across a key change, even while the new customer's query is disabled or pending.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const historyFor = (customerId: string, price: number): PriceHistoryResponse => ({
  customerId,
  customerName: customerId,
  productId: "p1",
  productName: "Cola",
  costVisible: false,
  references: { listPrice: null, tierPrice: null, changeSinceLast: null },
  rows: [
    {
      date: "2026-09-20T00:00:00.000Z",
      source: "INVOICE",
      unitPrice: price,
      unitLabel: "case",
      unitsPerBox: 24,
      qty: 1,
      boxes: 1,
      pieces: 0,
      avgCostAtSale: null,
      invoiceId: "i",
      invoiceNumber: "I-1",
      orderId: "o",
      orderNumber: "O-1",
      priceType: null,
    },
  ],
  summaries: [
    { unitLabel: "case", last: price, low: price, high: price, qtySold: 1, currentAvgCost: null },
  ],
});

const tree = (customerId: string | null, qc: QueryClient) => (
  <QueryClientProvider client={qc}>
    <PriceChips customerId={customerId} productId="p1" unitHint="case" onUsePrice={jest.fn()} />
  </QueryClientProvider>
);

describe("PriceChips across a customer change", () => {
  it("customer A's chips are gone the moment the customer changes (new query pending or disabled)", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes("/customers/A/")
        ? Promise.resolve({ data: historyFor("A", 18.75) })
        : new Promise(() => undefined),
    ); // customer B's request never settles
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(tree("A", qc));
    expect(
      await screen.findByRole("button", { name: /Use last price \$18\.75/ }),
    ).toBeInTheDocument();

    rerender(tree("B", qc)); // B: pending, no data
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Use last price/ })).not.toBeInTheDocument(),
    );

    rerender(tree(null, qc)); // no customer chosen: disabled
    expect(screen.queryByRole("button", { name: /Use last price/ })).not.toBeInTheDocument();
  });
});
