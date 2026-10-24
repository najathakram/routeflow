import * as fs from "fs";
import * as path from "path";

/**
 * Row 672 (SA-924): a buyer refusal that only waits on the buyer's own state shows the ONE shared sentence
 * (`buyerNeedsStateCopy` -> PORTAL_NEEDS_STATE_MESSAGE in packages/types), not the generic cart error. The helper is
 * read from the REAL source (the jest @routeflow/types stub is a hand copy); the screen is a source guard, per the
 * mobile pure-logic test style.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const types =
  require("../../../packages/types/api/restrictions") as typeof import("../../../packages/types/api/restrictions");
const src = fs.readFileSync(path.join(__dirname, "../app/(customer)/orders/cart.tsx"), "utf8");

const refusal = (data: object, status = 409) => ({ response: { status, data } });

describe("buyerNeedsStateCopy", () => {
  it("returns the shared sentence for a needs-state refusal", () => {
    expect(
      types.buyerNeedsStateCopy(
        refusal({ code: "SELLING_RESTRICTED", blockedLines: [], remedy: "ADD_CUSTOMER_STATE" }),
      ),
    ).toBe(types.PORTAL_NEEDS_STATE_MESSAGE);
  });

  it.each([
    ["a ban refusal (no remedy)", refusal({ code: "SELLING_RESTRICTED", blockedLines: [] })],
    ["another code", refusal({ code: "INSUFFICIENT_STOCK", remedy: "ADD_CUSTOMER_STATE" })],
    ["another status", refusal({ code: "SELLING_RESTRICTED", remedy: "ADD_CUSTOMER_STATE" }, 400)],
    ["a network error", new Error("offline")],
    ["nothing", undefined],
  ])("is null for %s", (_label, err) => {
    expect(types.buyerNeedsStateCopy(err)).toBeNull();
  });
});

describe("customer cart screen: needs-state refusal", () => {
  it("toasts buyerNeedsStateCopy before the generic fallback", () => {
    const at = src.indexOf("buyerNeedsStateCopy(e)");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/showToast\(needsState\);\s*return;/);
    expect(at).toBeLessThan(src.indexOf("Couldn't update your cart. Try again."));
  });
});
