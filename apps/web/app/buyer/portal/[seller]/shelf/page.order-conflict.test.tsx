import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerShelfPage from "./page";

/** Create-order idempotency refusals that name the existing order. */
const mutateAsync = jest.fn();
let offer: { portalMethods: string[]; portalDefault: string | null } | undefined;
let capState: "ok" | "error" | "loading" = "ok";

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    activeSeller: { linkId: "l1", tenant: { slug: "acme" } },
    sellers: [{ linkId: "l1", tenant: { slug: "acme" } }],
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: capState === "ok" && offer ? { ...offer, fleet: true } : undefined,
    isLoading: capState === "loading",
    isError: capState === "error",
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerShelf: () => ({
    isLoading: false,
    isError: false,
    data: {
      estimates: [
        {
          productId: "p1",
          name: "Widget",
          state: "low",
          snoozed: false,
          suggestedQty: 2,
          lastOrderedAt: "2026-09-01T00:00:00Z",
          cadenceDays: 7,
          imageUrl: null,
          unitsPerBox: null,
        },
      ],
    },
  }),
  useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
  useSnoozeReplenishment: () => ({ mutateAsync: jest.fn() }),
  useUnsnoozeReplenishment: () => ({ mutateAsync: jest.fn() }),
  useAddAllLow: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const refusal = (code: string, orderId?: string) =>
  Object.assign(new Error("x"), {
    response: {
      status: 409,
      data: { code, ...(orderId ? { orderId } : {}), message: "raw server text" },
    },
  });

const add = async () => {
  render(<BuyerShelfPage />);
  fireEvent.click(await screen.findByRole("button", { name: /^add$/i }));
};

beforeEach(() => {
  jest.clearAllMocks();
  capState = "ok";
  offer = undefined;
});

describe("buyer shelf quick order — order already placed", () => {
  it.each([
    "IDEMPOTENCY_KEY_CONFLICT",
    "IDEMPOTENCY_KEY_CART_MISMATCH",
    "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
  ])("%s with an orderId links to that order", async (code) => {
    mutateAsync.mockRejectedValueOnce(refusal(code, "o-9"));
    await add();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your order was already placed");
    expect(screen.getByRole("link", { name: /open it/i })).toHaveAttribute(
      "href",
      "/buyer/portal/acme/orders/o-9",
    );
    expect(screen.queryByText(/raw server text/)).toBeNull();
  });

  it("without an orderId shows fixed copy and no link", async () => {
    mutateAsync.mockRejectedValueOnce(refusal("IDEMPOTENCY_KEY_CONFLICT"));
    await add();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your order may already be placed. Check your orders.",
    );
    expect(screen.queryByRole("link", { name: /open it/i })).toBeNull();
  });
});
