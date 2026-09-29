#!/usr/bin/env node
// janitor.mjs — disk-space reclamation for the RouteFlow dev host.
//
// Report-only by default; nothing is ever deleted unless the caller passes
// --apply. Reclaims in a fixed order, re-checking free space after each step
// and stopping as soon as the target is met, so a light shortfall never
// triggers the more expensive/aggressive later steps.
//
// Order: (1) node_modules in worktrees whose branch is merged into
// origin/master, (2) whole merged+clean+pushed worktrees, (3) orphan dirs
// under .claude/worktrees/ that git no longer lists, (4) Docker BUILD CACHE
// only, (5) npm cache, (6) proof/audit folders older than 7 days, (7) Jest cache entries
// older than JEST_CACHE_AGE_DAYS (#2671: the legacy SHARED OS-temp cache `jest_*`, which grew to
// 8 GB, and each worktree's own per-workspace `.jest-cache`).
//
// NEVER touched, ever: Docker volumes / `docker system prune`, the main
// checkout, a worktree with uncommitted changes, a worktree whose HEAD moved
// in the last RECENT_ACTIVITY_HOURS, PROTECTED_WORKTREE_NAMES, or any branch
// this tool cannot prove is merged. A worktree with unpushed commits keeps its
// checkout (only node_modules may go). Those are reported, never acted on.
//
// "Merged" (B800) needs PROOF THE BRANCH HAD WORK OF ITS OWN: plain ancestry is
// not enough, because a branch just created from master (zero commits) points
// at a mainline master commit and is trivially an ancestor — it used to count
// as merged, so an active lane's fresh worktree could lose its node_modules or
// be removed. A branch is merged when its tip is in origin/master but NOT on
// master's first-parent mainline (it arrived through a merge), or when GitHub
// reports a PR on it MERGED into master (its merge commit on origin/master) with
// the local tip equal to, or an ancestor of, the PR head (#1732: a tip AHEAD of
// the PR head holds unmerged commits and never counts), or when
// `squashPatchId` proves a squash merge WITHOUT `gh` (B748): the branch's own
// combined diff (merge-base..tip) has the same `patch-id --verbatim` as a
// commit on master's first-parent chain since that base. That last proof is
// inference, not direct evidence, so it is the weakest of the three — it runs
// only when the others are silent, and an OPEN PR at the tip vetoes it. Last,
// `cherryAllMatched` (#1732): `git cherry` finds every branch commit already on
// master (cherry-picked or rebase-merged work), under the same veto. A
// fast-forwarded branch is indistinguishable from a fresh one and is left
// alone — a safe false negative.
//
// Safety rule (L-180/L-193): a Windows directory junction must NEVER be
// deleted with a recursive delete that can follow it into its target — that
// is exactly how a scratch worktree's node_modules junction once cascaded
// into a sibling worktree and destroyed ~2,388 of its tracked files. This
// tool never uses PowerShell's `Remove-Item -Recurse` (or Node's
// `fs.rmSync(..., {recursive:true})`, same risk) for anything that might
// contain a junction. It always unlinks every junction under a target with
// a BARE `cmd /c rmdir "<path>"` (no `/s`, which only detaches the reparse
// point) BEFORE running `cmd /c rmdir /s /q "<path>"` on what remains.
//
// Usage:
//   node scripts/janitor.mjs                    report-only (default)
//   node scripts/janitor.mjs --apply [--target <gb>]   reclaim, default target 10
//   node scripts/janitor.mjs --preflight <gb>   exit 1 if free space < <gb>
//   node scripts/janitor.mjs --stale-branches   report merged branches still on origin
//
// Preflight threshold guidance (document, not enforced by this tool):
//   > 10 GB  normal — proceed with anything
//   6-10 GB  reclaim (this tool, report-only or --apply) BEFORE an npm ci
//   < 6 GB   refuse installs — reclaim first
//   < 3 GB   stop everything and alert a human
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export const PROTECTED_WORKTREE_NAMES = new Set(["rf-migrate", "rf-crm-cloud"]);
export const PROTECTED_BRANCHES = new Set(["master", "main"]);
export const STALE_PROOF_AGE_DAYS = 7;
/** #2671: a Jest cache entry untouched this long is dead weight (every worktree path re-keys it). */
export const JEST_CACHE_AGE_DAYS = 3;
/** The per-workspace Jest cache directory every jest config now points at (#2671). */
export const WORKTREE_JEST_CACHE_DIR = ".jest-cache";

/**
 * #2671: Jest's DEFAULT cache directory name in the OS temp dir: `jest_<uid in base 36>` (e.g.
 * `jest_dx` for uid 501), or plain `jest` where there is no uid (Windows).
 */
export function isJestCacheDirName(name) {
  return /^jest(_[a-z0-9]+)?$/i.test(name);
}

/** The cache entries (paths) whose newest mtime is older than `days`. */
export function staleJestCacheEntries(entries, nowMs, days = JEST_CACHE_AGE_DAYS) {
  return entries.filter((e) => nowMs - e.mtimeMs > days * 86_400_000).map((e) => e.path);
}

/**
 * #2671: the refusal reason for deleting `targetReal` as a Jest cache entry, or null. Deliberately
 * narrow (the B815 guard only allows the repo's own trees): the target must be a DIRECT child of
 * one of the planned cache roots, and that root must itself be named like a Jest cache.
 */
export function jestCacheDeleteRefusal(targetReal, rootsReal, { caseInsensitive = false } = {}) {
  const norm = (x) => (caseInsensitive ? x.toLowerCase() : x);
  const parent = dirname(targetReal);
  if (!rootsReal.some((r) => norm(r) === norm(parent)))
    return "not a direct child of a planned Jest cache directory";
  const b = basename(parent);
  if (b !== WORKTREE_JEST_CACHE_DIR && !isJestCacheDirName(b))
    return "its parent is not named like a Jest cache directory";
  return null;
}
export const DEFAULT_TARGET_GB = 10;
export const RECENT_ACTIVITY_HOURS = 24;

// ---------------------------------------------------------------------------
// Pure classification logic — unit-tested with fixtures in
// janitor.self-test.mjs. Nothing in this section touches disk, git, or a
// process; every input is a plain value the caller already gathered.
// ---------------------------------------------------------------------------

/** name is the worktree's directory basename (e.g. "rf-migrate"). */
export function isProtectedWorktreeName(name, protectedNames = PROTECTED_WORKTREE_NAMES) {
  return protectedNames.has(name);
}

export function isProtectedBranch(branch, protectedBranches = PROTECTED_BRANCHES) {
  return protectedBranches.has(branch);
}

/**
 * B800: merged only on proof the branch carried work of its own (see the header).
 * evidence: { tipIsAncestor, tipOnMainline, prMergedAtTip, squashPatchId }
 *
 * `squashPatchId` (B748) is the squash-merge proof that needs no `gh`. It is the most permissive
 * of the three signals — content equality, not ancestry — so mergeEvidence computes it last and
 * only when nothing cheaper already said yes.
 */
