import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "ScanInvoiceModal.tsx"), "utf8");

describe("ScanInvoiceModal intent (scan-to-PO wiring)", () => {
  it("a new invoice defaults to raisePo=false: the vendor-bills entry is unchanged", () => {
    expect(src).toMatch(/raisePo = false,?\s*\): InvoiceGroup/);
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
  it("PO intent refuses to post a bare bill when the raise is off or blocked", () => {
    expect(src).toMatch(
      /poIntentRefusal\(\s*intent,\s*inv\.raisePo,\s*poBlockReason,\s*inv\.createMode,?\s*\)/,
    );
  });
  it("a plan lock on the create step also reads as the lock copy (closed copy otherwise)", () => {
    expect(src).toMatch(/error: planLocked \? SCAN_LOCK_BODY : RECORDS_FAILED_COPY/);
  });
  it("PO intent hides the create-mode selector and labels the footer for a purchase order", () => {
    expect(src).toMatch(
      /intent !== "purchase-order" && \(\s*<div>\s*<p className="mb-2 text-sm font-semibold text-navy">\s*What would you like to create\?/,
    );
    expect(src).toMatch(/"Create purchase order"/);
  });
});
