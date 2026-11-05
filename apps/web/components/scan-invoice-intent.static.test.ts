import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "ScanInvoiceModal.tsx"), "utf8");
const failureSrc = readFileSync(join(__dirname, "..", "lib", "scan-failure-copy.ts"), "utf8");

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
  it("the modal uses the extracted selector and footer label (PO slice lives in its own modules)", () => {
    expect(src).toMatch(/<ScanCreateModeSelector\s+intent=\{intent\}/);
    expect(src).toMatch(/scanCreateLabel\(\{\s*intent,/);
  });
  it("M1-1: the modal gets every scan failure's copy from scanFailureCopy (one call, both flows)", () => {
    expect(src.split("scanFailureCopy(")).toHaveLength(2);
    expect(src).toMatch(/title: failure\.title, description: failure\.description/);
    expect(src).toMatch(/error: failure\.rowError/);
  });
  it("M1-1: a cap refusal reads as the paused-until copy, after the plan lock and ahead of 'clearer photo'", () => {
    const flat = failureSrc.replace(/\s+/g, " ");
    const at = (s: string) => flat.indexOf(s);
    expect(at("if (planLocked)")).toBeGreaterThan(-1);
    expect(at("if (capPaused)")).toBeGreaterThan(at("if (planLocked)"));
    expect(at("if (isApiKeyError)")).toBeGreaterThan(at("if (capPaused)"));
    expect(at("description: SCAN_FAILED_COPY")).toBeGreaterThan(at("if (isApiKeyError)"));
  });
  it("a scan-step failure shows the closed SCAN_FAILED_COPY, never the server text", () => {
    expect(failureSrc).toMatch(/description: SCAN_FAILED_COPY,/);
    expect(failureSrc).toMatch(/rowError: SCAN_FAILED_COPY,/);
    expect(src).not.toMatch(/shownMsg/);
    expect(failureSrc).not.toMatch(/shownMsg/);
    expect(src).not.toMatch(/data\??\.message/); // the modal never reads the server's text for a scan failure
  });
});