export function isMergedEvidence({
  tipIsAncestor,
  tipOnMainline,
  prMergedAtTip,
  squashPatchId,
  cherryMatched,
}) {
  if (prMergedAtTip) return true;
  if (squashPatchId) return true; // B748: squash proof that needs no `gh`
  if (cherryMatched) return true; // #1732: every commit already on master, by patch-id
  return !!tipIsAncestor && !tipOnMainline;
}

/**
 * B815 guard: may the janitor delete this target? All paths are REAL paths (parent symlinks
 * resolved). Returns a refusal reason, or null when the delete is allowed. The main checkout is
 * never a target, nothing inside it may be deleted except under .claude/worktrees or local-assets,
 * and a node_modules target must lie inside its own worktree. This closes the gap posixRemoveTree
 * cannot see on its own: a symlink in a PARENT folder (lane/apps -> main/apps) that would make
 * "the lane's node_modules" really be the main checkout's.
 */
export function deleteRefusal({
  targetReal,
  mainReal,
  allowedInMainReal = [],
  worktreeReal = null,
  kind,
  caseInsensitive = false,
}) {
  // #1326 review: on Windows paths compare case-insensitively and without the \\?\ prefix.
  const norm = (p) => (caseInsensitive && p ? p.replace(/^\\\\\?\\/, "").toLowerCase() : p);
  targetReal = norm(targetReal);
  mainReal = norm(mainReal);
  allowedInMainReal = allowedInMainReal.map(norm);
  worktreeReal = norm(worktreeReal);
  const within = (child, parent) => child === parent || child.startsWith(parent + sep);
  if (targetReal === mainReal) return "target is the main checkout";
  if (within(targetReal, mainReal) && !allowedInMainReal.some((root) => within(targetReal, root))) {
    return "target resolves inside the main checkout, outside .claude/worktrees and local-assets";
  }
  if (kind === "node_modules") {
    if (!worktreeReal) return "node_modules target without a known worktree";
    if (worktreeReal === mainReal) return "node_modules of the main checkout";
    if (!within(targetReal, worktreeReal)) return "node_modules resolves outside its own worktree";
  }
  return null;
}

/** Recently active = HEAD moved within `hours`. Unknown activity counts as recent (safe side). */
export function isRecentlyActive(lastActivityMs, nowMs, hours = RECENT_ACTIVITY_HOURS) {
  if (lastActivityMs == null || !Number.isFinite(lastActivityMs)) return true;
  return nowMs - lastActivityMs < hours * 60 * 60 * 1000;
}

/**
 * Decide what (if anything) this tool may do to a worktree.
 * info: { name, branch, isMainCheckout, isMerged, isDirty, isRecent, hasUnpushed, isLocked }
 * Returns { nodeModules: "clear"|"skip", worktree: "remove"|"skip", reason }
 */
export function classifyWorktree(info) {
  const { name, branch, isMainCheckout, isMerged, isDirty, isRecent, hasUnpushed, isLocked } = info;
  if (isMainCheckout) return { nodeModules: "skip", worktree: "skip", reason: "main checkout" };
  if (isProtectedWorktreeName(name)) {
    return { nodeModules: "skip", worktree: "skip", reason: "protected worktree" };
  }
  if (isProtectedBranch(branch)) {
    return { nodeModules: "skip", worktree: "skip", reason: "protected branch" };
  }
  if (isLocked) {
    return { nodeModules: "skip", worktree: "skip", reason: "locked worktree — never touched" };
  }
  if (!isMerged) {
    return {
      nodeModules: "skip",
      worktree: "skip",
      reason: "branch not merged into origin/master",
    };
  }
  // B800: a worktree someone may still be working in is never touched at all — not even
  // node_modules, which an active lane needs to run its tests.
  if (isDirty) {
    return { nodeModules: "skip", worktree: "skip", reason: "uncommitted changes — never touched" };
  }
  if (isRecent) {
    return {
      nodeModules: "skip",
      worktree: "skip",
      reason: `HEAD moved in the last ${RECENT_ACTIVITY_HOURS}h (or unknown) — never touched`,
    };
  }
  // Merged, clean and idle: node_modules is safe to clear (the checkout survives).
  if (hasUnpushed) return { nodeModules: "clear", worktree: "skip", reason: "unpushed commits" };
  return { nodeModules: "clear", worktree: "remove", reason: "merged, clean, pushed" };
}

export function isStaleByAge(mtimeMs, nowMs, days = STALE_PROOF_AGE_DAYS) {
  return nowMs - mtimeMs > days * 24 * 60 * 60 * 1000;
}

export function meetsThreshold(freeGb, thresholdGb) {
  return freeGb >= thresholdGb;
}

/** listedPaths: worktree paths from `git worktree list`; dirNames: readdir() of .claude/worktrees/. */
/** May an orphan dir under .claude/worktrees be deleted? */
export function orphanEligible({
  hasGitEntry,
  newestMtimeMs,
  nowMs,
  hours = RECENT_ACTIVITY_HOURS,
}) {
  // B820: an orphan (a dir git no longer lists) may still be someone's checkout or scratch work.
  if (hasGitEntry) return false; // a .git file/dir: a repo or worktree git merely lost track of
  return !isRecentlyActive(newestMtimeMs, nowMs, hours); // touched lately, or unreadable: keep
}

export function findOrphanWorktreeDirs(listedPaths, dirNames, worktreesRoot) {
  const listed = new Set(listedPaths.map((p) => resolve(p)));
  return dirNames.filter((name) => !listed.has(resolve(join(worktreesRoot, name))));
}

/**
 * Remote branches merged into origin/master and still on origin. B800: a branch whose tip is
 * on master's mainline (`onMainline`) carries no work of its own — a fresh lane branch — and is
 * never reported as merged.
 */
export function findStaleBranches(
  remoteBranches,
  mergedBranchNames,
  protectedBranches = PROTECTED_BRANCHES,
  onMainline = new Set(),
) {
  return remoteBranches.filter(
    (b) => mergedBranchNames.has(b) && !protectedBranches.has(b) && !onMainline.has(b),
  );
}

// ---------------------------------------------------------------------------
// IO — real git/fs/exec. Kept thin and separate so the logic above can be
// tested without ever touching a real repo or filesystem.
// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
}

// Failure here is an expected, silent fallback (e.g. no upstream configured) —
// stderr is suppressed so a routine "this branch has no remote" doesn't read
// as an error in the plan output.
function trySh(cmd, args, opts = {}) {
  try {
    return sh(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
  } catch {
    return null;
  }
}

function isWindows() {
  return process.platform === "win32";
}

function getFreeSpaceGb() {
  if (isWindows()) {
    const out = trySh("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-PSDrive -Name C).Free",
    ]);
    if (out) return Number(out) / 1024 ** 3;
  }
  const out = sh("df", ["-k", "."]);
  const line = out.split("\n").slice(1).find(Boolean) ?? "";
  const kb = Number(line.trim().split(/\s+/)[3]);
  return kb / (1024 * 1024);
}

