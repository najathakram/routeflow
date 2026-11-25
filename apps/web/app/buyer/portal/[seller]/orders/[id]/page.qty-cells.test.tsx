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
  // One test per cell so each goes red on its own old value (Qty "36", Delivered "12", Remaining "24").
  it('Qty reads "3 boxes", never the raw "36"', () => {
    mockOrder = order([line()]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[1].textContent).toContain("3 boxes");
    expect(cells()[1].textContent).not.toContain("36");
  });

  it('Delivered 12 pieces reads "1 box", never the raw "12"', () => {
    mockOrder = order([line()]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[2].textContent).toBe("1 box");
  });

  it('Remaining 24 pieces reads "2 boxes", never the raw "24"', () => {
    mockOrder = order([line()]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[3].textContent).toBe("2 boxes");
  });

  it("the Subtotal stays $54.00 (labels only)", () => {
    mockOrder = order([line()]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[5]).toHaveTextContent("$54.00");
  });

  it("a split whose pack cannot be recovered (3 boxes, qty 37) keeps plain numbers", () => {
    mockOrder = order([line({ qty: 37, boxes: 3, pieces: 0, deliveredQty: 12 })]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(cells()[2].textContent).toBe("12");
    expect(cells()[3].textContent).toBe("25");
  });

  it("the line's own pack wins over a repacked live product (own 12, live 6)", () => {
    mockOrder = order([
      line({
        product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: 6 },
        unitsPerBox: 6,
      }),
    ]);
    renderWithProviders(<BuyerOrderDetailPage />);
    // Delivered 12 pieces is 1 box at the line's own pack of 12 (a live pack of 6 would say 2 boxes).
    expect(cells()[2].textContent).toBe("1 box");
    expect(cells()[3].textContent).toBe("2 boxes");
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
