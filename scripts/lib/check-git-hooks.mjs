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
import * as nodeFs from "node:fs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const cjsScrubbedGitEnv = createRequire(import.meta.url)("./scrubbed-git-env.cjs");

const FIX =
  "run `node scripts/ensure-git-hooks.mjs` at the worktree root (it copies the main checkout's hooks; husky must not be run in a linked worktree: it rewrites the shared core.hooksPath)";

/**
 * `.husky/_` is TRACKED on master. A tree on a branch that predates that, or that moved back to one, has git delete the
 * files at checkout: it loses its hooks the moment it switches, and nothing else says so. Name that cause loudly when
 * the missing directory is the repo's own `.husky/_`.
 */
export function olderBranchNote(dir) {
  return path.basename(dir) === "_" && path.basename(path.dirname(dir)) === ".husky"
    ? " If this tree was working before, it moved to a branch that predates the tracked .husky/_ (git deleted the files " +
        "on checkout): merge master into the branch to keep hooks on every switch."
    : "";
}

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

/**
 * Where git will look for hooks from `cwd`: { top, dir, where }, or { fail: <checkGitHooks result> } when
 * the state is unreadable (status 2, fail closed). Callers have already established `cwd` is in a work tree.
 */
function resolveHooks(cwd, git) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout) {
    return {
      fail: {
        status: 2,
        message: `check-git-hooks: cannot resolve the git work tree from ${cwd} — failing closed.`,
      },
    };
  }
  const cfg = git(cwd, ["config", "--get", "core.hooksPath"]);
  // `git config --get` exits 1 when the key is simply unset; anything else is an unreadable config.
  if (cfg.status !== 0 && cfg.status !== 1) {
    return {
      fail: {
        status: 2,
        message: `check-git-hooks: cannot read git config (exit ${cfg.status}) — failing closed.`,
      },
    };
  }
  const value = cfg.status === 0 ? cfg.stdout : undefined;
  let gitPathHooks = "";
  if (value === undefined) {
    const gp = git(cwd, ["rev-parse", "--git-path", "hooks"]);
    if (gp.status !== 0 || !gp.stdout) {
      return {
        fail: {
          status: 2,
          message: "check-git-hooks: cannot resolve the default hooks path — failing closed.",
        },
      };
    }
    gitPathHooks = gp.stdout;
  }
  return {
    top: top.stdout,
    dir: hooksDirFor(value, top.stdout, gitPathHooks),
    where: value === undefined ? "the default hooks directory" : `core.hooksPath = ${value}`,
  };
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
  const hooks = resolveHooks(cwd, git);
  if (hooks.fail) return hooks.fail;
  const { dir, where } = hooks;
  if (!isDir(dir)) {
    return {
      status: 1,
      message:
        `check-git-hooks: GIT HOOKS ARE NOT INSTALLED — ${where} resolves to ${dir}, which does not exist. ` +
        `Git treats that as "no hooks" and exits 0, so pushes from this tree skip the pre-push verify silently. Fix: ${FIX}.${olderBranchNote(dir)}`,
    };
  }
  if (!isFile(path.join(dir, "pre-push"))) {
    return {
      status: 1,
      message: `check-git-hooks: GIT HOOKS ARE NOT INSTALLED — ${dir} has no pre-push hook. Fix: ${FIX}.${olderBranchNote(dir)}`,
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

/** The main checkout of `cwd`'s repo: { top, hooks } or { fail: <message> } (bare or unreadable). */
function locateMain(cwd, git) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status !== 0 || path.basename(common.stdout) !== ".git") {
    return { fail: "ensure-git-hooks: cannot locate the main checkout (no .git common dir)." };
  }
  const top = path.dirname(common.stdout);
  const hooks = resolveHooks(top, git);
  if (hooks.fail)
    return { fail: hooks.fail.message.replace("check-git-hooks", "ensure-git-hooks") };
  return { top, hooks };
}

