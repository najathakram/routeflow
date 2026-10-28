// registry-clone.mjs — the register clone and the git plumbing under every write (B1-b1, SPEC v3.2 "Ruling v3").
//
//   cloneRegistry(opts)   clone or refresh the register clone (idempotent; a dirty clone is refused)
//   registryGit / dirtyPaths / guardClean / checkOrigin / locked / toOrigin / reset
//                         the pieces the write transaction in registry-write.mjs is built from: every git
//                         call is capped and never prompts; a reset never runs over a hand edit; a clone
//                         whose origin is not the register remote is refused before anything is reset
//
// Errors are RegistryError with an exitCode: 2 = fix it yourself (dirty clone, missing clone, foreign
// origin), 1 = not recorded. Inert while REGISTRY_MODE is "tracked": nothing calls this. The lock is
// scripts/lib/mkdir-lock.mjs (owner-death breaks, token-checked release).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { scrubbedGitEnv } from "./check-git-hooks.mjs";
import { withLock } from "./mkdir-lock.mjs";
import {
  REGISTRY_BRANCH,
  REGISTRY_GIT_TIMEOUT_MS,
  REGISTRY_LOCK_WAIT_MS,
  REGISTRY_PREFIX,
  REGISTRY_PUSH_RETRIES,
  REGISTRY_REPO,
  registryCloneDir,
} from "./registry-root.mjs";

export class RegistryError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
// A refusal that leaves the clone exactly as found (no reset, no clean): hand edits are never touched.
export const refusal = (message) =>
  Object.assign(new RegistryError(message, 2), { keepClone: true });
export const DIRTY_MESSAGE =
  "uncommitted edits in the register: run `bugs.mjs commit-record B###` to keep a hand edit, " +
  "or `bugs.mjs registry-discard` to save and clear leftovers";

export const CLONE_DEFAULTS = {
  branch: REGISTRY_BRANCH,
  prefix: REGISTRY_PREFIX,
  retries: REGISTRY_PUSH_RETRIES,
  lockWaitMs: REGISTRY_LOCK_WAIT_MS,
  timeoutMs: REGISTRY_GIT_TIMEOUT_MS,
};
export const settings = (o) => ({
  cloneDir: registryCloneDir(),
  ...CLONE_DEFAULTS,
  label: "write",
  ...o,
});
export const remoteUrl = () =>
  process.env.RF_REGISTRY_REMOTE || `https://github.com/${REGISTRY_REPO}.git`;
export const firstLine = (s) => s.trim().split("\n")[0];

// Every git call has a timeout, never prompts, and runs with autocrlf off: the register is
// compared and merged byte-for-byte. stdout is trimmed unless `raw` (file content).
export function registryGit(c, args, { timeoutMs = c.timeoutMs, ok = false, raw = false } = {}) {
  c.hooks?.onGit?.(args); // test seam: counts the capped calls the lock-wait budget has to cover
  const r = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "core.autocrlf=false", ...args],
    {
      cwd: c.cloneDir,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...scrubbedGitEnv(), GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const stdout = r.stdout ?? "";
  const out = {
    status: r.error ? -1 : r.status,
    stdout: raw ? stdout : stdout.trim(),
    stderr: (r.stderr ?? "") + (r.error ? String(r.error.message) : ""),
  };
  if (out.status !== 0 && !ok)
    throw new RegistryError(`git ${args[0]} failed: ${firstLine(out.stderr)}`);
  return out;
}

// The clone-level lock is the shared mkdir lock, waited on for lockWaitMs. A timeout throws (exit 1)
// instead of exiting the process; the helper's message names the lock directory to remove.
const REGISTRY_LABEL = { prefix: "registry", holder: "another registry writer" };
const lockDie = (message) => {
  throw new RegistryError(message, 1);
};
export const locked = (c, body) =>
  withLock(
    join(c.cloneDir, ".registry-write.lock"),
    "the register clone",
    c.cloneDir,
    body,
    lockDie,
    c.lockWaitMs,
    REGISTRY_LABEL,
  );

export const dirtyPaths = (c) =>
  registryGit(c, ["status", "--porcelain", "--untracked-files=all", "--", c.prefix], { raw: true })
    .stdout.split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));

// A reset never runs over a hand edit. `why` is set once a write was under way: it says that write
// was not recorded and why. `c.allowDirty` names the paths a hand-edit commit is about to capture.
export function guardClean(c, why = "") {
  const dirty = dirtyPaths(c).filter((p) => !c.allowDirty?.includes(p));
  if (dirty.length)
    throw refusal(
      `${DIRTY_MESSAGE}\n  dirty: ${dirty.join(", ")}` +
        (why ? `\n  this write was not recorded (${why})` : ""),
    );
}

// The clone's origin must be the register remote before anything is reset: a clone pointed at some
// other repo would be hard-reset to that repo's branch.
const norm = (u) =>
  u
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
export function checkOrigin(c) {
  const got = norm(registryGit(c, ["remote", "get-url", "origin"], { ok: true }).stdout);
  const want = norm(remoteUrl());
  const repo = REGISTRY_REPO.toLowerCase();
  const same =
    got === want ||
    (!process.env.RF_REGISTRY_REMOTE && (got.endsWith(`/${repo}`) || got.endsWith(`:${repo}`)));
  if (!same)
    throw refusal(
      `the register clone's origin is "${got}", not the register remote (${want}) — nothing was ` +
        `reset; point it back with \`git -C ${c.cloneDir} remote set-url origin <url>\` or use a fresh clone`,
    );
}

export const toOrigin = (c) => {
  registryGit(c, ["fetch", "origin", c.branch]);
  registryGit(c, ["reset", "--hard", `origin/${c.branch}`]);
};
// After a failed transaction: back to origin, no leftovers for the next writer's dirty guard.
export const reset = (c) => {
  registryGit(c, ["fetch", "origin", c.branch], { ok: true });
  registryGit(c, ["reset", "--hard", `origin/${c.branch}`], { ok: true });
  registryGit(c, ["clean", "-fd", "--", c.prefix], { ok: true });
};

export function cloneRegistry(opts = {}) {
  const c = settings(opts);
  if (!existsSync(join(c.cloneDir, ".git"))) {
    mkdirSync(dirname(c.cloneDir), { recursive: true });
    const args = ["clone", "--branch", c.branch, "--", remoteUrl(), c.cloneDir];
    const r = registryGit({ ...c, cloneDir: dirname(c.cloneDir) }, args, {
      timeoutMs: c.timeoutMs * 6,
      ok: true,
    });
    if (r.status !== 0) throw new RegistryError(`clone failed: ${firstLine(r.stderr)}`);
    registryGit(c, ["config", "core.autocrlf", "false"]); // keep later plain-git use byte-exact
    return "cloned";
  }
  return locked(c, () => {
    checkOrigin(c);
    guardClean(c);
    toOrigin(c);
    return "refreshed";
  });
}
