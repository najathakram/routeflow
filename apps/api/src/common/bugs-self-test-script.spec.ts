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
    // Observed runtime under this session's varying host load: 63s-131s. The spawnSync
    // timeout must sit comfortably above the worst observed case, and the outer jest
    // timeout must sit above THAT -- an inner bound tighter than the outer one means
    // spawnSync kills the child first, returning status:null/signal:'SIGTERM' (not a
    // real self-test failure) with an assertion failure that reads like one. Same class
    // this whole file exists to guard against (B231/B415), just one level up.
    const res = spawnSync(process.execPath, [SCRIPT, "self-test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 240_000,
    });

    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("self-test: all checks passed");
  }, 270_000);
});