/** Real path of `p`, or of its deepest existing ancestor plus the missing tail; null when unresolvable. */
function realPathOf(fs, p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch (e) {
      const up = path.dirname(cur);
      if (e?.code !== "ENOENT" || up === cur) return null;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

/** True when `p` is itself a symlink/junction and what it points at does not exist. */
function isDanglingLink(fs, p) {
  try {
    return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * The ONE ownership rule for writes into a hooks dir: it is this tree's own when this tree IS the main
 * checkout, or when its REAL path sits inside this tree's REAL top (a junction/symlink into main, or a
 * per-worktree core.hooksPath at a shared dir, resolves outside and is refused). Any realpath error
 * fails closed.
 */
function ownsHooksDir(fs, mine, mainTop) {
  const top = realPathOf(fs, mine.top);
  const dir = realPathOf(fs, mine.dir);
  const main = realPathOf(fs, mainTop);
  if (!top || !dir || !main) return false;
  if (top === main) return true;
  const rel = path.relative(top, dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Overwrite the husky helpers (not hooks): a stale one beside a fresh pre-push breaks it. */
function refreshHelpers(fs, fromDir, toDir) {
  for (const f of ["h", "husky.sh"].filter((n) => isFile(path.join(fromDir, n)))) {
    fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
  }
}

const ok = (copied, message) => ({ ok: true, copied, message });
const no = (message) => ({ ok: false, copied: false, message });

/**
 * Make a tree that inherited husky's relative core.hooksPath actually HAVE the hooks, without husky:
 * copy the MAIN checkout's hooks directory into this tree's. Never runs husky/npm and never writes git
 * config (`npx husky` rewrites the shared core.hooksPath for every worktree: W-679). Same CI/non-checkout
 * contract as checkGitHooks. Returns { ok, copied, message }.
 */
export function ensureGitHooks({
  cwd = process.cwd(),
  env = process.env,
  git = runGit,
  fs = nodeFs,
  platform = process.platform,
} = {}) {
  if (isCi(env)) return ok(false, "ensure-git-hooks: CI is the authority for this run — skipped.");
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout !== "true") {
    return ok(false, `ensure-git-hooks: skipped — ${cwd} is not inside a git work tree.`);
  }
  const mine = resolveHooks(cwd, git);
  if (mine.fail) return no(mine.fail.message.replace("check-git-hooks", "ensure-git-hooks"));
  const mine_pp = path.join(mine.dir, "pre-push");
  if (isFile(mine_pp)) {
    // Present is not enough off Windows: git ignores a non-executable hook, so fix the mode (what the check wants).
    const owner = locateMain(cwd, git);
    const owns = !owner.fail && ownsHooksDir(fs, mine, owner.top);
    // Refresh stale helpers whenever the dir is this tree's own (never main's, never a shared dir).
    if (owns && realPathOf(fs, owner.hooks.dir) !== realPathOf(fs, mine.dir)) {
      refreshHelpers(fs, owner.hooks.dir, mine.dir);
    }
    if (platform === "win32" || (fs.statSync(mine_pp).mode & 0o111) !== 0) {
      return ok(false, `ensure-git-hooks: ok — pre-push already present in ${mine.dir}`);
    }
    // Only this tree's own hooks: chmod on a shared dir would undo a deliberate chmod -x.
    if (owner.fail) return no(owner.fail);
    if (!owns) {
      return no(
        `ensure-git-hooks: ${mine.dir} is the main checkout's own hooks directory; not changing its modes from another tree.`,
      );
    }
    fs.chmodSync(mine_pp, 0o755);
    if ((fs.statSync(mine_pp).mode & 0o111) === 0) {
      return no(`ensure-git-hooks: ${mine_pp} is not executable and chmod did not change that.`);
    }
    return ok(false, `ensure-git-hooks: made ${mine_pp} executable`);
  }
  // A link whose target is gone: realPathOf would walk past ENOENT and call it ours, then cpSync dies
  // (exit 127, no message). Refuse it by name instead.
  if (isDanglingLink(fs, mine.dir)) {
    return no(
      `ensure-git-hooks: ${mine.dir} is a dangling link (its target does not exist); remove it, then re-run.`,
    );
  }
  const owner = locateMain(cwd, git);
  if (owner.fail) return no(owner.fail);
  const main = owner.hooks;
  if (realPathOf(fs, main.dir) === realPathOf(fs, mine.dir) || !ownsHooksDir(fs, mine, owner.top)) {
    return no(
      `ensure-git-hooks: ${mine.dir} is the main checkout's own hooks directory and has no pre-push.`,
    );
  }
  if (!isFile(path.join(main.dir, "pre-push"))) {
    return no(
      `ensure-git-hooks: the main checkout's hooks (${main.dir}) have no pre-push to copy.`,
    );
  }
  // A custom hooks dir keeps what it has: only the missing files are copied.
  fs.cpSync(main.dir, mine.dir, { recursive: true, force: false, errorOnExist: false });
  refreshHelpers(fs, main.dir, mine.dir);
  const copied = path.join(mine.dir, "pre-push");
  if (platform !== "win32" && (fs.statSync(copied).mode & 0o111) === 0) {
    return no(`ensure-git-hooks: copied, but ${copied} is not executable; git would ignore it.`);
  }
  return ok(true, `ensure-git-hooks: copied hooks ${main.dir} -> ${mine.dir}`);
}
