import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * A forced / stale submit toward a paused seller is a 403 SELLER_UNAVAILABLE. The cart answers with the ONE
 * seller-unavailable sentence (its own alert; the mutation opts out of the global toast), never the generic
 * permission line and never the server's text, keeps the cart, and re-reads the seller's capability.
 */
const mutateAsync = jest.fn();
const clearCart = jest.fn();
const refetch = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { slug: "acme", tenant: { name: "Acme Foods" } },
    isLoading: false,
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({
    items: [{ productId: "p1", qty: 1, name: "Widget", unitPrice: 5 }],
    itemCount: 1,
    totalQty: 1,
    clearCart,
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch,
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => ({ data: { data: [] } }),
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
  useBuyerActiveOrder: () => ({ data: undefined }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => jest.clearAllMocks());

describe("buyer cart — 403 SELLER_UNAVAILABLE", () => {
  it("shows only the seller-unavailable copy, keeps the cart and re-reads the capability", async () => {
    mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: {
          status: 403,
          data: { code: "SELLER_UNAVAILABLE", message: "This seller isn't taking online orders" },
        },
      }),
    );
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /place order/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Acme Foods isn't taking online orders right now. Please check back soon or contact them.",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(/permission/i)).toBeNull();
    expect(clearCart).not.toHaveBeenCalled();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
