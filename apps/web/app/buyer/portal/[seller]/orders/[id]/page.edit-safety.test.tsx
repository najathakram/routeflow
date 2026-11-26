import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * UX audit 2026-11-24, findings F72 and F74 on the buyer's order page.
 * F72: while editing items the page showed a white "Cancel" (drop my edits) beside "Save changes" and a red
 * "Cancel order" (kill the order) below. Two Cancels, one of them final. The edit one reads "Discard changes" and
 * the red one is hidden until the edit is saved or discarded.
 * F74: a successful save changed the numbers and said nothing. It says "Changes saved" now.
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

const startEdit = () => {
  mockOrder = order(4);
  renderWithProviders(<BuyerOrderDetailPage />);
  fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
};

describe("buyer order edit: one Cancel at a time", () => {
  it("before editing, Cancel order is offered", () => {
    mockOrder = order(4);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
  });

  it("while editing, the way out reads Discard changes and no button reads just Cancel", () => {
    startEdit();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("while editing, Cancel order is not on the page", () => {
    startEdit();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
  });

  it("Discard changes leaves edit mode without saving, and Cancel order is back", () => {
    startEdit();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(mockUpdateItems).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
  });
});

describe("buyer order edit: a save says it worked", () => {
  it("a successful save shows Changes saved", async () => {
    startEdit();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("a refused save does not claim success", async () => {
    mockUpdateItems.mockRejectedValueOnce({
      response: { status: 409, data: { code: "ORDER_REVISION_STALE", message: "server words" } },
    });
    startEdit();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Someone changed this order while you were editing/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });
});
