import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { OrderPreviewModal } from "./LinkedDocPreviewModal";

/**
 * B1424 (R-227 MEDIUM-2): the linked order preview's summary line printed the raw status code ("OUT_FOR_DELIVERY")
 * where every other staff screen says the house word. It now reads the same word as the order badge, per order.
 */
let order: Record<string, unknown> | undefined;
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrder: () => ({ data: order, isLoading: false }),
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoice: () => ({ data: undefined, isLoading: false }),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  ...jest.requireActual("@/lib/api/tracked-categories"),
  useTrackedCategories: () => ({ data: [] }),
}));

const preview = (over: Record<string, unknown>) => {
  order = {
    id: "ord-1",
    orderNumber: "ORD-100",
    status: "PENDING",
    orderDate: "2026-11-20",
    customer: { id: "c1", businessName: "Acme Foods" },
    subtotal: 1,
    tax: 0,
    total: 1,
    invoices: [],
    lineItems: [
      { id: "l1", qty: 1, unitPrice: 1, subtotal: 1, status: "ACTIVE", description: "Item" },
    ],
    ...over,
  };
  return renderWithProviders(<OrderPreviewModal open onClose={() => {}} orderId="ord-1" />);
};

describe("B1424 R-227 MEDIUM-2: the preview says the status in words", () => {
  it("OUT_FOR_DELIVERY reads 'Out for delivery', never the code", () => {
    preview({ status: "OUT_FOR_DELIVERY" });
    expect(screen.getByText(/^Out for delivery · /)).toBeInTheDocument();
    expect(screen.queryByText(/OUT_FOR_DELIVERY/)).toBeNull();
  });

  it("PARTIALLY_DELIVERED reads as the badge's word, 'Partly delivered'", () => {
    preview({ status: "PARTIALLY_DELIVERED" });
    expect(screen.queryByText(/PARTIALLY_DELIVERED/)).toBeNull();
    expect(screen.getByText(/^Partly delivered · /)).toBeInTheDocument();
  });

  it("a pickup order uses its own word, as the order badge does", () => {
    preview({ status: "OUT_FOR_DELIVERY", fulfillPath: "PICKUP" });
    expect(screen.getByText(/^Ready for pickup · /)).toBeInTheDocument();
  });
});
