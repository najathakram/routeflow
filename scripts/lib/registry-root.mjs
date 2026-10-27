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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = JSON.parse(readFileSync(new URL("./registry-source.json", import.meta.url), "utf8"));

export const REGISTRY_MODE = "tracked";
export const REGISTRY_REPO = SOURCE.repo;
export const REGISTRY_BRANCH = SOURCE.branch;
export const REGISTRY_PREFIX = SOURCE.prefix;
export const REGISTRY_PUSH_RETRIES = 5;
export const REGISTRY_GIT_TIMEOUT_MS = 20000;
// At least the worst-case write transaction: 5 x (20 s fetch + 20 s push) = 200 s, plus the write.
export const REGISTRY_LOCK_WAIT_MS = 240000;
export const REGISTRY_FIX_COMMAND = "npm run registry:clone";

// Where the register sits inside the repo while the mode is "tracked".
const TRACKED_PREFIX = ".claude/campaign";

export function registryMissingMessage(dir) {
  return `bug register not found at ${dir} — run \`${REGISTRY_FIX_COMMAND}\``;
}

// BUGS_ROOT points the real commands at a throwaway directory (fixtures); it wins over the mode.
// `allowMissing` is for the writers that create the register (import, file) on an empty fixture.
export function registryRoot({ allowMissing = false } = {}) {
  const dir = process.env.BUGS_ROOT
    ? resolve(process.env.BUGS_ROOT)
    : resolve(REPO_ROOT, TRACKED_PREFIX);
  // An existing but empty directory is not a register: bugs.jsonl must be there too.
  if (!allowMissing && !existsSync(join(dir, "bugs.jsonl")))
    throw new Error(registryMissingMessage(dir));
  return dir;
}

export function registrySource() {
  return { repoDir: REPO_ROOT, ref: "HEAD", prefix: TRACKED_PREFIX };
}
