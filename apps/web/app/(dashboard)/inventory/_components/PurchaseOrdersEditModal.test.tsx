/**
 * The Edit-PO modal (LANE-U step 6, web half): DRAFT/SENT edit freely; a received
 * order's lines are protected and saving a change to them asks "Re-apply to
 * inventory?" — the API needs an explicit answer, and the modal must never guess.
 */
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PurchaseOrdersEditModal } from "./PurchaseOrdersEditModal";
import type { PurchaseOrder } from "./purchase-orders-shared";
import { unitWords } from "@routeflow/pricing";

// U-3a: the cost input is labelled by the default unit words (no per-product label on a PO line yet).
const UW = unitWords();
const UNIT_COST = new RegExp(`^Cost per (${UW.pack.lower}|${UW.base.lower})$`);

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast }) };
});

const mutate = jest.fn();
let mockPending = false;
// The modal builds its form from the FRESH purchase order, not the list row it was opened from.
let mockDetail: PurchaseOrder | undefined;
jest.mock("@/lib/api/inventory", () => ({
  useUpdatePurchaseOrder: () => ({ mutate, isPending: mockPending }),
  usePurchaseOrder: () => ({ data: mockDetail, isError: false }),
}));

const suppliers = [
  { id: "s1", name: "Acme Supply", isActive: true },
  { id: "s2", name: "Beta Traders", isActive: true },
];
const products = [
  { id: "p1", name: "Widget", sku: "W-1", unitsPerBox: null },
  { id: "p2", name: "Boxed Gadget", sku: "G-1", unitsPerBox: 12 },
];

function po(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "po1",
    poNumber: "PO-2026-0001",
    supplier: suppliers[0],
    status: "RECEIVED",
    totalAmount: "30.00",
    expectedDate: "2026-10-01T00:00:00.000Z",
    notes: "Dock 3",
    createdAt: "2026-09-01",
    items: [
      {
        id: "i1",
        productId: "p1",
        qtyOrdered: "10",
        qtyReceived: "10",
        unitCost: "3",
        sku: "W-1",
        packSize: null,
      },
    ],
    ...over,
  };
}
const draft = () =>
  po({
    status: "DRAFT",
    items: [
      {
        id: "i1",
        productId: "p1",
        qtyOrdered: "10",
        qtyReceived: "0",
        unitCost: "3",
        sku: null,
        packSize: null,
      },
    ],
  });

const renderModal = (p: PurchaseOrder, onClose = jest.fn()) => {
  mockDetail = p;
  render(
    <PurchaseOrdersEditModal po={p} suppliers={suppliers} products={products} onClose={onClose} />,
  );
  return onClose;
};
const setCost = (v: string) =>
  fireEvent.change(screen.getByLabelText(UNIT_COST), { target: { value: v } });
const setQty = (v: string) =>
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: v } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

beforeEach(() => {
  jest.clearAllMocks();
  mockDetail = undefined;
  mockPending = false;
  mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
});

