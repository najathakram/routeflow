#!/usr/bin/env node
// B897 — pre-push guard against pushing build/cache output or a heavy push.
//
// WHY: #2742 pushed a commit that added 2,401 `.jest-cache/` files (~38 MB, and their source maps
// carried an absolute local path). `git add -A` on whole directories ran on a branch cut before
// `.jest-cache/` was in `.gitignore`, so nothing stopped it, and a pushed blob stays in the
// repository's history for good. This runs from `.husky/pre-push` FIRST (before SKIP_VERIFY and
// before verify), so it holds even when verify is skipped.
//
// It refuses a push that:
//   1. ADDS a file under a build/cache directory: any path segment equal to .jest-cache, .turbo,
//      dist, coverage, .next or node_modules. Judged per commit over the whole pushed range, so a
//      file added in one commit and deleted in a later one still counts (the bloat is in the pushed
//      history). Only ADDS count: touching a file already tracked under such a directory is fine.
//   2. adds more than SIZE_CAP_BYTES (5 MiB) of new blobs in total, outside the heavy-files
//      policy's allow-listed asset directories (CLAUDE.md "Heavy files policy").
//
// Range: for an update, the remote sha; for a new branch, the merge-base with origin/master. Commits
// already reachable from ANY origin/* ref are excluded (`--remotes=origin`), so a merge of master, a
// stale origin/master, or a merge of another lane's already-pushed branch never re-judges what the
// remote carries.
//
// Modes: hook (stdin = git's pre-push lines `<local ref> <local sha> <remote ref> <remote sha>`) or
// `--base <rev> --head <rev>` (tests, ad-hoc). A branch deletion, or no refs at all, is a pass.
//
// Override, loud and audited (mirrors SKIP_VERIFY): PUSH_GUARD_OVERRIDE_REASON="why" lets a push
// through and appends an audit line to <git-dir>/push-guard.log. A blank reason is not an override.
//
// Exit: 0 pass, 1 refused, 2 the range could not be resolved (fails CLOSED; the override applies).
// Edge case: with no origin/* ref carrying master (master fetched by URL / FETCH_HEAD only), a NEW
// branch has no merge-base to judge from, so it refuses loudly (exit 2) rather than passing
// unchecked; the override (PUSH_GUARD_OVERRIDE_REASON, audited with the actual cause) applies.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FORBIDDEN_SEGMENTS = [
  ".jest-cache",
  ".turbo",
  "dist",
  "coverage",
  ".next",
  "node_modules",
];
export const SIZE_CAP_BYTES = 5 * 1024 * 1024;
// CLAUDE.md "Heavy files policy": the required build-asset directories (size rule only).
export const SIZE_ALLOWLIST_PREFIXES = [
  "apps/mobile/assets/",
  "apps/web/public/brand/",
  "apps/web/public/marketing/",
  "apps/web/fonts/",
];
const ZERO = /^0+$/;

function git(args, opts = {}) {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

const fmt = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** Pure: the decision over already-collected additions `[{ path, sha, size }]`. */
export function evaluateAdditions(added) {
  const forbidden = added.filter((f) =>
    f.path.split("/").some((s) => FORBIDDEN_SEGMENTS.includes(s)),
  );
  const sized = added.filter((f) => !SIZE_ALLOWLIST_PREFIXES.some((p) => f.path.startsWith(p)));
  const bySha = new Map();
  for (const f of sized) bySha.set(f.sha, f);
  const totalBytes = [...bySha.values()].reduce((sum, f) => sum + f.size, 0);
  const problems = [];
  if (forbidden.length > 0) {
    const dirs = [
      ...new Set(
        forbidden.flatMap((f) => f.path.split("/").filter((s) => FORBIDDEN_SEGMENTS.includes(s))),
      ),
    ];
    const shown = forbidden.slice(0, 10).map((f) => `    ${f.path}`);
    if (forbidden.length > shown.length)
      shown.push(`    ... and ${forbidden.length - shown.length} more`);
    problems.push(
      `adds ${forbidden.length} file(s) under a build/cache directory (${dirs.join(", ")}):\n${shown.join("\n")}`,
    );
  }
  if (totalBytes > SIZE_CAP_BYTES) {
    const top = [...bySha.values()]
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
      .map((f) => `    ${f.path}  (${fmt(f.size)})`);
    problems.push(
      `adds ${fmt(totalBytes)} of new files (cap ${fmt(SIZE_CAP_BYTES)}; the heavy-files policy's asset dirs are not counted). Largest:\n${top.join("\n")}`,
    );
  }
  return { problems, forbidden, totalBytes };
}

/** Every file ADDED by any commit in `head` not in `base` / origin/master, with its blob size. */
function collectAdditions(base, head) {
  // Everything the remote already has is excluded: the base, and EVERY origin/* ref (not just
  // origin/master). A stale origin/master, or a merge of another lane's already-pushed branch, must
  // never make this push re-answer for commits the remote carries.
  const excludes = [base, "--remotes=origin"];
  const log = git([
    "log",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--diff-filter=A",
    "--format=",
    "-z",
    head,
    "--not",
    ...excludes,
  ]);
  if (log.status !== 0) throw new Error(log.stderr || "git log failed");
  const tokens = log.stdout.split("\0");
  const added = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i].replace(/^\n+/, "");
    if (!meta.startsWith(":")) continue;
    const fields = meta.split(/\s+/);
    added.push({ path: tokens[++i], sha: fields[3] });
  }
  const uniq = [...new Set(added.map((f) => f.sha))];
  const sizes = new Map();
  if (uniq.length > 0) {
    const batch = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
      input: uniq.join("\n") + "\n",
    });
    if (batch.status !== 0) throw new Error(batch.stderr || "git cat-file failed");
    for (const line of batch.stdout.split("\n")) {
      const [sha, size] = line.split(" ");
      if (sha && size) sizes.set(sha, Number(size));
    }
  }
  return added.map((f) => ({ ...f, size: sizes.get(f.sha) ?? 0 }));
}

