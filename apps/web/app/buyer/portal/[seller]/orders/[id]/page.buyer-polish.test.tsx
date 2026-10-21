import * as React from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * Row 604 (UX run 2026-10-21, Director rows 14 + 15): buyer order detail polish (P29-P35) and
 * "Order again" (F32). Fixtures are placeholders; no live-client names.
 */

const push = jest.fn();
const addItem = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "ord-1" }),
  useRouter: () => ({ push }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    buyer: { id: "b1" },
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));
jest.mock("@/lib/buyer-cart", () => ({
  useBuyerCart: () => ({ items: [], itemCount: 0, totalQty: 0, addItem }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: { portalMethods: [], portalDefault: null, fleet: true },
    isLoading: false,
    isError: false,
  }),
}));

let mockOrder: unknown;
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "PENDING", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerOrder: () => ({ data: mockOrder, isLoading: false, isError: false }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerProducts: () => ({ data: undefined }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

const base = {
  priceType: "STANDARD",
  originalPrice: null,
  notes: null,
  status: "DELIVERED",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
};
const PLAIN = {
  ...base,
  id: "li-1",
  productId: "p-1",
  qty: 2,
  unitPrice: 10,
  subtotal: 20,
  product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: null },
};
const BOXED = {
  ...base,
  id: "li-2",
  productId: "p-2",
  qty: 24,
  boxes: 2,
  pieces: 0,
  unitPrice: 1,
  subtotal: 24,
  product: { id: "p-2", name: "Sample Water", unit: "each", unitsPerBox: 12 },
};
const GONE = { ...PLAIN, id: "li-3", productId: "p-3", status: "CANCELLED" };
const CUSTOM = { ...PLAIN, id: "li-4", productId: null, product: null, name: "Surcharge" };

function order(lineItems: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "PENDING",
    total: 44,
    subtotal: 44,
    tax: 0,
    discountAmount: 0,
    createdAt: "2026-09-10T12:00:00Z",
    requestedDeliveryDate: null,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    lineItems,
    invoices: [],
    changeRequests: [],
    editWindow: { editable: true, editableUntil: null, closedReason: null },
    routeRun: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buyer order detail - polish (P29-P35)", () => {
  it("P29: Cancel Order is an outline button with a 44 px target, not a filled red one", () => {
    mockOrder = order([PLAIN]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const btn = screen.getAllByRole("button", { name: "Cancel Order" })[0];
    expect(btn).toHaveClass("text-danger");
    expect(btn).not.toHaveClass("bg-danger");
    expect(btn).toHaveClass("min-h-[44px]");
  });

  it("P30: the tracking card does not repeat 'Not scheduled' as a pill over its own heading", () => {
    mockOrder = order([PLAIN]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByTestId("tracking-headline")).toHaveTextContent("Not scheduled yet");
    expect(screen.queryByTestId("tracking-status")).toBeNull();
  });

  it("P31: the four money figures live in ONE summary card", () => {
    mockOrder = order([PLAIN], { subtotal: 40, tax: 2, discountAmount: 3, total: 39 });
    renderWithProviders(<BuyerOrderDetailPage />);
    const card = screen.getByTestId("order-summary");
    for (const label of ["Subtotal", "Tax", "Discount", "Total"]) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    expect(within(card).getByText("$39.00")).toBeInTheDocument();
    expect(within(card).getByText("-$3.00")).toBeInTheDocument();
  });

  it("P32: at phone width only the current timeline step keeps its label", () => {
    mockOrder = order([PLAIN]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const steps = screen.getAllByTestId("timeline-step");
    const current = steps.find((s) => s.getAttribute("data-state") === "current")!;
    const label = (s: HTMLElement) => s.querySelector("span") as HTMLElement;
    expect(label(current)).not.toHaveClass("max-sm:hidden");
    for (const s of steps.filter((x) => x !== current)) {
      expect(label(s)).toHaveClass("max-sm:hidden");
    }
  });

  it("P33: the items table no longer forces a 640 px minimum width at phone size", () => {
    mockOrder = order([PLAIN]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const table = screen.getByRole("table");
    expect(table.className).not.toMatch(/(^|\s)min-w-\[640px\]/);
    expect(screen.getByRole("columnheader", { name: /unit price/i })).toHaveClass("max-sm:hidden");
  });

  it("P34: both header dates use one format", () => {
    mockOrder = order([PLAIN], { requestedDeliveryDate: "2026-09-15T00:00:00Z" });
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByText(/Placed/)).toHaveTextContent(
      "Placed Sep 10, 2026 · Delivery requested Sep 15, 2026",
    );
  });

  it("P35: the status badge sits with the order number, not at the far edge", () => {
    mockOrder = order([PLAIN]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.parentElement).toContainElement(screen.getByTestId("order-status-badge"));
  });
});

describe("buyer order detail - Order again (F32)", () => {
  it("a delivered order offers Order again beside Items; it fills the cart and opens it", () => {
    mockOrder = order([PLAIN, BOXED, GONE, CUSTOM], { status: "DELIVERED" });
    renderWithProviders(<BuyerOrderDetailPage />);
    const btn = screen.getByRole("button", { name: /order again/i });
    expect(btn).toHaveClass("min-h-[44px]");
    fireEvent.click(btn);

    expect(addItem).toHaveBeenCalledTimes(2); // cancelled and custom lines are not re-ordered
    expect(addItem.mock.calls[0][0]).toMatchObject({
      productId: "p-1",
      name: "Sample Cola 12oz",
      qty: 2,
    });
    expect(addItem.mock.calls[1][0]).toMatchObject({
      productId: "p-2",
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
    });
    expect(push).toHaveBeenCalledWith("/buyer/portal/acme/cart");
  });

  it("row 604 M2: a CANCELLED order (every line CANCELLED) adds its catalog lines", () => {
    mockOrder = order(
      [
        { ...PLAIN, status: "CANCELLED" },
        { ...BOXED, status: "CANCELLED" },
      ],
      { status: "CANCELLED" },
    );
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /order again/i }));
    expect(addItem).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledWith("/buyer/portal/acme/cart");
  });

  it("row 604 M2: nothing addable shows a plain toast and does not navigate", async () => {
    mockOrder = order([CUSTOM], { status: "DELIVERED" });
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /order again/i }));
    expect(
      await screen.findByText("Nothing from this order can be added to your cart."),
    ).toBeInTheDocument();
    expect(addItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("an open (pending) order does not offer it", () => {
    mockOrder = order([PLAIN], { status: "PENDING" });
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByRole("button", { name: /order again/i })).toBeNull();
  });
});
