import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import BuyerFavoritesPage from "./page";

/**
 * Row 531 S5: the favourites card's quantity stepper was a ~26px control (a 44px floor applies to every
 * buyer stepper). It now uses the shared 44px cart-row stepper, which counts the line's selling unit,
 * names it, and offers the Case / Each toggle for a boxed product.
 */
const updateQty = jest.fn();
const setUnit = jest.fn();
let cartLine: Record<string, unknown> | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { slug: "acme", tenant: { name: "Acme" } },
    isLoading: false,
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({
    items: cartLine ? [cartLine] : [],
    getItemQty: () => (cartLine ? Number(cartLine.qty) : 0),
    getItemCount: () => (cartLine ? Number(cartLine.qty) / 12 : 0),
    addItem: jest.fn(),
    updateQty,
    setUnit,
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerFavorites: () => ({
    data: [
      {
        id: "f-p1",
        productId: "p1",
        name: "Widget",
        sku: null,
        unit: "ea",
        category: null,
        buyerPrice: 15.6,
        thumbnailUrl: null,
        imageKeys: [],
        unitsPerBox: 12,
        createdAt: "2026-10-01T00:00:00.000Z",
        unavailable: false,
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useBuyerRemoveFavorite: () => ({ mutateAsync: jest.fn() }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  cartLine = {
    productId: "p1",
    name: "Widget",
    unit: "ea",
    unitsPerBox: 12,
    qty: 24,
    boxes: 2,
    pieces: 0,
    sellBy: "CASE",
  };
});

describe("favourites card stepper (row 531 S5)", () => {
  it("every control is a 44px target: minus, plus, the count field and both unit buttons", () => {
    render(<BuyerFavoritesPage />);
    const stepper = screen.getByTestId("cart-row-stepper");
    expect(stepper.className).toMatch(/\bh-11\b/);
    for (const btn of [
      screen.getByRole("button", { name: "Decrease Widget" }),
      screen.getByRole("button", { name: "Increase Widget" }),
      screen.getByRole("button", { name: /order widget by the case/i }),
      screen.getByRole("button", { name: /order widget by the each/i }),
    ]) {
      expect(btn.className).toMatch(/\bmin-h-11\b/);
      expect(btn.className).toMatch(/\bmin-w-11\b/);
    }
    expect(screen.getByRole("spinbutton").className).toMatch(/\bh-11\b/);
  });

  it("names the unit and quantity, and its buttons drive the same count / unit setters", () => {
    render(<BuyerFavoritesPage />);
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
    fireEvent.click(screen.getByRole("button", { name: "Increase Widget" }));
    expect(updateQty).toHaveBeenCalledWith("p1", 3);
    fireEvent.click(screen.getByRole("button", { name: /order widget by the each/i }));
    expect(setUnit).toHaveBeenCalledWith("p1", "EACH");
  });

  it("minus at 1 removes the line (updateQty to 0), as the old control did", () => {
    cartLine = { ...cartLine, qty: 12, boxes: 1 };
    render(<BuyerFavoritesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Widget" }));
    expect(updateQty).toHaveBeenCalledWith("p1", 0);
  });

  it("with nothing in the cart the card shows Add and no stepper", () => {
    cartLine = undefined;
    render(<BuyerFavoritesPage />);
    expect(screen.queryByTestId("cart-row-stepper")).toBeNull();
    expect(within(document.body).getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });
});
