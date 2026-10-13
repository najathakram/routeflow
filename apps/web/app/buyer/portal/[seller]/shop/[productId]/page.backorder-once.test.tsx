import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import BuyerProductDetailPage from "./page";

/**
 * A buyer who can backorder an out-of-stock item saw "Ships when restocked" twice (the page's stock
 * line AND the actions' note). It is now rendered once, tied to the backorder state.
 */
let product: Record<string, unknown>;
let cartItems: Array<{ productId: string; qty: number }> = [];

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", productId: "p1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { tenant: { slug: "acme" } },
    isLoading: false,
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({ items: cartItems, addItem: jest.fn(), updateQty: jest.fn() }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProduct: () => ({ data: product, isLoading: false, isError: false, error: null }),
  useBuyerPromotions: () => ({ data: [] }),
  useBuyerFavorites: () => ({ data: [] }),
  useBuyerAddFavorite: () => ({ mutate: jest.fn() }),
  useBuyerRemoveFavorite: () => ({ mutate: jest.fn() }),
  useBuyerStockAlerts: () => ({ data: { productIds: [] } }),
  useSubscribeStockAlert: () => ({ mutate: jest.fn() }),
  useUnsubscribeStockAlert: () => ({ mutate: jest.fn() }),
  toPromotionRules: () => [],
}));
jest.mock("./_components/ProductGallery", () => ({ ProductGallery: () => <div /> }));

const base = {
  id: "p1",
  name: "Widget",
  description: null,
  sku: "W-1",
  barcode: null,
  unit: "ea",
  category: "Snacks",
  buyerPrice: 5,
  unitsPerBox: null,
  thumbnailUrl: null,
  imageUrls: [],
  variants: [],
  isFeatured: false,
  isNew: false,
  isDeal: false,
  inStock: false,
  stockStatus: "OUT_OF_STOCK",
  stockLeft: null,
};

beforeEach(() => {
  cartItems = [];
});

describe("product detail: Ships when restocked", () => {
  it("renders exactly once when the buyer can backorder", () => {
    product = { ...base, canBackorder: true };
    render(
      <ToastProvider>
        <BuyerProductDetailPage />
      </ToastProvider>,
    );
    expect(screen.getAllByText("Ships when restocked")).toHaveLength(1);
  });

  it("still renders once when the item is already in the cart", () => {
    product = { ...base, canBackorder: true };
    cartItems = [{ productId: "p1", qty: 1 }];
    render(
      <ToastProvider>
        <BuyerProductDetailPage />
      </ToastProvider>,
    );
    expect(screen.getAllByText("Ships when restocked")).toHaveLength(1);
  });

  it("out of stock and cannot backorder: the page still says Out of stock", () => {
    product = { ...base, canBackorder: false };
    render(
      <ToastProvider>
        <BuyerProductDetailPage />
      </ToastProvider>,
    );
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
    expect(screen.queryByText("Ships when restocked")).toBeNull();
  });

  it("in stock and low stock lines are unchanged", () => {
    product = { ...base, stockStatus: "LOW", stockLeft: 3, inStock: true };
    render(
      <ToastProvider>
        <BuyerProductDetailPage />
      </ToastProvider>,
    );
    expect(screen.getByText("Only 3 left")).toBeInTheDocument();
  });

  it("the favourite heart has a 44px hit area", () => {
    product = { ...base, canBackorder: true };
    render(
      <ToastProvider>
        <BuyerProductDetailPage />
      </ToastProvider>,
    );
    expect(screen.getByTitle("Add to favorites").className).toMatch(/\bmin-h-11\b/);
  });
});
