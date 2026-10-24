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
let capState: "ok" | "error" | "loading" = "ok";
const push = jest.fn();
const activeOrderArgs: unknown[] = [];
let active: { id: string; orderNumber: string; fulfillPath: string } | undefined;

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
// #3200's seller-scoped hook is the ONE capability source (GET /buyer/capabilities).
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: capState === "ok" && offer ? { ...offer, fleet: true } : undefined,
    isLoading: capState === "loading",
    isError: capState === "error",
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
  useBuyerActiveOrder: (path?: string) => {
    activeOrderArgs.push(path);
    return { data: active, isSuccess: true, isError: false, refetch: jest.fn() };
  },
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const place = async () =>
  fireEvent.click(await screen.findByRole("button", { name: /place order/i }));

beforeEach(() => {
  jest.clearAllMocks();
  activeOrderArgs.length = 0;
  mutateAsync.mockResolvedValue({ id: "o1", orderNumber: "SO-1" });
  offer = undefined;
  capState = "ok";
  active = undefined;
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

  it("capability read failed (503): no choice and no fulfillPath in the payload", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    capState = "error";
    render(<BuyerCartPage />);
    await place();
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty("fulfillPath");
  });

  it("capability still loading: no choice and no fulfillPath in the payload", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    capState = "loading";
    render(<BuyerCartPage />);
    await place();
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).not.toHaveProperty("fulfillPath");
  });
});

describe("buyer cart — merge follows the chosen fulfilment path", () => {
  const both = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };

  it("Ship to me with an active PICKUP order: no merge banner, button reads Place Order", async () => {
    offer = both;
    active = { id: "a1", orderNumber: "SO-9", fulfillPath: "PICKUP" };
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("radio", { name: "Ship to me" }));
    expect(screen.queryByText(/added to your existing order/i)).toBeNull();
    expect(screen.getByRole("button", { name: /place order/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add to existing order/i })).toBeNull();
  });

  it("Pick up with an active SHIP order: no merge banner", async () => {
    offer = both;
    active = { id: "a1", orderNumber: "SO-9", fulfillPath: "SHIP" };
    render(<BuyerCartPage />);
    await screen.findByRole("radio", { name: "Pick up at store" });
    expect(screen.queryByText(/added to your existing order/i)).toBeNull();
    expect(screen.getByRole("button", { name: /place order/i })).toBeInTheDocument();
  });

  it("reads the active order for the CHOSEN path (default, then after switching)", async () => {
    offer = both;
    render(<BuyerCartPage />);
    await screen.findByRole("radio", { name: "Pick up at store" });
    expect(activeOrderArgs[activeOrderArgs.length - 1]).toBe("PICKUP");
    fireEvent.click(screen.getByRole("radio", { name: "Ship to me" }));
    expect(activeOrderArgs[activeOrderArgs.length - 1]).toBe("SHIP");
  });

  it("no offer: the active order is read with no path (today's read)", async () => {
    offer = { portalMethods: [], portalDefault: null };
    render(<BuyerCartPage />);
    await screen.findByRole("button", { name: /place order/i });
    expect(activeOrderArgs[activeOrderArgs.length - 1]).toBeUndefined();
  });

  it("path mismatch: submit goes to the NEW order, not the active one", async () => {
    offer = both;
    active = { id: "a1", orderNumber: "SO-9", fulfillPath: "PICKUP" };
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("radio", { name: "Ship to me" }));
    await place();
    fireEvent.click(await screen.findByRole("button", { name: /view order/i }));
    expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/o1");
    expect(push).not.toHaveBeenCalledWith("/buyer/portal/acme/orders/a1");
  });

  it("same path (control): banner shows, button says Add to existing, redirects to the active order", async () => {
    offer = both;
    active = { id: "a1", orderNumber: "SO-9", fulfillPath: "PICKUP" };
    render(<BuyerCartPage />);
    expect(await screen.findByText(/added to your existing order/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add to existing order/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/a1"));
  });

  it("no path sent (no offer): today's rule, any active order merges", async () => {
    offer = { portalMethods: [], portalDefault: null };
    active = { id: "a1", orderNumber: "SO-9", fulfillPath: "SHIP" };
    render(<BuyerCartPage />);
    expect(await screen.findByText(/added to your existing order/i)).toBeInTheDocument();
  });

  it("no active order: never an Add to existing order label", async () => {
    offer = both;
    render(<BuyerCartPage />);
    await screen.findByRole("button", { name: /place order/i });
    expect(screen.queryByText(/add to existing order/i)).toBeNull();
  });

  it("forced new with a mismatched active order: no Add to existing order switch", async () => {
    offer = both;
    active = { id: "a1", orderNumber: "SO-9", fulfillPath: "PICKUP" };
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /create new order instead/i }));
    fireEvent.click(screen.getByRole("radio", { name: "Ship to me" }));
    expect(screen.queryByText(/add to existing order/i)).toBeNull();
  });
});
