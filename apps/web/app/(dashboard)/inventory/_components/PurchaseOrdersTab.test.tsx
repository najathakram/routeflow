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
import {
  emptyPOLine,
  resolvePOLine,
  resolvePOLineAmounts,
  resolveStoredPOLineAmounts,
  toCreateItem,
  type PurchaseOrder,
} from "./purchase-orders-shared";

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
  useUpdatePurchaseOrder: () => ({ mutate: jest.fn(), isPending: false }),
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
    totalAmount: "120.00", // the API sends the raw Prisma Decimal (B719)
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

// PO line money: the total of a boxed line comes from the ENTERED case cost through the one pricing builder,
// never pieces x the rounded per-piece cost (1,000 boxes of 12 at $11.00: $11,000.00, not $11,000.40).
describe("resolvePOLineAmounts / toCreateItem (exact case cost)", () => {
  const boxes1000 = {
    ...emptyPOLine(),
    productId: "p2",
    boxes: "1000",
    pieces: "0",
    unitCost: "11",
  };

  it("1,000 boxes of 12 at $11.00 total exactly $11,000.00", () => {
    const a = resolvePOLineAmounts(boxes1000, 12);
    expect(a.totalCost).toBe(11000);
    expect(a.qtyOrdered).toBe(12000);
    expect(a.unitCost).toBe(0.9167); // costing only
    expect(a.qtyOrdered * a.unitCost).toBeCloseTo(11000.4, 6); // the figure the old route displayed and stored
  });

  it("loose pieces are prorated: 5 boxes + 6 pieces at $11.00 = $60.50", () => {
    expect(resolvePOLineAmounts({ ...boxes1000, boxes: "5", pieces: "6" }, 12).totalCost).toBe(
      60.5,
    );
  });

  it("a per-piece line is roundMoney(qty x unitCost)", () => {
    expect(
      resolvePOLineAmounts({ ...emptyPOLine(), qty: "3", unitCost: "0.3333" }, 0).totalCost,
    ).toBe(1);
  });

  it("an unusable entry is an all-zero line, never a throw", () => {
    expect(resolvePOLineAmounts(emptyPOLine(), 12).totalCost).toBe(0);
    expect(
      resolvePOLineAmounts({ ...emptyPOLine(), unitCost: "-5", boxes: "2" }, 12).totalCost,
    ).toBe(0);
  });

  it("the create payload for a boxed line is the ENTERED case figures; a per-piece line is unchanged", () => {
    expect(toCreateItem(boxes1000, 12)).toEqual({
      productId: "p2",
      packSize: 12,
      caseCost: 11,
      cases: 1000,
      loosePieces: 0,
    });
    expect(
      toCreateItem({ ...emptyPOLine(), productId: "p1", qty: "5", unitCost: "2.5" }, 0),
    ).toEqual({
      productId: "p1",
      qty: 5,
      unitCost: 2.5,
    });
  });
});

// A STORED line (POItem) carries the per-piece cost at 4 dp AND the exact document total the server wrote.
// Display must read the total, never re-multiply pieces x the rounded per-piece cost (#1199 / B677).
describe("resolveStoredPOLineAmounts (stored line, exact total)", () => {
  const stored1000 = { qtyOrdered: "12000", unitCost: "0.9167", totalCost: "11000.00" };

  it("1,000 cases of 12 stored at $11,000.00 display $11,000.00, not the $11,000.40 of qty x unitCost", () => {
    const a = resolveStoredPOLineAmounts(stored1000, 12);
    expect(a.totalCost).toBe(11000);
    expect(a.qtyOrdered).toBe(12000);
    expect(a.cases).toBe(1000);
    expect(a.caseCost).toBe(11);
    expect(Number(stored1000.qtyOrdered) * Number(stored1000.unitCost)).toBeCloseTo(11000.4, 6);
  });

  it("the stored total wins even where the 4 dp case cost could not rebuild it", () => {
    // 3,000 cases at $1,000.01: a case cost read back at 4 dp (0.3333) rebuilds to $999.90
    expect(
      resolveStoredPOLineAmounts(
        { qtyOrdered: "36000", unitCost: "0.0278", totalCost: "1000.01" },
        12,
      ).totalCost,
    ).toBe(1000.01);
  });

  it("a row with no stored total is rebuilt from the per-piece cost, honestly drifted", () => {
    const a = resolveStoredPOLineAmounts({ qtyOrdered: "12000", unitCost: "0.9167" }, 12);
    expect(a.totalCost).toBe(11000.4);
    expect(a.caseCost).toBe(11.0004);
  });

  it("a per-piece line is roundMoney(qty x unitCost), and the stored total still wins", () => {
    expect(resolveStoredPOLineAmounts({ qtyOrdered: "3", unitCost: "0.3333" }, 0).totalCost).toBe(
      1,
    );
    expect(
      resolveStoredPOLineAmounts({ qtyOrdered: "3", unitCost: "0.3333", totalCost: "1.00" }, 0)
        .totalCost,
    ).toBe(1);
  });

  it("an unusable row never throws: the stored total, else zero", () => {
    expect(
      resolveStoredPOLineAmounts({ qtyOrdered: "abc", unitCost: "x", totalCost: "12.34" }, 12)
        .totalCost,
    ).toBe(12.34);
    expect(resolveStoredPOLineAmounts({ qtyOrdered: "abc", unitCost: "x" }, 12).totalCost).toBe(0);
  });
});

