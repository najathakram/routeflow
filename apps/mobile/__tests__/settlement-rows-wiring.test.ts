import { readFileSync } from "fs";
import { join } from "path";

// B1008 (SA-644): the settlement screen must build its rows through buildSettlementRows (server payload
// first), never straight from this device's own tally, which is what let the rows and the server-sourced
// total disagree; and it must not let the driver close the run on a device-only tally.
const src = readFileSync(join(__dirname, "../app/(driver)/route/settlement.tsx"), "utf8");

describe("settlement screen row source (B1008)", () => {
  it("imports and calls buildSettlementRows with the run's collectedPayments", () => {
    expect(src).toMatch(/buildSettlementRows/);
    expect(src).toMatch(/buildSettlementRows\(\s*run\?\.collectedPayments/);
  });

  it("no longer renders rows from the device-only summary.byMethod", () => {
    expect(src).not.toMatch(/summary\.byMethod/);
  });

  it("disables Close run (button and handler) until the totals are ready (loaded AND fetched this session)", () => {
    expect(src).toMatch(/isFetchedAfterMount/);
    expect(src).toMatch(/settlementTotalsReady\(\{[^}]*fetchedAfterMount: isFetchedAfterMount/);
    expect(src).toMatch(/disabled=\{[^}]*!totalsReady[^}]*\}/);
    expect(src).toMatch(/if \(!totalsReady\) return/);
  });
});
