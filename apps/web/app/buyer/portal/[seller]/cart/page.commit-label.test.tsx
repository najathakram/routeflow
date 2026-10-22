import * as React from "react";
import { render, screen } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * The cart's one commit button names what it will do. The server answers "no open order" with an
 * empty body, which the client reads as "" (not null): the label must follow the same test as the
 * "Items will be added to your existing order" banner, never promise a merge that cannot happen.
 * Fixtures are placeholders.
 */
let active: unknown = null;

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
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
  useBuyerCreateOrder: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBuyerActiveOrder: () => ({ data: active }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

const BANNER = /will be added to your existing order/i;

describe("buyer cart — commit button label matches what it does", () => {
  it.each([
    ["an empty body (no open order)", ""],
    ["null (no open order)", null],
    ["undefined (still loading)", undefined],
  ])("%s: the button says Place order and there is no merge banner", async (_name, value) => {
    active = value;
    render(<BuyerCartPage />);
    expect(await screen.findByRole("button", { name: "Place order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to existing order" })).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("an open order: the banner shows and the button says Add to existing order", async () => {
    active = { id: "o-old", orderNumber: "ORD-100", fulfillPath: "ROUTE" };
    render(<BuyerCartPage />);
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to existing order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Place order" })).not.toBeInTheDocument();
  });
});
