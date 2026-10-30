import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import MovementsPage from "./page";

// SA-1049 R6 (L-072): MOVEMENT_TYPE_LABELS / _VARIANTS were hand-typed `Record<string, …>` and left out
// COST_BASIS (the audited row written when a product's average cost is set or corrected), so its row fell
// back to a generated label and a variant outside the map's own union, and the "All types" filter could
// not select it. Both maps are now keyed by every MovementType.
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
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [] } }) }));

jest.mock("@/lib/api/inventory", () => ({
  useStockMovements: () => ({
    isLoading: false,
    data: {
      data: [
        {
          id: "m1",
          type: "COST_BASIS",
          quantity: 0,
          createdAt: "2026-09-05T15:00:00.000Z",
          notes: null,
          reference: null,
          product: { id: "p1", name: "Acme Soda", sku: "SODA-1" },
        },
        {
          id: "m3",
          type: "FUTURE_KIND",
          quantity: 1,
          createdAt: "2026-09-05T15:00:00.000Z",
          notes: null,
          reference: null,
          product: { id: "p1", name: "Acme Soda", sku: "SODA-1" },
        },
        {
          id: "m2",
          type: "PURCHASE",
          quantity: 10,
          createdAt: "2026-09-05T15:00:00.000Z",
          notes: null,
          reference: null,
          product: { id: "p1", name: "Acme Soda", sku: "SODA-1" },
        },
      ],
      meta: { total: 3, page: 1, limit: 50, totalPages: 1 },
    },
  }),
}));
jest.mock("./_components/MovementsExportButton", () => ({ MovementsExportButton: () => null }));

const typeCell = (label: string) => screen.getByText(label, { selector: "td *, td" });

describe("Stock movements — COST_BASIS (SA-1049 R6)", () => {
  it("R-4: a COST_BASIS row reads 'Cost update' in the neutral badge", () => {
    renderWithProviders(<MovementsPage />);
    const badge = typeCell("Cost update");
    expect(badge.closest("span")?.className ?? badge.className).toContain("bg-sunken");
  });

  it("the other types keep their words and variants (PURCHASE: Purchase, success)", () => {
    renderWithProviders(<MovementsPage />);
    const badge = typeCell("Purchase");
    expect(badge.closest("span")?.className ?? badge.className).toContain("bg-success-bg");
  });

  it("W-1016: a type the server adds later still shows a word, in the neutral badge, and the page stands", () => {
    renderWithProviders(<MovementsPage />);
    const badge = typeCell("Future kind");
    expect(badge.closest("span")?.className ?? badge.className).toContain("bg-sunken");
  });

  it("the All types filter can select Cost update", () => {
    renderWithProviders(<MovementsPage />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining([
        "Purchase",
        "Sale",
        "Adjustment",
        "Return",
        "Write-off",
        "Cost update",
      ]),
    );
    expect(within(screen.getAllByRole("combobox")[1]).getByText("Cost update")).toBeInTheDocument();
  });
});
