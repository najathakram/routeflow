import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import BuyerFavoritesPage from "./page";

/**
 * OOS PR2 (R3c): a favourite follows the same rule as the shop tile. An out-of-stock item this
 * buyer cannot order is not addable ("Out of stock"); one they can order shows "Ships when
 * restocked" and Add. In-stock items are unchanged.
 */
const addItem = jest.fn();
const favorites: any[] = [];

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
  useBuyerCart: () => ({ getItemQty: () => 0, addItem, updateQty: jest.fn() }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerFavorites: () => ({ data: favorites, isLoading: false, isError: false }),
  useBuyerRemoveFavorite: () => ({ mutateAsync: jest.fn() }),
}));

const fav = (id: string, over: Record<string, unknown> = {}) => ({
  id: `f-${id}`,
  productId: id,
  name: `Product ${id}`,
  sku: null,
  unit: "ea",
  category: null,
  buyerPrice: 5,
  thumbnailUrl: null,
  imageKeys: [],
  unitsPerBox: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  unavailable: false,
  ...over,
});

beforeEach(() => {
  addItem.mockClear();
  favorites.length = 0;
});

describe("favorites — out-of-stock items follow the shop's rule", () => {
  it("out of stock + cannot order: 'Out of stock', no Add, nothing reaches the cart", () => {
    favorites.push(fav("p1", { stockStatus: "OUT_OF_STOCK", canBackorder: false }));
    render(<BuyerFavoritesPage />);
    expect(screen.getByTestId("favorite-out-of-stock")).toHaveTextContent("Out of stock");
    expect(screen.queryByRole("button", { name: /^add$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("favorite-ships-when-restocked")).not.toBeInTheDocument();
    expect(addItem).not.toHaveBeenCalled();
  });

  it("out of stock + canBackorder UNKNOWN (an older server) fails closed the same way", () => {
    favorites.push(fav("p1", { stockStatus: "OUT_OF_STOCK" }));
    render(<BuyerFavoritesPage />);
    expect(screen.getByTestId("favorite-out-of-stock")).toBeInTheDocument();
  });

  it("out of stock + canBackorder: says 'Ships when restocked' and Add puts it in the cart", () => {
    favorites.push(fav("p1", { stockStatus: "OUT_OF_STOCK", canBackorder: true }));
    render(<BuyerFavoritesPage />);
    expect(screen.getByTestId("favorite-ships-when-restocked")).toHaveTextContent(
      "Ships when restocked",
    );
    expect(screen.queryByTestId("favorite-out-of-stock")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem.mock.calls[0][0]).toMatchObject({ productId: "p1", qty: 1 });
  });

  it("in stock (or no stock field at all): a normal Add, no note", () => {
    favorites.push(fav("p1", { stockStatus: "IN_STOCK", canBackorder: false }), fav("p2"));
    render(<BuyerFavoritesPage />);
    expect(screen.getAllByRole("button", { name: /add/i })).toHaveLength(2);
    expect(screen.queryByTestId("favorite-out-of-stock")).not.toBeInTheDocument();
    expect(screen.queryByTestId("favorite-ships-when-restocked")).not.toBeInTheDocument();
  });
});
