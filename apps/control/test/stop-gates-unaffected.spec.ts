/**
 * T36 (R19) — REGRESSION PIN: .claude/hooks/stop.mjs is still the file that holds Gates 2 and 3.
 *
 * There is deliberately NO byte comparison against origin/master any more. It needed `origin/master`
 * in the checkout (CI has only the PR merge ref, so it was skipped there) and it turned red for any
 * PR that legitimately edits stop.mjs while `origin/master` exists, which made the pin a tax on
 * unrelated work (lead ruling on #2900). What matters to this package is only that the two gates the
 * bookkeeping flow depends on are still in the hook, so that is all this checks. It reads one file
 * and needs no git ref.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const STOP = path.join(ROOT, ".claude/hooks/stop.mjs");

describe("T36 stop.mjs Gates 2/3 unaffected (R19)", () => {
  it("stop.mjs is still the file that holds Gates 2 and 3 (always on, needs no git ref)", () => {
    const src = fs.readFileSync(STOP, "utf8");
    expect(src).toMatch(/Gate 2/);
    expect(src).toMatch(/Gate 3/);
  });
});
