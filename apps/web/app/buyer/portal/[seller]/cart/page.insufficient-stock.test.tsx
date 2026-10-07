import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import BuyerCartPage from "./page";
import { BUYER_INSUFFICIENT_STOCK_COPY } from "@/lib/buyer-backorder";

/**
 * OOS PR2 (R4): an order refused for stock is a coded 409 INSUFFICIENT_STOCK. The cart shows the
 * portal's own fixed sentence, never a raw server string (the old server message carried
 * "available: N"), and keeps the cart.
 */
const mutateAsync = jest.fn();
const clearCart = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({ buyer: { id: "b1" }, activeSeller: { slug: "acme" }, isLoading: false }),
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
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => ({ data: { data: [] } }),
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
  useBuyerActiveOrder: () => ({ data: undefined }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const reject = (status: number, data: object) =>
  mutateAsync.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );
const place = async () => {
  render(<BuyerCartPage />);
  fireEvent.click(await screen.findByRole("button", { name: /place order/i }));
};

beforeEach(() => jest.clearAllMocks());

describe("buyer cart — INSUFFICIENT_STOCK", () => {
  it("shows the portal's fixed copy, not the server's text, and keeps the cart", async () => {
    reject(409, {
      code: "INSUFFICIENT_STOCK",
      message: "Insufficient stock: Widget (available: 3, requested: 6)",
    });
    await place();
    expect(await screen.findByRole("alert")).toHaveTextContent(BUYER_INSUFFICIENT_STOCK_COPY);
    expect(screen.queryByText(/available: 3|requested: 6|Insufficient stock/)).toBeNull();
    expect(clearCart).not.toHaveBeenCalled();
  });

  it("an uncoded failure still shows its own message (unchanged)", async () => {
    reject(500, { message: "Something else went wrong" });
    await place();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something else went wrong");
  });
});
