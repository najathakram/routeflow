import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import BuyerShelfPage from "./page";

/**
 * Row 702: "Add all low to cart" posted /buyer/shelf/add-all-low and created a SERVER order, while the single Add on
 * the same page fills the local cart (row 696). Add all low now fills the cart through the same path as Add: one
 * cart line per running-low item not already in the cart, boxed items in whole Cases, and no server call.
 */
const addAllLowMutate = jest.fn();
const createOrderMutate = jest.fn();
const addItem = jest.fn();

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
  // p3 is already in the cart: Add all low must not add it again.
  useBuyerCart: () => ({
    items: [{ productId: "p3", name: "Cups", qty: 1 }],
    itemCount: 1,
    totalQty: 1,
    addItem,
  }),
}));

const est = (over: Record<string, unknown>) => ({
  name: "x",
  unit: "ea",
  state: "low",
  snoozed: false,
  lastOrderedAt: "2026-09-01T00:00:00Z",
  cadenceDays: 7,
  imageUrl: null,
  unitsPerBox: null,
  suggestedQty: 1,
  ...over,
});

jest.mock("@/lib/api/buyer", () => ({
  useBuyerShelf: () => ({
    isLoading: false,
    isError: false,
    data: {
      estimates: [
        est({ productId: "p1", name: "Widget", suggestedQty: 3 }),
        est({ productId: "p2", name: "Juice", suggestedQty: 24, unitsPerBox: 12 }),
        est({ productId: "p3", name: "Cups", suggestedQty: 2 }),
        est({ productId: "p4", name: "Napkins", state: "due-soon", suggestedQty: 5 }),
        est({ productId: "p5", name: "Lids", snoozed: true, suggestedQty: 5 }),
      ],
    },
  }),
  useBuyerCreateOrder: () => ({ mutateAsync: createOrderMutate, isPending: false }),
  useSnoozeReplenishment: () => ({ mutateAsync: jest.fn() }),
  useUnsnoozeReplenishment: () => ({ mutateAsync: jest.fn() }),
  useAddAllLow: () => ({ mutate: addAllLowMutate, mutateAsync: addAllLowMutate, isPending: false }),
}));

beforeEach(() => jest.clearAllMocks());

describe("buyer shelf Add all low fills the cart like Add (row 702)", () => {
  it("adds each running-low item not yet in the cart, and never calls the server", async () => {
    render(<BuyerShelfPage />);
    fireEvent.click(await screen.findByRole("button", { name: /add all low to cart/i }));
    expect(addAllLowMutate).not.toHaveBeenCalled();
    expect(createOrderMutate).not.toHaveBeenCalled();
    const lines = addItem.mock.calls.map((c) => c[0]);
    expect(lines.map((l) => l.productId).sort()).toEqual(["p1", "p2"]);
    expect(lines.find((l) => l.productId === "p1")).toMatchObject({ name: "Widget", qty: 3 });
    // 24 suggested pieces on a 12/box product = 2 whole Cases (qty in pieces), exactly as the single Add writes it.
    expect(lines.find((l) => l.productId === "p2")).toMatchObject({ name: "Juice", qty: 24 });
  });

  it("counts only the running-low items it would add (not those already in the cart)", async () => {
    render(<BuyerShelfPage />);
    const btn = await screen.findByRole("button", { name: /add all low to cart/i });
    // p1 and p2 are not in the cart here, so the button is on; the count shows only what it would add.
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent("Add all low to cart (2)");
  });
});
