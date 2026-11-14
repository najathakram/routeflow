import path from "node:path";
import { IDLE_RUN_MAX_MS, runWithIdleTimeout } from "./testing/run-with-idle-timeout";

// scripts/leak-check.self-test.mjs is a plain node script (the pre-push leak guard) that nothing in
// `npm run verify` runs directly. This thin wrapper drives the real self-test as a child process (throwaway
// temp repos and bare remotes, no verify/turbo/docker) and asserts its process contract, the same way the
// heavy-slot self-test is run. It is ended only when it goes 5 min WITHOUT output, never for total time.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/leak-check.self-test.mjs");
const IDLE_MS = 300_000;

// The self-test builds its own explicit envs; this only keeps CI / push settings of the host
// running jest (or a pre-push hook's GIT_* variables) from leaking into its process.
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "CI" || k === "GITHUB_ACTIONS" || k === "RF_REBRAND_PUSH" || k.startsWith("GIT_")) {
      delete env[k];
    }
  }
  return env;
}

describe("leak-check self-test contract", () => {
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
      expect(res.stdout).toMatch(/leak-check self-test: \d+ passed, 0 failed/);
    },
    IDLE_RUN_MAX_MS + 30_000,
  );
});
