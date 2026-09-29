/**
 * B901 — the scan-tray price pencil did nothing on iOS: LinePriceModal was
 * presented while ScanOrderSheet's own Modal was up, and iOS cannot present a
 * Modal over another Modal (it queues it until the first dismisses). The fix
 * closes the scan sheet first, presents the price modal after the dismissal,
 * and reopens the scan sheet when the modal closes (cancel or save).
 */
import * as fs from "fs";
import * as path from "path";
import {
  PRICE_MODAL_AFTER_SCAN_CLOSE_MS,
  planScanPriceEdit,
} from "../lib/scan-price-edit";

const SRC = fs.readFileSync(path.join(__dirname, "../components/NewOrderScreen.tsx"), "utf8");

function between(start: string, end: string): string {
  const s = SRC.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  const e = SRC.indexOf(end, s);
  expect(e).toBeGreaterThan(s);
  return SRC.slice(s, e);
}

describe("planScanPriceEdit (B901)", () => {
  it("scan open: close it, wait out the dismissal, resume on close", () => {
    expect(planScanPriceEdit(true)).toEqual({
      closeScan: true,
      presentDelayMs: PRICE_MODAL_AFTER_SCAN_CLOSE_MS,
      resumeScanOnClose: true,
    });
    expect(PRICE_MODAL_AFTER_SCAN_CLOSE_MS).toBeGreaterThan(0);
  });

  it("scan closed: present immediately, nothing to resume", () => {
    expect(planScanPriceEdit(false)).toEqual({
      closeScan: false,
      presentDelayMs: 0,
      resumeScanOnClose: false,
    });
  });
});

describe("NewOrderScreen wiring (B901, source pins)", () => {
  const handler = between("const onTrayEditPrice = useCallback(", "const priceEditTarget");

  it("onTrayEditPrice closes the scan sheet BEFORE presenting the price modal", () => {
    const close = handler.indexOf("setScanOpen(false)");
    const present = handler.indexOf("setPriceEditId(id)");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(present).toBeGreaterThanOrEqual(0);
    expect(close).toBeLessThan(present);
  });

  it("onTrayEditPrice plans via planScanPriceEdit and keeps the contract-price refusal", () => {
    expect(handler).toContain("planScanPriceEdit(");
    expect(handler).toContain("Contract price — not editable on this order");
  });

  it("modal onClose and onSave reopen the scan sheet via the resume flag", () => {
    const helper = between("const closePriceEdit", "const priceEditTarget");
    expect(helper).toContain("resumeScanRef.current");
    expect(helper).toContain("setScanOpen(true)");
    const modal = between("<LinePriceModal", "<CartModal");
    expect(modal).toContain("onClose={closePriceEdit}");
    const save = modal.slice(modal.indexOf("onSave="));
    expect(save).toContain("closePriceEdit()");
    expect(save).not.toContain("setPriceEditId(null)");
  });

  it("paused= expression is unchanged", () => {
    expect(SRC).toContain(
      "paused={createCode != null || pickCode != null || priceEditId != null}",
    );
  });
});