/** Read-only detection of Windows directory junctions under `dir` — never deletes anything. */
/** A PowerShell single-quoted literal for `s`. */
export function psLiteral(s) {
  // A single-quoted PS literal doubles its quotes, and PowerShell also treats U+2018-U+201B as
  // single quotes, so those are doubled too.
  return `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/** True when `p` is itself a symlink or junction (Node reports a junction as a symlink). */
function isLinkPath(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * #1326 Windows re-review: is anything at `p`, the link ITSELF included? existsSync follows a link,
 * so a link that survived its unlink but points at a missing target would read as removed.
 */
export function pathPresent(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function findJunctions(dir) {
  if (!isWindows() || !existsSync(dir)) return [];
  const out = trySh("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    // B818: -ErrorVariable + exit 3, so an access-denied subtree (which could hide a junction)
    // fails the scan instead of being silently skipped.
    `Get-ChildItem -LiteralPath ${psLiteral(dir)} -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable scanErr | Where-Object { $_.LinkType } | Select-Object -ExpandProperty FullName; if ($scanErr) { exit 3 }`,
  ]);
  if (out == null) return null; // PowerShell failed: we do NOT know there are no junctions
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The real path of `p` with symlinks in its PARENT folders resolved (the last component kept). */
function realParentPath(p) {
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return null;
  }
}

const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** B815: the refusal reason for deleting `target` in this repo context, or null. */
export function refuseDelete(target, ctx, { kind, worktreePath = null } = {}) {
  const targetReal = realParentPath(target);
  if (!targetReal) return "cannot resolve the target's real path";
  const mainReal = realOr(ctx.mainCheckoutPath);
  return deleteRefusal({
    targetReal,
    mainReal,
    allowedInMainReal: [
      realOr(ctx.worktreesRoot),
      realOr(join(ctx.mainCheckoutPath, "local-assets")),
    ],
    worktreeReal: worktreePath ? realOr(worktreePath) : null,
    kind,
    caseInsensitive: isWindows(),
  });
}

/**
 * B815: remove a tree on macOS/Linux WITHOUT following a symlink inside it. Every entry is lstat'ed: a
 * symlink (to a file OR a directory) and a plain file are unlinked — the link, never its target —
 * and only a real directory is descended into and then rmdir'ed. A lane worktree's node_modules on
 * the MacBook is a symlink into the MAIN checkout; recursing through it would wipe the main
 * checkout's dependencies. (Same rule as the Windows junction handling below, L-180/L-193.)
 */
export function posixRemoveTree(target) {
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return; // already gone
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    unlinkSync(target);
    return;
  }
  for (const name of readdirSync(target)) posixRemoveTree(join(target, name));
  rmdirSync(target);
}

/**
 * Safely remove a directory tree that may contain links. Windows: unlink every junction first with
 * a bare `rmdir` (never `/s`, which is the one thing that can follow a reparse point into its
 * target — see file header), THEN `cmd /c rmdir /s /q` what's left. Never PowerShell's
 * Remove-Item -Recurse or Node's fs.rmSync recursive mode. Elsewhere: posixRemoveTree (B815 — the
 * Windows-only `cmd` made every macOS/Linux --apply throw at its first delete).
 */
export function safeRemoveTree(dir) {
  if (!isWindows()) {
    posixRemoveTree(dir);
    return;
  }
  windowsRemoveTree(dir, WINDOWS_DEPS);
}

/** The Windows removal sequence, with its OS calls injected (so it is testable anywhere). */
// #1326 review (HIGH): `cmd /c rmdir` gets an UNQUOTED path (Node quotes only spaces and quotes),
// and cmd splits on & | < > and drops ^, so deleting `wt\a&b` deleted the SIBLING `wt\a`. Any path
// holding a cmd metacharacter is refused before cmd ever sees it; a human deletes it by hand.
// `,` `;` `=` too: for cmd's built-ins they separate arguments exactly like a space (and Node only
// quotes a path containing a space, tab or quote), so `rmdir /s /q wt\a,b` removes `wt\a` and `b`.
// Control characters too: Node does not quote a newline, and cmd stops reading at one.
export const CMD_UNSAFE = /[&|<>^%!"(),;=\x00-\x1f]/;
function assertCmdSafe(p) {
  if (CMD_UNSAFE.test(p)) {
    throw new Error(`refusing a Windows delete of a path with a cmd metacharacter: ${p}`);
  }
}

/**
 * #1326 Windows re-review (REQUIRED): the ONLY way a path reaches cmd. `git worktree list
 * --porcelain` prints forward slashes (`C:/…`) and cmd reads a `/segment` as a switch, so a path of
 * `s`/`q` segments could turn `rmdir /s /q C:/…` into `rd /s /q C:`. So the path must be
 * absolute, either a drive path (`C:\…`) or a UNC path with a server AND a share. A `\\?\` or
 * `\\.\` device prefix is refused; git never prints one. A `.` or `..` segment, or one ending in
 * a dot or a space, is refused too: Win32 strips those, so cmd would delete a different folder
 * than the one the containment guard approved. The path is then backslashed with
 * path.win32.resolve, and a drive or share root is refused.
 */
const refuseCmd = (why, p) => {
  throw new Error(`refusing a Windows delete of ${why}: ${JSON.stringify(p)}`);
};
export function cmdRmdirArgs(p, { recursive = false } = {}) {
  assertCmdSafe(p);
  if (/^[\\/]{2}[?.][\\/]/.test(p)) refuseCmd("a device or long-path prefix", p);
  const drive = /^[A-Za-z]:[\\/]/.test(p);
  const unc = /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/.test(p);
  if (!drive && !unc) refuseCmd("a non-absolute path", p);
  const segments = p.split(/[\\/]+/).filter((seg, i) => seg && !(drive && i === 0));
  if (segments.some((seg) => seg === "." || seg === ".." || /[. ]$/.test(seg))) {
    refuseCmd("a path with a dot segment or a trailing dot or space", p);
  }
  const abs = win32.resolve(p);
  // A backstop: with the checks above it cannot fire today. It only guards against
  // path.win32.resolve changing behaviour, so keep it even though no test reaches it alone.
  const sameRootKind = drive ? /^[A-Za-z]:\\/.test(abs) : /^\\\\[^\\?.]/.test(abs);
  if (
    abs.includes("/") ||
    !sameRootKind ||
    win32.parse(abs).root === abs ||
    win32.dirname(abs) === abs
  ) {
    refuseCmd("a root or unnormalised path", p);
  }
  return ["/c", "rmdir", ...(recursive ? ["/s", "/q"] : []), abs];
}

/**
 * B818: unlink every junction under `dir` and PROVE it: a failed scan refuses, each unlink is
 * verified, and a re-scan must come back empty. Shared by windowsRemoveTree and unlinkLinksWithin.
 */
export function unlinkJunctionsVerified(dir, { findJunctions: find, unlinkJunction, exists }) {
  const junctions = find(dir);
  if (junctions == null) throw new Error(`junction scan failed for ${dir}: refusing to delete it`);
  junctions.forEach((j) => cmdRmdirArgs(j)); // every junction is checked BEFORE any unlink
  for (const junction of junctions) {
    unlinkJunction(junction);
    if (exists(junction)) throw new Error(`junction ${junction} survived its unlink: refusing`);
  }
  const again = find(dir);
  if (again == null || again.length > 0) {
    throw new Error(`junctions remain under ${dir} after unlinking: refusing to delete it`);
  }
}

/**
 * #1326 review: a target that IS a junction (a lane's node_modules -> main's) must never be
 * scanned — Get-ChildItem -Recurse walks INTO the target. Unlink the link alone and prove it with
 * deps.exists (lstat-based in WINDOWS_DEPS). Returns true when `dir` was a link. deps.isLink is
 * REQUIRED: a missing one would silently treat every junction target as a plain tree.
 */
function unlinkIfLink(dir, deps, who) {
  if (typeof deps.isLink !== "function") throw new Error(`${who} needs deps.isLink`);
  cmdRmdirArgs(dir); // the whole cmd path contract, before any OS call
  if (!deps.isLink(dir)) return false;
  deps.unlinkJunction(dir);
  if (deps.exists(dir)) throw new Error(`link ${dir} survived its unlink: refusing`);
  return true;
}

export function windowsRemoveTree(dir, deps) {
  if (unlinkIfLink(dir, deps, "windowsRemoveTree")) return;
  // `rmdir /s` follows a junction, so it only ever runs on a tree PROVEN junction-free.
  unlinkJunctionsVerified(dir, deps);
  if (deps.exists(dir)) deps.rmdirS(dir);
}

/** B817 on Windows, with its OS calls injected: unlink every junction in `dir`, following none. */
export function unlinkLinksWindows(dir, deps) {
  if (unlinkIfLink(dir, deps, "unlinkLinksWindows")) return;
  unlinkJunctionsVerified(dir, deps);
}

/** The real Windows OS calls. Every cmd path goes through cmdRmdirArgs; every "gone?" is lstat. */
export const WINDOWS_DEPS = Object.freeze({
  findJunctions,
  isLink: isLinkPath,
  unlinkJunction: (j) => trySh("cmd", cmdRmdirArgs(j)),
  exists: pathPresent,
  rmdirS: (d) => execFileSync("cmd", cmdRmdirArgs(d, { recursive: true })),
});

/**
 * B816: where the janitor operates — the repo's MAIN checkout and its .claude/worktrees root — no
 * matter which worktree it is run from. `git rev-parse --show-toplevel` answers "this worktree",
 * which made a run from a lane worktree treat the real main checkout as an ordinary, removable
 * worktree. `git worktree list` always lists the main worktree first.
 */
export function resolveRepoContext(cwd = process.cwd()) {
  const out = trySh("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
  const first = out?.split("\n").find((l) => l.startsWith("worktree "));
  // #1326 review: never GUESS a main checkout; a janitor that cannot identify it must not run.
  if (!first) throw new Error(`not inside a git repository (git worktree list failed in ${cwd})`);
  const main = first.slice("worktree ".length).trim();
  return {
    repoRoot: main,
    mainCheckoutPath: main,
    worktreesRoot: join(main, ".claude", "worktrees"),
  };
}

function listWorktrees(repoRoot) {
  const out = sh("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const entries = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), branch: null, locked: false };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
    } else if ((line === "locked" || line.startsWith("locked ")) && cur) {
      cur.locked = true; // `git worktree lock`: someone asked git to keep this one
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

const mainlineCache = new Map();
/** Every commit on `masterRef`'s first-parent chain (cached per repo + resolved master sha). */
export function mainlineCommits(repoRoot, masterRef = "origin/master") {
  // Keyed on the RESOLVED master sha, not the ref name, so a moved master never reads a stale set.
  const head = trySh("git", ["-C", repoRoot, "rev-parse", masterRef]);
  if (!head) return null;
  const key = `${repoRoot}\0${head}`;
  if (!mainlineCache.has(key)) {
    const out = trySh("git", ["-C", repoRoot, "rev-list", "--first-parent", head], {
      maxBuffer: 256 * 1024 * 1024,
    });
    if (out == null) return null; // unreadable: callers fail CLOSED (treat as on the mainline)
    mainlineCache.set(key, new Set(out.split("\n").filter(Boolean)));
  }
  return mainlineCache.get(key);
}

/** Does `ancestor` exist and lie in `descendant`'s history (or equal it)? Any failure: false. */
function isAncestorOrSelf(repoRoot, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false; // not an ancestor, or an object missing locally: not proven
  }
}

/**
 * #1732: does one of these MERGED PRs cover this local tip? `prs` is `gh pr list --json
 * headRefOid,mergeCommit` output. A PR covers the tip when
 *   - its merge commit is on `masterRef` (it merged into master, not into some other base), and
 *   - the local tip IS the PR head, or an ANCESTOR of it: every local commit went into that PR.
 * The old rule required `headRefOid === tip` exactly, so a worktree whose branch was pushed on
 * (from another machine, or by the landing coordinator's merge of master) looked unmerged forever.
 * A local tip AHEAD of the PR head is never covered: those extra commits were never merged. A PR
 * head or merge commit whose object is missing locally is not proven either (fails closed).
 */
export function mergedPrCoversTip(repoRoot, tip, prs, masterRef = "origin/master") {
  if (!tip || !Array.isArray(prs)) return false;
  return prs.some((p) => {
    const head = p?.headRefOid;
    const mergeCommit = p?.mergeCommit?.oid;
    if (!head || !mergeCommit) return false;
    if (!isAncestorOrSelf(repoRoot, mergeCommit, masterRef)) return false;
    return head === tip || isAncestorOrSelf(repoRoot, tip, head);
  });
}

/** B800/#1732: GitHub says a MERGED PR on this branch covers this local tip. Any failure: false. */
function ghPrMergedAtTip(repoRoot, branch, tip, masterRef = "origin/master") {
  const out = trySh(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "headRefOid,mergeCommit",
      "--limit",
      "5",
    ],
    { cwd: repoRoot, timeout: 15_000 }, // a network hang never blocks the report; timeout = not proven
  );
  if (!out) return false;
  try {
    return mergedPrCoversTip(repoRoot, tip, JSON.parse(out), masterRef);
  } catch {
    return false;
  }
}

/**
 * Is there an OPEN PR whose head is exactly this tip?
 *
 * A patch-id match says "master carries an identical change", which is NOT the same as "this
 * branch is done". A lane can re-land the same diff (a revert-and-redo, a cherry-pick someone
 * else merged first) while its own PR is still open and under review. An open PR at the tip is
 * the branch's owner saying it is live, so it VETOES the patch-id proof — the ancestry and
 * merged-PR proofs are unaffected, since those are direct evidence rather than inference.
 *
 * Absence of `gh` is not a veto: null/false means "no answer", and the scan proceeds as before.
 */
function ghOpenPrAtTip(repoRoot, branch, tip) {
  const out = trySh(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "headRefOid", "--limit", "5"],
    { cwd: repoRoot, timeout: 15_000 },
  );
  if (!out) return false;
  try {
    return JSON.parse(out).some((p) => p.headRefOid === tip);
  } catch {
    return false;
  }
}

/** The evidence isMergedEvidence() judges. `ghLookup` is injectable so the self-test is hermetic. */
/** The commit a local branch points at (LOW: never a same-named tag). */
export function branchTip(repoRoot, branch) {
  // refs/heads/ explicitly: a bare name resolves a same-named TAG first.
  return trySh("git", [
    "-C",
    repoRoot,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}^{commit}`,
  ]);
}

