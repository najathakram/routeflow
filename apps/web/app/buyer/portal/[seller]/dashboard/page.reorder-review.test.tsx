import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import BuyerDashboardPage from "./page";

/**
 * The dashboard's Standing Orders "Reorder" places a REAL order, so the tap only opens a
 * review (lines + total); the order is placed from "Place order" and never before it.
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
    activeSeller: { slug: "acme", tenant: { name: "Acme Foods" }, customer: null },
    isLoading: false,
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({ items: [], itemCount: 0, totalQty: 0, addItem: jest.fn() }),
}));
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));

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
  ],
};

jest.mock("@/lib/api/buyer", () => ({
  useBuyerDashboard: () => ({
    isLoading: false,
    isError: false,
    data: {
      recentOrders: [],
      stats: {
        activeOrders: 0,
        pendingDeliveries: 0,
        templateCount: 1,
        spend30d: 0,
        spend90d: 0,
        spendAllTime: 0,
      },
      frequentlyOrdered: [],
      newFromSeller: [],
      featuredItems: [],
      suggestedItems: [],
    },
  }),
  useBuyerTemplates: () => ({ data: { data: [template], meta: { total: 1 } }, isLoading: false }),
  useBuyerShelf: () => ({ data: undefined }),
  useBuyerReorder: (...a: unknown[]) => {
    mockUseBuyerReorder(...a);
    return { mutateAsync, isPending: false };
  },
  useBuyerProducts: () => ({
    isLoading: false,
    isError: false,
    data: { data: [{ id: "p1", buyerPrice: 30, category: null, unitsPerBox: 12 }] },
  }),
  useBuyerPromotions: () => ({ isLoading: false, isError: false, data: [] }),
  toPromotionRules: () => [],
}));

// The dashboard's Recent Orders badge reads the seller's capabilities (a react-query hook, kept out
// of "@/lib/api/buyer"); this suite has no QueryClient and no recent orders, so an unset seller will do.
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "o1" });
});

describe("buyer dashboard — Standing Orders Reorder review", () => {
  it("tapping Reorder does NOT place the order; it opens a review with the lines and total", async () => {
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);

    await user.click(await screen.findByRole("button", { name: /^reorder$/i }));

    expect(mutateAsync).not.toHaveBeenCalled();
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Oat Milk")).toBeInTheDocument();
    expect(dialog.getByText("2 box")).toBeInTheDocument();
    expect(dialog.getAllByText("$60.00").length).toBeGreaterThan(0);
  });

  it("Place order places it exactly once; a failure keeps the review open with fixed copy", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("boom: internal detail"));
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);

    await user.click(await screen.findByRole("button", { name: /^reorder$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Place order" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith("t1");
    expect(await dialog.findByRole("alert")).toHaveTextContent(/couldn't place this order/i);
    expect(screen.queryByText(/internal detail/)).not.toBeInTheDocument();
  });

  it("a paused seller (403 SELLER_UNAVAILABLE) says so in the sheet, never the generic failure", async () => {
    mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: { status: 403, data: { code: "SELLER_UNAVAILABLE", message: "x" } },
      }),
    );
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);

    await user.click(await screen.findByRole("button", { name: /^reorder$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Place order" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Acme Foods isn't taking online orders right now. Please check back soon or contact them.",
    );
    expect(screen.queryByText(/permission|couldn't place/i)).toBeNull();
  });

  it("cancelling the review never places the order", async () => {
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);

    await user.click(await screen.findByRole("button", { name: /^reorder$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("the reorder mutation opts out of the global error toast, so a failure shows ONE message (the sheet's)", async () => {
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);
    await screen.findAllByRole("button", { name: /^reorder$/i });
    expect(mockUseBuyerReorder).toHaveBeenCalledWith({ localErrorToast: true });
  });
});

describe("buyer dashboard — reorder leaves out lines the portal no longer offers", () => {
  it("some skipped: the order is placed and the buyer is told how many were left out", async () => {
    mutateAsync.mockResolvedValueOnce({
      id: "o1",
      skipped: [{ productId: "x" }, { productId: "y" }],
    });
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);
    await user.click(await screen.findByRole("button", { name: /^reorder$/i }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Place order" }),
    );
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("reorder-skipped-note")).toHaveTextContent(
      "2 items aren't available to you and were left out.",
    );
  });

  it("all skipped: no order, the sheet stays and says none are available", async () => {
    mutateAsync.mockResolvedValueOnce({ skipped: [{ productId: "x" }] });
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);
    await user.click(await screen.findByRole("button", { name: /^reorder$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Place order" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "None of these items are available to you right now.",
    );
  });
});
