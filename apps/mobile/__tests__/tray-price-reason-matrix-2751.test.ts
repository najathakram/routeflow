/**
 * #2751 / #2696(c) — the scan-tray pencil's REASON matrix, at the pure-function level plus a
 * source pin on the screen's onSave wiring. Oracle: tier 10.00 (special), list 15.00.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { decideStaffOverride, withinStaffOverrideTolerance } from "@routeflow/pricing";
import { decideTrayPrice } from "../lib/staff-price-override";

const rule = { base: 10, listPrice: 15, isSpecial: true };

describe("#2751 tray reason matrix (tier 10.00, list 15.00, special tier)", () => {
  it("off-tier 12.00 with no reason is refused, with the reason-required signal", () => {
    expect(decideTrayPrice({ ...rule, typed: 12, reason: "" })).toEqual({ kind: "refused" });
    expect(decideTrayPrice({ ...rule, typed: 12, reason: undefined })).toEqual({ kind: "refused" });
    expect(
      decideStaffOverride({
        overridePrice: 12,
        baselinePrice: 10,
        listPrice: 15,
        isSpecialTier: true,
        hasReason: false,
      }),
    ).toEqual({ refused: "REASON_REQUIRED" });
  });

  it("off-tier 12.00 with reason 'contract' is set, and the rule stamps DISCOUNTED", () => {
    expect(decideTrayPrice({ ...rule, typed: 12, reason: "contract" })).toEqual({
      kind: "set",
      price: 12,
      overrideReason: "contract",
    });
    expect(
      decideStaffOverride({
        overridePrice: 12,
        baselinePrice: 10,
        listPrice: 15,
        isSpecialTier: true,
        hasReason: true,
      }),
    ).toEqual({ priceType: "DISCOUNTED", unitPrice: 12, originalPrice: 15 });
  });

  it("typing the tier price back CLEARS even with a stale reason present", () => {
    expect(decideTrayPrice({ ...rule, typed: 10, reason: "contract" })).toEqual({ kind: "clear" });
    expect(
      decideStaffOverride({
        overridePrice: 10,
        baselinePrice: 10,
        listPrice: 15,
        isSpecialTier: true,
        hasReason: true,
      }),
    ).toEqual({ priceType: "SPECIAL", unitPrice: 10, originalPrice: 15 });
  });

  it("the half-cent band is the boundary: inside clears, outside needs the reason", () => {
    expect(withinStaffOverrideTolerance(10.004, 10)).toBe(true);
    expect(decideTrayPrice({ ...rule, typed: 10.004, reason: "" })).toEqual({ kind: "clear" });
    expect(withinStaffOverrideTolerance(10.02, 10)).toBe(false);
    expect(decideTrayPrice({ ...rule, typed: 10.02, reason: "" })).toEqual({ kind: "refused" });
  });

  it("a whitespace-only reason counts as none", () => {
    expect(decideTrayPrice({ ...rule, typed: 12, reason: "   " })).toEqual({ kind: "refused" });
  });
});

describe("#2751 the screen's tray onSave cannot bypass the decision", () => {
  const screen = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const mount = (screen.match(/<LinePriceModal[\s\S]*?\n\s*\/>/) ?? [""])[0];

  it("onSave receives the reason and passes typed price AND reason to decideTrayPrice", () => {
    expect(mount).toMatch(/onSave=\{\(value, reason\) =>/);
    expect(mount).toMatch(/decideTrayPrice\(\{ typed: price, \.\.\.target\.rule, reason \}\)/);
  });

  it("only a 'set' decision writes a price+reason; 'clear' drops both; 'refused' writes nothing", () => {
    expect(mount).toMatch(
      /d\.kind === "set"\) setLinePrice\(target\.id, d\.price, d\.overrideReason\)/,
    );
    expect(mount).toMatch(/d\.kind === "clear"\) setLinePrice\(target\.id, null\)/);
    expect(mount).not.toMatch(/refused/);
    const setter = (screen.match(/const setLinePrice = [\s\S]*?\n    \}\);/) ?? [""])[0];
    expect(setter).toMatch(/delete rest\.overrideReason/);
  });
});
