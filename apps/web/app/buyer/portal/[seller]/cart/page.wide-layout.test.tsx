import * as React from "react";
import { render, screen } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * W-665: the items table needs 640px from md up (md:min-w-[640px]). Beside the 256px portal sidebar, the
 * 3-column grid inside max-w-4xl gave its 2/3 column only ~555px at 1440 and ~470px at 1024, so the table
 * scrolled inside its card and hid Subtotal's edge and the remove column. The grid goes 3-up only from xl,
 * where the page widens enough for the 2/3 column to hold 640px; below xl the summary rail sits under the
 * table. Class checks only; the pixel result is proven by Playwright at 1440/1280/1024/768/390.
 */
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { linkId: "l1", tenant: { slug: "acme" } },
    sellers: [],
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({
    items: [
      { productId: "p1", qty: 2, name: "Widget", unit: "ea", unitPrice: 5 },
      { productId: "p2", qty: 5, name: "Gadget", unit: "ea", unitsPerBox: 5, boxes: 1, pieces: 0 },
    ],
    itemCount: 2,
    totalQty: 7,
    clearCart: jest.fn(),
    addItem: jest.fn(),
    updateQty: jest.fn(),
    setUnit: jest.fn(),
    adoptCatalogPacks: jest.fn(),
    removeItem: jest.fn(),
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => ({
    data: {
      data: [
        { id: "p1", buyerPrice: 5, category: null, unitsPerBox: null },
        { id: "p2", buyerPrice: 2, category: null, unitsPerBox: 5 },
      ],
    },
  }),
  useBuyerCreateOrder: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBuyerActiveOrder: () => ({
    data: undefined,
    isSuccess: true,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

describe("buyer cart table on a wide screen (W-665)", () => {
  it("goes 3-up only from xl, so the table column is never narrower than its 640px minimum", () => {
    render(<BuyerCartPage />);
    const table = screen.getByRole("table");
    const grid = table.closest(".grid") as HTMLElement;
    expect(grid.className).toMatch(/(^|\s)xl:grid-cols-3(\s|$)/);
    expect(grid.className).not.toMatch(/(^|\s)lg:grid-cols-3(\s|$)/);
    const itemsColumn = grid.children[0] as HTMLElement;
    expect(itemsColumn.contains(table)).toBe(true);
    expect(itemsColumn.className).toMatch(/(^|\s)xl:col-span-2(\s|$)/);
    expect(itemsColumn.className).not.toMatch(/(^|\s)lg:col-span-2(\s|$)/);
  });

  it("widens the page from xl so the 2/3 column holds the table", () => {
    render(<BuyerCartPage />);
    const page = (screen.getByRole("table").closest(".grid") as HTMLElement).parentElement!;
    expect(page.className).toMatch(/(^|\s)max-w-4xl(\s|$)/);
    expect(page.className).toMatch(/(^|\s)xl:max-w-6xl(\s|$)/);
  });

  it("keeps the remove control on every line", () => {
    render(<BuyerCartPage />);
    const rows = screen.getByRole("table").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.querySelector("button")).not.toBeNull();
  });
});
