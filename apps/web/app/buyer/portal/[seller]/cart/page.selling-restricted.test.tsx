import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PORTAL_NEEDS_STATE_MESSAGE } from "@routeflow/types";
import BuyerCartPage from "./page";

/**
 * A buyer's Place Order refused with SELLING_RESTRICTED shows an inline message that NAMES the
 * items only — no rule, state or reason (that detail is for staff) — and the cart is kept.
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
    items: [{ productId: "p1", qty: 1, name: "Hemp Gummies", unitPrice: 5 }],
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
  useBuyerActiveOrder: () => ({
    data: undefined,
    isSuccess: true,
    isError: false,
    refetch: jest.fn(),
  }),
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

describe("buyer cart — SELLING_RESTRICTED", () => {
  it("names the blocked items only, keeps the cart, and never shows the rule detail", async () => {
    reject(409, {
      code: "SELLING_RESTRICTED",
      message: "Restricted federally: internal rule reason",
      blockedLines: [
        {
          productId: "p1",
          productName: "Hemp Gummies",
          ruleId: "r1",
          reason: "FEDERAL_BAN",
          message: "m",
        },
      ],
    });
    await place();
    // role="alert": the banner sits below Place Order on a long cart, so it must be announced.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /can't be ordered right now: Hemp Gummies/,
    );
    expect(screen.queryByText(/federal|internal rule reason/i)).toBeNull();
    expect(clearCart).not.toHaveBeenCalled();
  });

  // Row 672 (SA-924): the server's needs-state refusal reaches the buyer as the ONE shared sentence.
  it("a refusal waiting on the buyer's own state asks for it (the shared copy, not the names)", async () => {
    reject(409, {
      code: "SELLING_RESTRICTED",
      message: "server text",
      blockedLines: [{ productId: "p1", productName: "Hemp Gummies" }],
      remedy: "ADD_CUSTOMER_STATE",
    });
    await place();
    expect(await screen.findByRole("alert")).toHaveTextContent(PORTAL_NEEDS_STATE_MESSAGE);
    expect(screen.queryByText(/server text|can't be ordered right now/)).toBeNull();
    expect(clearCart).not.toHaveBeenCalled();
  });

  it("any other failure still shows the server message", async () => {
    reject(500, { message: "Boom happened" });
    await place();
    await waitFor(() => expect(screen.getByText("Boom happened")).toBeInTheDocument());
  });
});
