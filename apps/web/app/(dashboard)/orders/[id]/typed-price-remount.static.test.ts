/**
 * #2381: the order-edit page marks a line whose price the operator TYPED, so the unit picker's
 * first-sight refresh (which re-runs on every remount — "Not available" → Undo) never snaps it back
 * to the ladder. A deliberate unit change clears the mark: its price is the ladder's. Payloads are
 * unchanged (buildItemUpdates never reads the flag).
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("order-edit typed price survives a picker remount (#2381)", () => {
  it("typing a price marks the line", () => {
    expect(src).toMatch(
      /onPriceChange=\{\(net\) => update\(item\.id, \{ unitPrice: net, priceEdited: true \}\)\}/,
    );
  });

  it("the picker is told the line was typed", () => {
    const at = src.indexOf("<OrderLineUnitPicker");
    expect(src.slice(at, src.indexOf("/>", at))).toMatch(/priceEdited: item\.priceEdited/);
  });

  it("a deliberate unit change clears the mark", () => {
    const at = src.indexOf("function setLineUnit");
    expect(src.slice(at, src.indexOf("\n  }\n", at))).toMatch(/priceEdited: false/);
  });

  it("buildItemUpdates never sends it", () => {
    const at = src.indexOf("export function buildItemUpdates");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 6000)).not.toMatch(/priceEdited/);
  });
});
