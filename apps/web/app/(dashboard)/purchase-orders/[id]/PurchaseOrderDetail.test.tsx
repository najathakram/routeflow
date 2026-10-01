import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PurchaseOrderDetail } from "./PurchaseOrderDetail";
import { poActions } from "./po-detail-logic";
import { fmtDate } from "@/lib/formatting";

const setTitle = jest.fn();
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle }) }));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

const refetch = jest.fn();
const sendMutate = jest.fn();
const closeMutate = jest.fn();
let poState: { data?: unknown; isLoading: boolean; isError: boolean; error?: unknown } = {
  isLoading: false,
  isError: false,
};
let planFlag = { enabled: true, resolved: true, failed: false };

jest.mock("@/lib/api/plan-flags", () => ({ usePlanFlag: () => planFlag }));
jest.mock("@/lib/api/inventory", () => ({
  usePurchaseOrder: () => ({ ...poState, refetch }),
  useSendPurchaseOrder: () => ({ mutate: sendMutate, isPending: false }),
  useClosePurchaseOrder: () => ({ mutate: closeMutate, isPending: false }),
  useReceivePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useSuppliers: () => ({ data: [{ id: "s1", name: "Acme Supply", isActive: true }] }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [{ id: "p1", name: "Widget", sku: "W-1" }] } }),
}));
// the existing modals have their own tests; here they are markers
jest.mock("../../inventory/_components/PurchaseOrdersEditModal", () => ({
  PurchaseOrdersEditModal: ({ po }: { po: { poNumber: string } }) => (
    <div data-testid="edit-modal">{po.poNumber}</div>
  ),
}));
jest.mock("../../inventory/_components/PurchaseOrdersReceiveModal", () => ({
  ReceivePOModal: ({ po }: { po: { poNumber: string } }) => (
    <div data-testid="receive-modal">{po.poNumber}</div>
  ),
}));

const po = (over: Record<string, unknown> = {}) => ({
  id: "po1",
  poNumber: "PO-0007",
  status: "DRAFT",
  supplier: { id: "s1", name: "Acme Supply", isActive: true },
  expectedDate: "2026-10-15T00:00:00.000Z",
  notes: "Dock 2, before noon",
  totalAmount: "80.00",
  createdAt: "2026-10-01T00:00:00.000Z",
  items: [
    {
      id: "i1",
      productId: "p1",
      product: { id: "p1", name: "Widget", unit: "ea" },
      qtyOrdered: "20",
      qtyReceived: "0",
      unitCost: "4",
      totalCost: "80",
    },
  ],
  receipts: [],
  vendorBill: null,
  ...over,
});

const show = (data: unknown) => {
  poState = { data, isLoading: false, isError: false };
  return render(<PurchaseOrderDetail id="po1" />);
};

beforeEach(() => {
  jest.clearAllMocks();
  poState = { isLoading: false, isError: false };
  planFlag = { enabled: true, resolved: true, failed: false };
});

describe("poActions (status to actions)", () => {
  it.each([
    ["DRAFT", { edit: true, send: true, receive: false, close: false }],
    ["SENT", { edit: true, send: false, receive: true, close: true }],
    ["PARTIAL", { edit: true, send: false, receive: true, close: true }],
    ["RECEIVED", { edit: true, send: false, receive: false, close: true }],
    ["CLOSED", { edit: false, send: false, receive: false, close: false }],
  ])("%s", (status, expected) => {
    expect(poActions(status as never)).toEqual(expected);
  });
});