/**
 * Raw bytes of `git <args>`, NEVER decoded. Buffer, or null on failure.
 *
 * A diff is not text. `sh`/`trySh` decode as UTF-8 and `.trim()`, so any byte sequence that is not
 * valid UTF-8 becomes U+FFFD — two different binary blobs collapse to the same string and would
 * hash alike, and the trim can drop bytes patch-id counts. Everything on the patch-id path stays
 * in Buffers for that reason.
 */
function gitRaw(repoRoot, args, input) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "buffer",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Every patch-id in a raw diff stream, in order. `--verbatim`, never `--stable`.
 *
 * `--stable` (and `--unstable`) strip whitespace before hashing, so a change that only re-indents
 * or re-spaces a line hashes identically to not making it at all. That is a DATA-LOSS bug here: a
 * lane whose work was squash-merged, which then pushes an unmerged follow-up that only re-indents
 * a line its own earlier work added, produces a combined diff whose `--stable` id equals the
 * squash commit's — so the janitor would call the branch merged and delete the worktree holding
 * that unpushed commit. `--verbatim` hashes the bytes as they are.
 */
function patchIdsOfDiff(repoRoot, diffBuf) {
  if (!diffBuf || diffBuf.length === 0) return [];
  const out = gitRaw(repoRoot, ["patch-id", "--verbatim"], diffBuf);
  if (!out) return [];
  return out
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * B748: proof WITHOUT `gh` that a squash merge landed this branch's work on master.
 *
 * GitHub's "Squash and merge" replays the branch as ONE new commit, so the tip is not an ancestor
 * and is not on the mainline — every ancestry signal reads "not merged", and `ghPrMergedAtTip` is
 * the only thing that saved it. `gh` is absent on CI runners and on the cloud container, so that
 * proof is unavailable exactly where the janitor runs unattended.
 *
 * The branch's OWN combined change is `merge-base..tip`; a squash commit on master carries that
 * same change, so their patch-ids match. Per-commit matching (`git cherry`) is not enough: a
 * multi-commit branch collapses to one commit whose patch-id equals the COMBINED diff and no
 * individual commit's.
 *
 * Fails CLOSED everywhere — unreadable history, an empty diff (a branch with no work of its own,
 * which B800 says is never merged), or a scan longer than `maxScan` all return false. A false
 * negative leaves disk behind; a false positive deletes someone's work.
 */
export function squashMergedByPatchId(
  repoRoot,
  tip,
  { masterRef = "origin/master", maxScan = 1000 } = {},
) {
  if (!tip) return false;
  const mergeBase = trySh("git", ["-C", repoRoot, "merge-base", masterRef, tip]);
  if (!mergeBase || mergeBase === tip) return false; // nothing of its own to have been squashed

  // BOTH sides must run the SAME command with the SAME options. Porcelain `git diff` applies
  // rename detection and honours the invoking user's diff config; `diff-tree` is plumbing and
  // does neither, so mixing them meant a squash-merged RENAME never matched and its worktree was
  // never reclaimed. Plumbing on both sides, so the comparison cannot depend on who is running it.
  const ownIds = patchIdsOfDiff(
    repoRoot,
    gitRaw(repoRoot, ["diff-tree", "-p", "--binary", mergeBase, tip]),
  );
  // Exactly one patch is expected. Zero = unreadable, or a branch carrying no change of its own
  // (B800: never merged). Anything else is not a shape this can reason about — fail closed.
  if (ownIds.length !== 1) return false;
  const own = ownIds[0];

  const list = trySh("git", [
    "-C",
    repoRoot,
    "rev-list",
    "--first-parent",
    `${mergeBase}..${masterRef}`,
  ]);
  if (list == null) return false; // unreadable mainline: fail closed
  const shas = list.split("\n").filter(Boolean);
  if (shas.length === 0) return false; // nothing on master since the base: nothing to have squashed
  if (shas.length > maxScan) return false; // pathological range: fail closed rather than churn

  // ONE pass over the range, not two processes per commit: rev-list feeds `diff-tree --stdin`,
  // whose whole stream feeds one `patch-id`. Measured on a 187-commit range this is ~5-8s against
  // ~40s for the per-commit loop, per worktree scanned.
  const diffs = gitRaw(
    repoRoot,
    ["diff-tree", "-p", "--binary", "--stdin"],
    Buffer.from(`${shas.join("\n")}\n`),
  );
  if (!diffs) return false; // unreadable: fail closed
  return patchIdsOfDiff(repoRoot, diffs).includes(own);
}

/**
 * #1732: proof WITHOUT `gh` that every commit of this branch is already on master:
 * `git cherry <master> <tip>` lists each commit not in master's history, `-` when an equivalent
 * patch is upstream and `+` when not. At least one line and no `+` line = merged. This covers what
 * the combined-diff proof cannot: a branch whose commits reached master one by one (cherry-picks,
 * a rebase-merge, or a squash of a branch that later merged master in). Like the patch-id proof it
 * is inference, so it runs only when nothing direct proved the merge, and an OPEN PR vetoes it.
 * Zero lines (a branch with no work of its own, B800) or any failure: false.
 */
export function cherryAllMatched(repoRoot, tip, { masterRef = "origin/master" } = {}) {
  if (!tip) return false;
  const out = trySh("git", ["-C", repoRoot, "cherry", masterRef, tip]);
  if (out == null) return false; // unreadable: fail closed
  const lines = out.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("- "));
}

