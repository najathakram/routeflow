/**
 * T36 (R19) — REGRESSION PIN (passes today): .claude/hooks/stop.mjs, which
 * holds Gates 2/3, is byte-unchanged versus origin/master.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

describe("T36 stop.mjs Gates 2/3 unaffected (R19)", () => {
  it("stop.mjs is byte-identical to origin/master", () => {
    const base = execFileSync("git", ["show", "origin/master:.claude/hooks/stop.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const cur = fs.readFileSync(path.join(ROOT, ".claude/hooks/stop.mjs"), "utf8");
    expect(cur).toBe(base);
  });
});
