import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import PurchaseOrdersPage from "./page";

// P1b: the REAL purchase-orders page threads the products read (with currentStock) into the list's
// expanded row; "30.000" pieces on a 12-pack reads "30 pcs (2 boxes + 6 pcs)", never a dash.
jest.mock("./ScanPoButton", () => ({ ScanPoButton: () => <button>Scan</button> }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

const item = {
  id: "i1",
  productId: "p1",
  product: {
    id: "p1",
    name: "Strawberry",
    unit: "case",
    parentProductId: "fam",
    variantName: "Strawberry",
    parent: { name: "Geek" },
  },
  qtyOrdered: "12000",
  qtyReceived: "0",
  unitCost: "0.9167",
  totalCost: "11000.00",
  packSize: 12,
};
const po = {
  id: "po1",
  poNumber: "PO-1",
  status: "DRAFT",
  supplier: { id: "s1", name: "Acme Supply", isActive: true },
  items: [item],
  totalAmount: "11000.00",
  expectedDate: "",
  createdAt: "2026-11-20T00:00:00Z",
};
jest.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: () => ({
    data: { data: [po], meta: { total: 1 } },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  usePurchaseOrder: () => ({ data: po, isLoading: false }),
  useSendPurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useClosePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useCreatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useReceivePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useSuppliers: () => ({ data: [{ id: "s1", name: "Acme Supply", isActive: true }] }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: {
      data: [{ id: "p1", name: "Strawberry", sku: "S-1", unitsPerBox: 12, currentStock: "30.000" }],
    },
  }),
}));

describe("/purchase-orders page on hand (P1b)", () => {
  it("shows the stock on hand in the expanded row", () => {
    render(<PurchaseOrdersPage />);
    fireEvent.click(screen.getAllByTitle("View details")[0]);
    const cell = screen.getByTestId("po-line-on-hand");
    expect(
      within(cell.closest("tr") as HTMLElement).getByText("30 pcs (2 boxes + 6 pcs)"),
    ).toBeTruthy();
  });

  it("names the line from its own include, family first", () => {
    render(<PurchaseOrdersPage />);
    fireEvent.click(screen.getAllByTitle("View details")[0]);
    expect(screen.getByText("Geek - Strawberry")).toBeTruthy();
  });
});
