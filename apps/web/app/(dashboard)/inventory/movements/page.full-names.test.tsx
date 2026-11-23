import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import MovementsPage from "./page";

/** SA-1216: a movement row and the product filter show a family variant as "<Family> - <Variant>". */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/inventory/movements",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/hooks/useUrlPage", () => ({
  useUrlPage: () => [1, jest.fn()],
  useClampPage: jest.fn(),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: {
      data: [
        {
          id: "v1",
          name: "Blueberry",
          variantName: "Blueberry",
          parentProductId: "fam-1",
          parent: { name: "Acme Vape" },
        },
      ],
    },
  }),
}));
jest.mock("@/lib/api/inventory", () => ({
  useStockMovements: () => ({
    isLoading: false,
    data: {
      data: [
        {
          id: "m1",
          type: "PURCHASE",
          quantity: 10,
          createdAt: "2026-09-05T15:00:00.000Z",
          notes: null,
          reference: null,
          product: {
            id: "v1",
            name: "Blueberry",
            variantName: "Blueberry",
            parentProductId: "fam-1",
            parent: { name: "Acme Vape" },
            sku: "AV-1",
          },
        },
      ],
      meta: { total: 1, page: 1, limit: 50, totalPages: 1 },
    },
  }),
}));
jest.mock("./_components/MovementsExportButton", () => ({ MovementsExportButton: () => null }));

describe("Stock movements: full names (SA-1216)", () => {
  it("the row's product link and the product filter read the family and the variant", () => {
    renderWithProviders(<MovementsPage />);
    expect(screen.getByRole("link", { name: "Acme Vape - Blueberry" })).toHaveAttribute(
      "href",
      "/products/v1",
    );
    expect(screen.getByRole("option", { name: "Acme Vape - Blueberry" })).toBeInTheDocument();
  });
});
