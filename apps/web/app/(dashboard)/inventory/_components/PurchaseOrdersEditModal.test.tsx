/**
 * The Edit-PO modal (LANE-U step 6, web half): DRAFT/SENT edit freely; a received
 * order's lines are protected and saving a change to them asks "Re-apply to
 * inventory?" — the API needs an explicit answer, and the modal must never guess.
 */
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PurchaseOrdersEditModal } from "./PurchaseOrdersEditModal";
import type { PurchaseOrder } from "./purchase-orders-shared";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast }) };
});

const mutate = jest.fn();
jest.mock("@/lib/api/inventory", () => ({
  useUpdatePurchaseOrder: () => ({ mutate, isPending: false }),
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
    total: 30,
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
  render(
    <PurchaseOrdersEditModal po={p} suppliers={suppliers} products={products} onClose={onClose} />,
  );
  return onClose;
};
const setCost = (v: string) =>
  fireEvent.change(screen.getByLabelText("Unit cost"), { target: { value: v } });
const setQty = (v: string) =>
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: v } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

beforeEach(() => {
  jest.clearAllMocks();
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
    expect(screen.getByLabelText("Unit cost")).toHaveValue(3);
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
    expect(screen.getByLabelText("Unit cost")).toHaveValue(24);
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
    expect(screen.getByLabelText("Unit cost")).toHaveValue(4);
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
    fireEvent.change(screen.getAllByLabelText("Unit cost")[1], { target: { value: "2" } });
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

  it("PARTIAL is protected the same way as RECEIVED", () => {
    renderModal(
      po({
        status: "PARTIAL",
        items: [{ id: "i1", productId: "p1", qtyOrdered: "10", qtyReceived: "4", unitCost: "3" }],
      }),
    );
    expect(screen.getByLabelText("Product")).toBeDisabled();
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("min", "4");
    setCost("4");
    save();
    expect(screen.getByRole("dialog", { name: "Re-apply to inventory?" })).toBeInTheDocument();
  });
});
