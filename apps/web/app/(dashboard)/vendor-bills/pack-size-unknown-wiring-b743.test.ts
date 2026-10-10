/**
 * B743 PR B (REG-B743-web): the two receive surfaces route PACK_SIZE_UNKNOWN to an explicit
 * choice. The bill page and ScanInvoiceModal have no RTL harness (both are large client
 * components), so their wiring is pinned from source, like scanner-refocus-wiring-b744.test.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";

const WEB = join(__dirname, "..", "..", "..");
const page = readFileSync(join(__dirname, "[id]", "page.tsx"), "utf8");
const scan = readFileSync(join(WEB, "components", "ScanInvoiceModal.tsx"), "utf8");

describe("B743 — PACK_SIZE_UNKNOWN wiring (REG-B743-web)", () => {
  it("the bill page checks PACK_SIZE_UNKNOWN before the unlinked-lines dialog", () => {
    const onError = page.slice(page.indexOf("onError: (err: any) => {"));
    expect(onError.indexOf("getPackSizeUnknownError(err)")).toBeGreaterThan(-1);
    expect(onError.indexOf("getPackSizeUnknownError(err)")).toBeLessThan(
      onError.indexOf("getUnlinkedItemsError(err)"),
    );
  });

  it("the bill page acknowledges the pack ONLY from the dialog's loose-pieces choice", () => {
    expect(page).toContain(
      "onReceiveLoose={() => handleReceive(lastAckUnlinked, pendingReceiveItems, true)}",
    );
    // Every other receive call leaves the third argument (the pack acknowledgement) unset.
    const calls = page.match(/handleReceive\([^)]*\)/g) ?? [];
    const acknowledging = calls.filter((c) => /,\s*true\)$/.test(c) && c.split(",").length === 3);
    expect(acknowledging).toEqual(["handleReceive(lastAckUnlinked, pendingReceiveItems, true)"]);
  });

  it("ScanInvoiceModal never sends acknowledgePackSizeUnknown, and routes the refusal to a note", () => {
    expect(scan).not.toContain("acknowledgePackSizeUnknown");
    expect(scan).toContain("getPackSizeUnknownError(receiveErr)");
    expect(scan).toContain("don't state units per case");
  });
});
