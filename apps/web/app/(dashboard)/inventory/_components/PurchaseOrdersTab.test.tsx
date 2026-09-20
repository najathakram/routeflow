/**
 * Characterization tests for the purchase-order surface extracted from
 * inventory/page.tsx (LANE-U step 3 prefactor). They pin today's behaviour —
 * the boxed-line conversion, the row actions per status, the detail row, and the
 * create-PO submit payload — so the follow-up PO edit / from-scan steps change
 * it deliberately, never by accident.
 */
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PurchaseOrdersTab } from "./PurchaseOrdersTab";
import { CreatePOModal } from "./PurchaseOrdersCreateModal";
import { ReceivePOModal } from "./PurchaseOrdersReceiveModal";
import { formatMoney } from "@/lib/format";
import { fmtCalendarDate } from "@/lib/formatting";
import { unitsLabel } from "@/lib/stock-label";
import { emptyPOLine, resolvePOLine, type PurchaseOrder } from "./purchase-orders-shared";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast }) };
});

const sendMutate = jest.fn();
const closeMutate = jest.fn();
const createMutate = jest.fn();
const receiveMutate = jest.fn();
const detailById: Record<string, unknown> = {};
let listData: unknown = { data: [] };
jest.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: () => ({ data: listData, isLoading: false }),
  usePurchaseOrder: (id: string) => ({ data: detailById[id], isLoading: false }),
  useSendPurchaseOrder: () => ({ mutate: sendMutate, isPending: false }),
  useClosePurchaseOrder: () => ({ mutate: closeMutate, isPending: false }),
  useCreatePurchaseOrder: () => ({ mutate: createMutate, isPending: false }),
  useReceivePurchaseOrder: () => ({ mutate: receiveMutate, isPending: false }),
}));

const supplier = { id: "s1", name: "Acme Supply", isActive: true };
const products = [
  { id: "p1", name: "Widget", sku: "W-1", unitsPerBox: null },
  { id: "p2", name: "Boxed Gadget", sku: "G-1", unitsPerBox: 12 },
];

function po(over: Partial<PurchaseOrder>): PurchaseOrder {
  return {
    id: "po1",
    poNumber: "PO-0001",
    supplier,
    status: "DRAFT",
    items: [],
    total: 120,
    expectedDate: "2026-10-01",
    createdAt: "2026-09-01",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(detailById)) delete detailById[k];
  listData = { data: [] };
});

describe("resolvePOLine (pure)", () => {
  it("passes a non-boxed line through as typed", () => {
    const line = { ...emptyPOLine(), productId: "p1", qty: "5", unitCost: "2.5" };
    expect(resolvePOLine(line, 0)).toEqual({ qty: 5, unitCost: 2.5 });
    expect(resolvePOLine(line, 1)).toEqual({ qty: 5, unitCost: 2.5 });
  });

  it("converts a boxed line to a piece total and a per-piece cost", () => {
    const line = { ...emptyPOLine(), productId: "p2", boxes: "2", pieces: "3", unitCost: "24" };
    // 2 boxes of 12 + 3 pieces = 27 pcs; $24/box = $2/pc
    expect(resolvePOLine(line, 12)).toEqual({ qty: 27, unitCost: 2 });
  });

  it("rolls loose pieces over into whole boxes and truncates fractions", () => {
    const line = { ...emptyPOLine(), boxes: "1.9", pieces: "14", unitCost: "12" };
    expect(resolvePOLine(line, 12)).toEqual({ qty: 26, unitCost: 1 });
  });

  it("treats blank/garbage input as zero, never NaN", () => {
    expect(resolvePOLine(emptyPOLine(), 12)).toEqual({ qty: 0, unitCost: 0 });
    expect(resolvePOLine({ ...emptyPOLine(), qty: "abc", unitCost: "x" }, 0)).toEqual({
      qty: 0,
      unitCost: 0,
    });
  });
});

