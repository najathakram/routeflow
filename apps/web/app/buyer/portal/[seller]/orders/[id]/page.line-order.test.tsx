import * as React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * W-1187 PR-2c (BR8, BR9, BG-g): a buyer arranges their OWN order's lines while the edit window is open.
 * Master draws no handle and sends nothing. Fixtures are placeholders (`Sample ...`).
 */
const mockPut = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: {
    put: (...a: unknown[]) => mockPut(...a),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

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

let current: Record<string, unknown>;
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "PENDING", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerOrder: () => ({ data: current, isLoading: false, isError: false, refetch: jest.fn() }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerProducts: () => ({ data: { data: [] } }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

const line = (id: string, name: string) => ({
  id,
  productId: `p-${id}`,
  qty: 1,
  unitPrice: 10,
  subtotal: 10,
  priceType: "STANDARD",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
  product: { id: `p-${id}`, name, unit: "each" },
});
const STAMP = "2026-11-11T08:00:00.000Z";
const base = () => ({
  id: "ord-1",
  orderNumber: "ORD-00001",
  status: "PENDING",
  total: 30,
  subtotal: 30,
  taxAmount: 0,
  createdAt: "2026-11-10T12:00:00Z",
  requestedDeliveryDate: null,
  customer: { id: "c-1", businessName: "Sample Buyer Co" },
  lineItems: [line("l1", "Sample Apple"), line("l2", "Sample Pear"), line("l3", "Sample Zucchini")],
  invoices: [],
  changeRequests: [],
  editWindow: { editable: true, editableUntil: null, closedReason: null },
  routeRun: null,
  revisionNumber: 3,
  updatedAt: STAMP,
});

beforeEach(() => {
  mockPut.mockReset();
  mockPut.mockResolvedValue({
    data: { id: "ord-1", updatedAt: "2026-11-11T08:00:05.000Z", lineIds: ["l2", "l1", "l3"] },
  });
  current = base();
});

describe("buyer order page: arranging your own lines (W-1187 PR-2c)", () => {
  it("BR8: one handle per line, named by product and place", () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(
      screen.getByRole("button", { name: "Move Sample Apple, line 1 of 3" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Move / })).toHaveLength(3);
  });

  it("BR9: Alt+Down on a handle sends ONE PUT to the buyer route with the full permutation and updatedAt", async () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: /Move Sample Apple, line 1 of 3/ }), {
        key: "ArrowDown",
        altKey: true,
      });
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith("/buyer/orders/ord-1/line-order", {
      expectedUpdatedAt: STAMP,
      lineIds: ["l2", "l1", "l3"],
    });
  });

  it("Sort A–Z sends sort name to the buyer route", async () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sort A–Z" }));
    });
    expect(mockPut).toHaveBeenCalledWith("/buyer/orders/ord-1/line-order", {
      expectedUpdatedAt: STAMP,
      sort: "name",
    });
  });

  it("BG-g: a closed edit window shows no handles and no Sort A–Z", () => {
    current = {
      ...base(),
      status: "OUT_FOR_DELIVERY",
      editWindow: { editable: false, editableUntil: null, closedReason: "DISPATCHED" },
    };
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort A–Z" })).toBeNull();
  });

  it("an older server answer without updatedAt keeps the list read-only", () => {
    current = { ...base(), updatedAt: undefined };
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("no handles while the items editor is open", () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });
});