export function mergeEvidence(
  repoRoot,
  branch,
  { masterRef = "origin/master", ghLookup = ghPrMergedAtTip, ghOpenLookup = ghOpenPrAtTip } = {},
) {
  const none = {
    tipIsAncestor: false,
    tipOnMainline: false,
    prMergedAtTip: false,
    squashPatchId: false,
    cherryMatched: false,
  };
  if (!branch) return none; // detached HEAD — cannot prove merged
  const tip = branchTip(repoRoot, branch);
  if (!tip) return none;
  let tipIsAncestor = false;
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", tip, masterRef], {
      stdio: "ignore",
    });
    tipIsAncestor = true;
  } catch {
    tipIsAncestor = false; // not in master by ancestry (squash merges land here)
  }
  const mainline = mainlineCommits(repoRoot, masterRef);
  const tipOnMainline = mainline ? mainline.has(tip) : true; // unreadable mainline: fail closed
  // Ancestry through a merge is already proof; only ask GitHub when it is not.
  const proven = tipIsAncestor && !tipOnMainline;
  const prMergedAtTip = proven ? false : !!ghLookup(repoRoot, branch, tip, masterRef);
  // B748: only when nothing cheaper proved it. The patch-id scan walks master since the merge
  // base, so it must never run on the common already-proven paths. An OPEN PR at this tip vetoes
  // it outright — and the veto is checked FIRST, so a live branch never pays for the scan either.
  // #1732: the same veto and ordering gate the `git cherry` proof, which runs last.
  const inferenceAllowed = !proven && !prMergedAtTip && !ghOpenLookup(repoRoot, branch, tip);
  const squashPatchId = inferenceAllowed
    ? squashMergedByPatchId(repoRoot, tip, { masterRef })
    : false;
  const cherryMatched =
    inferenceAllowed && !squashPatchId ? cherryAllMatched(repoRoot, tip, { masterRef }) : false;
  return { tipIsAncestor, tipOnMainline, prMergedAtTip, squashPatchId, cherryMatched };
}

