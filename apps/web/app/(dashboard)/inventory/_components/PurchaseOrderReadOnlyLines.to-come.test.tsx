/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { PurchaseOrderReadOnlyLines } from "./PurchaseOrderReadOnlyLines";
import type { POItem } from "./purchase-orders-shared";

// B1478: after a short delivery the PO says what is still to come, every quantity has a unit, and a
// stock figure under one whole box is said once ("21 pcs", not "21 pcs (21 pcs)").
const chips: POItem = {
  id: "l1",
  productId: "p-chips",
  product: { id: "p-chips", name: "UX-pos Chips Box", unit: "box", unitsPerBox: 24 },
  qtyOrdered: 72,
  qtyReceived: 48,
  unitCost: "0.5000",
  totalCost: "36.00",
  packSize: 24,
};
const cola: POItem = {
  id: "l2",
  productId: "p-cola",
  product: { id: "p-cola", name: "UX-pos Cola", unit: "can", unitsPerBox: null },
  qtyOrdered: 48,
  qtyReceived: 48,
  unitCost: "0.6000",
  totalCost: "28.80",
};
const catalog = new Map([
  ["p-chips", { id: "p-chips", name: "UX-pos Chips Box", unitsPerBox: 24, currentStock: 21 }],
  ["p-cola", { id: "p-cola", name: "UX-pos Cola", unitsPerBox: null, currentStock: 47 }],
]);

describe("PurchaseOrderReadOnlyLines after a short delivery (B1478)", () => {
  it("shows Still to come per line on a PARTIAL order", () => {
    render(
      <PurchaseOrderReadOnlyLines items={[chips, cola]} catalogById={catalog} status="PARTIAL" />,
    );
    expect(screen.getByRole("columnheader", { name: "Still to come" })).toBeTruthy();
    const [chipsCell, colaCell] = screen.getAllByTestId("po-line-to-come");
    expect(chipsCell.textContent).toBe("24 pcs (1 box)");
    expect(colaCell.textContent).toBe("—");
  });

  it("has no Still to come column on an order that is not PARTIAL", () => {
    render(<PurchaseOrderReadOnlyLines items={[chips]} catalogById={catalog} status="SENT" />);
    expect(screen.queryByRole("columnheader", { name: "Still to come" })).toBeNull();
  });

  it("puts a unit on an unboxed line's quantities", () => {
    render(<PurchaseOrderReadOnlyLines items={[cola]} catalogById={catalog} status="PARTIAL" />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getAllByText("48 can")).toHaveLength(2); // ordered and received
  });

  it("says on hand once when there is no whole box", () => {
    render(<PurchaseOrderReadOnlyLines items={[chips]} catalogById={catalog} status="PARTIAL" />);
    expect(screen.getByTestId("po-line-on-hand").textContent).toBe("21 pcs");
  });
});
