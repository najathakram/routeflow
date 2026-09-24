import { buildVendorBillPayload, type ScanBillPayloadInput } from "./scan-bill-payload";
import type { CreateVendorBillItem } from "./api/vendor-bills";

/**
 * MONEY/WIRING guard (#1045 review): nothing tested that `createPurchaseOrder` actually reaches
 * the create-bill payload — drop it and the bill auto-receives, stock moves, no PO is raised,
 * and every OTHER test stays green (this is the ONLY place that would go red).
 */
const inv = (over: Partial<ScanBillPayloadInput> = {}): ScanBillPayloadInput => ({
  supplierId: "sup-1",
  billDate: "2026-09-21",
  dueDate: "2026-10-05",
  invoiceNumber: "INV-1",
  allowDuplicate: false,
  raisePo: false,
  ...over,
});
const matchedItem: CreateVendorBillItem = {
  productId: "p1",
  description: "Widget",
  qty: 1,
  unitCost: 10,
} as CreateVendorBillItem;
const unmatchedItem: CreateVendorBillItem = {
  description: "Mystery item",
  qty: 1,
  unitCost: 10,
} as CreateVendorBillItem;

describe("buildVendorBillPayload", () => {
  it("MONEY/WIRING: raisePo on, no blocker — createPurchaseOrder: true reaches the payload", () => {
    const payload = buildVendorBillPayload(inv({ raisePo: true }), [matchedItem]);
    expect(payload.createPurchaseOrder).toBe(true);
  });

  it("raisePo off — createPurchaseOrder is omitted (undefined), never false", () => {
    const payload = buildVendorBillPayload(inv({ raisePo: false }), [matchedItem]);
    expect(payload.createPurchaseOrder).toBeUndefined();
  });

  it("raisePo on but BLOCKED (an unmatched line) — createPurchaseOrder is omitted, not true", () => {
    const payload = buildVendorBillPayload(inv({ raisePo: true }), [unmatchedItem]);
    expect(payload.createPurchaseOrder).toBeUndefined();
  });

  it("passes items, dates, notes and the supplier invoice number through", () => {
    const payload = buildVendorBillPayload(inv({ invoiceNumber: "  INV-9  " }), [matchedItem]);
    expect(payload.items).toEqual([matchedItem]);
    expect(payload.billDate).toBe("2026-09-21");
    expect(payload.dueDate).toBe("2026-10-05");
    expect(payload.notes).toBe("Supplier invoice #  INV-9  ");
    expect(payload.supplierInvoiceNumber).toBe("INV-9");
  });

  it("MONEY: rounds tax/subtotal to cents, omits them when zero or absent", () => {
    expect(buildVendorBillPayload(inv({ tax: 2.005 }), [matchedItem]).taxAmount).toBe(2.01);
    expect(buildVendorBillPayload(inv({ subtotal: 9.995 }), [matchedItem]).subtotal).toBe(10);
    expect(buildVendorBillPayload(inv({ tax: 0 }), [matchedItem]).taxAmount).toBeUndefined();
    expect(buildVendorBillPayload(inv(), [matchedItem]).subtotal).toBeUndefined();
  });

  it("scanId passes through; absent becomes undefined, never null", () => {
    expect(buildVendorBillPayload(inv({ scanId: "scan-1" }), [matchedItem]).scanId).toBe("scan-1");
    expect(buildVendorBillPayload(inv(), [matchedItem]).scanId).toBeUndefined();
  });
});
