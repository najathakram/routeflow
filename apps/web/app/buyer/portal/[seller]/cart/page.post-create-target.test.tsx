import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * B654: after the order is created the buyer lands on the order the SERVER returned, not on the id
 * the client assumed it would merge into. Fixtures are placeholders.
 */
const mutateAsync = jest.fn();
const push = jest.fn();
const refetch = jest.fn();

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
  useBuyerActiveOrder: () => ({
    data: { id: "o-assumed", orderNumber: "ORD-100", fulfillPath: "ROUTE" },
    isSuccess: true,
    isError: false,
    refetch,
  }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buyer cart — post-create navigation", () => {
  it("lands on the order id the server returned, not the assumed merge target", async () => {
    mutateAsync.mockResolvedValue({ id: "o-server", orderNumber: "ORD-200" });
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to existing order" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/o-server");
  });

  it("falls back to the merge target when the response carries no id", async () => {
    mutateAsync.mockResolvedValue({});
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to existing order" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/orders/o-assumed"));
  });
});