export function isMergedIntoMaster(repoRoot, branch, opts) {
  return isMergedEvidence(mergeEvidence(repoRoot, branch, opts));
}

/** When this worktree's HEAD last moved (commit, checkout, reset, rebase), from its HEAD reflog. */
export function lastActivityMs(worktreePath) {
  const gitDir = trySh("git", ["-C", worktreePath, "rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return null;
  const log = join(gitDir, "logs", "HEAD");
  return existsSync(log) ? statSync(log).mtimeMs : null;
}

// B819: ignored paths that are build output and safe to lose; any OTHER ignored path (a .env, a
// local-assets folder, a scratch note) is someone's data and makes the worktree "dirty".
const REGENERABLE_IGNORED = [
  /(^|\/)node_modules\/?$/,
  // #1326 review: build output only at the top level or a package root — a source folder that
  // happens to be called `build` (apps/api/src/build/) is someone's code, not output.
  /^((apps|packages)\/[^/]+\/)?(dist|build|coverage)\/?$/,
  /(^|\/)\.next\/?$/,
  /(^|\/)\.turbo\/?$/,
  /(^|\/)\.expo\/?$/,
  /(^|\/)test-output\/?$/,
  /\.tsbuildinfo$/,
  /(^|\/)\.DS_Store$/,
  /^\.campaign\/?$/, // regenerable per its own .gitignore comment
  /(^|\/)next-env\.d\.ts$/, // Next regenerates it
  /^\.husky\/_(\/.*)?$/, // husky regenerates it (git lists its files one by one)
  /^\.claude\/settings\.local\.json$/, // per-machine settings copy of a worktree being removed
];

/** Is this worktree dirty, from its `git status --porcelain` (and `--ignored`) output? */
export function dirtyFromStatus(statusOut, ignoredOut) {
  // B819: unknown is unsafe — a failed `git status` (null) is dirty, never clean.
  if (statusOut == null || ignoredOut == null) return true;
  if (statusOut.trim().length > 0) return true;
  return ignoredOut
    .split("\n")
    .filter((l) => l.startsWith("!! "))
    .map((l) => l.slice(3).trim())
    .some((path) => !REGENERABLE_IGNORED.some((re) => re.test(path)));
}

/** What orphanEligible needs, read without following links: a .git entry, the newest mtime. */
function orphanFacts(dir) {
  try {
    const top = lstatSync(dir);
    if (!top.isDirectory()) return { hasGitEntry: false, newestMtimeMs: top.mtimeMs };
    let newest = top.mtimeMs;
    let hasGitEntry = false;
    const stack = [[dir, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = lstatSync(p);
        if (name === ".git") hasGitEntry = true;
        newest = Math.max(newest, st.mtimeMs);
        if (st.isDirectory() && !st.isSymbolicLink() && depth < 3 && name !== "node_modules") {
          stack.push([p, depth + 1]);
        }
      }
    }
    return { hasGitEntry, newestMtimeMs: newest };
  } catch {
    return { hasGitEntry: false, newestMtimeMs: null }; // unreadable: orphanEligible keeps it
  }
}

function isDirty(worktreePath) {
  const out = trySh("git", ["-C", worktreePath, "status", "--porcelain"]);
  const ignored = trySh("git", ["-C", worktreePath, "status", "--porcelain", "--ignored=matching"]);
  return dirtyFromStatus(out, ignored);
}

function hasUnpushedCommits(worktreePath, branch) {
  if (!branch) return true; // detached — treat as unknown/unsafe
  const upstream = trySh("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", `${branch}@{u}`]);
  if (!upstream) return true; // no upstream configured — unknown, treat as unsafe
  const ahead = trySh("git", ["-C", worktreePath, "rev-list", "--count", `${upstream}..${branch}`]);
  return Number(ahead ?? "1") > 0;
}

function findNodeModulesDirs(worktreePath) {
  const candidates = [join(worktreePath, "node_modules")];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(worktreePath, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      candidates.push(join(groupDir, name, "node_modules"));
    }
  }
  return candidates.filter((p) => existsSync(p));
}

// ---------------------------------------------------------------------------
// Plan + execute
// ---------------------------------------------------------------------------

