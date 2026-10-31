import path from "node:path";
import { IDLE_RUN_MAX_MS, runWithIdleTimeout } from "./testing/run-with-idle-timeout";

// scripts/prisma-fresh.self-test.mjs is a plain node script (the verify preflight that refuses a
// stale generated Prisma client before the heavy slot is taken); root package.json is not touched
// by this change, so this thin wrapper drives it as a child process and asserts its contract, the
// same way heavy-slot-self-test-script.spec.ts does. Fixtures are throwaway temp dirs.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/prisma-fresh.self-test.mjs");

// Ended only after this long WITHOUT output (it prints a line per check), never for total time under load.
const IDLE_MS = 300_000;

describe("prisma-fresh self-test contract", () => {
  it(
    "exits 0 with no failures",
    async () => {
      const res = await runWithIdleTimeout(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        idleMs: IDLE_MS,
        env: process.env,
      });
      expect(res.timedOut).toBeNull();
      expect(res.signal).toBeNull();
      expect(res.stdout).not.toMatch(/\bFAIL\b/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/prisma-fresh self-test: \d+ passed, 0 failed/);
    },
    IDLE_RUN_MAX_MS + 30_000,
  );
});
