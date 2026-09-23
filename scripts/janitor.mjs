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
// only, (5) npm cache, (6) proof/audit folders older than 7 days.
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
// reports its PR MERGED with the PR head equal to the local tip (this also
// covers squash merges). A fast-forwarded branch is indistinguishable from a
// fresh one and is left alone — a safe false negative.
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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROTECTED_WORKTREE_NAMES = new Set(["rf-migrate", "rf-crm-cloud"]);
export const PROTECTED_BRANCHES = new Set(["master", "main"]);
export const STALE_PROOF_AGE_DAYS = 7;
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
 * evidence: { tipIsAncestor, tipOnMainline, prMergedAtTip }
 */
export function isMergedEvidence({ tipIsAncestor, tipOnMainline, prMergedAtTip }) {
  if (prMergedAtTip) return true;
  return !!tipIsAncestor && !tipOnMainline;
}

/** Recently active = HEAD moved within `hours`. Unknown activity counts as recent (safe side). */
export function isRecentlyActive(lastActivityMs, nowMs, hours = RECENT_ACTIVITY_HOURS) {
  if (lastActivityMs == null || !Number.isFinite(lastActivityMs)) return true;
  return nowMs - lastActivityMs < hours * 60 * 60 * 1000;
}

/**
 * Decide what (if anything) this tool may do to a worktree.
 * info: { name, branch, isMainCheckout, isMerged, isDirty, isRecent, hasUnpushed }
 * Returns { nodeModules: "clear"|"skip", worktree: "remove"|"skip", reason }
 */
