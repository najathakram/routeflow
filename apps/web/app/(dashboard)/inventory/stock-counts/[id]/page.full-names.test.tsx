import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import StockCountDetailPage from "./page";

/** SA-1216: a count line shows a family variant as "<Family> - <Variant>". */
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "sc1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/stock-count", () => ({
  ...jest.requireActual("@/lib/api/stock-count"),
  useStockCountSession: () => ({
    isLoading: false,
    data: {
      id: "sc1",
      name: "Acme count",
      status: "REVIEW",
      startedAt: "2026-09-05T15:00:00.000Z",
      startedBy: { username: "acme-op" },
      startedById: "u1",
      lines: [
        {
          id: "l1",
          productId: "v1",
          mode: "ABSOLUTE",
          countedQty: 3,
          expectedQty: 5,
          countedById: "u1",
          updatedAt: "2026-09-05T15:00:00.000Z",
          product: {
            id: "v1",
            name: "Blueberry",
            variantName: "Blueberry",
            parentProductId: "fam-1",
            parent: { name: "Acme Vape" },
            sku: "AV-1",
            unit: "each",
            averageCost: 2,
          },
        },
      ],
    },
  }),
}));

describe("Stock count detail: full names (SA-1216)", () => {
  it("a count line reads the family and the variant together", () => {
    renderWithProviders(<StockCountDetailPage />);
    expect(screen.getByRole("link", { name: "Acme Vape - Blueberry" })).toHaveAttribute(
      "href",
      "/products/v1",
    );
  });
});
