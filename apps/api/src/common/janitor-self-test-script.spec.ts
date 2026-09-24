import { spawnSync } from "node:child_process";
import path from "node:path";

// B800: scripts/janitor.self-test.mjs is a plain node script, so nothing ran it — a regression in the
// janitor's "is this worktree merged / safe to touch" rules would ship silently, and those rules
// decide whether `janitor:apply` deletes a lane's worktree. This thin wrapper drives the real
// self-test as a child process (it builds its own throwaway git repos under the OS temp dir and
// scrubs GIT_* first) and asserts its process contract.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/janitor.self-test.mjs");

describe("janitor self-test contract (B800)", () => {
  it("exits 0 with no failures, including the fresh zero-commit branch case", () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(res.signal).toBeNull();
    expect(res.stderr).not.toMatch(/FAIL/);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/janitor self-test: \d+ passed, 0 failed/);
  }, 150_000);
});