export function buildPlan(repoRoot, mainCheckoutPath, worktreesRoot) {
  const worktrees = listWorktrees(repoRoot);
  const actions = [];
  const skipped = [];
  const nowMs = Date.now();

  for (const wt of worktrees) {
    const name = wt.path.split(/[\\/]/).pop();
    const isMainCheckout = resolve(wt.path) === resolve(mainCheckoutPath);
    // The patch-id scan walks master's first-parent chain, so it is the most expensive question
    // asked here. classifyWorktree already returns "skip" for a locked, protected-name or
    // protected-branch worktree BEFORE it ever consults isMerged — so computing it for one is
    // pure cost with no effect on the verdict. `null` records "not asked", and reads as falsy at
    // the `!isMerged` branch those cases never reach.
    const skippedBeforeMerge =
      !!wt.locked || isProtectedWorktreeName(name) || isProtectedBranch(wt.branch);
    const isMerged = isMainCheckout
      ? true
      : skippedBeforeMerge
        ? null
        : isMergedIntoMaster(repoRoot, wt.branch);
    const info = {
      name,
      branch: wt.branch,
      isMainCheckout,
      isMerged,
      isLocked: !!wt.locked,
      isDirty: isMainCheckout ? false : isDirty(wt.path),
      isRecent: isMainCheckout ? false : isRecentlyActive(lastActivityMs(wt.path), nowMs),
      hasUnpushed: isMainCheckout ? false : hasUnpushedCommits(wt.path, wt.branch),
    };
    const verdict = classifyWorktree(info);
    if (verdict.nodeModules === "clear") {
      for (const nm of findNodeModulesDirs(wt.path)) {
        actions.push({
          step: 1,
          kind: "node_modules",
          target: nm,
          worktree: name,
          worktreePath: wt.path,
        });
      }
    }
    if (verdict.worktree === "remove") {
      // #1346: worktreePath, so execute()'s delete-time dirty re-check covers the DESTRUCTIVE
      // removal too, not only the node_modules clear (a worktree action without it skipped the
      // re-check entirely).
      actions.push({
        step: 2,
        kind: "worktree",
        target: wt.path,
        worktree: name,
        worktreePath: wt.path,
      });
    }
    if (verdict.nodeModules === "skip" || verdict.worktree === "skip") {
      skipped.push({ worktree: name, branch: wt.branch, reason: verdict.reason });
    }
  }

  if (existsSync(worktreesRoot)) {
    const listedPaths = worktrees.map((w) => w.path);
    const dirNames = readdirSync(worktreesRoot);
    for (const orphan of findOrphanWorktreeDirs(listedPaths, dirNames, worktreesRoot)) {
      const target = join(worktreesRoot, orphan);
      const facts = orphanFacts(target);
      if (orphanEligible({ ...facts, nowMs })) {
        actions.push({ step: 3, kind: "orphan-dir", target });
      } else {
        skipped.push({
          worktree: orphan,
          branch: null,
          reason: facts.hasGitEntry
            ? "orphan dir holds a .git entry — never touched"
            : `orphan dir touched in the last ${RECENT_ACTIVITY_HOURS}h (or unreadable) — never touched`,
        });
      }
    }
  }

  actions.push({ step: 4, kind: "docker-build-cache" });
  actions.push({ step: 5, kind: "npm-cache" });

  const now = Date.now();
  for (const sub of ["local-assets/proofs", "local-assets/handoff"]) {
    const dir = join(mainCheckoutPath, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory() && isStaleByAge(st.mtimeMs, now)) {
        actions.push({ step: 6, kind: "stale-proof-dir", target: full });
      }
    }
  }

  // #2671: Jest caches. The legacy SHARED default cache in the OS temp dir (every verify from a new
  // worktree path re-keyed it; it reached 8 GB) and each worktree's per-workspace `.jest-cache`.
  // Only entries untouched for JEST_CACHE_AGE_DAYS go; a live run's recent entries stay.
  actions.push(
    ...planJestCacheActions(
      jestCacheRoots(worktrees.map((w) => w.path).concat(mainCheckoutPath)),
      now,
    ),
  );

  return { actions, skipped };
}

/**
 * #2671: the step-7 actions for these Jest cache roots: one per direct entry untouched for
 * JEST_CACHE_AGE_DAYS. A symlink entry is never planned and never followed for its age (its target
 * could be anywhere); a real directory's age is its own and its direct children's newest lstat mtime.
 */
