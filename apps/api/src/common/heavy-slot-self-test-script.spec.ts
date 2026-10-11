import { spawnSync } from "node:child_process";
import path from "node:path";

// scripts/heavy-slot.self-test.mjs is a plain node script (the machine-wide heavy-job slot), and
// nothing in `npm run verify` runs it directly because root package.json is not touched by this
// change. This thin wrapper drives the real self-test as a child process (throwaway temp slot dirs,
// no verify/turbo/docker) and asserts its process contract, the same way the janitor's is run.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/heavy-slot.self-test.mjs");

// The child is ~1 s of tiny `node` spawns; the generous default is for a heavily loaded host.
const CHILD_TIMEOUT_MS = 120_000;

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
    () => {
      const res = spawnSync(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: scrubbedEnv(),
      });
      expect(res.signal).toBeNull();
      expect(res.stdout).not.toMatch(/\bFAIL\b/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/heavy-slot self-test: \d+ passed, 0 failed/);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );
});
