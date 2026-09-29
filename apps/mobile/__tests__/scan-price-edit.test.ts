/**
 * B901 — the scan-tray price pencil did nothing on iOS: LinePriceModal was
 * presented while ScanOrderSheet's own Modal was up, and iOS cannot present a
 * Modal over another Modal (it queues it until the first dismisses). The fix
 * closes the scan sheet first, presents the price modal from the sheet's
 * Modal onDismiss on iOS (timer fallback elsewhere),
 * and reopens the scan sheet when the modal closes (cancel or save).
 */
import * as fs from "fs";
import * as path from "path";
import { SCAN_CLOSE_FALLBACK_MS, planScanPriceEdit } from "../lib/scan-price-edit";

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "components/NewOrderScreen.tsx"), "utf8");
const HOOK = fs.readFileSync(path.join(ROOT, "lib/use-scan-price-edit.ts"), "utf8");
const SHEET = fs.readFileSync(path.join(ROOT, "components/ScanOrderSheet.tsx"), "utf8");

function between(start: string, end: string, text: string = SRC): string {
  const s = text.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  const e = text.indexOf(end, s);
  expect(e).toBeGreaterThan(s);
  return text.slice(s, e);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("planScanPriceEdit (B901)", () => {
  it("iOS, scan open: close it, present from onDismiss, no timer, resume on close", () => {
    expect(planScanPriceEdit(true, "ios")).toEqual({
      closeScan: true,
      present: "onDismiss",
      fallbackDelayMs: 0,
      resumeScanOnClose: true,
    });
  });

  it.each(["android", "web"])("%s, scan open: timer fallback, resume on close", (platform) => {
    expect(planScanPriceEdit(true, platform)).toEqual({
      closeScan: true,
      present: "timer",
      fallbackDelayMs: SCAN_CLOSE_FALLBACK_MS,
      resumeScanOnClose: true,
    });
    expect(SCAN_CLOSE_FALLBACK_MS).toBe(450);
  });

  it("scan closed: present now, nothing to resume (any platform)", () => {
    for (const platform of ["ios", "android", "web"]) {
      expect(planScanPriceEdit(false, platform)).toEqual({
        closeScan: false,
        present: "now",
        fallbackDelayMs: 0,
        resumeScanOnClose: false,
      });
    }
  });
});

describe("useScanPriceEdit sequencing (B901, source pins)", () => {
  const handler = between(
    "const onTrayEditPrice = useCallback(",
    "const handleScanSheetDismiss",
    HOOK,
  );

  it("onTrayEditPrice closes the scan sheet BEFORE presenting the price modal", () => {
    const close = handler.indexOf("setScanOpen(false)");
    const present = handler.indexOf("setPriceEditId(id)");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(present).toBeGreaterThanOrEqual(0);
    expect(close).toBeLessThan(present);
  });

  it("plans with the platform; a SPECIAL line no longer refuses (#2696(c))", () => {
    expect(handler).toContain("planScanPriceEdit(scanOpenRef.current, Platform.OS)");
    // #2696(c): the contract-price refusal is gone — LinePriceModal asks the override reason.
    expect(handler).not.toContain("Contract price — not editable on this order");
    expect(handler).not.toContain("isSpecialLine");
  });

  it("the timer only exists on the 'timer' path and clears the pending ref when it fires", () => {
    expect(handler).toContain('plan.present === "timer"');
    const t = handler.indexOf("setTimeout(");
    expect(t).toBeGreaterThan(handler.indexOf('plan.present === "timer"'));
    expect(handler.indexOf("setTimeout(", t + 1)).toBe(-1);
    const fired = handler.slice(t);
    expect(fired).toContain("pendingPriceEditIdRef.current = null");
    expect(fired).toContain("plan.fallbackDelayMs");
  });

  it("handleScanSheetDismiss presents from the pending ref, once", () => {
    const h = between("const handleScanSheetDismiss = useCallback(", "const closePriceEdit", HOOK);
    expect(h).toContain("pendingPriceEditIdRef.current");
    expect(h.indexOf("pendingPriceEditIdRef.current = null")).toBeLessThan(
      h.indexOf("setPriceEditId("),
    );
    expect(h).toContain("setPriceEditId(");
  });

  it("modal close helper reopens the scan sheet via the resume flag", () => {
    const helper = HOOK.slice(HOOK.indexOf("const closePriceEdit"));
    expect(helper).toContain("resumeScanRef.current");
    expect(helper).toContain("setScanOpen(true)");
  });

  it("unmount clears the pending timer", () => {
    expect(HOOK).toContain("if (priceTimerRef.current) clearTimeout(priceTimerRef.current);");
  });
});

describe("NewOrderScreen wiring (B901, source pins)", () => {
  it("calls useScanPriceEdit and holds no sequencing state itself", () => {
    expect(SRC).toContain("useScanPriceEdit({");
    expect(SRC).not.toContain("pendingPriceEditIdRef");
    expect(SRC).not.toContain("planScanPriceEdit");
  });

  it("passes onDismiss to <ScanOrderSheet", () => {
    const sheet = between("<ScanOrderSheet", "onDone={() => setScanOpen(false)}");
    expect(sheet).toContain("onDismiss={handleScanSheetDismiss}");
  });

  it("modal onClose and onSave both go through closePriceEdit", () => {
    const modal = between("<LinePriceModal", "<CartModal");
    expect(modal).toContain("onClose={closePriceEdit}");
    const save = modal.slice(modal.indexOf("onSave="));
    expect(save).toContain("closePriceEdit()");
    expect(save).not.toContain("setPriceEditId(null)");
  });

  it("paused= expression is unchanged", () => {
    expect(SRC).toContain("paused={createCode != null || pickCode != null || priceEditId != null}");
  });
});

describe("ScanOrderSheet + retired constant (B901)", () => {
  it("forwards onDismiss to its Modal", () => {
    expect(SHEET).toContain("onDismiss?: () => void;");
    const modal = SHEET.slice(SHEET.indexOf("<Modal"), SHEET.indexOf(">", SHEET.indexOf("<Modal")));
    expect(modal).toContain("onDismiss={onDismiss}");
  });

  it("the fixed-timer constant no longer exists anywhere under apps/mobile", () => {
    const needle = ["PRICE_MODAL", "AFTER_SCAN", "CLOSE_MS"].join("_");
    const hits = walk(ROOT).filter((f) => fs.readFileSync(f, "utf8").includes(needle));
    expect(hits).toEqual([]);
  });
});
