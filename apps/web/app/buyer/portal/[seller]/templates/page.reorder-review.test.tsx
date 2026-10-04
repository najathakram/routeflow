import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import BuyerTemplatesPage from "./page";

/**
 * "Reorder Now" places a REAL order, so a tap must only open a review (lines + total); the
 * order is placed from the sheet's "Place order" button and never before it.
 */
const mutateAsync = jest.fn();
const mockUseBuyerReorder = jest.fn();

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

let mockCatalog: Array<Record<string, unknown>> = [
  { id: "p1", buyerPrice: 30, category: null, unitsPerBox: 12 },
  { id: "p2", buyerPrice: 2.5, category: null, unitsPerBox: null },
];

jest.mock("@/lib/api/buyer", () => ({
  useBuyerTemplates: () => ({ data: { data: [template], meta: { total: 1 } }, isLoading: false }),
  useBuyerReorder: (...a: unknown[]) => {
    mockUseBuyerReorder(...a);
    return { mutateAsync, isPending: false };
  },
  useBuyerProducts: () => ({
    isLoading: false,
    isError: false,
    data: { data: mockCatalog },
  }),
  useBuyerPromotions: () => ({ isLoading: false, isError: false, data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "o1" });
  mockCatalog = [
    { id: "p1", buyerPrice: 30, category: null, unitsPerBox: 12 },
    { id: "p2", buyerPrice: 2.5, category: null, unitsPerBox: null },
  ];
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

  it("a failed placement keeps the review open with FIXED copy and never shows the server's text", async () => {
    mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: { status: 400, data: { message: "Product 9f3c-uuid not found" } },
      }),
    );
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Place order" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(/couldn't place this order/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/uuid|not found/i)).not.toBeInTheDocument();
  });

  it("a successful placement closes the review", async () => {
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Place order" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a line with no catalog price is listed as 'Price on confirmation', not dropped", async () => {
    mockCatalog = [{ id: "p1", buyerPrice: 30, category: null, unitsPerBox: 12 }];
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByText("Almond Bar")).toBeInTheDocument();
    expect(dialog.getByText("Price on confirmation")).toBeInTheDocument();
    expect(dialog.getAllByText("$60.00")).toHaveLength(2); // the line and the estimated total
    expect(dialog.getByRole("button", { name: "Place order" })).toBeEnabled();
    // A license-gated or banned line is skipped by the server, so never promise it is ordered.
    expect(dialog.getByText(/may also be left out of the order/i)).toBeInTheDocument();
    expect(dialog.queryByText(/still on the order/i)).not.toBeInTheDocument();
  });

  it("when NO line can be priced there is no total and Place order stays disabled", async () => {
    mockCatalog = [];
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);

    await user.click(await screen.findByRole("button", { name: /reorder now/i }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByRole("button", { name: "Place order" })).toBeDisabled();
    expect(dialog.queryByText("$0.00")).not.toBeInTheDocument();
    expect(dialog.queryByText(/estimated total/i)).not.toBeInTheDocument();
    expect(dialog.getByRole("alert")).toHaveTextContent(/can be priced here/i);
  });

  it("the reorder mutation opts out of the global error toast, so a failure shows ONE message (the sheet's)", async () => {
    const user = userEvent.setup();
    render(<BuyerTemplatesPage />);
    await screen.findAllByRole("button", { name: /reorder now/i });
    expect(mockUseBuyerReorder).toHaveBeenCalledWith({ localErrorToast: true });
  });
});
