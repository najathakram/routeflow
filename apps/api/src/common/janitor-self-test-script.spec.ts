import path from "node:path";
import { IDLE_RUN_MAX_MS, runWithIdleTimeout } from "./testing/run-with-idle-timeout";

// B800: scripts/janitor.self-test.mjs is a plain node script, so nothing ran it — a regression in the
// janitor's "is this worktree merged / safe to touch" rules would ship silently, and those rules
// decide whether `janitor:apply` deletes a lane's worktree. This thin wrapper drives the real
// self-test as a child process (it builds its own throwaway git repos under the OS temp dir and
// scrubs GIT_* first) and asserts its process contract.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/janitor.self-test.mjs");

// #2146: the child's time is intrinsic real process spawns (PowerShell cold starts plus ~150 git
// spawns): ~56s standalone, ~129s when the machine is contended. A fixed total-time budget therefore
// failed a healthy child exactly when the machine was busiest, so the budget is IDLE time: the child
// prints one progress mark per case and is ended only when it goes this long without output (stuck).
// JANITOR_SELF_TEST_TIMEOUT_MS overrides the idle window for a slower box without touching this file
// (a non-numeric or non-positive value falls back to the default).
const DEFAULT_IDLE_MS = 300_000;
const envIdleMs = Number(process.env.JANITOR_SELF_TEST_TIMEOUT_MS);
const IDLE_MS = Number.isFinite(envIdleMs) && envIdleMs > 0 ? envIdleMs : DEFAULT_IDLE_MS;

describe("janitor self-test contract (B800)", () => {
  it(
    "exits 0 with no failures, including the fresh zero-commit branch case",
    async () => {
      const res = await runWithIdleTimeout(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        idleMs: IDLE_MS,
      });
      expect(res.timedOut).toBeNull();
      expect(res.signal).toBeNull();
      // One mark per case while it runs: the idle window needs output to watch.
      expect(res.stdout).toMatch(/^\.{20,}/);
      expect(res.stderr).not.toMatch(/FAIL/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/janitor self-test: \d+ passed, 0 failed/);
    },
    IDLE_RUN_MAX_MS + 30_000,
  );
});
