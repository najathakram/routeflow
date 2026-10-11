import { readFileSync } from "fs";
import { join } from "path";
import { refundBlockedText } from "../lib/standard-refund";

// SA-773: the refund claim refuses a STANDARD return whose goods were already returned or credited, so the return screen blocks
// Resolve and says what is left instead of offering the priced amount.
describe("refundBlockedText", () => {
  it("is null for a return the claim would accept", () => {
    expect(refundBlockedText({ refundEstimate: 55, refundEstimateReason: null })).toBeNull();
    expect(
      refundBlockedText({ refundEstimate: 0, refundEstimateReason: "NOTHING_BILLED" }),
    ).toBeNull();
    expect(refundBlockedText({})).toBeNull();
  });

  it("says what is left, or that nothing is, and names the way out", () => {
    const some = refundBlockedText({
      refundEstimate: 10,
      refundEstimateReason: "EXCEEDS_REFUNDABLE",
    });
    expect(some).toMatch(/already returned or credited/);
    expect(some).toMatch(/Up to \$10\.00 can still be given back for these goods\./);
    expect(some).toMatch(/Cancel the return/);
    expect(
      refundBlockedText({ refundEstimate: 0, refundEstimateReason: "EXCEEDS_REFUNDABLE" }),
    ).toMatch(/Nothing more can be given back/);
  });

  it("the return screen disables Resolve on it and shows the text (wired, not just defined)", () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "(operator)", "returns", "[id].tsx"),
      "utf8",
    );
    expect(src).toContain("refundBlockedText(ret)");
    expect(src).toMatch(/label="Resolve return"\s+disabled=\{anyPending \|\| !!blockedText\}/);
  });
});
