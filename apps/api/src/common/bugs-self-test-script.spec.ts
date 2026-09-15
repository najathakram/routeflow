import { spawnSync } from "node:child_process";
import path from "node:path";

// REG-B231 / REG-B415 — scripts/campaign/bugs.mjs's own self-test harness (`node
// scripts/campaign/bugs.mjs self-test`) is not a jest test, so campaign-check has no
// literal jest test it can point at to prove these regressions stay fixed. This is a
// thin wrapper: it drives the real self-test harness as a child process and asserts its
// process contract (exit code + the harness's own summary line). No mocking — the
// harness's internal checks (including the lock-order race and lock-liveness checks
// these registry entries are about) run for real.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/campaign/bugs.mjs");

describe("bugs.mjs self-test contract (REG-B231, REG-B415)", () => {
  it("exits 0 and reports all checks passed", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "self-test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("self-test: all checks passed");
  });
});
