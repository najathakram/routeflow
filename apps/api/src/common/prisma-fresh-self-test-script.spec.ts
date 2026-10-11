import { spawnSync } from "node:child_process";
import path from "node:path";

// scripts/prisma-fresh.self-test.mjs is a plain node script (the verify preflight that refuses a
// stale generated Prisma client before the heavy slot is taken); root package.json is not touched
// by this change, so this thin wrapper drives it as a child process and asserts its contract, the
// same way heavy-slot-self-test-script.spec.ts does. Fixtures are throwaway temp dirs.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/prisma-fresh.self-test.mjs");

const CHILD_TIMEOUT_MS = 120_000;

describe("prisma-fresh self-test contract", () => {
  it(
    "exits 0 with no failures",
    () => {
      const res = spawnSync(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: process.env,
      });
      expect(res.signal).toBeNull();
      expect(res.stdout).not.toMatch(/\bFAIL\b/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/prisma-fresh self-test: \d+ passed, 0 failed/);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );
});
