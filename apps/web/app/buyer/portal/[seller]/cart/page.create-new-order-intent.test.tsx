import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * B1239: with a pending order the cart offers "Create new order instead". The choice must reach the request
 * as an explicit `forceNew: true`; without it the cart folds into the pending order (and the buyer lands on
 * that order, not on a "placed" screen).
 */
const mutateAsync = jest.fn();
const clearCart = jest.fn();
const push = jest.fn();
let pending = false;
const active = { id: "o-old", orderNumber: "ORD-100", fulfillPath: "ROUTE" };

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { linkId: "l1", tenant: { slug: "acme" } },
    sellers: [{ linkId: "l1", tenant: { slug: "acme" } }],
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({
    items: [{ productId: "p1", qty: 1, name: "Widget", unitPrice: 5 }],
    itemCount: 1,
    totalQty: 1,
    clearCart,
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => ({ data: { data: [] } }),
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: pending }),
  useBuyerActiveOrder: () => ({ data: active }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

// The primary button reads "Add to existing order" while the cart will fold, "Place Order" once it will not.
const PRIMARY = /^(add to existing order|place order)$/i;
const place = async () => fireEvent.click(await screen.findByRole("button", { name: PRIMARY }));

beforeEach(() => {
  jest.clearAllMocks();
  pending = false;
  mutateAsync.mockResolvedValue({ id: "o-new", orderNumber: "ORD-101" });
});

describe("buyer cart — create new order instead (B1239)", () => {
  it("default: names the pending order and sends forceNew false", async () => {
    render(<BuyerCartPage />);
    expect(await screen.findByText(/will be added to your existing order/i)).toBeInTheDocument();
    await place();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ forceNew: false });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/o-old"));
  });

  it("after 'Create new order instead' the request carries forceNew true and lands on the NEW order", async () => {
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /create new order instead/i }));
    expect(await screen.findByText(/a new order will be created/i)).toBeInTheDocument();
    await place();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ forceNew: true });
    await waitFor(() => expect(clearCart).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalledWith("/buyer/portal/acme/orders/o-old");
  });

  it("Place Order is disabled while the submit is in flight", async () => {
    pending = true;
    render(<BuyerCartPage />);
    expect(await screen.findByRole("button", { name: PRIMARY })).toBeDisabled();
  });
});
