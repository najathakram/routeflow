import * as React from "react";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * B1387 (SA-1286): the buyer order read view printed the raw piece qty ("36") beside the BOX price
 * ($18.00) with a hand-built "3 boxes" sub-line, and its Delivered / Remaining cells counted pieces
 * too ("12"). deliveredQty is written against qty (delivered-stamp.ts), so on a split line it counts
 * pieces. The cells now read through invoiceLineQtyText at the line's own stored unitsPerBox.
 * Fixtures are placeholders (`Sample ...`, `acme`).
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

let mockOrder: unknown;
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "PARTIALLY_DELIVERED", tracking: null },
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

jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: { portalMethods: ["ROUTE"], portalDefault: "ROUTE", fleet: true },
    isLoading: false,
    isError: false,
  }),
}));

function line(over: Record<string, unknown> = {}) {
  return {
    id: "li-1",
    productId: "p-1",
    qty: 36,
    unitPrice: 18,
    subtotal: 54,
    priceType: "STANDARD",
    originalPrice: null,
    notes: null,
    status: "PENDING",
    deliveredQty: 12,
    boxes: 3,
    pieces: 0,
    unitsPerBox: 12,
    product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: 12 },
    ...over,
  };
}

function order(lineItems: unknown[]) {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "PARTIALLY_DELIVERED",
    total: 54,
    subtotal: 54,
    taxAmount: 0,
    createdAt: "2026-09-10T12:00:00Z",
    requestedDeliveryDate: null,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    lineItems,
    invoices: [],
    changeRequests: [],
    editWindow: { editable: false, editableUntil: null, closedReason: null },
    routeRun: null,
    fulfillPath: "ROUTE",
    shippingCarrier: null,
    shippingTrackingNumber: null,
    shippedAt: null,
  };
}

/** product, qty, delivered, remaining, unit price, subtotal */
function cells(): HTMLElement[] {
  const row = screen.getByText("Sample Cola 12oz").closest("tr") as HTMLElement;
  return within(row).getAllByRole("cell");
}

describe("buyer order read view - quantity cells on a boxed line (B1387)", () => {
  it('3 boxes of 12 at $18.00: Qty "3 boxes", Delivered "1 box", Remaining "2 boxes"; Subtotal $54.00', () => {
    mockOrder = order([line()]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const c = cells();
    expect(c[1]).toHaveTextContent("3 boxes");
    expect(c[1]).not.toHaveTextContent("36");
    expect(c[2]).toHaveTextContent("1 box");
    expect(c[2]).not.toHaveTextContent("12");
    expect(c[3]).toHaveTextContent("2 boxes");
    expect(c[5]).toHaveTextContent("$54.00");
  });

  it("fully delivered reads 0 remaining", () => {
    mockOrder = order([line({ deliveredQty: 36 })]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[3]).toHaveTextContent(/^0$/);
  });

  it('a line with no split still reads plain numbers ("3")', () => {
    mockOrder = order([
      line({ qty: 3, boxes: null, pieces: null, unitsPerBox: null, deliveredQty: 1, subtotal: 54 }),
    ]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const c = cells();
    expect(c[1].textContent).toBe("3");
    expect(c[2].textContent).toBe("1");
    expect(c[3].textContent).toBe("2");
  });

  it('a unitLabel "Case" line reads "3 Cases"', () => {
    mockOrder = order([line({ unitLabel: "Case" })]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[1]).toHaveTextContent("3 Cases");
    expect(cells()[2]).toHaveTextContent("1 Case");
  });
});
