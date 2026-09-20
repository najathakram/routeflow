import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * B586 — the buyer order detail crashed ("Cannot read properties of null (reading 'name')") for
 * any order containing a staff-added custom (unlisted) line: such a line has `product: null` and
 * its label in `name`. The page read `li.product.name` unguarded in the items table, the
 * change-request select and edit-mode entry.
 *
 * Fixtures are placeholders (`Sample …`); no live-client names.
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "ord-1" }),
  useRouter: () => ({ push }),
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

let mockOrder: unknown;
const mockUpdateItems = jest.fn().mockResolvedValue({});
jest.mock("@/lib/api/buyer", () => ({
  useBuyerOrder: () => ({ data: mockOrder, isLoading: false, isError: false }),
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

const CUSTOM = {
  id: "li-2",
  productId: null,
  name: "Delivery surcharge",
  qty: 1,
  unitPrice: 15,
  subtotal: 15,
  priceType: "MANUAL",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
  product: null,
};

function order(lineItems: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "PENDING",
    total: 35,
    subtotal: 35,
    taxAmount: 0,
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

describe("BuyerOrderDetailPage — order with a custom line (B586)", () => {
  it("REG-B586: renders instead of crashing, showing the custom line's own label", () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByText("Sample Cola 12oz")).toBeInTheDocument();
    expect(screen.getByText("Delivery surcharge")).toBeInTheDocument();
  });

  it("a custom line with no label at all reads 'Custom item'", () => {
    mockOrder = order([{ ...CUSTOM, name: null }]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByText("Custom item")).toBeInTheDocument();
  });

  it("Edit is still offered on an order with a custom line; edit mode lists only the catalog lines and says the custom item stays", () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByTestId("custom-line-edit-note")).toBeNull(); // only while editing
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));

    expect(screen.getByTestId("custom-line-edit-note")).toHaveTextContent("stay on your order");
    expect(screen.getByText("Sample Cola 12oz")).toBeInTheDocument();
    expect(screen.queryByText("Delivery surcharge")).toBeNull();
  });

  it("saving sends catalog lines only — the server keeps the seller's custom line (REG-B51)", async () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems).toHaveBeenCalledWith({
      orderId: "ord-1",
      items: [{ productId: "p-1", qty: 2 }],
    });
  });

  it("a custom line does not get a 'Special' pill (its MANUAL price type is not a customer special)", () => {
    mockOrder = order([CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByText("Special")).toBeNull();
  });

  it("cancelling is still available on such an order", () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByRole("button", { name: /cancel order/i })).toBeInTheDocument();
  });

  it("no custom-item note when the only custom line is cancelled", () => {
    mockOrder = order([LISTED, { ...CUSTOM, status: "CANCELLED" }]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.queryByTestId("custom-line-edit-note")).toBeNull();
  });

  it("an order of catalog lines only is unchanged: Edit is offered and enters edit mode", () => {
    mockOrder = order([LISTED]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    expect(screen.queryByTestId("custom-line-edit-note")).toBeNull();
  });

  it("the change-request line picker labels a custom line instead of crashing", () => {
    mockOrder = order([LISTED, CUSTOM], {
      status: "OUT_FOR_DELIVERY",
      editWindow: { editable: false, editableUntil: null, closedReason: "DISPATCHED" },
      routeRun: { status: "IN_PROGRESS" },
    });
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /request a change/i }));
    fireEvent.click(screen.getByRole("button", { name: "Change a quantity" }));
    expect(screen.getByRole("option", { name: "Delivery surcharge (qty 1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sample Cola 12oz (qty 2)" })).toBeInTheDocument();
  });
});
