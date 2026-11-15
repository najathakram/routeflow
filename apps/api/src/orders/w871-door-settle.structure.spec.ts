import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

/** SA-1156 section 0: the door apply runs the credit settle once, after the draft re-sync (A4), and the shrink reads the one predicate (S4). */
describe("W-871 door settle structure", () => {
  it("A4: approveChangeRequestAtStop calls syncAndSettleOrderCredits once, after reconcileOrderDraftInvoice", () => {
    const src = read("orders.service.ts");
    const start = src.indexOf("async approveChangeRequestAtStop(");
    const end = src.indexOf("\n  async ", start + 10);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body.match(/syncAndSettleOrderCredits\(/g)).toHaveLength(1);
    expect(body.indexOf("syncAndSettleOrderCredits(")).toBeGreaterThan(
      body.indexOf("reconcileOrderDraftInvoice("),
    );
  });

  it("S4: the credit settle's shrink calls isSettleAdjustedPayment once and never spells the filter by hand", () => {
    const src = read("../credit-notes/credit-notes.service.ts");
    expect(src.match(/isSettleAdjustedPayment\(/g)).toHaveLength(1);
    expect(src).not.toContain('p.method === "CREDIT_NOTE"');
  });
});
