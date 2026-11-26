import * as React from "react";
import { render, screen } from "@testing-library/react";
import BuyerFavoritesPage from "./page";

/** B1383 PR-B: a favourites card's price line comes from `pricedPerLabel` (a box price never reads "per can"). */
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
    items: [],
    getItemQty: () => 0,
    getItemCount: () => 0,
    addItem: jest.fn(),
    updateQty: jest.fn(),
    setUnit: jest.fn(),
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerFavorites: () => ({
    data: [
      {
        id: "f-p1",
        productId: "p1",
        name: "Acme Cola",
        sku: null,
        unit: "can",
        category: null,
        buyerPrice: 12,
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

describe("favourites card price line (B1383)", () => {
  it("a boxed product with a piece-word unit reads per box with the pack count", () => {
    render(<BuyerFavoritesPage />);
    expect(screen.getByText("per box (12 cans)")).toBeInTheDocument();
    expect(screen.queryByText(/per can/)).not.toBeInTheDocument();
  });
});
