// registry-root.mjs — the ONE place that knows where the bug register lives (B1-a, SPEC v3.2).
//
// Every reader asks this module instead of naming a path:
//   registryRoot()    the directory holding bugs.jsonl, bugs/ and status/ (filesystem readers)
//   registrySource()  { repoDir, ref, prefix } for readers that go through git history or a ref
//
// Both are anchored on this file's own location, never on process.cwd(): a command run from
// apps/api used to resolve ".claude/campaign" against apps/api and read zero rows (B278).
//
// A missing register THROWS and names the fix. There is no fallback and no empty result: a reader
// that cannot find the register must stop, because "0 rows" looks exactly like a clean register.
//
// REGISTRY_MODE is "tracked" in B1-a and B1-b (the register still lives in this repo) and flips to
// "clone" in B1-c. The repo, branch and prefix of the clone live in registry-source.json, which is
// vendored byte-for-byte into the ops-monitor image (a parity test pins the two copies).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = JSON.parse(readFileSync(new URL("./registry-source.json", import.meta.url), "utf8"));

export const REGISTRY_MODE = "tracked";
export const REGISTRY_REPO = SOURCE.repo;
export const REGISTRY_BRANCH = SOURCE.branch;
export const REGISTRY_PREFIX = SOURCE.prefix;
export const REGISTRY_PUSH_RETRIES = 5;
export const REGISTRY_GIT_TIMEOUT_MS = 20000;
// At least the worst-case write transaction: every capped git call of every attempt (dirty check,
// fetch, reset, add, diff, config, commit, push = 8), plus the fixed calls (the origin check and the
// give-up's dirty check, fetch, reset, clean = 5), plus slack for the write itself. Derived, never a
// literal: the self-test pins the inequality and counts the real calls against these two numbers.
export const REGISTRY_GIT_CALLS_PER_ATTEMPT = 8;
export const REGISTRY_GIT_CALLS_FIXED = 5;
export const REGISTRY_LOCK_SLACK_MS = 60000;
export const REGISTRY_LOCK_WAIT_MS =
  ((REGISTRY_PUSH_RETRIES + 1) * REGISTRY_GIT_CALLS_PER_ATTEMPT + REGISTRY_GIT_CALLS_FIXED) *
    REGISTRY_GIT_TIMEOUT_MS +
  REGISTRY_LOCK_SLACK_MS;
// The sync scan: the bounded window of a --rescan, the machine-local anchor, and the repo it reads.
// BUGS_SYNC_REPO points a fixture at a throwaway repo and is honoured only under BUGS_SELF_TEST=1.
export const FIRST_RUN_WINDOW = 400;
export const syncStatePath = () =>
  process.env.BUGS_SYNC_STATE || join(REPO_ROOT, ".campaign", "bugs-sync-state.json");
export const syncRepoOverride = () =>
  (process.env.BUGS_SELF_TEST === "1" && process.env.BUGS_SYNC_REPO) || null;
export const REGISTRY_FIX_COMMAND = "npm run registry:clone";

// Where the register sits inside the repo while the mode is "tracked".
const TRACKED_PREFIX = ".claude/campaign";

export function registryMissingMessage(dir) {
  return `bug register not found at ${dir} — run \`${REGISTRY_FIX_COMMAND}\``;
}

// The register clone (clone mode). RF_REGISTRY_DIR overrides the default, for fixtures and CI.
export const registryCloneDir = () =>
  resolve(
    process.env.RF_REGISTRY_DIR || join(homedir(), ".routeflow", "registry", "routeflow-specs"),
  );

// RF_REGISTRY_MODE_TEST=clone is a TEST hook (honoured only together with RF_REGISTRY_DIR and
// BUGS_SELF_TEST=1, which a fixture always sets): it lets the self-test drive the real commands in
// clone mode while REGISTRY_MODE stays a code constant. A stray export must never silently move a
// real command onto another register, so setting it always warns, once per process, honoured or not.
// Removed with REGISTRY_MODE in B1-c.
let modeTestWarned = false;
export const registryMode = () => {
  if (process.env.RF_REGISTRY_MODE_TEST !== "clone") return REGISTRY_MODE;
  const honoured = process.env.BUGS_SELF_TEST === "1" && Boolean(process.env.RF_REGISTRY_DIR);
  if (!modeTestWarned) {
    modeTestWarned = true;
    console.error(
      `WARNING: RF_REGISTRY_MODE_TEST=clone is set — a test-only hook, ${
        honoured
          ? "honoured (clone mode)"
          : "IGNORED (it needs BUGS_SELF_TEST=1 and RF_REGISTRY_DIR); using tracked mode"
      }. Unset it for real use.`,
    );
  }
  return honoured ? "clone" : REGISTRY_MODE;
};

// BUGS_ROOT points the real commands at a throwaway directory (fixtures); it wins over the mode.
// `allowMissing` is for the writers that create the register (import, file) on an empty fixture.
export function registryRoot({ allowMissing = false } = {}) {
  const dir = process.env.BUGS_ROOT
    ? resolve(process.env.BUGS_ROOT)
    : registryMode() === "clone"
      ? join(registryCloneDir(), REGISTRY_PREFIX)
      : resolve(REPO_ROOT, TRACKED_PREFIX);
  // An existing but empty directory is not a register: bugs.jsonl must be there too.
  if (!allowMissing && !existsSync(join(dir, "bugs.jsonl")))
    throw new Error(registryMissingMessage(dir));
  return dir;
}

export function registrySource() {
  if (registryMode() === "clone")
    return {
      repoDir: registryCloneDir(),
      ref: `refs/remotes/origin/${REGISTRY_BRANCH}`,
      prefix: REGISTRY_PREFIX,
    };
  return { repoDir: REPO_ROOT, ref: "HEAD", prefix: TRACKED_PREFIX };
}