export function planJestCacheActions(roots, nowMs) {
  const actions = [];
  for (const root of roots) {
    const entries = [];
    for (const name of safeReaddir(root)) {
      const full = join(root, name);
      const m = newestMtimeMs(full);
      if (m != null) entries.push({ path: full, mtimeMs: m });
    }
    for (const target of staleJestCacheEntries(entries, nowMs)) {
      actions.push({ step: 7, kind: "jest-cache", target, root });
    }
  }
  return actions;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** An entry's newest mtime: itself, or for a directory the newest of it and its direct children. */
function newestMtimeMs(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null; // never follow a link out of a cache dir
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const child of safeReaddir(p)) {
      try {
        newest = Math.max(newest, lstatSync(join(p, child)).mtimeMs);
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return newest;
}

/** #2671: the Jest cache roots to sweep: the OS-temp shared caches and every worktree's per-workspace ones. */
function jestCacheRoots(worktreePaths) {
  const roots = new Set();
  const temps = new Set(
    [tmpdir(), "/tmp", "/private/tmp"].filter(existsSync).map((t) => realOr(t)),
  );
  for (const t of temps)
    for (const name of safeReaddir(t))
      if (isJestCacheDirName(name) && statSafeIsDir(join(t, name))) roots.add(join(t, name));
  for (const wt of new Set(worktreePaths)) {
    for (const group of ["apps", "packages"]) {
      for (const ws of safeReaddir(join(wt, group))) {
        const dir = join(wt, group, ws, WORKTREE_JEST_CACHE_DIR);
        if (statSafeIsDir(dir)) roots.add(dir);
      }
    }
  }
  return [...roots];
}

function statSafeIsDir(p) {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function describeAction(a) {
  switch (a.kind) {
    case "node_modules":
      return `[1] clear node_modules — ${a.target} (worktree ${a.worktree}, merged)`;
    case "worktree":
      return `[2] remove whole worktree — ${a.target} (merged, clean, idle, pushed)`;
    case "orphan-dir":
      return `[3] remove orphan worktree dir — ${a.target} (not listed by git worktree)`;
    case "docker-build-cache":
      return `[4] docker builder prune -a -f (build cache only, never volumes/system)`;
    case "npm-cache":
      return `[5] npm cache clean --force`;
    case "stale-proof-dir":
      return `[6] remove stale proof/handoff dir — ${a.target} (older than ${STALE_PROOF_AGE_DAYS}d)`;
    case "jest-cache":
      return `[7] remove stale Jest cache entry — ${a.target} (untouched ${JEST_CACHE_AGE_DAYS}d+)`;
    default:
      return `[?] ${a.kind}`;
  }
}

/** The real OS/git calls execute() uses; the self-test injects fakes instead. */
const EXECUTE_DEPS = {
  refuseDelete: (target, opts) => refuseDelete(target, resolveRepoContext(), opts),
  // #2671: the Jest-cache guard (the B815 guard only allows the repo's own trees).
  refuseJestCacheDelete: (target, root) =>
    jestCacheDeleteRefusal(realOr(target), [realOr(root)], { caseInsensitive: isWindows() }),
  isDirty: (worktreePath) => isDirty(worktreePath),
  removeTree: (t) => safeRemoveTree(t),
  removeWorktree: (t) => {
    const { repoRoot } = resolveRepoContext();
    removeWorktreeSafely(t, {
      git: (...args) => trySh("git", ["-C", repoRoot, ...args]),
      unlinkLinksWithin,
      exists: pathPresent,
      removeTree: safeRemoveTree,
    });
  },
  run: (cmd, args) => trySh(cmd, args),
  log: (m) => console.log(m),
};

/**
 * Carry out one planned action. Every delete passes the B815 containment guard first; a refusal
 * skips the action, loudly. A whole worktree goes through removeWorktreeSafely (B817: links first).
 */
export function execute(a, deps = EXECUTE_DEPS) {
  if (["node_modules", "orphan-dir", "stale-proof-dir", "worktree"].includes(a.kind)) {
    const why = deps.refuseDelete(a.target, { kind: a.kind, worktreePath: a.worktreePath });
    if (why) {
      deps.log(`   REFUSED, skipped: ${a.target} (${why})`);
      return "refused";
    }
    // B748: the plan (isDirty) is computed once; execute() may run later, or be reordered by a
    // caller. Re-verify RIGHT BEFORE deleting anything under a worktree — a worktree going dirty
    // between plan and execute must never lose uncommitted work to a clear/remove that was
    // decided when it still looked clean.
    if (a.worktreePath && deps.isDirty(a.worktreePath)) {
      deps.log(`   REFUSED, skipped: ${a.target} (worktree went dirty since the plan was built)`);
      return "refused";
    }
  }
  if (a.kind === "jest-cache") {
    const why = deps.refuseJestCacheDelete(a.target, a.root);
    if (why) {
      deps.log(`   REFUSED, skipped: ${a.target} (${why})`);
      return "refused";
    }
    deps.removeTree(a.target);
    return "done";
  }
  switch (a.kind) {
    case "node_modules":
    case "orphan-dir":
    case "stale-proof-dir":
      deps.removeTree(a.target);
      return "done";
    case "worktree":
      deps.removeWorktree(a.target);
      return "done";
    case "docker-build-cache":
      deps.run("docker", ["builder", "prune", "-a", "-f"]);
      return "done";
    case "npm-cache":
      deps.run("npm", ["cache", "clean", "--force"]);
      return "done";
    default:
      throw new Error(`unknown janitor action kind: ${a.kind}`);
  }
}

/** Remove a whole worktree, with its OS/git calls injected (testable anywhere). */
export function removeWorktreeSafely(
  target,
  { git, unlinkLinksWithin: unlinkLinks, exists, removeTree },
) {
  // B817: git's own recursive delete (Git for Windows) can follow a junction into its target, so
  // every link inside the worktree is unlinked FIRST; git then only ever sees plain files.
  unlinkLinks(target);
  git("worktree", "remove", "--force", target);
  if (exists(target)) removeTree(target); // Windows file-lock leftover
  git("worktree", "prune");
}

/** B817: unlink every symlink/junction inside `dir`, following none. Throws when unsure. */
export function unlinkLinksWithin(dir) {
  if (isWindows()) {
    unlinkLinksWindows(dir, WINDOWS_DEPS);
    return;
  }
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) unlinkSync(p);
      else if (st.isDirectory()) walk(p);
    }
  };
  if (existsSync(dir)) walk(dir);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flagValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function runStaleBranches(repoRoot) {
  sh("git", ["-C", repoRoot, "fetch", "origin", "master"]);
  const remoteOut = trySh("git", ["-C", repoRoot, "branch", "-r"]) ?? "";
  const remoteBranches = remoteOut
    .split("\n")
    .map((l) => l.trim().replace(/^origin\//, ""))
    .filter((b) => b && !b.startsWith("HEAD"));
  const mergedOut =
    trySh("git", ["-C", repoRoot, "branch", "-r", "--merged", "origin/master"]) ?? "";
  const merged = new Set(
    mergedOut
      .split("\n")
      .map((l) => l.trim().replace(/^origin\//, ""))
      .filter(Boolean),
  );
  const mainline = mainlineCommits(repoRoot, "origin/master");
  // Unreadable mainline: report nothing as merged rather than guess (fail closed).
  const onMainline = new Set(
    [...merged].filter(
      (b) => !mainline || mainline.has(trySh("git", ["-C", repoRoot, "rev-parse", `origin/${b}`])),
    ),
  );
  const stale = findStaleBranches(remoteBranches, merged, PROTECTED_BRANCHES, onMainline);
  console.log(`Branches merged into origin/master but still on origin (${stale.length}):`);
  for (const b of stale) console.log(`  - origin/${b}`);
  console.log("Report only — never deletes a remote branch.");
}

function main() {
  const argv = process.argv.slice(2);

  // --preflight is a free-space check only; it needs no repo context.
  if (argv.includes("--preflight")) {
    const gb = Number(flagValue(argv, "--preflight", "6"));
    const free = getFreeSpaceGb();
    console.log(`free space: ${free.toFixed(1)} GB (threshold ${gb} GB)`);
    process.exit(meetsThreshold(free, gb) ? 0 : 1);
  }
  const { repoRoot, mainCheckoutPath, worktreesRoot } = resolveRepoContext();

  if (argv.includes("--stale-branches")) {
    runStaleBranches(repoRoot);
    return;
  }

  const apply = argv.includes("--apply");
  const target = Number(flagValue(argv, "--target", String(DEFAULT_TARGET_GB)));

  const before = getFreeSpaceGb();
  console.log(`free space before: ${before.toFixed(1)} GB (target ${target} GB)`);

  const { actions, skipped } = buildPlan(repoRoot, mainCheckoutPath, worktreesRoot);

  console.log(`\nPlan (${actions.length} action(s)):`);
  for (const a of actions) console.log(`  ${describeAction(a)}`);
  if (skipped.length) {
    console.log(`\nProtected / not eligible (${skipped.length}) — never touched:`);
    for (const s of skipped)
      console.log(`  - ${s.worktree} (${s.branch ?? "detached"}): ${s.reason}`);
  }

  if (!apply) {
    console.log("\nReport-only run (pass --apply to actually reclaim). Nothing was changed.");
    return;
  }

  console.log("\nApplying...");
  for (const a of actions) {
    let free = getFreeSpaceGb();
    if (meetsThreshold(free, target)) {
      console.log(`\nTarget reached (${free.toFixed(1)} GB >= ${target} GB) — stopping early.`);
      break;
    }
    console.log(`→ ${describeAction(a)}`);
    try {
      execute(a);
    } catch (err) {
      // A fail-closed refusal (B817/B818) or an OS error skips THIS action only.
      console.log(`   REFUSED, skipped: ${a.target ?? a.kind} (${err.message})`);
    }
  }

  const after = getFreeSpaceGb();
  console.log(`\nfree space after: ${after.toFixed(1)} GB (was ${before.toFixed(1)} GB)`);
}

// Guarded: when imported from an inline script there is no argv[1] to compare against.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