describe("PurchaseOrderDetail", () => {
  it("renders the header, notes, expected date, total and the lines", () => {
    show(po());
    expect(screen.getByRole("heading", { name: "PO-0007" })).toBeInTheDocument();
    expect(screen.getAllByText("Acme Supply").length).toBeGreaterThan(0);
    expect(screen.getByText(/Dock 2, before noon/)).toBeInTheDocument();
    expect(screen.getByText("Widget")).toBeInTheDocument();
    expect(screen.getByTestId("po-total")).toHaveTextContent("$80.00");
    expect(setTitle).toHaveBeenCalledWith("PO-0007");
  });

  it("DRAFT offers Edit and Send only; Send mutates", () => {
    show(po());
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Receive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendMutate).toHaveBeenCalledWith("po1", expect.anything());
  });

  it("SENT offers Receive and Close, and Receive opens the existing modal for this PO", () => {
    show(po({ status: "SENT" }));
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Receive" }));
    expect(screen.getByTestId("receive-modal")).toHaveTextContent("PO-0007");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closeMutate).toHaveBeenCalledWith("po1", expect.anything());
  });

  it("Edit opens the existing edit modal for this PO", () => {
    show(po());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("edit-modal")).toHaveTextContent("PO-0007");
  });

  it("CLOSED has no actions at all", () => {
    show(po({ status: "CLOSED" }));
    for (const name of ["Edit", "Send", "Receive", "Close"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("receipts: empty copy, then a populated list that flags a reversal", () => {
    const { unmount } = show(po());
    expect(screen.getByText("Nothing received yet.")).toBeInTheDocument();
    unmount();
    show(
      po({
        status: "PARTIAL",
        receipts: [
          {
            id: "m2",
            kind: "RECEIPT",
            productId: "p1",
            productName: "Widget",
            quantity: 20,
            unitCost: 6,
            at: "2026-10-03T10:00:00.000Z",
          },
          {
            id: "m1x",
            kind: "REVERSAL",
            productId: "p1",
            productName: "Widget",
            quantity: -20,
            unitCost: 4,
            at: "2026-10-03T09:59:00.000Z",
            reversesId: "m1",
          },
          {
            id: "m1",
            kind: "RECEIPT",
            productId: "p1",
            productName: "Widget",
            quantity: 20,
            unitCost: 4,
            at: "2026-10-02T10:00:00.000Z",
          },
        ],
      }),
    );
    const section = screen.getByRole("region", { name: "Receipts" });
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Received")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Correction")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Received")).toBeInTheDocument();
  });

  it("links the bill (Open bill) when the plan has bills, and not otherwise", () => {
    const bill = { id: "b1", billNumber: "BILL-2026-0003", status: "DRAFT" };
    const first = show(po({ vendorBill: bill }));
    expect(screen.getByRole("link", { name: /Open bill BILL-2026-0003/ })).toHaveAttribute(
      "href",
      "/vendor-bills/b1",
    );
    first.unmount();

    planFlag = { enabled: false, resolved: true, failed: false };
    const second = show(po({ vendorBill: bill }));
    expect(screen.queryByRole("link", { name: /Open bill/ })).toBeNull();
    expect(screen.getByText(/BILL-2026-0003/)).toBeInTheDocument(); // still says it is billed
    second.unmount();

    planFlag = { enabled: true, resolved: true, failed: false };
    show(po());
    expect(screen.queryByRole("link", { name: /Open bill/ })).toBeNull();
  });

  it("receipt unit cost shows 4dp for a boxed product and 2dp otherwise", () => {
    const receipt = (productId: string, unitCost: number) => ({
      id: `m-${productId}`,
      kind: "RECEIPT",
      productId,
      productName: "Widget",
      quantity: 12,
      unitCost,
      at: "2026-10-03T10:00:00.000Z",
    });
    const base = po().items[0];
    const first = show(
      po({
        status: "PARTIAL",
        items: [{ ...base, packSize: 12 }],
        receipts: [receipt("p1", 0.4167)],
      }),
    );
    const inReceipts = () => within(screen.getByRole("region", { name: "Receipts" }));
    expect(inReceipts().getByText("$0.4167")).toBeInTheDocument();
    first.unmount();
    show(po({ status: "PARTIAL", receipts: [receipt("p1", 4)] }));
    expect(inReceipts().getByText("$4.00")).toBeInTheDocument();
  });

  it("a VOID bill is shown as voided, not as a live bill", () => {
    show(po({ vendorBill: { id: "b1", billNumber: "BILL-2026-0003", status: "VOID" } }));
    expect(screen.getByText("Bill voided")).toBeInTheDocument();
  });

  it("receipt dates are timestamps in the viewer's zone, not pinned-UTC calendar days", () => {
    const at = "2026-10-03T02:30:00.000Z";
    show(
      po({
        status: "PARTIAL",
        receipts: [
          {
            id: "m1",
            kind: "RECEIPT",
            productId: "p1",
            productName: "Widget",
            quantity: 5,
            unitCost: 4,
            at,
          },
        ],
      }),
    );
    const section = screen.getByRole("region", { name: "Receipts" });
    const cell = within(section).getAllByRole("row")[1].querySelectorAll("td")[0];
    expect(cell.textContent).toBe(fmtDate(at));
  });

  it("loading shows a skeleton, not the not-found copy", () => {
    poState = { isLoading: true, isError: false };
    const { container } = render(<PurchaseOrderDetail id="po1" />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it("a 404 says the PO was not found and links back", () => {
    poState = {
      isLoading: false,
      isError: true,
      error: { response: { status: 404, data: { message: "Purchase order not found" } } },
    };
    render(<PurchaseOrderDetail id="po1" />);
    expect(screen.getByText("Purchase order not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to purchase orders/i })).toHaveAttribute(
      "href",
      "/purchase-orders",
    );
  });

  it("other errors offer Retry and never show the raw message", () => {
    poState = {
      isLoading: false,
      isError: true,
      error: { response: { status: 500, data: { message: "AxiosError: 500 boom" } } },
    };
    render(<PurchaseOrderDetail id="po1" />);
    expect(screen.getByText("Couldn't load this purchase order.")).toBeInTheDocument();
    expect(screen.queryByText(/boom|AxiosError/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
