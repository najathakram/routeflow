import * as React from "react";
import { render, screen } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * Cart items table at 390px wide: below md the rows stack as cards (no 640px min width, no sideways
 * scroll) and every column's information stays visible (labels replace the hidden header). Class
 * checks only; the pixel result is proven by Playwright.
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
  useBuyerActiveOrder: () => ({ data: undefined }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

describe("buyer cart table on a narrow screen", () => {
  it("stacks rows below md: no forced min width, header hidden, block rows", () => {
    render(<BuyerCartPage />);
    const table = screen.getByRole("table");
    expect(table.className).toMatch(/max-md:block/);
    expect(table.className).toMatch(/md:min-w-\[640px\]/);
    expect(table.className).not.toMatch(/(^|\s)min-w-\[640px\]/);
    expect(table.querySelector("thead")!.className).toMatch(/max-md:hidden/);
    for (const row of table.querySelectorAll("tbody tr")) {
      expect(row.className).toMatch(/max-md:flex/);
      expect(row.className).toMatch(/max-md:flex-wrap/);
    }
  });

  it("keeps every column's information per line: product, qty, price, subtotal, remove", () => {
    render(<BuyerCartPage />);
    expect(screen.getByText("Widget")).toBeInTheDocument();
    expect(screen.getByText("Gadget")).toBeInTheDocument();
    // Mobile-only labels stand in for the hidden header cells (one per row each).
    expect(screen.getAllByText("Price", { selector: "span" })).toHaveLength(2);
    expect(screen.getAllByText("Subtotal", { selector: "span" })).toHaveLength(2);
    expect(screen.getAllByText("Price", { selector: "span" })[0].className).toMatch(/md:hidden/);
    expect(screen.getAllByRole("spinbutton").length).toBeGreaterThanOrEqual(3);
    // one remove button per row (the last button of each row)
    for (const row of screen.getByRole("table").querySelectorAll("tbody tr")) {
      expect(row.querySelectorAll("button").length).toBeGreaterThan(0);
    }
  });

  it("keeps table semantics under the block layout via explicit ARIA roles", () => {
    render(<BuyerCartPage />);
    const table = screen.getByRole("table");
    expect(table.querySelector("thead")).toHaveAttribute("role", "rowgroup");
    expect(table.querySelector("tbody")).toHaveAttribute("role", "rowgroup");
    // header row + one per line
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getAllByRole("cell")).toHaveLength(10);
  });

  it("names each remove button after its product and gives it a 44px hit area", () => {
    render(<BuyerCartPage />);
    for (const name of ["Widget", "Gadget"]) {
      const btn = screen.getByRole("button", { name: `Remove ${name}` });
      expect(btn.className).toMatch(/min-h-11/);
      expect(btn.className).toMatch(/min-w-11/);
    }
  });
});
