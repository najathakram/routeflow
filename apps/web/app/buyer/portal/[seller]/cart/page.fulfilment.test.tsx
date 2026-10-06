import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * Order ahead: the cart offers "Pick up at store" / "Ship to me" only when the seller offers a choice
 * (portalMethods.length > 1), defaulting to portalDefault; one method is sent without a choice; none
 * sends nothing (today). A FULFIL_METHOD_NOT_OFFERED refusal shows fixed copy, never the raw message.
 */
const mutateAsync = jest.fn();
const clearCart = jest.fn();
let offer: { portalMethods: string[]; portalDefault: string | null } | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { linkId: "l1", tenant: { slug: "acme" }, fulfilment: offer },
    sellers: [{ linkId: "l1", tenant: { slug: "acme" }, fulfilment: offer }],
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
jest.mock("@/lib/api/buyer", () => ({
  useBuyerProducts: () => ({ data: { data: [] } }),
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
  useBuyerActiveOrder: () => ({ data: undefined }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const place = async () =>
  fireEvent.click(await screen.findByRole("button", { name: /place order/i }));

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "o1", orderNumber: "SO-1" });
  offer = undefined;
});

describe("buyer cart — pickup / ship choice", () => {
  it("shows the radio group when two methods are offered, defaulting to portalDefault", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    render(<BuyerCartPage />);
    expect(await screen.findByRole("radio", { name: "Pick up at store" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Ship to me" })).not.toBeChecked();
  });

  it("sends the default fulfillPath", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    render(<BuyerCartPage />);
    await place();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toEqual(
      expect.objectContaining({ fulfillPath: "PICKUP" }),
    );
  });

  it("sends the changed fulfillPath after the buyer switches to Ship to me", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("radio", { name: "Ship to me" }));
    await place();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].fulfillPath).toBe("SHIP");
  });

  it("one offered method: no choice shown, that method is sent", async () => {
    offer = { portalMethods: ["SHIP"], portalDefault: "SHIP" };
    render(<BuyerCartPage />);
    await place();
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].fulfillPath).toBe("SHIP");
  });

  it("no methods (unset): no choice and no fulfillPath key in the payload", async () => {
    offer = { portalMethods: [], portalDefault: null };
    render(<BuyerCartPage />);
    await place();
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty("fulfillPath");
  });

  it("FULFIL_METHOD_NOT_OFFERED shows fixed copy, never the raw message", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("x"), {
        response: {
          status: 400,
          data: { code: "FULFIL_METHOD_NOT_OFFERED", message: "raw server text PICKUP" },
        },
      }),
    );
    render(<BuyerCartPage />);
    await place();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That option isn't available from this seller any more. Choose another and try again.",
    );
    expect(screen.queryByText(/raw server text/)).toBeNull();
    expect(clearCart).not.toHaveBeenCalled();
  });
});
