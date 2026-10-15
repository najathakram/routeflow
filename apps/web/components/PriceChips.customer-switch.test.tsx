import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { PriceChips } from "./PriceHistory";
import { usePriceSummary, type PriceSummaryResponse } from "@/lib/api/price-history";

/**
 * Money: after "Change customer" in the order builder (lines kept) the chips must NEVER show the previous
 * customer's prices: tapping one would put A's price on B's order. The shared history hook must not carry
 * placeholder data across a key change, even while the new customer's query is disabled or pending.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const summaryFor = (price: number): PriceSummaryResponse => ({
  p1: {
    last3: [
      { date: "2026-09-20T00:00:00.000Z", unitPrice: price, unitLabel: "case", unitsPerBox: 24 },
    ],
    low: price,
    high: price,
    unitLabel: "case",
    unitsPerBox: 24,
  },
});

/** The order screen's wiring: the batched hook feeds the chip view. */
function Harness({ customerId }: { customerId: string | null }) {
  const { data } = usePriceSummary(customerId, ["p1"]);
  return <PriceChips entry={data?.p1} unitHint="case" onUsePrice={jest.fn()} />;
}

const tree = (customerId: string | null, qc: QueryClient) => (
  <QueryClientProvider client={qc}>
    <Harness customerId={customerId} />
  </QueryClientProvider>
);

describe("PriceChips across a customer change", () => {
  it("customer A's chips are gone the moment the customer changes (new query pending or disabled)", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes("/customers/A/price-summary")
        ? Promise.resolve({ data: summaryFor(18.75) })
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

  it("a failed batch request renders no chips at all", async () => {
    mockGet.mockImplementation(() => Promise.reject(new Error("boom")));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(tree("A", qc));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Use last price/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Recent prices")).not.toBeInTheDocument();
  });
});
