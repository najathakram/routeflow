import path from "node:path";
import { IDLE_RUN_MAX_MS, runWithIdleTimeout } from "./testing/run-with-idle-timeout";

// scripts/heavy-slot.self-test.mjs is a plain node script (the machine-wide heavy-job slot), and
// nothing in `npm run verify` runs it directly because root package.json is not touched by this
// change. This thin wrapper drives the real self-test as a child process (throwaway temp slot dirs,
// no verify/turbo/docker) and asserts its process contract, the same way the janitor's is run.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/heavy-slot.self-test.mjs");

// The child is ~1 s of tiny `node` spawns and prints a line per check. It is ended only when it goes this
// long WITHOUT output (stuck), never for total time: under a full verify it is merely slow, and a test of
// the slot must not fail because the slot is in use. It never touches the real slot dir (every case runs
// in a temp dir), so a holder elsewhere cannot make it wait; only CPU starvation slows it.
const IDLE_MS = 90_000;

// The self-test builds its own explicit envs; this only keeps a CI / slot setting of the host
// running jest (or a verify that holds a slot right now) from leaking into its process.
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "CI",
    "RF_HEAVY_SLOT",
    "RF_HEAVY_SLOTS",
    "RF_HEAVY_SLOT_TOKEN",
    "RF_HEAVY_SLOT_DIR",
  ]) {
    delete env[k];
  }
  return env;
}

describe("heavy-slot self-test contract", () => {
  it(
    "exits 0 with no failures",
    async () => {
      const res = await runWithIdleTimeout(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        idleMs: IDLE_MS,
        env: scrubbedEnv(),
      });
      expect(res.timedOut).toBeNull();
      expect(res.signal).toBeNull();
      expect(res.stdout).not.toMatch(/\bFAIL\b/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/heavy-slot self-test: \d+ passed, 0 failed/);
    },
    IDLE_RUN_MAX_MS + 30_000,
  );
});
