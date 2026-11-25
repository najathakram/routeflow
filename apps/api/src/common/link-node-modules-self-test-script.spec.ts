import path from "node:path";
import { IDLE_RUN_MAX_MS, runWithIdleTimeout } from "./testing/run-with-idle-timeout";

// scripts/link-node-modules.self-test.mjs is a plain node script (temp dirs / fake gh only, no network, no docker). This thin
// wrapper drives it as a child process and asserts its process contract, like heavy-slot-self-test-script.spec.ts.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/link-node-modules.self-test.mjs");

describe("link-node-modules self-test contract", () => {
  it(
    "exits 0 with no failures",
    async () => {
      const res = await runWithIdleTimeout(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        idleMs: 120_000,
        env: { ...process.env },
      });
      expect(res.timedOut).toBeNull();
      expect(res.signal).toBeNull();
      expect(res.stdout).not.toMatch(/\bFAIL\b/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/link-node-modules self-test: \d+ passed, 0 failed/);
    },
    IDLE_RUN_MAX_MS + 30_000,
  );
});