describe("prefill", () => {
  it("shows the PO's own values", () => {
    renderModal(draft());
    expect(screen.getByText("Edit PO-2026-0001")).toBeInTheDocument();
    expect(screen.getByLabelText("Supplier")).toHaveValue("s1");
    expect(screen.getByLabelText("Expected Date")).toHaveValue("2026-10-01");
    expect(screen.getByLabelText("Notes")).toHaveValue("Dock 3");
    expect(screen.getByLabelText("Quantity")).toHaveValue(10);
    expect(screen.getByLabelText(UNIT_COST)).toHaveValue(3);
  });

  it("shows a boxed line as Boxes + Pieces and cost per box", () => {
    renderModal(
      po({
        status: "SENT",
        items: [{ id: "i9", productId: "p2", qtyOrdered: "27", qtyReceived: "0", unitCost: "2" }],
      }),
    );
    expect(screen.getByTitle("Boxes")).toHaveValue(2);
    expect(screen.getByTitle("Extra pieces")).toHaveValue(3);
    expect(screen.getByLabelText(UNIT_COST)).toHaveValue(24);
  });

  // #1199 pin: a boxed line's subtotal AND the running total must be the ENTERED case cost x
  // cases, exact — never pieces x a rounded per-piece cost (1,000 cases of $11.00/box read as
  // $11,000.40 before #1199, not $11,000.00). The stored per-piece unitCost (0.9167 at 4dp) is
  // for costing only; PurchaseOrderLinesTable must route both figures through
  // resolvePOLineAmounts(...).totalCost, never qty * unitCost, or this goes red the moment
  // either sum is rebuilt inline.
  it("a 1,000-case line reads back as exactly $11,000.00 subtotal AND total (#1199 exactness, pinned)", () => {
    renderModal(
      po({
        status: "SENT",
        items: [
          {
            id: "i10",
            productId: "p2",
            qtyOrdered: "12000", // 1,000 cases x 12/case
            qtyReceived: "0",
            unitCost: "0.9167", // per-piece, 4dp — for costing only, never re-multiplied
            totalCost: "11000",
            packSize: 12,
          },
        ],
      }),
    );
    // Case cost reads back exact (derived from the stored total, not 0.9167 x 12 = 11.0004).
    expect(screen.getByLabelText(UNIT_COST)).toHaveValue(11);
    expect(screen.getByTitle("Boxes")).toHaveValue(1000);
    expect(screen.getByTitle("Extra pieces")).toHaveValue(0);
    // Subtotal (the line) and Total (the footer) both read the exact entered figure.
    const amounts = screen.getAllByText("$11,000.00");
    expect(amounts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("DRAFT / SENT — edits freely, no inventory question", () => {
  it("saves a changed line straight away, keeping the line id, with no reapplyInventory", () => {
    const onClose = renderModal(draft());
    setCost("4");
    save();
    expect(screen.queryByText("Re-apply to inventory?")).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      id: "po1",
      items: [
        { id: "i1", productId: "p1", qtyOrdered: 10, unitCost: 4, sku: null, packSize: null },
      ],
    });
    expect(mutate.mock.calls[0][0]).not.toHaveProperty("reapplyInventory");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without a request when nothing changed", () => {
    const onClose = renderModal(draft());
    save();
    expect(mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("lets a line be removed and another added", () => {
    renderModal(
      po({
        status: "DRAFT",
        items: [
          { id: "i1", productId: "p1", qtyOrdered: "10", qtyReceived: "0", unitCost: "3" },
          { id: "i2", productId: "p2", qtyOrdered: "12", qtyReceived: "0", unitCost: "2" },
        ],
      }),
    );
    fireEvent.click(screen.getAllByLabelText("Remove line")[1]);
    save();
    expect(mutate.mock.calls[0][0].items).toHaveLength(1);
    expect(mutate.mock.calls[0][0].items[0].id).toBe("i1");
  });
});

describe("RECEIVED — protected lines and the re-apply question", () => {
  it("locks a received line's product and hides Remove; the quantity floor is what was received", () => {
    renderModal(po());
    expect(screen.getByLabelText("Product")).toBeDisabled();
    expect(screen.queryByLabelText("Remove line")).toBeNull();
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("min", "10");
    expect(screen.getByText(/Received:/)).toBeInTheDocument();
  });

  it("refuses a quantity below what was received — no request, and the return is named", () => {
    renderModal(po());
    setQty("8");
    save();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /can't go below what was already received \(10\)/,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/recording a return/);
  });

  it("asks 'Re-apply to inventory?' before changing a received line — and sends nothing yet", () => {
    renderModal(po());
    setCost("4");
    save();
    const dialog = screen.getByRole("dialog", { name: "Re-apply to inventory?" });
    expect(dialog).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Re-apply" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Keep stock as is" })).toBeEnabled();
  });

  it("[Re-apply] sends reapplyInventory: true with the edited lines", () => {
    const onClose = renderModal(po());
    setCost("4");
    save();
    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    expect(mutate.mock.calls[0][0]).toEqual({
      id: "po1",
      reapplyInventory: true,
      items: [
        { id: "i1", productId: "p1", qtyOrdered: 10, unitCost: 4, sku: "W-1", packSize: null },
      ],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("[Keep stock as is] sends reapplyInventory: false", () => {
    renderModal(po());
    setCost("4");
    save();
    fireEvent.click(screen.getByRole("button", { name: "Keep stock as is" }));
    expect(mutate.mock.calls[0][0].reapplyInventory).toBe(false);
  });

  it("[Back] returns to the form without sending", () => {
    renderModal(po());
    setCost("4");
    save();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Re-apply to inventory?")).toBeNull();
    expect(screen.getByLabelText(UNIT_COST)).toHaveValue(4);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("a header-only edit (notes) needs no question and sends no lines", () => {
    renderModal(po());
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Moved to dock 5" } });
    save();
    expect(screen.queryByText("Re-apply to inventory?")).toBeNull();
    expect(mutate.mock.calls[0][0]).toEqual({ id: "po1", notes: "Moved to dock 5" });
  });

  it("a raised quantity and an added line are allowed and asked about; the new line has no id", () => {
    renderModal(po());
    setQty("15");
    fireEvent.click(screen.getByRole("button", { name: /Add Row/ }));
    const selects = screen.getAllByLabelText("Product");
    fireEvent.change(selects[1], { target: { value: "p1" } });
    fireEvent.change(screen.getAllByLabelText("Quantity")[1], { target: { value: "5" } });
    fireEvent.change(screen.getAllByLabelText(UNIT_COST)[1], { target: { value: "2" } });
    save();
    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    const items = mutate.mock.calls[0][0].items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "i1", qtyOrdered: 15 });
    expect(items[1]).not.toHaveProperty("id");
    expect(items[1]).toMatchObject({ productId: "p1", qtyOrdered: 5, unitCost: 2 });
  });

  it("a supplier change can only be saved WITH the re-apply — Keep is disabled", () => {
    renderModal(po());
    fireEvent.change(screen.getByLabelText("Supplier"), { target: { value: "s2" } });
    save();
    expect(screen.getByRole("button", { name: "Keep stock as is" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    expect(mutate.mock.calls[0][0]).toMatchObject({ supplierId: "s2", reapplyInventory: true });
    // the server only re-posts the receipts when it is sent `items` — without them just the PO
    // header moves and the stock keeps the old supplier — so the (unchanged) lines ride along
    expect(mutate.mock.calls[0][0].items).toEqual([
      { id: "i1", productId: "p1", qtyOrdered: 10, unitCost: 3, sku: "W-1", packSize: null },
    ]);
  });

  it("shows the API's partly-consumed-lot refusal in words and leaves 'Keep stock as is' available", () => {
    mutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({
        response: { data: { code: "PO_LOT_PARTIALLY_CONSUMED", message: "raw" } },
      }),
    );
    renderModal(po());
    setCost("4");
    save();
    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/already been sold or used/);
    expect(screen.getByRole("alert")).toHaveTextContent(/Keep stock as is/);
    // still on the question, so the operator can choose the document-only route
    expect(screen.getByRole("button", { name: "Keep stock as is" })).toBeEnabled();
  });

  // The API treats PARTIAL exactly like RECEIVED for a line edit (inventory.service.ts
  // updatePurchaseOrder: `wasReceived = PARTIAL || RECEIVED`, and a line/supplier edit on a
  // received PO without `reapplyInventory` is a 400) — so the prompt is asked on BOTH, never on
  // DRAFT/SENT, and never for a header-only edit.
  const partial = () =>
    po({
      status: "PARTIAL",
      items: [{ id: "i1", productId: "p1", qtyOrdered: "10", qtyReceived: "4", unitCost: "3" }],
    });

  it("PARTIAL is protected the same way as RECEIVED, and a line edit asks the Re-apply question", () => {
    renderModal(partial());
    expect(screen.getByLabelText("Product")).toBeDisabled();
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("min", "4");
    setCost("4");
    save();
    expect(screen.getByRole("dialog", { name: "Re-apply to inventory?" })).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("a PARTIAL PO's header-only edit (notes) asks nothing — only a line change does", () => {
    renderModal(partial());
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Moved to dock 5" } });
    save();
    expect(screen.queryByRole("dialog", { name: "Re-apply to inventory?" })).toBeNull();
    expect(mutate.mock.calls[0][0]).toEqual({ id: "po1", notes: "Moved to dock 5" });
  });
});

describe("built from fresh data, once", () => {
  it("shows Loading… (and no form) until the fresh purchase order has loaded", () => {
    mockDetail = undefined;
    render(
      <PurchaseOrdersEditModal
        po={po()}
        suppliers={suppliers}
        products={products}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText("Edit PO-2026-0001")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByLabelText(UNIT_COST)).toBeNull();
  });

  it("waits for the product catalog too — a boxed line built before it arrives would flip shape", () => {
    mockDetail = po();
    render(
      <PurchaseOrdersEditModal po={po()} suppliers={suppliers} products={[]} onClose={jest.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByLabelText(UNIT_COST)).toBeNull();
  });

  it("uses the FRESH lines, not the stale list row (a line added since the list loaded must not be dropped)", () => {
    const stale = po({ status: "DRAFT" });
    mockDetail = po({
      status: "DRAFT",
      items: [
        ...stale.items.map((i) => ({ ...i, qtyReceived: "0" })),
        { id: "i2", productId: "p2", qtyOrdered: "12", qtyReceived: "0", unitCost: "2" },
      ],
    });
    render(
      <PurchaseOrdersEditModal
        po={stale}
        suppliers={suppliers}
        products={products}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getAllByLabelText("Product")).toHaveLength(2);
    // saving an unrelated header edit must not have removed it: lines unchanged → no items sent
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "x" } });
    save();
    expect(mutate.mock.calls[0][0]).toEqual({ id: "po1", notes: "x" });
  });
});

describe("values the API would reject are handled before the round trip", () => {
  it("rounds a cost to 4dp and a quantity to 3dp", () => {
    renderModal(draft());
    setCost("3.12345");
    setQty("10.1239");
    save();
    const item = mutate.mock.calls[0][0].items[0];
    expect(item.unitCost).toBe(3.1235);
    expect(item.qtyOrdered).toBe(10.124);
  });

  it("refuses a quantity above the maximum and below the minimum, and a cost above the maximum", () => {
    renderModal(draft());
    setQty("10000000");
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/9,999,999/);
    setQty("0.0004");
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 0.001/);
    setQty("5");
    setCost("1000000");
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/999,999/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows Nest's array of validation messages as one sentence, not a run-together blob", () => {
    mutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({
        response: {
          data: {
            message: ["qtyOrdered must not be greater than 9999999", "unitCost must be a number"],
          },
        },
      }),
    );
    renderModal(draft());
    setCost("4");
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "qtyOrdered must not be greater than 9999999; unitCost must be a number",
    );
  });
});

describe("Escape (the modal is a hand-rolled overlay, so it must handle the key itself)", () => {
  const esc = () => fireEvent.keyDown(document.body, { key: "Escape" });

  it("closes the edit form, sending nothing", () => {
    const onClose = renderModal(draft());
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("on the Re-apply prompt it is Back: the form returns with the edit kept, nothing is sent, the modal stays open", () => {
    const onClose = renderModal(po());
    setCost("4");
    save();
    expect(screen.getByRole("dialog", { name: "Re-apply to inventory?" })).toBeInTheDocument();
    esc();
    expect(screen.queryByRole("dialog", { name: "Re-apply to inventory?" })).toBeNull();
    expect(screen.getByLabelText(UNIT_COST)).toHaveValue(4);
    expect(mutate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // a second Escape now closes it
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is ignored while a save is in flight, so a half-sent update is never abandoned", () => {
    mockPending = true;
    const onClose = renderModal(draft());
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the Loading… placeholder too", () => {
    mockDetail = undefined;
    const onClose = jest.fn();
    render(
      <PurchaseOrdersEditModal
        po={po()}
        suppliers={suppliers}
        products={products}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
