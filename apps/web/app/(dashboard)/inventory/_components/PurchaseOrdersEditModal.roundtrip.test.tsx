/**
 * P1 commit 1 (SA-1207 spec 20): the B689 and B690 symptoms, pinned on the EDIT path before the create
 * half ships. Both bugs were closed as stale-image artifacts; these tests prove the client sends the right
 * shape today (an edited boxed cost on a received order; an untouched boxed line beside an edited plain one).
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { PurchaseOrdersEditModal } from "./PurchaseOrdersEditModal";
import type { PurchaseOrder } from "./purchase-orders-shared";
import { unitWords } from "@routeflow/pricing";

const UW = unitWords();
const COST_PER_BOX = `Cost per ${UW.pack.lower}`;

jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});
const mutate = jest.fn();
let mockDetail: PurchaseOrder | undefined;
jest.mock("@/lib/api/inventory", () => ({
  useUpdatePurchaseOrder: () => ({ mutate, isPending: false }),
  usePurchaseOrder: () => ({ data: mockDetail, isError: false }),
}));

const suppliers = [{ id: "s1", name: "Acme Supply", isActive: true }];
const products = [
  { id: "p1", name: "Widget", sku: "W-1", unitsPerBox: null },
  { id: "p2", name: "Boxed Gadget", sku: "G-1", unitsPerBox: 12 },
];
const boxedLine = (qtyReceived: string) => ({
  id: "i1",
  productId: "p2",
  qtyOrdered: "60",
  qtyReceived,
  unitCost: "1.0000",
  totalCost: "60.00",
  sku: null,
  packSize: 12,
});
const base = (status: PurchaseOrder["status"], items: PurchaseOrder["items"]): PurchaseOrder => ({
  id: "po1",
  poNumber: "PO-2026-0001",
  supplier: suppliers[0],
  status,
  totalAmount: "60.00",
  expectedDate: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-09-01",
  items,
});
const open = (p: PurchaseOrder) => {
  mockDetail = p;
  render(
    <PurchaseOrdersEditModal
      po={p}
      suppliers={suppliers}
      products={products}
      onClose={jest.fn()}
    />,
  );
};
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

beforeEach(() => {
  jest.clearAllMocks();
  mutate.mockImplementation((_v, opts) => opts?.onSuccess?.());
});

describe("B689 symptom: a boxed cost edit on a RECEIVED PO", () => {
  it("sends the new case cost in the case shape, and Keep stock as is closes the modal as saved", () => {
    open(base("RECEIVED", [boxedLine("60")]));
    fireEvent.change(screen.getByLabelText(COST_PER_BOX), { target: { value: "11" } });
    save();
    fireEvent.click(screen.getByRole("button", { name: "Keep stock as is" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      id: "po1",
      reapplyInventory: false,
      items: [
        {
          id: "i1",
          productId: "p2",
          packSize: 12,
          caseCost: 11,
          cases: 5,
          loosePieces: 0,
          sku: null,
        },
      ],
    });
  });
});

describe("B690 symptom: a DRAFT edited a second time, only the plain line touched", () => {
  it("round-trips the untouched boxed line in the case shape with no piece fields, and the plain line in the piece shape", () => {
    open(
      base("DRAFT", [
        boxedLine("0"),
        {
          id: "i2",
          productId: "p1",
          qtyOrdered: "10",
          qtyReceived: "0",
          unitCost: "3",
          sku: null,
          packSize: null,
        },
      ]),
    );
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "12" } });
    save();
    const items = mutate.mock.calls[0][0].items;
    expect(items[0]).toEqual({
      id: "i1",
      productId: "p2",
      packSize: 12,
      caseCost: 12,
      cases: 5,
      loosePieces: 0,
      sku: null,
    });
    expect(items[0]).not.toHaveProperty("qtyOrdered");
    expect(items[1]).toEqual({
      id: "i2",
      productId: "p1",
      qtyOrdered: 12,
      unitCost: 3,
      sku: null,
      packSize: null,
    });
    for (const it of items) expect(it.qtyOrdered ?? 0).toBeLessThanOrEqual(9_999_999);
  });
});
