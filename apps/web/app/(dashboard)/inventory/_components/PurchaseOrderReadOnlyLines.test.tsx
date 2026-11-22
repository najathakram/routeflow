/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { PurchaseOrderReadOnlyLines } from "./PurchaseOrderReadOnlyLines";
import type { POItem } from "./purchase-orders-shared";
import { realDetailItem, oldShapeDetailItem } from "../../purchase-orders/po-detail.fixture";

// P1b: each read-only PO line shows the stock on hand (the stock reader's figure, in pieces) and its
// amount (the stored exact total, never qty x unitCost).
const boxedItem: POItem = {
  id: "i1",
  productId: "p-box",
  product: {
    id: "p-box",
    name: "Strawberry",
    unit: "case",
    parentProductId: "fam",
    variantName: "Strawberry",
    parent: { name: "Acme Vape" },
  },
  qtyOrdered: 12000,
  qtyReceived: 0,
  unitCost: "0.9167",
  totalCost: "11000.00",
  packSize: 12,
};

describe("PurchaseOrderReadOnlyLines stock + amount (P1b)", () => {
  it("shows on hand beside the line, in boxes + pieces for a boxed product", () => {
    const catalog = new Map([
      ["p-box", { id: "p-box", name: "Acme Vape - Strawberry", unitsPerBox: 12, currentStock: 30 }],
    ]);
    render(<PurchaseOrderReadOnlyLines items={[boxedItem]} catalogById={catalog} />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("30 pcs (2 boxes + 6 pcs)")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "On hand" })).toBeTruthy();
  });

  it("shows the amount from the stored exact total, not qty x per-piece cost", () => {
    const catalog = new Map([["p-box", { id: "p-box", name: "Strawberry", unitsPerBox: 12 }]]);
    render(<PurchaseOrderReadOnlyLines items={[boxedItem]} catalogById={catalog} />);
    expect(screen.getByText("$11,000.00")).toBeTruthy();
    expect(screen.queryByText("$11,000.40")).toBeNull();
  });

  it("names a variant line from its own include, with the catalog empty (archived product)", () => {
    render(<PurchaseOrderReadOnlyLines items={[boxedItem]} catalogById={new Map()} />);
    expect(screen.getByText("Acme Vape - Strawberry")).toBeTruthy();
  });

  it("splits on hand by the CURRENT catalog pack, not the line's stored pack (repack 12 -> 6)", () => {
    const catalog = new Map([
      ["p-box", { id: "p-box", name: "Acme Vape - Strawberry", unitsPerBox: 6, currentStock: 30 }],
    ]);
    render(<PurchaseOrderReadOnlyLines items={[boxedItem]} catalogById={catalog} />);
    expect(screen.getByTestId("po-line-on-hand").textContent).toBe("30 pcs (5 boxes)");
  });

  it("shows a dash, never 0, when the product has no stock figure", () => {
    const catalog = new Map([["p-box", { id: "p-box", name: "Strawberry", unitsPerBox: 12 }]]);
    render(<PurchaseOrderReadOnlyLines items={[boxedItem]} catalogById={catalog} />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("po-line-on-hand").textContent).toBe("—");
  });

  it("an older read shape (no family fields) falls back to the catalog's composed name", () => {
    const catalog = new Map([
      ["p1", { id: "p1", name: "Acme Vape - Strawberry", unitsPerBox: 12, currentStock: 30 }],
    ]);
    render(<PurchaseOrderReadOnlyLines items={[oldShapeDetailItem]} catalogById={catalog} />);
    expect(screen.getByText("Acme Vape - Strawberry")).toBeTruthy();
  });

  it("the real read shape names the line with no catalog at all", () => {
    render(<PurchaseOrderReadOnlyLines items={[realDetailItem]} catalogById={new Map()} />);
    expect(screen.getByText("Acme Vape - Strawberry")).toBeTruthy();
    expect(screen.getByTestId("po-line-on-hand").textContent).toBe("30 pcs (2 boxes + 6 pcs)");
  });
});
