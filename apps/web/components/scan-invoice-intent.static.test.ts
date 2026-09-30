import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "ScanInvoiceModal.tsx"), "utf8");

describe("ScanInvoiceModal intent (scan-to-PO wiring)", () => {
  it("a new invoice defaults to raisePo=false: the vendor-bills entry is unchanged", () => {
    expect(src).toMatch(/raisePo = false,\n\): InvoiceGroup/);
    expect(src).toMatch(/intent = "bill"/);
  });
  it("purchase-order intent starts every invoice with raisePo on", () => {
    expect(src).toMatch(/makeInvoice\(g\.kind, g\.files, intent === "purchase-order"\)/);
  });
  it("retitles the modal for purchase-order intent", () => {
    expect(src).toMatch(/Create a PO from a supplier invoice/);
  });
  it("reports a raised PO only when the raise actually fired and the response carries its id", () => {
    expect(src).toMatch(/if \(raisesPo && raisedPo\?\.id\) \{\s*onPurchaseOrderCreated/);
  });
  it("maps a 403 scan error to the lock copy in purchase-order mode, not the raw message", () => {
    expect(src).toMatch(/intent === "purchase-order" && isScanPlanLock\(err\)/);
    expect(src).toMatch(/planLocked\s*\? SCAN_LOCK_BODY/);
  });
});
