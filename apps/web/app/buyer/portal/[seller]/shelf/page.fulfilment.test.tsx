import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerShelfPage from "./page";

/** Order ahead: the shelf quick order carries the seller's default method when it offers one. */
const mutateAsync = jest.fn();
let offer: { portalMethods: string[]; portalDefault: string | null } | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    activeSeller: { linkId: "l1", tenant: { slug: "acme" }, fulfilment: offer },
    sellers: [{ linkId: "l1", tenant: { slug: "acme" }, fulfilment: offer }],
    isLoading: false,
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

const add = async () => {
  render(<BuyerShelfPage />);
  fireEvent.click(await screen.findByRole("button", { name: /^add$/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  return mutateAsync.mock.calls[0][0];
};

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({});
});

describe("buyer shelf quick order — fulfilment", () => {
  it("sends portalDefault when the seller offers methods", async () => {
    offer = { portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" };
    expect((await add()).fulfillPath).toBe("PICKUP");
  });

  it("sends nothing when the seller offers none (today)", async () => {
    offer = { portalMethods: [], portalDefault: null };
    expect(await add()).not.toHaveProperty("fulfillPath");
  });
});
