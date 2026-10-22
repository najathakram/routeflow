import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * Row 695 (F36): "Create new order instead" was component state, so Back -> Forward remounted the
 * cart with the banner back on "added to your existing order" while the order placed was a new one.
 * The choice is now stored (per buyer + seller) and the banner, the button and the POST all read it.
 */
const mutateAsync = jest.fn();
const clearCart = jest.fn();
const push = jest.fn();
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
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
  useBuyerActiveOrder: () => ({
    data: active,
    isSuccess: true,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const PRIMARY = /^(add to existing order|place order)$/i;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mutateAsync.mockResolvedValue({ id: "o-new", orderNumber: "ORD-101" });
});

describe("buyer cart - the new-order choice survives a remount (row 695)", () => {
  it("after choosing a new order and remounting, the banner and the POST still say new", async () => {
    const first = render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /create new order instead/i }));
    expect(await screen.findByText(/a new order will be created/i)).toBeInTheDocument();
    first.unmount(); // Back

    render(<BuyerCartPage />); // Forward
    expect(await screen.findByText(/a new order will be created/i)).toBeInTheDocument();
    expect(screen.queryByText(/will be added to your existing order/i)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: PRIMARY }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ forceNew: true });
  });

  it("without a choice nothing changes: merge banner, forceNew false, lands on the open order", async () => {
    render(<BuyerCartPage />);
    expect(await screen.findByText(/will be added to your existing order/i)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: PRIMARY }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ forceNew: false });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/o-old"));
  });

  it("the choice is forgotten once the order is placed", async () => {
    const first = render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /create new order instead/i }));
    fireEvent.click(await screen.findByRole("button", { name: PRIMARY }));
    await waitFor(() => expect(clearCart).toHaveBeenCalled());
    first.unmount();
    render(<BuyerCartPage />);
    expect(await screen.findByText(/will be added to your existing order/i)).toBeInTheDocument();
  });
});

describe("buyer cart - Place order button (P25, P28)", () => {
  it("reads in sentence case and is a 44 px target", async () => {
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /create new order instead/i }));
    const btn = await screen.findByRole("button", { name: /^place order$/i });
    expect(btn).toHaveTextContent(/^Place order$/);
    expect(btn).toHaveClass("min-h-[44px]");
  });
});
