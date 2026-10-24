import * as fs from "fs";
import * as path from "path";
import { DUNNING_SWEEP_WHERE } from "./auto-lock-candidates";
import { DunningService } from "./dunning.service";

/**
 * SA-775 follow-up: the hourly dunning sweep and the super-admin unpause preview must select the very same rows,
 * so the cron scans with the ONE exported predicate (`DUNNING_SWEEP_WHERE`) and keeps no copy of it (L-167).
 */
describe("dunning sweep predicate (one copy)", () => {
  it("sweep() scans with exactly DUNNING_SWEEP_WHERE", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { tenantSubscription: { findMany } } as any;
    const stripe = { isConfigured: true } as any;
    const svc = new DunningService(prisma, stripe, {} as any, {} as any);
    const prev = process.env.BILLING_PAUSE_MODE;
    process.env.BILLING_PAUSE_MODE = "dark";
    try {
      await svc.sweep(new Date("2026-11-02T00:00:00Z"));
    } finally {
      if (prev === undefined) delete process.env.BILLING_PAUSE_MODE;
      else process.env.BILLING_PAUSE_MODE = prev;
    }
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual(DUNNING_SWEEP_WHERE);
  });

  it("dunning.service.ts references DUNNING_SWEEP_WHERE and spells none of the predicate itself", () => {
    const src = fs
      .readFileSync(path.join(__dirname, "dunning.service.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    expect(src).toContain("DUNNING_SWEEP_WHERE");
    expect(src).not.toMatch(/externalPayment:\s*false/);
    expect(src).not.toMatch(/catchupState:\s*null/);
    expect(src).not.toMatch(/pastDueInvoiceId:\s*\{\s*not:\s*null/);
  });
});
