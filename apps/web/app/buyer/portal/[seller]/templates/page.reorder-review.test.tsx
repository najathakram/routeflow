import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import BuyerTemplatesPage from "./page";

/**
 * "Reorder Now" places a REAL order, so a tap must only open a review (lines + total); the
 * order is placed from the sheet's "Place order" button and never before it.
 */
const mutateAsync = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { slug: "acme", tenant: { name: "Acme Foods" } },
    isLoading: false,
  }),
}));

const template = {
  id: "t1",
  name: "Weekly restock",
  isActive: true,
  daysOfWeek: [1],
  notes: null,
  nextFireDate: null,
  customer: { id: "c1", businessName: "Corner Shop" },
  items: [
    {
      id: "i1",
      productId: "p1",
      qty: 2,
      notes: null,
      product: { id: "p1", name: "Oat Milk", unit: "box" },
    },
    {
      id: "i2",
      productId: "p2",
      qty: 3,
      notes: null,
      product: { id: "p2", name: "Almond Bar", unit: "each" },
    },
  ],
};

jest.mock("@/lib/api/buyer", () => ({
  useBuyerTemplates: () => ({ data: { data: [template], meta: { total: 1 } }, isLoading: false }),
  useBuyerReorder: () => ({ mutateAsync, isPending: false }),
  useBuyerProducts: () => ({
    isLoading: false,
    isError: false,
    data: {
      data: [
        { id: "p1", buyerPrice: 30, category: null, unitsPerBox: 12 },
        { id: "p2", buyerPrice: 2.5, category: null, unitsPerBox: null },
      ],
    },
  }),
  useBuyerPromotions: () => ({ isLoading: false, isError: false, data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "o1" });
});

describe("buyer standing orders — Reorder Now review", () => {
  it("tapping Reorder Now does NOT place the order; it opens a review with the lines and total", async () => {
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));

    expect(mutateAsync).not.toHaveBeenCalled();
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Oat Milk")).toBeInTheDocument();
    expect(dialog.getByText("2 box")).toBeInTheDocument();
    expect(dialog.getByText("$60.00")).toBeInTheDocument();
    expect(dialog.getByText("Almond Bar")).toBeInTheDocument();
    expect(dialog.getByText("3 each")).toBeInTheDocument();
    expect(dialog.getByText("$7.50")).toBeInTheDocument();
    expect(dialog.getByText("$67.50")).toBeInTheDocument();
  });

  it("Place order in the review places the order exactly once, for that template", async () => {
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Place order" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith("t1");
  });

  it("cancelling the review never places the order", async () => {
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
