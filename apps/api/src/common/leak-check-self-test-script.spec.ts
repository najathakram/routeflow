import { spawnSync } from "node:child_process";
import path from "node:path";
import { IDLE_RUN_MAX_MS, runWithIdleTimeout } from "./testing/run-with-idle-timeout";

// scripts/leak-check.self-test.mjs is a plain node script (the pre-push leak guard) that nothing in
// `npm run verify` runs directly. This thin wrapper drives the real self-test as a child process (throwaway
// temp repos and bare remotes, no verify/turbo/docker) and asserts its process contract, the same way the
// heavy-slot self-test is run. It is ended only when it goes 5 min WITHOUT output, never for total time.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(REPO_ROOT, "scripts/leak-check.self-test.mjs");
// Timeout headroom: this spec lives in the repo-truth lane beside bugs-self-test-script.spec.ts, which saw a
// 121 s run fail under load. The idle bound (5 min without output) and the 30 min total cap here sit above that
// spec's 1_000_000 ms child bound and 1_050_000 ms jest timeout, so a loaded host cannot fake a failure.
const IDLE_MS = 300_000;

// Two modes (about 8 s fast, about 80 s full): the fast mode runs library and simulated-stdin cases only; the full
// mode adds real `git push` cases against a throwaway bare repo. Full runs when RF_LEAK_SELFTEST_FULL=1, or when
// the guard itself differs from origin/master (or that cannot be told: fail toward full).
const GUARD_FILES = [
  "scripts/leak-check.mjs",
  "scripts/leak-check.self-test.mjs",
  "scripts/lib/leak-patterns.mjs",
  ".husky/pre-push",
];
function wantsFull(): boolean {
  if (process.env.RF_LEAK_SELFTEST_FULL === "1") return true;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync("git", ["diff", "--quiet", "origin/master", "--", ...GUARD_FILES], {
    cwd: REPO_ROOT,
    env,
  });
  return r.status !== 0; // 1 = changed, anything else (no origin/master, git missing) = unknown
}

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
      const res = await runWithIdleTimeout(
        process.execPath,
        [SCRIPT, ...(wantsFull() ? [] : ["--fast"])],
        {
          cwd: REPO_ROOT,
          idleMs: IDLE_MS,
          env: scrubbedEnv(),
        },
      );
      expect(res.timedOut).toBeNull();
      expect(res.signal).toBeNull();
      expect(res.stdout).not.toMatch(/\bFAIL\b/);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/leak-check self-test: \d+ passed, 0 failed/);
    },
    IDLE_RUN_MAX_MS + 30_000,
  );
});