export function classifyWorktree(info) {
  const { name, branch, isMainCheckout, isMerged, isDirty, isRecent, hasUnpushed } = info;
  if (isMainCheckout) return { nodeModules: "skip", worktree: "skip", reason: "main checkout" };
  if (isProtectedWorktreeName(name)) {
    return { nodeModules: "skip", worktree: "skip", reason: "protected worktree" };
  }
  if (isProtectedBranch(branch)) {
    return { nodeModules: "skip", worktree: "skip", reason: "protected branch" };
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
function findJunctions(dir) {
  if (!isWindows() || !existsSync(dir)) return [];
  const out = trySh("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-ChildItem -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType } | Select-Object -ExpandProperty FullName`,
  ]);
  return out
    ? out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Safely remove a directory tree that may contain junctions: unlink every
 * junction first with a bare `rmdir` (never `/s`, which is the one thing
 * that can follow a reparse point into its target — see file header), THEN
 * recursively remove what's left with `cmd /c rmdir /s /q`. Never uses
 * PowerShell's Remove-Item -Recurse or Node's fs.rmSync recursive mode.
 */
function safeRemoveTree(dir) {
  for (const junction of findJunctions(dir)) {
    trySh("cmd", ["/c", "rmdir", junction]);
  }
  if (existsSync(dir)) {
    execFileSync("cmd", ["/c", "rmdir", "/s", "/q", dir]);
  }
}

function listWorktrees(repoRoot) {
  const out = sh("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const entries = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

const mainlineCache = new Map();
/** Every commit on `masterRef`'s first-parent chain (cached per repo + resolved master sha). */
export function mainlineCommits(repoRoot, masterRef = "origin/master") {
  // Keyed on the RESOLVED master sha, not the ref name, so a moved master never reads a stale set.
  const head = trySh("git", ["-C", repoRoot, "rev-parse", masterRef]) ?? masterRef;
  const key = `${repoRoot}\0${head}`;
  if (!mainlineCache.has(key)) {
    const out = trySh("git", ["-C", repoRoot, "rev-list", "--first-parent", masterRef]) ?? "";
    mainlineCache.set(key, new Set(out.split("\n").filter(Boolean)));
  }
  return mainlineCache.get(key);
}

/** B800: GitHub says this branch's PR MERGED, at exactly this local tip. Any failure: false. */
function ghPrMergedAtTip(repoRoot, branch, tip) {
  const out = trySh(
    "gh",
    ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--limit", "5"],
    { cwd: repoRoot },
  );
  if (!out) return false;
  try {
    return JSON.parse(out).some((p) => p.headRefOid === tip);
  } catch {
    return false;
  }
}

/** The evidence isMergedEvidence() judges. `ghLookup` is injectable so the self-test is hermetic. */
export function mergeEvidence(
  repoRoot,
  branch,
  { masterRef = "origin/master", ghLookup = ghPrMergedAtTip } = {},
) {
  const none = { tipIsAncestor: false, tipOnMainline: false, prMergedAtTip: false };
  if (!branch) return none; // detached HEAD — cannot prove merged
  const tip = trySh("git", ["-C", repoRoot, "rev-parse", branch]);
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
  return {
    tipIsAncestor,
    tipOnMainline: mainlineCommits(repoRoot, masterRef).has(tip),
    prMergedAtTip: !!ghLookup(repoRoot, branch, tip),
  };
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

function isDirty(worktreePath) {
  const out = trySh("git", ["-C", worktreePath, "status", "--porcelain"]);
  return !!(out && out.length > 0);
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

function buildPlan(repoRoot, mainCheckoutPath, worktreesRoot) {
  const worktrees = listWorktrees(repoRoot);
  const actions = [];
  const skipped = [];
  const nowMs = Date.now();

  for (const wt of worktrees) {
    const name = wt.path.split(/[\\/]/).pop();
    const isMainCheckout = resolve(wt.path) === resolve(mainCheckoutPath);
    const isMerged = isMainCheckout ? true : isMergedIntoMaster(repoRoot, wt.branch);
    const info = {
      name,
      branch: wt.branch,
      isMainCheckout,
      isMerged,
      isDirty: isMainCheckout ? false : isDirty(wt.path),
      isRecent: isMainCheckout ? false : isRecentlyActive(lastActivityMs(wt.path), nowMs),
      hasUnpushed: isMainCheckout ? false : hasUnpushedCommits(wt.path, wt.branch),
    };
    const verdict = classifyWorktree(info);
    if (verdict.nodeModules === "clear") {
      for (const nm of findNodeModulesDirs(wt.path)) {
        actions.push({ step: 1, kind: "node_modules", target: nm, worktree: name });
      }
    }
    if (verdict.worktree === "remove") {
      actions.push({ step: 2, kind: "worktree", target: wt.path, worktree: name });
    }
    if (verdict.nodeModules === "skip" || verdict.worktree === "skip") {
      skipped.push({ worktree: name, branch: wt.branch, reason: verdict.reason });
    }
  }

  if (existsSync(worktreesRoot)) {
    const listedPaths = worktrees.map((w) => w.path);
    const dirNames = readdirSync(worktreesRoot);
    for (const orphan of findOrphanWorktreeDirs(listedPaths, dirNames, worktreesRoot)) {
      actions.push({ step: 3, kind: "orphan-dir", target: join(worktreesRoot, orphan) });
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

  return { actions, skipped };
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
    default:
      return `[?] ${a.kind}`;
  }
}

function execute(a) {
  switch (a.kind) {
    case "node_modules":
    case "orphan-dir":
    case "stale-proof-dir":
      safeRemoveTree(a.target);
      return;
    case "worktree": {
      const repoRoot = trySh("git", ["rev-parse", "--show-toplevel"]) ?? process.cwd();
      trySh("git", ["-C", repoRoot, "worktree", "remove", "--force", a.target]);
      if (existsSync(a.target)) safeRemoveTree(a.target); // Windows file-lock leftover
      trySh("git", ["-C", repoRoot, "worktree", "prune"]);
      return;
    }
    case "docker-build-cache":
      trySh("docker", ["builder", "prune", "-a", "-f"]);
      return;
    case "npm-cache":
      trySh("npm", ["cache", "clean", "--force"]);
      return;
  }
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
  const onMainline = new Set(
    [...merged].filter((b) =>
      mainline.has(trySh("git", ["-C", repoRoot, "rev-parse", `origin/${b}`])),
    ),
  );
  const stale = findStaleBranches(remoteBranches, merged, PROTECTED_BRANCHES, onMainline);
  console.log(`Branches merged into origin/master but still on origin (${stale.length}):`);
  for (const b of stale) console.log(`  - origin/${b}`);
  console.log("Report only — never deletes a remote branch.");
}

function main() {
  const argv = process.argv.slice(2);
  const repoRoot = trySh("git", ["rev-parse", "--show-toplevel"]) ?? process.cwd();

  if (argv.includes("--preflight")) {
    const gb = Number(flagValue(argv, "--preflight", "6"));
    const free = getFreeSpaceGb();
    console.log(`free space: ${free.toFixed(1)} GB (threshold ${gb} GB)`);
    process.exit(meetsThreshold(free, gb) ? 0 : 1);
  }

  if (argv.includes("--stale-branches")) {
    runStaleBranches(repoRoot);
    return;
  }

  const apply = argv.includes("--apply");
  const target = Number(flagValue(argv, "--target", String(DEFAULT_TARGET_GB)));
  const worktreesRoot = join(repoRoot, ".claude", "worktrees");

  const before = getFreeSpaceGb();
  console.log(`free space before: ${before.toFixed(1)} GB (target ${target} GB)`);

  const { actions, skipped } = buildPlan(repoRoot, repoRoot, worktreesRoot);

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
    execute(a);
  }

  const after = getFreeSpaceGb();
  console.log(`\nfree space after: ${after.toFixed(1)} GB (was ${before.toFixed(1)} GB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
