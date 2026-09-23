#!/usr/bin/env node
// Pre-merge ancestry guard — refuses to land a PR whose head does not
// contain master's current tip.
//
// WHY THIS EXISTS
// A second gate hole let a PR land on 2026-09-22 without master's tip in its
// history — a branch cut before a prior merge, never rebased, squash-merged
// anyway. Nothing in the pre-merge-review skill's hygiene pre-check
// (.claude/skills/pre-merge-review/SKILL.md step 1) checked ancestry, only
// authorship/scratch/secrets. This script is the missing check: it is a
// yes/no oracle a human or an automated merge step runs BEFORE merging,
// refusing (non-zero exit, both shas named) whenever the PR's head does not
// already contain `--base`'s tip.
//
// This is read-only: `git merge-base --is-ancestor` inspects local history,
// never mutates it, and this script never merges, rebases, or pushes.
//
// USAGE
//   node scripts/pre-merge-ancestry-check.mjs --base <ref-or-sha> --head <ref-or-sha>
//   --base   the branch tip the head must already contain — usually
//            "origin/master" (run `git fetch origin master` first so this is
//            current; this script does not fetch on its own, matching
//            pre-merge-review's "read-only on that worktree" rule).
//   --head   the landing PR's head ref or sha.
//
// EXIT CODES
//   0   --head contains --base's tip (safe to merge, as far as ancestry goes).
//   1   --head does NOT contain --base's tip, OR either ref could not be
//       resolved (unknown ref, detached history, shallow clone missing the
//       commit) — refuse in both cases; an unresolvable ref is exactly the
//       kind of thing that must block a merge, not wave it through.
//
// Both shas are always printed (resolved to full 40-char form when possible)
// so the refusal names concretely what did not contain what — never just
// "ancestry check failed".

import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;

export function parseArgs(argv) {
  const args = { base: null, head: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a.startsWith("--base=")) args.base = a.slice("--base=".length);
    else if (a === "--head") args.head = argv[++i];
    else if (a.startsWith("--head=")) args.head = a.slice("--head=".length);
  }
  return args;
}

function git(repoRoot, gitArgs) {
  return spawnSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: process.env,
  });
}

function resolveSha(repoRoot, ref) {
  const res = git(repoRoot, ["rev-parse", ref]);
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim();
}

/**
 * Pure decision given two already-resolved shas and the ancestry fact —
 * unit-testable without a real repo. `isAncestor` is `true`/`false`/`null`
 * (null = "could not be determined", e.g. an unresolvable ref).
 */
export function decide({ base, baseSha, head, headSha, isAncestor }) {
  if (baseSha === null) {
    return { pass: false, message: `REFUSE: could not resolve --base ${JSON.stringify(base)}` };
  }
  if (headSha === null) {
    return { pass: false, message: `REFUSE: could not resolve --head ${JSON.stringify(head)}` };
  }
  if (isAncestor === null) {
    return {
      pass: false,
      message: `REFUSE: could not determine ancestry between base ${baseSha} and head ${headSha}`,
    };
  }
  if (!isAncestor) {
    return {
      pass: false,
      message: `REFUSE: head ${headSha} does not contain base ${baseSha} — rebase or merge base into head before landing`,
    };
  }
  return { pass: true, message: `OK: head ${headSha} contains base ${baseSha}` };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.head) {
    console.error("usage: pre-merge-ancestry-check.mjs --base <ref-or-sha> --head <ref-or-sha>");
    return 1;
  }

  const repoRoot = process.cwd();
  const baseSha = resolveSha(repoRoot, args.base);
  const headSha = resolveSha(repoRoot, args.head);

  let isAncestor = null;
  if (baseSha !== null && headSha !== null) {
    const res = git(repoRoot, ["merge-base", "--is-ancestor", baseSha, headSha]);
    if (res.error) {
      isAncestor = null;
    } else if (res.status === 0) {
      isAncestor = true;
    } else if (res.status === 1) {
      isAncestor = false;
    } else {
      // Any other exit (128 = bad revision / not a repo / grafted history the
      // command cannot walk) is "could not be determined", not "not an
      // ancestor" — the two must not be conflated into the same refusal text.
      isAncestor = null;
    }
  }

  const verdict = decide({ base: args.base, baseSha, head: args.head, headSha, isAncestor });
  console.log(verdict.message);
  return verdict.pass ? 0 : 1;
}

process.exitCode = main();
