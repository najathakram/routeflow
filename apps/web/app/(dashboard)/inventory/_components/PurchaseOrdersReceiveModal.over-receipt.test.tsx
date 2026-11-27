import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReceivePOModal } from "./PurchaseOrdersReceiveModal";
import type { PurchaseOrder } from "./purchase-orders-shared";

/**
 * B1479: the Receive dialog shows a running pieces total, and a quantity larger than is still to come says so
 * ("48 boxes is more than the 3 boxes ordered.") instead of passing silently. The API refuses such a receipt, so
 * Confirm stays off until the line is fixed.
 */
const mutate = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});
jest.mock("@/lib/api/inventory", () => ({
  useReceivePurchaseOrder: () => ({ mutate: (...a: unknown[]) => mutate(...a), isPending: false }),
}));

const po = {
  id: "po1",
  poNumber: "PO-2026-0001",
  supplier: { id: "s1", name: "UX-stock Supply Co", isActive: true },
  status: "SENT",
  totalAmount: "64.80",
  expectedDate: null,
  notes: null,
  createdAt: "2026-11-26",
  items: [
    {
      id: "l1",
      productId: "p-chips",
      qtyOrdered: "72",
      qtyReceived: "0",
      unitCost: "0.5",
      packSize: 24,
    },
  ],
} as unknown as PurchaseOrder;
const products = [{ id: "p-chips", name: "UX-pos Chips Box", unitsPerBox: 24 }];

const boxes = () => screen.getByTitle("Boxes") as HTMLInputElement;
const confirm = () => screen.getByRole("button", { name: "Confirm receipt" });

describe("ReceivePOModal over-receipt (B1479)", () => {
  beforeEach(() => mutate.mockClear());

  it("starts with the full amount, a pieces total and no warning", () => {
    render(<ReceivePOModal po={po} products={products} onClose={jest.fn()} />);
    expect(screen.getByTestId("receive-line-total")).toHaveTextContent("= 72 pcs");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(confirm()).toBeEnabled();
  });

  it("48 boxes against 3 ordered warns, shows the pieces and holds Confirm", () => {
    render(<ReceivePOModal po={po} products={products} onClose={jest.fn()} />);
    fireEvent.change(boxes(), { target: { value: "48" } });
    expect(screen.getByTestId("receive-line-total")).toHaveTextContent("= 1,152 pcs");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "48 boxes is more than the 3 boxes ordered.",
    );
    expect(confirm()).toBeDisabled();
    fireEvent.submit(confirm().closest("form")!);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("2 boxes (a short delivery) sends 48 pieces with no warning", () => {
    render(<ReceivePOModal po={po} products={products} onClose={jest.fn()} />);
    fireEvent.change(boxes(), { target: { value: "2" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(confirm());
    expect(mutate.mock.calls[0][0]).toEqual({ id: "po1", items: [{ id: "l1", receivedQty: 48 }] });
  });
});
