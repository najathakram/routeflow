import { spawnSync } from "node:child_process";
import path from "node:path";

// B800: scripts/janitor.self-test.mjs is a plain node script, so nothing ran it — a regression in the
// janitor's "is this worktree merged / safe to touch" rules would ship silently, and those rules
// decide whether `janitor:apply` deletes a lane's worktree. This thin wrapper drives the real
// self-test as a child process (it builds its own throwaway git repos under the OS temp dir and
// scrubs GIT_* first) and asserts its process contract.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/janitor.self-test.mjs");

// #2146: the child's time is intrinsic real process spawns (PowerShell cold starts plus ~150 git
// spawns): ~56s standalone, ~129s when the machine is contended — a fixed 120s timeout had no
// margin inside the full `npm run test -w apps/api`. Load-tolerant default (5 min);
// JANITOR_SELF_TEST_TIMEOUT_MS overrides it for a slower box without touching this file (a
// non-numeric or non-positive value falls back to the default). The jest test timeout stays
// above the child's own, so a genuine hang still fails with the child's own signal/status
// assertions instead of a less specific jest-level timeout.
const DEFAULT_CHILD_TIMEOUT_MS = 300_000;
const envTimeoutMs = Number(process.env.JANITOR_SELF_TEST_TIMEOUT_MS);
const CHILD_TIMEOUT_MS =
  Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : DEFAULT_CHILD_TIMEOUT_MS;

describe("janitor self-test contract (B800)", () => {
  it(
    "exits 0 with no failures, including the fresh zero-commit branch case",
    () => {
      const res = spawnSync(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      });
      expect(res.signal).toBeNull();
      expect(res.stderr).not.toMatch(/FAIL/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/janitor self-test: \d+ passed, 0 failed/);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );
});
