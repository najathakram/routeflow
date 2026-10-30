import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * Row 380: the buyer's order edit sends the `revisionNumber` it loaded when edit mode opened, and a 409
 * ORDER_REVISION_STALE shows fixed copy with a Reload instead of a raw server sentence.
 * Fixtures are placeholders (`Sample …`); no live-client names.
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "ord-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: { portalMethods: [], portalDefault: null, fleet: true },
    isLoading: false,
    isError: false,
  }),
}));

let mockOrder: unknown;
const mockRefetch = jest.fn();
const mockUpdateItems = jest.fn().mockResolvedValue({});
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "PENDING", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerOrder: () => ({
    data: mockOrder,
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({
    mutateAsync: mockUpdateItems,
    mutate: jest.fn(),
    isPending: false,
  }),
  useBuyerProducts: () => ({ data: undefined }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

const LISTED = {
  id: "li-1",
  productId: "p-1",
  qty: 2,
  unitPrice: 10,
  subtotal: 20,
  priceType: "STANDARD",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
  product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: null },
};

const order = (revisionNumber: number | undefined) => ({
  id: "ord-1",
  orderNumber: "ORD-00001",
  status: "PENDING",
  total: 20,
  subtotal: 20,
  taxAmount: 0,
  createdAt: "2026-09-10T12:00:00Z",
  requestedDeliveryDate: null,
  customer: { id: "c-1", businessName: "Sample Buyer Co" },
  lineItems: [LISTED],
  invoices: [],
  changeRequests: [],
  editWindow: { editable: true, editableUntil: null, closedReason: null },
  routeRun: null,
  revisionNumber,
});

beforeEach(() => jest.clearAllMocks());

describe("buyer order edit revision guard (row 380)", () => {
  it("Save sends the revision the editor loaded", async () => {
    mockOrder = order(4);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ord-1", expectedRevisionNumber: 4 }),
    );
  });

  it("a background refetch while editing never moves the revision it sends", async () => {
    mockOrder = order(4);
    const { rerender } = renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    mockOrder = order(5);
    rerender(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems.mock.calls[0][0].expectedRevisionNumber).toBe(4);
  });

  it("a 409 ORDER_REVISION_STALE shows fixed copy and Reload refetches the order", async () => {
    mockUpdateItems.mockRejectedValueOnce({
      response: { status: 409, data: { code: "ORDER_REVISION_STALE", message: "server words" } },
    });
    mockOrder = order(4);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(
      await screen.findByText(/Someone changed this order while you were editing/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/server words/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload order" }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("while the order is stale Save and Cancel are not offered, and the notice is a full-width 44px amber warning", async () => {
    mockUpdateItems.mockRejectedValueOnce({
      response: { status: 409, data: { code: "ORDER_REVISION_STALE" } },
    });
    mockOrder = order(4);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const reload = await screen.findByRole("button", { name: "Reload order" });
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
    expect(reload).toHaveClass("w-full", "min-h-[44px]");
    const notice = screen.getByRole("alert");
    expect(notice).toHaveClass("bg-warning-bg", "text-amber-900"); // 8.15:1 on #fef3c7 (text-warning is 2.86:1)
    expect(notice).not.toHaveClass("bg-danger-bg");
  });

  it("while the order is stale the steppers, delete and product search are inert", async () => {
    mockUpdateItems.mockRejectedValueOnce({
      response: { status: 409, data: { code: "ORDER_REVISION_STALE" } },
    });
    mockOrder = order(4);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.getByTitle("Remove item")).toBeEnabled();
    expect(screen.getByRole("spinbutton")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await screen.findByRole("button", { name: "Reload order" });
    expect(screen.getByTitle("Remove item")).toBeDisabled();
    // the × is named for its line and dims like its siblings
    const remove = screen.getByRole("button", { name: "Remove Sample Cola 12oz" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveClass("disabled:opacity-40");
    expect(screen.getByRole("spinbutton")).toBeDisabled();
    expect(screen.getByPlaceholderText(/search products to add/i)).toBeDisabled();
    const stepButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-minus, svg.lucide-plus"));
    expect(stepButtons).toHaveLength(2);
    stepButtons.forEach((b) => expect(b).toBeDisabled());
  });

  it("an order that sent no revision sends none", async () => {
    mockOrder = order(undefined);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems.mock.calls[0][0].expectedRevisionNumber).toBeUndefined();
  });
});
