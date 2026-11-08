// Is this tree's tracked register at least as new as origin/master? `bugs.mjs file` mints max+1 over
// THIS tree's catalogue, so a checkout that is behind master can mint an id master already used
// (B1291, B1292). Fail closed: a fetch or git error is "not fresh", never "assume fine".
//
// `git(args)` returns { status, stdout, stderr }; the default runs real git in `repoDir` with the
// same timeout cap as every other register git call. Clone mode never needs this (withRegistryWrite
// fetches and resets the clone).
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { REGISTRY_GIT_TIMEOUT_MS } from "./registry-root.mjs";
import { scrubbedGitEnv } from "./check-git-hooks.mjs";

const MASTER = "refs/remotes/origin/master";

// Which repo to check, or null to skip. BUGS_ROOT is a fixture hook, so a BUGS_ROOT elsewhere skips
// the check; but a BUGS_ROOT that IS this repo's tracked register (plane-intake --apply always sets it
// so) is the real register and is checked. BUGS_FRESHNESS_REPO is a test-only seam (BUGS_SELF_TEST=1),
// like BUGS_SYNC_REPO.
export function freshnessRepoFor(env, repoRoot, prefix) {
  const seam = env.BUGS_SELF_TEST === "1" && env.BUGS_FRESHNESS_REPO;
  if (seam) return seam;
  if (!env.BUGS_ROOT) return repoRoot;
  // relative() is case-insensitive on win32, so a drive-letter case difference still matches.
  return relative(resolve(env.BUGS_ROOT), resolve(repoRoot, prefix)) === "" ? repoRoot : null;
}

const defaultGit = (repoDir) => (args) => {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: REGISTRY_GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    // Never wait on a credential prompt: a stalled helper fails the check (closed), not a hang.
    env: { ...scrubbedGitEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: r.status ?? (r.error ? 128 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr || (r.error ? String(r.error.message) : ""),
  };
};

const firstLine = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .find(Boolean) || "no output";

// `stale: true`: origin/master is known to be ahead of this tree. `stale: false` with `ok: false`:
// freshness could not be checked (a git error), which refuses too.
export function checkRegisterFresh({ repoDir, prefix, localIds, git = defaultGit(repoDir) }) {
  // --no-tags and --no-auto-gc: only origin/master moves; no tag writes, no gc in a shared repo.
  const fetch = git([
    "fetch",
    "-q",
    "--no-write-fetch-head",
    "--no-tags",
    "--no-auto-gc",
    "origin",
    `+refs/heads/master:${MASTER}`,
  ]);
  if (fetch.status !== 0)
    return {
      ok: false,
      stale: false,
      reason: `git fetch origin master failed: ${firstLine(fetch.stderr)}`,
    };

  const anc = git(["merge-base", "--is-ancestor", MASTER, "HEAD"]);
  if (anc.status === 1)
    return { ok: false, stale: true, reason: "HEAD does not contain origin/master" };
  if (anc.status !== 0)
    return { ok: false, stale: false, reason: `git merge-base failed: ${firstLine(anc.stderr)}` };

  const show = git(["show", `${MASTER}:${prefix}/bugs.jsonl`]);
  if (show.status !== 0)
    return {
      ok: false,
      stale: false,
      reason: `could not read ${prefix}/bugs.jsonl on origin/master: ${firstLine(show.stderr)}`,
    };
  const have = new Set(localIds);
  const missing = [];
  for (const line of show.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let id;
    try {
      id = JSON.parse(line).id;
    } catch {
      return {
        ok: false,
        stale: false,
        reason: `origin/master ${prefix}/bugs.jsonl has an unreadable line`,
      };
    }
    if (id && !have.has(id)) missing.push(id);
  }
  if (missing.length)
    return {
      ok: false,
      stale: true,
      reason: `origin/master has ${missing.length} id(s) this tree lacks: ${missing.slice(0, 5).join(", ")}`,
    };
  return { ok: true };
}
