import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * SA-1118 / SA-1131 R-3 (guard): the buyer editor's full state sequence, remove a named box-split row then add the
 * same product back from search, sends that product as an unnamed bare count `{ productId, qty: 1 }` with no
 * `orderItemId`. That is the shape the server reads as the pack under `namesLines: true` (SA-601, SA-1118 R-1).
 * Green on master; this pins the client half so a change to either step shows up here.
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

const mockUpdateItems = jest.fn().mockResolvedValue({});
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "PENDING", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerOrder: () => ({ data: ORDER, isLoading: false, isError: false, refetch: jest.fn() }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({
    mutateAsync: mockUpdateItems,
    mutate: jest.fn(),
    isPending: false,
  }),
  useBuyerProducts: () => ({
    data: { data: [{ id: "p-1", name: "Sample Cola 12oz", unit: "case", buyerPrice: 48 }] },
  }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

// A named box-split line: 2 boxes of 12, stored as 24 pieces.
const BOXED = {
  id: "li-1",
  productId: "p-1",
  qty: 24,
  unitPrice: 4,
  subtotal: 96,
  priceType: "STANDARD",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: 2,
  pieces: 0,
  product: { id: "p-1", name: "Sample Cola 12oz", unit: "case", unitsPerBox: 12 },
};

const ORDER = {
  id: "ord-1",
  orderNumber: "ORD-00001",
  status: "PENDING",
  total: 96,
  subtotal: 96,
  taxAmount: 0,
  createdAt: "2026-09-10T12:00:00Z",
  requestedDeliveryDate: null,
  customer: { id: "c-1", businessName: "Sample Buyer Co" },
  lineItems: [BOXED],
  invoices: [],
  changeRequests: [],
  editWindow: { editable: true, editableUntil: null, closedReason: null },
  routeRun: null,
  revisionNumber: 3,
};

beforeEach(() => jest.clearAllMocks());

describe("buyer editor remove then re-add (SA-1131 R-3)", () => {
  it("R-3: removing a named box-split row and adding the product back sends { productId, qty: 1 } with no orderItemId", async () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));

    // Before the remove, the product is on the order, so search hides it.
    fireEvent.change(screen.getByPlaceholderText(/search products to add/i), {
      target: { value: "cola" },
    });
    expect(await screen.findByText("All results already in order")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Sample Cola 12oz" }));
    fireEvent.click(await screen.findByRole("button", { name: /Sample Cola 12oz/ }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems.mock.calls[0][0].items).toEqual([{ productId: "p-1", qty: 1 }]);
  });
});
