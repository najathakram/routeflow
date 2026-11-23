/**
 * Hotfix: on a long purchase order the Receive dialog must keep "Confirm receipt" in view, so the
 * submit button lives in the footer, outside the scrolling body.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ReceivePOModal } from "./PurchaseOrdersReceiveModal";
import type { PurchaseOrder } from "./purchase-orders-shared";

jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

jest.mock("@/lib/api/inventory", () => ({
  useReceivePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
}));

const items = Array.from({ length: 60 }, (_, i) => ({
  id: `i${i}`,
  productId: `p${i}`,
  qtyOrdered: "10",
  qtyReceived: "0",
  unitCost: "3",
  sku: `A-${i}`,
  packSize: null,
}));
const po = {
  id: "po1",
  poNumber: "PO-2026-0001",
  supplier: { id: "s1", name: "Acme Supply", isActive: true },
  status: "SENT",
  totalAmount: "30.00",
  expectedDate: null,
  notes: null,
  createdAt: "2026-09-01",
  items,
} as unknown as PurchaseOrder;
const products = items.map((i) => ({ id: i.productId, name: `Acme item ${i.sku}` }));

describe("ReceivePOModal scroll layout", () => {
  it("renders the submit button outside the scrolling body", () => {
    const { container } = render(
      <ReceivePOModal po={po} products={products} onClose={jest.fn()} />,
    );
    const submit = screen.getByRole("button", { name: "Confirm receipt" });
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(submit)).toBe(false);
    expect(scroller!.contains(screen.getAllByRole("spinbutton")[0])).toBe(true);
  });
});
