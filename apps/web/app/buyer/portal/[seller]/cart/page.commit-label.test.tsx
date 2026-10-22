import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * The cart's one commit button names what it will do AND the request does it. "No open order" reaches
 * the client as an empty body (""), not null. Until the open-order read has succeeded the cart cannot
 * know whether the server will fold it into an open order, so the button waits (and never submits
 * after a failed read). `forceNew` is the buyer's explicit "Create new order instead" only: it also
 * pins the new order out of later merges, so it is not sent for a buyer who has no open order.
 * Fixtures are placeholders.
 */
type Query = { data: unknown; isSuccess: boolean; isError: boolean; refetch: jest.Mock };
let query: Query;
const mutateAsync = jest.fn();
const push = jest.fn();
const refetch = jest.fn();
const ok = (data: unknown): Query => ({ data, isSuccess: true, isError: false, refetch });

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
    clearCart: jest.fn(),
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => ({ data: { data: [] } }),
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
  useBuyerActiveOrder: () => query,
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const BANNER = /will be added to your existing order/i;
const open = { id: "o-old", orderNumber: "ORD-100", fulfillPath: "ROUTE" };

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "o-new", orderNumber: "ORD-101" });
});

describe("buyer cart — the commit button, the banner and the request agree", () => {
  it.each([
    ["an empty body", ""],
    ["null", null],
  ])("no open order (%s): Place order, no banner, a new order is requested", async (_n, value) => {
    query = ok(value);
    render(<BuyerCartPage />);
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to existing order" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Place order" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // Never "Create new order instead" here: forceNew would pin this order out of later merges.
    expect(mutateAsync.mock.calls[0][0].forceNew).toBeFalsy();
    // No open order: the confirmation is the placed-order screen, not a jump to an old order.
    expect(await screen.findByText("ORD-101")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("an open order: banner + Add to existing order; the request merges (no forceNew) and lands on it", async () => {
    query = ok(open);
    render(<BuyerCartPage />);
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to existing order" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].forceNew).toBeFalsy();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/o-old"));
  });

  it("while the open-order read is loading: the button is disabled, says it is checking, and nothing is sent", () => {
    query = { data: undefined, isSuccess: false, isError: false, refetch };
    render(<BuyerCartPage />);
    const button = screen.getByRole("button", { name: /checking your orders/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Place order" })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("when the read failed: Retry is offered, the button cannot submit, and Retry re-reads", () => {
    query = { data: undefined, isSuccess: false, isError: true, refetch };
    render(<BuyerCartPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t check for an open order/i);
    const place = screen.getByRole("button", { name: "Place order" });
    expect(place).toBeDisabled();
    fireEvent.click(place);
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
