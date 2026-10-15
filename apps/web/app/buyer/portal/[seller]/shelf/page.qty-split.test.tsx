import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerShelfPage from "./page";

/**
 * Row 531: the server refuses a buyer line whose qty and box split disagree, so the shelf quick-add
 * derives qty FROM its box count: a boxed estimate sends {qty: boxes x pack, boxes, pieces: 0}, a
 * plain one sends qty alone.
 */
const mutateAsync = jest.fn();
let estimate: Record<string, unknown> = {};

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
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
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
          lastOrderedAt: "2026-09-01T00:00:00Z",
          cadenceDays: 7,
          imageUrl: null,
          ...estimate,
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
  return mutateAsync.mock.calls[0][0].items[0];
};

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({});
});

describe("buyer shelf quick add: the payload agrees with itself", () => {
  it.each([
    [24, 12, { qty: 24, boxes: 2, pieces: 0 }],
    [12, 12, { qty: 12, boxes: 1, pieces: 0 }],
    [5, 12, { qty: 12, boxes: 1, pieces: 0 }], // an odd suggestion rounds to one whole box, qty follows
    [30, 12, { qty: 36, boxes: 3, pieces: 0 }], // 2.5 boxes rounds to 3, qty follows
  ])("suggested %i on a %i/box product sends %j", async (suggestedQty, unitsPerBox, expected) => {
    estimate = { suggestedQty, unitsPerBox };
    const item = await add();
    expect(item).toEqual({ productId: "p1", ...expected });
    expect(item.qty).toBe(item.boxes * unitsPerBox + item.pieces);
  });

  it("a plain product sends qty alone", async () => {
    estimate = { suggestedQty: 3, unitsPerBox: null };
    expect(await add()).toEqual({ productId: "p1", qty: 3 });
  });
});
