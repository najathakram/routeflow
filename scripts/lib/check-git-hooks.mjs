// B642 guard — the repo's git hooks must actually be INSTALLED, or a "green" push/verify means nothing.
//
// The incident: husky sets `core.hooksPath = .husky/_` (a RELATIVE path, in the shared repo config)
// and its `prepare` script generates that directory. A worktree created with `npm ci --ignore-scripts`
// (or any setup that skips `prepare`) inherits the setting but has no `.husky/_`. Git treats a
// hooksPath that points at a missing directory as "no hooks" — silently, exit 0 — so every push from
// that tree skipped the pre-push verify while looking exactly like a push that passed it.
//
// A control must assert its own presence, or its absence looks like success. This resolves the
// hooks directory git will really use and FAILS unless it exists and holds a `pre-push` hook.
//
// Scope: `pre-push` is deliberately the single gate this checks: it is the verify that mirrors CI.
// `commit-msg` (commitlint) and `pre-commit` (lint-staged) live in the same directory and could go
// missing the same way, but they shape commits; they do not stand between a change and origin.
//
// Exit contract: 0 hooks present, or nothing to check (CI is its own authority; a non-checkout such as a
// Docker build context is skipped with a note) · 1 hooks missing · 2 INSIDE a work tree but the state
// could not be read (toplevel/config unreadable) — fail CLOSED, never pass.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const cjsScrubbedGitEnv = createRequire(import.meta.url)("./scrubbed-git-env.cjs");

const FIX =
  "run `npx husky` at the worktree root (and do not create worktrees with `npm ci --ignore-scripts`)";

/**
 * The process environment WITHOUT git's own variables (GIT_DIR, GIT_WORK_TREE ... — a git hook exports
 * them into every child, and they override the repository git would discover from a cwd: the B420
 * shape). The single definition lives in ./scrubbed-git-env.cjs so ts-jest CJS specs share it.
 */
export const { scrubbedGitEnv } = cjsScrubbedGitEnv;

/** Default git runner: `git <args>` in `cwd`, returning { status, stdout }. */
export function runGit(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedGitEnv() });
  return { status: r.error ? -1 : r.status, stdout: (r.stdout ?? "").trim() };
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Where git will look for hooks. A relative core.hooksPath is relative to the top of the work tree
 * (git's own rule), an absolute one — POSIX or Windows drive/UNC — is used as written, `~/` expands
 * to the home directory, and an unset one falls back to `git rev-parse --git-path hooks`.
 */
export function hooksDirFor(value, toplevel, gitPathHooks, home = homedir()) {
  if (value === undefined) return path.resolve(toplevel, gitPathHooks);
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return value;
  return path.resolve(toplevel, value);
}

/**
 * CI is on only when CI is set to something that MEANS true. `CI=false` / `CI=0` / `CI=` are exported
 * by plenty of shells and tools on a developer machine and must NOT switch the guard off (a bare
 * truthiness test treated the string "false" as CI: the guard silently skipping itself).
 */
export function isCi(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.CI ?? "").trim());
}

export function checkGitHooks({
  cwd = process.cwd(),
  env = process.env,
  git = runGit,
  platform = process.platform,
} = {}) {
  if (isCi(env))
    return {
      status: 0,
      message: "check-git-hooks: CI is the authority for this run — hooks are not required here.",
    };
  // Not a checkout at all (a tarball, a Docker build context with no .git, git not installed): there
  // are no hooks to require, so SKIP with a printed note. This must stay a no-op there — a production
  // image build must never be able to reach a failure from this guard.
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout !== "true") {
    return {
      status: 0,
      skipped: true,
      message: `check-git-hooks: skipped — ${cwd} is not inside a git work tree (or git is unavailable).`,
    };
  }
  // Inside a work tree from here on: anything unreadable is a failure, never a pass.
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout) {
    return {
      status: 2,
      message: `check-git-hooks: cannot resolve the git work tree from ${cwd} — failing closed.`,
    };
  }
  const cfg = git(cwd, ["config", "--get", "core.hooksPath"]);
  // `git config --get` exits 1 when the key is simply unset; anything else is an unreadable config.
  if (cfg.status !== 0 && cfg.status !== 1) {
    return {
      status: 2,
      message: `check-git-hooks: cannot read git config (exit ${cfg.status}) — failing closed.`,
    };
  }
  const value = cfg.status === 0 ? cfg.stdout : undefined;
  let gitPathHooks = "";
  if (value === undefined) {
    const gp = git(cwd, ["rev-parse", "--git-path", "hooks"]);
    if (gp.status !== 0 || !gp.stdout) {
      return {
        status: 2,
        message: "check-git-hooks: cannot resolve the default hooks path — failing closed.",
      };
    }
    gitPathHooks = gp.stdout;
  }
  const dir = hooksDirFor(value, top.stdout, gitPathHooks);
  const where = value === undefined ? "the default hooks directory" : `core.hooksPath = ${value}`;
  if (!isDir(dir)) {
    return {
      status: 1,
      message:
        `check-git-hooks: GIT HOOKS ARE NOT INSTALLED — ${where} resolves to ${dir}, which does not exist. ` +
        `Git treats that as "no hooks" and exits 0, so pushes from this tree skip the pre-push verify silently. Fix: ${FIX}.`,
    };
  }
  if (!isFile(path.join(dir, "pre-push"))) {
    return {
      status: 1,
      message: `check-git-hooks: GIT HOOKS ARE NOT INSTALLED — ${dir} has no pre-push hook. Fix: ${FIX}.`,
    };
  }
  // Git IGNORES a hook that is not executable (only a hint), so a complete .husky/_ whose files lost
  // their exec bit (cp -R, an archive extraction, a permissions-stripping filesystem) would pass an
  // existence check while running no hooks: the incident, reproduced through the guard. On POSIX the
  // mode bit is authoritative. On Windows there is no exec bit to check (Git for Windows runs a hook
  // by shebang through its bundled sh), so that half is skipped there rather than failing forever.
  if (platform !== "win32" && (statSync(path.join(dir, "pre-push")).mode & 0o111) === 0) {
    return {
      status: 1,
      message:
        `check-git-hooks: GIT HOOKS ARE NOT RUNNABLE — ${path.join(dir, "pre-push")} is present but not executable, ` +
        `and git silently ignores a non-executable hook. Fix: chmod +x it, or ${FIX}.`,
    };
  }
  return { status: 0, message: `check-git-hooks: ok — pre-push present in ${dir}` };
}
