import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import BuyerDashboardPage from "./page";

/**
 * The buyer home reads the SAME `acceptingOrders` capability the shop and the cart read: a paused seller
 * gets the one quiet line, every Add and the standing-order Reorder are disabled with that line as their
 * reason, and a healthy / loading / unknown seller changes nothing.
 */
const addItem = jest.fn();
let mockCapability: { data?: { acceptingOrders?: boolean }; isLoading: boolean } = {
  isLoading: false,
};

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
  useBuyerCart: () => ({ items: [], itemCount: 0, totalQty: 0, addItem }),
}));
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => mockCapability,
}));

const product = (id: string) => ({
  id,
  productId: id,
  name: `Product ${id}`,
  unit: "box",
  thumbnailUrl: null,
  buyerPrice: 10,
});
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
      frequentlyOrdered: [product("f1")],
      newFromSeller: [product("n1")],
      featuredItems: [product("x1")],
      suggestedItems: [product("s1")],
    },
  }),
  useBuyerTemplates: () => ({ data: { data: [template], meta: { total: 1 } }, isLoading: false }),
  useBuyerShelf: () => ({ data: undefined }),
  useBuyerReorder: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBuyerProducts: () => ({ isLoading: false, isError: false, data: { data: [] } }),
  useBuyerPromotions: () => ({ isLoading: false, isError: false, data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockCapability = { isLoading: false };
});

describe("buyer dashboard — paused seller", () => {
  it("paused: the one line is shown and every Add + Reorder is disabled, pointing at it", async () => {
    mockCapability = { data: { acceptingOrders: false }, isLoading: false };
    render(<BuyerDashboardPage />);

    expect(await screen.findByTestId("seller-unavailable-line")).toHaveTextContent(
      "Acme Foods isn't taking online orders right now. Please check back soon or contact them.",
    );
    const adds = screen.getAllByRole("button", { name: /^add$/i });
    expect(adds).toHaveLength(4);
    for (const add of adds) {
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute("aria-describedby", "seller-unavailable-line");
    }
    const reorder = screen.getByRole("button", { name: /^reorder$/i });
    expect(reorder).toBeDisabled();
    expect(reorder).toHaveAttribute("aria-describedby", "seller-unavailable-line");
  });

  it("paused: a click on Add never reaches the cart and Reorder never opens the review", async () => {
    mockCapability = { data: { acceptingOrders: false }, isLoading: false };
    const user = userEvent.setup();
    render(<BuyerDashboardPage />);

    for (const add of await screen.findAllByRole("button", { name: /^add$/i })) {
      await user.click(add);
    }
    await user.click(screen.getByRole("button", { name: /^reorder$/i }));

    expect(addItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("accepting, loading or unknown: no line and every control stays live", async () => {
    for (const cap of [
      { data: { acceptingOrders: true }, isLoading: false },
      { data: undefined, isLoading: true },
      { data: {}, isLoading: false },
    ]) {
      mockCapability = cap;
      const { unmount } = render(<BuyerDashboardPage />);
      await screen.findAllByRole("button", { name: /^add$/i });
      expect(screen.queryByTestId("seller-unavailable-line")).toBeNull();
      for (const add of screen.getAllByRole("button", { name: /^add$/i })) {
        expect(add).toBeEnabled();
      }
      expect(screen.getByRole("button", { name: /^reorder$/i })).toBeEnabled();
      unmount();
    }
  });
});
