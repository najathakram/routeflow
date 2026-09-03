/**
 * F11 — TP4: pins P11–P12 (test-plan.md "Pins"). GREEN pre-impl AND
 * post-impl. Titles carry NO `REG-` token by design — mobile's testMatch
 * globs every __tests__ dir for *.test.ts, so this *.pins.test.ts file is
 * what the red gate's --testPathIgnorePatterns pins excludes (a
 * .pins.spec.ts would never even be collected here).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { trackingStepIndex } from "../lib/order-tracking-logic";

// ─── P11 (B146) ─────────────────────────────────────────────────────────────

describe("pin (B146): trackingStepIndex is unchanged by the F11 helpers", () => {
  it("keeps today's step indices — the F11 headline/interval helpers are additive, not a rewrite", () => {
    expect(trackingStepIndex("OUT_FOR_DELIVERY")).toBe(2);
    expect(trackingStepIndex("CANCELLED")).toBe(-1);
  });
});

// ─── P12 (B34) ──────────────────────────────────────────────────────────────

describe("pin (B34): the operator route-runs screen still skips through useUpdateStopStatus", () => {
  it('source text still wires Skip through useUpdateStopStatus with status: "SKIPPED" — B34\'s working model must not regress if this screen is later refactored onto the shared driver-side handler', () => {
    const screenSrc = readFileSync(
      join(__dirname, "..", "app", "(operator)", "route-runs", "[id].tsx"),
      "utf8",
    );
    expect(screenSrc).toMatch(/status: "SKIPPED"/);
    expect(screenSrc).toMatch(/useUpdateStopStatus/);
  });
});
