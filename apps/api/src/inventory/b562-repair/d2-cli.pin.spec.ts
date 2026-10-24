import { readFileSync } from "fs";
import * as path from "path";

/**
 * SA-911 "also checked": `applyD2InTx`'s `expectXNow` override exists only for R-D2b's forced mismatch. Neither the runner
 * the owner-run wrapper imports nor the wrapper itself may reach it, so the apply's assert always compares against
 * D2's own X_now.
 */
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

describe("D2's test-only assert override stays unreachable from the CLI", () => {
  it.each([["d2-runner.ts"], ["../../../scripts/b562-d2-average-repair.mjs"]])(
    "%s never names expectXNow",
    (rel) => {
      expect(read(rel)).not.toMatch(/expectXNow/);
    },
  );
  it("the override is still the apply's own (so this pin guards a real seam)", () => {
    expect(read("d2-repair.ts")).toMatch(/expectXNow\?: \(entry: D2Entry\) => string/);
  });
});
