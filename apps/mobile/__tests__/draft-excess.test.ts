import { readFileSync } from "fs";
import { join } from "path";
import { allocationTotals, draftBlockedByExcess } from "../lib/payments-logic";

// B1385: a draft payment cannot carry a leftover (it would become spendable credit). RN screens are not renderable in
// this lane, so the rule is a pure function and the screen's use of it is source-pinned.
describe("draftBlockedByExcess (B1385)", () => {
  it("a draft with a $50 leftover is blocked", () => {
    expect(draftBlockedByExcess(true, allocationTotals(50, []).excess)).toBe(true);
  });
  it("a paid save with a leftover is not blocked (it becomes an advance)", () => {
    expect(draftBlockedByExcess(false, 50)).toBe(false);
  });
  it("a draft with everything allocated, or dust under a tenth of a cent, is not blocked", () => {
    expect(draftBlockedByExcess(true, allocationTotals(50, [{ amount: 50 }]).excess)).toBe(false);
    expect(draftBlockedByExcess(true, 0.0005)).toBe(false);
  });
  it("record.tsx disables submit through it", () => {
    const src = readFileSync(join(__dirname, "..", "app/(operator)/payments/record.tsx"), "utf8");
    expect(src).toMatch(/submitDisabled=\{[^}]*draftBlockedByExcess\(asDraft, totals\.excess\)/);
  });
});
