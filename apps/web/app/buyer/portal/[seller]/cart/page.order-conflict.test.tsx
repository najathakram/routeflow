import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/** Create-order idempotency refusals that name the existing order. */
const mutateAsync = jest.fn();
const clearCart = jest.fn();
let offer: { portalMethods: string[]; portalDefault: string | null } | undefined;
let capState: "ok" | "error" | "loading" = "ok";
const push = jest.fn();
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
  useBuyerActiveOrder: () => ({ data: active }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const place = async () =>
  fireEvent.click(await screen.findByRole("button", { name: /place order/i }));

const refusal = (code: string, orderId?: string) =>
  Object.assign(new Error("x"), {
    response: {
      status: 409,
      data: { code, ...(orderId ? { orderId } : {}), message: "raw server text" },
    },
  });

beforeEach(() => {
  jest.clearAllMocks();
  offer = undefined;
  capState = "ok";
  active = undefined;
});

describe("buyer cart — order already placed", () => {
  it.each([
    "IDEMPOTENCY_KEY_CONFLICT",
    "IDEMPOTENCY_KEY_CART_MISMATCH",
    "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
  ])("%s with an orderId links to that order", async (code) => {
    mutateAsync.mockRejectedValueOnce(refusal(code, "o-9"));
    render(<BuyerCartPage />);
    await place();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your order was already placed");
    expect(screen.getByRole("link", { name: /open it/i })).toHaveAttribute(
      "href",
      "/buyer/portal/acme/orders/o-9",
    );
    expect(screen.queryByText(/raw server text/)).toBeNull();
    expect(clearCart).not.toHaveBeenCalled();
  });

  it("without an orderId shows fixed copy and no link", async () => {
    mutateAsync.mockRejectedValueOnce(refusal("IDEMPOTENCY_KEY_CONFLICT"));
    render(<BuyerCartPage />);
    await place();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your order may already be placed. Check your orders.",
    );
    expect(screen.queryByRole("link", { name: /open it/i })).toBeNull();
    expect(screen.queryByText(/raw server text/)).toBeNull();
  });
});