describe("PurchaseOrdersTab", () => {
  it("shows the empty state", () => {
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    expect(screen.getByText("No purchase orders yet")).toBeInTheDocument();
  });

  it("each PO number links to its detail page", () => {
    listData = { data: [po({ id: "a", poNumber: "PO-A", status: "DRAFT" })] };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    expect(screen.getByRole("link", { name: "PO-A" })).toHaveAttribute(
      "href",
      "/purchase-orders/a",
    );
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

  it("offers Edit on every status except CLOSED, and it opens the edit modal", () => {
    listData = {
      data: [
        po({ id: "a", poNumber: "PO-A", status: "DRAFT" }),
        po({ id: "b", poNumber: "PO-B", status: "SENT" }),
        po({ id: "c", poNumber: "PO-C", status: "PARTIAL" }),
        po({ id: "r", poNumber: "PO-R", status: "RECEIVED" }),
        po({ id: "d", poNumber: "PO-D", status: "CLOSED" }),
      ],
    };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    const row = (n: string) => screen.getByText(n).closest("tr") as HTMLElement;
    for (const n of ["PO-A", "PO-B", "PO-C", "PO-R"]) {
      expect(within(row(n)).getByTitle("Edit")).toBeInTheDocument();
    }
    expect(within(row("PO-D")).queryByTitle("Edit")).toBeNull();

    fireEvent.click(within(row("PO-C")).getByTitle("Edit"));
    expect(screen.getByText("Edit PO-C")).toBeInTheDocument();
  });

  it("renders the row total and expected date through the shared formatters", () => {
    listData = { data: [po({ id: "a", poNumber: "PO-A", status: "SENT", totalAmount: "120.00" })] };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    const row = screen.getByText("PO-A").closest("tr") as HTMLElement;
    expect(within(row).getByText(formatMoney(120))).toBeInTheDocument();
    expect(within(row).getByText(fmtCalendarDate("2026-10-01"))).toBeInTheDocument();
    expect(within(row).getByText("Acme Supply")).toBeInTheDocument();
  });

  // B719 (#1485): the list read a `total` the API never sends, so every row showed $0.00.
  it("B719: the Total column shows the server's totalAmount (a numeric string), never $0.00", () => {
    listData = { data: [po({ id: "a", poNumber: "PO-A", status: "SENT", totalAmount: "123.45" })] };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    const row = screen.getByText("PO-A").closest("tr") as HTMLElement;
    expect(within(row).getByText(formatMoney(123.45))).toBeInTheDocument();
    expect(within(row).queryByText(formatMoney(0))).toBeNull();
  });

  it("B719: with no stored total the row falls back to the sum of the lines' STORED totals", () => {
    listData = {
      data: [
        po({
          id: "a",
          poNumber: "PO-A",
          status: "DRAFT",
          totalAmount: null,
          items: [
            {
              id: "i1",
              productId: "p1",
              qtyOrdered: "3",
              qtyReceived: "0",
              unitCost: "10.0000",
              totalCost: "30.00",
            },
            {
              id: "i2",
              productId: "p2",
              qtyOrdered: "12",
              qtyReceived: "0",
              unitCost: "1.0417",
              totalCost: "12.50",
              packSize: 12,
            },
          ],
        }),
      ],
    };
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    const row = screen.getByText("PO-A").closest("tr") as HTMLElement;
    expect(within(row).getByText(formatMoney(42.5))).toBeInTheDocument();
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

  it("the detail subtotal of a boxed line is the stored exact total, not qty x per-piece cost (#1199)", () => {
    listData = {
      data: [po({ id: "c", poNumber: "PO-C", status: "SENT", totalAmount: "11000.00" })],
    };
    detailById.c = po({
      id: "c",
      status: "SENT",
      totalAmount: "11000.00",
      items: [
        {
          id: "i1",
          productId: "p2",
          product: { id: "p2", name: "Boxed Gadget", unit: "ea" },
          qtyOrdered: "12000",
          qtyReceived: "0",
          unitCost: "0.9167",
          totalCost: "11000.00",
          packSize: 12,
        },
      ],
    });
    render(<PurchaseOrdersTab suppliers={[supplier]} products={products} />);
    fireEvent.click(screen.getByTitle("View details"));
    expect(screen.getByText(unitsLabel(12000, 12))).toBeInTheDocument();
    expect(screen.getByText("$0.9167")).toBeInTheDocument();
    // the line subtotal and the row total agree on the exact document figure
    expect(screen.getAllByText(formatMoney(11000)).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(formatMoney(11000.4))).not.toBeInTheDocument();
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
        items: [{ productId: "p2", packSize: 12, caseCost: 24, cases: 2, loosePieces: 3 }],
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

  it("#2734: a line stored at pack 12 on a product repacked to 6 seeds and sends at 12", () => {
    receiveMutate.mockClear();
    const order = po({
      id: "c",
      status: "SENT",
      items: [
        {
          id: "i1",
          productId: "p3",
          qtyOrdered: "24",
          qtyReceived: "0",
          unitCost: "2",
          packSize: 12,
        },
      ],
    });
    const repacked = [{ id: "p3", name: "Repacked", unitsPerBox: 6 }];
    render(<ReceivePOModal po={order} products={repacked} onClose={jest.fn()} />);
    // 24 pcs at the stored pack 12 = 2 boxes + 0 (at the live pack 6 it would seed 4 boxes)
    expect((screen.getByTitle("Boxes") as HTMLInputElement).value).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Receipt" }));
    expect(receiveMutate).toHaveBeenCalledWith(
      { id: "c", items: [{ id: "i1", receivedQty: 24 }] },
      expect.any(Object),
    );
  });
});
