import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { SalesHistoryCard } from "./SalesHistoryCard";

/**
 * SA-1077 (W-1093): the product page's sales card strikes the list price only on a line sold BELOW it. A line sold above its
 * list (a tier above Retail, or a staff upsell) never shows the lower list price: `isAboveListLine` is the one rule.
 */
const line = (
  id: string,
  unitPrice: number,
  originalPrice: number | null,
  overridden: boolean,
) => ({
  date: "2026-01-05",
  invoiceId: `inv-${id}`,
  invoiceNumber: `INV-${id}`,
  orderId: null,
  orderNumber: null,
  customerId: `c-${id}`,
  customerName: `Buyer ${id}`,
  qty: 1,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice,
  lineTotal: unitPrice,
  originalPrice,
  overridden,
});

jest.mock("@/lib/api/product-sales", () => ({
  useProductSales: () => ({
    data: {
      lines: [
        line("above", 12, 10, true),
        line("below", 8, 10, true),
        line("upsell", 15, 10, true),
        line("plain", 10, null, false),
      ],
      summary: {
        count: 4,
        buyers: 4,
        totalQty: 4,
        totalRevenue: 45,
        minPrice: 8,
        avgPrice: 11.25,
        maxPrice: 15,
      },
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

function renderCard() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SalesHistoryCard productId="p1" />
    </QueryClientProvider>,
  );
}

describe("SalesHistoryCard: the list price strikes only below list (SA-1077)", () => {
  it("a SPECIAL tier line at 12 on a list of 10 shows $12.00 and no struck $10.00", () => {
    renderCard();
    const row = rowOf("Buyer above");
    expect(within(row).queryByText("$10.00")).toBeNull();
    expect(row.querySelector(".strike")).toBeNull();
    expect(within(row).getAllByText("$12.00").length).toBeGreaterThan(0);
  });

  it("a staff upsell at 15 on a list of 10 never strikes the list either", () => {
    renderCard();
    expect(rowOf("Buyer upsell").querySelector(".strike")).toBeNull();
  });

  it("guard: a line at 8 on a list of 10 still strikes the $10.00", () => {
    renderCard();
    const struck = rowOf("Buyer below").querySelector(".strike");
    expect(struck).toHaveTextContent("$10.00");
  });

  it("guard: a plain line has no strike", () => {
    renderCard();
    expect(rowOf("Buyer plain").querySelector(".strike")).toBeNull();
  });
});
