/**
 * T36 (R19) — REGRESSION PIN: .claude/hooks/stop.mjs, which holds Gates 2/3, is byte-unchanged
 * versus origin/master.
 *
 * CI checks out only the PR merge ref, so `origin/master` is not in its repository (lead review of
 * #2900, B2). The byte comparison therefore runs only when the base ref exists (every local
 * checkout); otherwise it is skipped with a visible warning and the always-on pin below still
 * holds. STOP_GATES_BASE_REF overrides the ref (used to prove the skip path).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const BASE = process.env.STOP_GATES_BASE_REF ?? "origin/master";
const STOP = path.join(ROOT, ".claude/hooks/stop.mjs");

const hasBase = ((): boolean => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();
if (!hasBase) {
  console.warn(
    `T36 byte comparison skipped: ${BASE} is not in this checkout (CI has the merge ref only)`,
  );
}

describe("T36 stop.mjs Gates 2/3 unaffected (R19)", () => {
  (hasBase ? it : it.skip)(`stop.mjs is byte-identical to ${BASE}`, () => {
    const base = execFileSync("git", ["show", `${BASE}:.claude/hooks/stop.mjs`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(fs.readFileSync(STOP, "utf8")).toBe(base);
  });

  it("stop.mjs is still the file that holds Gates 2 and 3 (always on, needs no git ref)", () => {
    const src = fs.readFileSync(STOP, "utf8");
    expect(src).toMatch(/Gate 2/);
    expect(src).toMatch(/Gate 3/);
  });
});
