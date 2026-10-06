import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * B1135: an order that has shipped (with the carrier) has no change request to send: the API answers
 * 409 ORDER_WITH_CARRIER_NO_CHANGE_REQUEST. The buyer's request form shows the fixed shipped sentence
 * for it, not the server's text and not the generic "Failed to send the change request." A carrier
 * order has no route run, so the page never offers "Request a change" for one in the first place.
 *
 * Fixtures are placeholders; no live-client names.
 */
const SHIPPED = "This order has already shipped. Contact the seller for changes.";

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

let mockOrder: unknown;
const mockCreateCr = jest.fn();
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "OUT_FOR_DELIVERY", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerOrder: () => ({ data: mockOrder, isLoading: false, isError: false }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerProducts: () => ({ data: undefined }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: (...a: unknown[]) => mockCreateCr(...a),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

const LINE = {
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

const dispatched = (routeRun: unknown) => ({
  id: "ord-1",
  orderNumber: "ORD-00001",
  status: "OUT_FOR_DELIVERY",
  total: 20,
  subtotal: 20,
  taxAmount: 0,
  createdAt: "2026-09-10T12:00:00Z",
  requestedDeliveryDate: null,
  customer: { id: "c-1", businessName: "Sample Buyer Co" },
  lineItems: [LINE],
  invoices: [],
  changeRequests: [],
  editWindow: { editable: false, editableUntil: null, closedReason: "DISPATCHED" },
  routeRun,
});

beforeEach(() => jest.clearAllMocks());

describe("BuyerOrderDetailPage: change requests on a shipped order (B1135)", () => {
  it("a refused request shows the fixed shipped sentence, not the server text or the generic failure", async () => {
    mockOrder = dispatched({ status: "IN_PROGRESS" });
    mockCreateCr.mockRejectedValue({
      response: {
        status: 409,
        data: { code: "ORDER_WITH_CARRIER_NO_CHANGE_REQUEST", message: "server wording" },
      },
    });
    renderWithProviders(<BuyerOrderDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: /request a change/i }));
    fireEvent.click(screen.getByRole("button", { name: "Note for the driver" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add one case" } });
    fireEvent.click(screen.getByRole("button", { name: /send request/i }));

    await waitFor(() => expect(screen.getByText(SHIPPED)).toBeInTheDocument());
    expect(screen.queryByText(/Failed to send the change request/i)).toBeNull();
    expect(screen.queryByText("server wording")).toBeNull();
  });

  it("a carrier order (no route run) is never offered a change request", () => {
    mockOrder = dispatched(null);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByRole("button", { name: /request a change/i })).toBeNull();
    expect(screen.queryByText(/send a change request/i)).toBeNull();
  });
});
