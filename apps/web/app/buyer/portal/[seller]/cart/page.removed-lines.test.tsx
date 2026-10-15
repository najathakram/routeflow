import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * State portal limits (spec §4, C e): a cart line the catalog no longer returns for this buyer is removed only after a
 * SUCCESSFUL load, and the buyer is told calmly, by name, with OK as the only action.
 */
const removeItem = jest.fn();
let productsState: { data?: { data: Array<{ id: string }> }; isSuccess?: boolean } = {};
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({ buyer: { id: "b1" }, activeSeller: { slug: "acme" }, isLoading: false }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({
    items: [
      { productId: "p1", qty: 1, name: "Kratom 50ct", unitPrice: 5 },
      { productId: "p2", qty: 2, name: "Vape Pod Mint", unitPrice: 9 },
      { productId: "p3", qty: 1, name: "Sample Cola", unitPrice: 2 },
    ],
    itemCount: 3,
    totalQty: 4,
    clearCart: jest.fn(),
    removeItem,
    adoptCatalogPacks: jest.fn(),
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => productsState,
  useBuyerCreateOrder: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBuyerActiveOrder: () => ({ data: undefined }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  jest.clearAllMocks();
  productsState = {};
});

describe("buyer cart — lines the portal no longer offers (C e)", () => {
  it("after a successful load: removes the unresolved lines and names them, calmly", () => {
    productsState = { isSuccess: true, data: { data: [{ id: "p3" }] } };
    render(<BuyerCartPage />);
    expect(removeItem).toHaveBeenCalledTimes(2);
    expect(removeItem).toHaveBeenCalledWith("p1");
    expect(removeItem).toHaveBeenCalledWith("p2");
    const notice = screen.getByTestId("cart-removed-notice");
    expect(notice).toHaveTextContent(
      "Some items are no longer available to you, so we took them out of your cart: Kratom 50ct, Vape Pod Mint.",
    );
    expect(notice.className).not.toMatch(/danger|red/);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByTestId("cart-removed-notice")).toBeNull();
  });

  it("a failed or pending fetch removes nothing and says nothing", () => {
    productsState = { isSuccess: false, data: undefined };
    render(<BuyerCartPage />);
    expect(removeItem).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cart-removed-notice")).toBeNull();
  });

  it("when every line resolves, nothing is removed", () => {
    productsState = { isSuccess: true, data: { data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] } };
    render(<BuyerCartPage />);
    expect(removeItem).not.toHaveBeenCalled();
  });
});
