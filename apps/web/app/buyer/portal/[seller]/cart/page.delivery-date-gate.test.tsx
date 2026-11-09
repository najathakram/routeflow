import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * B1164: "Requested delivery date" is a delivery-route control, so it follows the same gate as the
 * other route wording (`sellerShowsRouteWording`): hidden for a configured seller with no fleet
 * (ship-only), shown for a fleet seller and for an unset / unread capability. Fixtures are placeholders.
 */
const mutateAsync = jest.fn();
let capability: Record<string, unknown> | undefined;

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
  useBuyerSellerCapabilities: () => ({ data: capability, isLoading: false, isError: false }),
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
  useBuyerActiveOrder: () => ({ data: null, isSuccess: true, isError: false, refetch: jest.fn() }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "o1", orderNumber: "SO-1" });
});

describe("buyer cart — requested delivery date gate", () => {
  it("ship-only seller (no fleet): no delivery date input, none sent", async () => {
    capability = { portalMethods: ["SHIP"], portalDefault: "SHIP", fleet: false };
    render(<BuyerCartPage />);
    fireEvent.click(await screen.findByRole("button", { name: /place order/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Requested delivery date")).not.toBeInTheDocument();
    expect(mutateAsync.mock.calls[0][0].requestedDeliveryDate).toBeUndefined();
  });

  it("route-capable seller: the delivery date input is shown", async () => {
    capability = { portalMethods: ["ROUTE"], portalDefault: "ROUTE", fleet: true };
    render(<BuyerCartPage />);
    expect(await screen.findByText("Requested delivery date")).toBeInTheDocument();
  });

  it("unset / unread capability: today's screen, the input is shown", async () => {
    capability = undefined;
    render(<BuyerCartPage />);
    expect(await screen.findByText("Requested delivery date")).toBeInTheDocument();
  });
});

describe("buyer cart — a typed delivery date follows the gate (B1164)", () => {
  it("date typed while capability is unresolved is NOT sent once the seller is ship-only", async () => {
    capability = undefined;
    const { container, rerender } = render(<BuyerCartPage />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "2026-12-01" } });
    expect(input.value).toBe("2026-12-01");

    capability = { portalMethods: ["SHIP"], portalDefault: "SHIP", fleet: false };
    rerender(<BuyerCartPage />);
    await waitFor(() =>
      expect(container.querySelector('input[type="date"]')).not.toBeInTheDocument(),
    );

    fireEvent.click(await screen.findByRole("button", { name: /place order/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].requestedDeliveryDate).toBeUndefined();
  });

  it("route seller with a typed date still sends it", async () => {
    capability = { portalMethods: ["ROUTE"], portalDefault: "ROUTE", fleet: true };
    const { container } = render(<BuyerCartPage />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-12-01" } });
    fireEvent.click(await screen.findByRole("button", { name: /place order/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].requestedDeliveryDate).toBe("2026-12-01");
  });
});
