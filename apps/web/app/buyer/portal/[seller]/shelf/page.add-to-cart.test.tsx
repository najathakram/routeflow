import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import BuyerShelfPage from "./page";

/**
 * Row 696 (F33): the Shelf "Add" was dead because it created a server order instead of putting the
 * item in the cart. Add now writes one cart line, the same one the shop's running-low strip writes
 * (a boxed estimate adds whole Cases, qty in pieces), and never touches createOrder.
 */
const createOrderMutate = jest.fn();
const addItem = jest.fn();
let estimate: Record<string, unknown> = {};

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { linkId: "l1", tenant: { slug: "acme", name: "Acme" } },
    sellers: [{ linkId: "l1", tenant: { slug: "acme" } }],
    isLoading: false,
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({ items: [], itemCount: 0, totalQty: 0, addItem }),
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
          unit: "ea",
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
  useBuyerCreateOrder: () => ({ mutateAsync: createOrderMutate, isPending: false }),
  useSnoozeReplenishment: () => ({ mutateAsync: jest.fn() }),
  useUnsnoozeReplenishment: () => ({ mutateAsync: jest.fn() }),
  useAddAllLow: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const clickAdd = async () => {
  render(<BuyerShelfPage />);
  fireEvent.click(await screen.findByRole("button", { name: /^add$/i }));
};

beforeEach(() => {
  jest.clearAllMocks();
  estimate = {};
});

describe("buyer shelf Add puts the item in the cart (row 696)", () => {
  it("a plain product adds its suggested qty as one cart line and creates no order", async () => {
    estimate = { suggestedQty: 3, unitsPerBox: null };
    await clickAdd();
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem.mock.calls[0][0]).toMatchObject({ productId: "p1", name: "Widget", qty: 3 });
    expect(createOrderMutate).not.toHaveBeenCalled();
  });

  it.each([
    [24, 12, 24, 2],
    [12, 12, 12, 1],
    [5, 12, 12, 1], // an odd suggestion rounds to one whole Case
    [30, 12, 36, 3], // 2.5 Cases rounds to 3
  ])("suggested %i on a %i/box product adds qty %i (%i Cases)", async (sugg, upb, qty, boxes) => {
    estimate = { suggestedQty: sugg, unitsPerBox: upb };
    await clickAdd();
    const line = addItem.mock.calls[0][0];
    expect(line).toMatchObject({ productId: "p1", qty, boxes, pieces: 0, unitsPerBox: upb });
    expect(line.qty).toBe(line.boxes * upb + line.pieces);
    expect(createOrderMutate).not.toHaveBeenCalled();
  });
});