function resolveBase(localSha, remoteSha) {
  if (
    remoteSha &&
    !ZERO.test(remoteSha) &&
    git(["cat-file", "-e", `${remoteSha}^{commit}`]).status === 0
  ) {
    return remoteSha;
  }
  const mb = git(["merge-base", "refs/remotes/origin/master", localSha]);
  if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  throw new Error(
    `could not resolve a base for ${localSha.slice(0, 9)} (no usable remote sha, no origin/master merge-base)`,
  );
}

function parseArgs(argv) {
  const o = { base: null, head: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") o.base = argv[++i];
    else if (argv[i] === "--head") o.head = argv[++i];
  }
  return o;
}

function refsToCheck(opts) {
  if (opts.base && opts.head) return [{ base: opts.base, head: opts.head, label: opts.head }];
  const input = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
  const out = [];
  for (const line of input.split("\n")) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // a deletion pushes no commits
    out.push({ base: null, head: localSha, remoteSha, label: localRef });
  }
  return out;
}

function audit(reason, summary) {
  const dir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const head = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const line = `${new Date().toISOString()} branch=${branch} head=${head} reason=${JSON.stringify(reason)} ${summary}\n`;
  if (dir) fs.appendFileSync(path.join(dir, "push-guard.log"), line);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const override = (process.env.PUSH_GUARD_OVERRIDE_REASON ?? "").trim();
  const problems = [];
  let failedResolve = null;
  for (const ref of refsToCheck(opts)) {
    try {
      const base = ref.base ?? resolveBase(ref.head, ref.remoteSha);
      const result = evaluateAdditions(collectAdditions(base, ref.head));
      for (const p of result.problems) problems.push(`${ref.label}: ${p}`);
    } catch (e) {
      failedResolve = e.message;
    }
  }
  const unchecked = failedResolve ? `could not check: ${failedResolve}` : null;
  if (failedResolve && problems.length === 0) {
    console.error(
      `push-guard: cannot check this push (${failedResolve}) — refusing to pass it unchecked.`,
    );
    if (!override) {
      console.error(
        'push-guard: PUSH_GUARD_OVERRIDE_REASON="why" overrides (audited to <git-dir>/push-guard.log).',
      );
      process.exit(2);
    }
  }
  if (problems.length === 0 && !failedResolve) process.exit(0);
  // An override used on a push the guard could not check must record WHY it could not (the actual
  // error), not an empty problem list.
  const detail = [...problems, unchecked].filter(Boolean).join("\n");
  if (override) {
    audit(override, `problems=${JSON.stringify(detail.split("\n").slice(0, 6))}`);
    console.error(
      `push-guard: OVERRIDE (audited to <git-dir>/push-guard.log): ${override}\n${detail}`,
    );
    process.exit(0);
  }
  console.error(
    `push-guard: refusing this push.\n${detail}\n\n` +
      "  Fix: remove the files (`git rm -r --cached <dir>`), make sure the directory is in .gitignore, and\n" +
      "  rebuild the commit so the files never enter history; do not just delete them in a later commit.\n" +
      '  Deliberate exception: PUSH_GUARD_OVERRIDE_REASON="why" git push (audited to <git-dir>/push-guard.log).',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