describe("PurchaseOrdersTab", () => {
  it("shows the empty state", () => {
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    expect(screen.getByText("No purchase orders found.")).toBeInTheDocument();
  });

  it("offers Send on DRAFT, Receive on SENT/PARTIAL, and neither on CLOSED", () => {
    listData = {
      data: [
        po({ id: "a", poNumber: "PO-A", status: "DRAFT" }),
        po({ id: "b", poNumber: "PO-B", status: "SENT" }),
        po({ id: "c", poNumber: "PO-C", status: "PARTIAL" }),
        po({ id: "d", poNumber: "PO-D", status: "CLOSED" }),
      ],
    };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    const row = (n: string) => screen.getByText(n).closest("tr") as HTMLElement;
    expect(within(row("PO-A")).getByTitle("Send")).toBeInTheDocument();
    expect(within(row("PO-A")).queryByTitle("Receive")).toBeNull();
    expect(within(row("PO-B")).getByTitle("Receive")).toBeInTheDocument();
    expect(within(row("PO-C")).getByTitle("Receive")).toBeInTheDocument();
    expect(within(row("PO-D")).queryByTitle("Send")).toBeNull();
    expect(within(row("PO-D")).queryByTitle("Receive")).toBeNull();
    expect(within(row("PO-D")).getByText("Closed")).toBeInTheDocument();
  });

  it("renders the row total and expected date through the shared formatters", () => {
    listData = { data: [po({ id: "a", poNumber: "PO-A", status: "SENT", total: 120 })] };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    const row = screen.getByText("PO-A").closest("tr") as HTMLElement;
    expect(within(row).getByText(formatMoney(120))).toBeInTheDocument();
    expect(within(row).getByText(fmtCalendarDate("2026-10-01"))).toBeInTheDocument();
    expect(within(row).getByText("Acme Supply")).toBeInTheDocument();
  });

  it("send button fires the send mutation for that PO", () => {
    listData = { data: [po({ id: "a", poNumber: "PO-A", status: "DRAFT" })] };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    fireEvent.click(screen.getByTitle("Send"));
    expect(sendMutate).toHaveBeenCalledWith("a", expect.any(Object));
    expect(closeMutate).not.toHaveBeenCalled();
  });

  it("expands a row into the detail with boxed quantities and Close on SENT", () => {
    listData = { data: [po({ id: "b", poNumber: "PO-B", status: "SENT" })] };
    detailById.b = po({
      id: "b",
      status: "SENT",
      notes: "Dock 3",
      items: [
        {
          id: "i1",
          productId: "p2",
          product: { id: "p2", name: "Boxed Gadget", unit: "ea" },
          qtyOrdered: "27",
          qtyReceived: "0",
          unitCost: "2",
        },
      ],
    });
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    fireEvent.click(screen.getByTitle("View details"));
    expect(screen.getByText("Boxed Gadget")).toBeInTheDocument();
    expect(screen.getByText(/Dock 3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Close/ })).toBeInTheDocument();
    // boxed line: piece total with its box split, per-piece cost at 4dp, /pc suffix
    expect(screen.getByText(unitsLabel(27, 12))).toBeInTheDocument();
    expect(screen.getByText("$2.0000")).toBeInTheDocument();
    expect(screen.getByText("/pc")).toBeInTheDocument();
    expect(screen.getByText(formatMoney(27 * 2))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(closeMutate).toHaveBeenCalledWith("b", expect.any(Object));
    expect(sendMutate).not.toHaveBeenCalled();
  });
});

describe("CreatePOModal", () => {
  it("submits a boxed line as piece qty + per-piece cost", () => {
    const onClose = jest.fn();
    const { container } = render(
      <CreatePOModal suppliers={[supplier]} products={products} onClose={onClose} />,
    );
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[1], { target: { value: "p2" } });
    fireEvent.change(screen.getByTitle("Boxes"), { target: { value: "2" } });
    fireEvent.change(screen.getByTitle("Extra pieces"), { target: { value: "3" } });
    fireEvent.change(screen.getByTitle("Cost per box"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Create PO" }));
    expect(createMutate).toHaveBeenCalledWith(
      {
        supplierId: undefined,
        expectedDate: undefined,
        items: [{ productId: "p2", qty: 27, unitCost: 2 }],
        notes: undefined,
      },
      expect.any(Object),
    );
  });

  it("warns and does not submit with no valid line", () => {
    render(<CreatePOModal suppliers={[supplier]} products={products} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create PO" }));
    expect(createMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Validation" }));
  });
});

describe("ReceivePOModal", () => {
  it("pre-fills outstanding and submits a piece-total receivedQty", () => {
    const order = po({
      id: "b",
      status: "PARTIAL",
      items: [
        {
          id: "i1",
          productId: "p2",
          qtyOrdered: "27",
          qtyReceived: "3",
          unitCost: "2",
        },
        { id: "i2", productId: "p1", qtyOrdered: "10", qtyReceived: "0", unitCost: "1" },
      ],
    });
    render(<ReceivePOModal po={order} products={products} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm Receipt" }));
    // outstanding 24 pcs = 2 boxes of 12; unboxed line outstanding 10
    expect(receiveMutate).toHaveBeenCalledWith(
      {
        id: "b",
        items: [
          { id: "i1", receivedQty: 24 },
          { id: "i2", receivedQty: 10 },
        ],
      },
      expect.any(Object),
    );
  });
});
