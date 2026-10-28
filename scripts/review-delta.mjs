#!/usr/bin/env node
// Says whether a review verdict given at <verdict-sha> still holds at <head-sha>, so a no-op head move
// (reworded commit, update-branch, clean rebase) does not need a fresh agent read.
//
//   node scripts/review-delta.mjs <verdict-sha> <head-sha> [--repo <dir>] [--base <ref>] [--json]
//
// Carries (`same-delta`, --base default origin/master) only when the PR touches files (F = the files each
// sha changed against ITS OWN merge-base with --base), the base did not move under any file in F, and
// the two shas agree on every file in F: then both PR deltas are byte-identical. File names only, from
// plumbing: no patch-id (it ignores hunk positions), no config (color, textconv, external diff).
// Otherwise `changed`, listing the files the re-read must cover, with a hint: `base-moved` (the base
// changed under a PR file), `whitespace-only` (indentation and literals still change meaning), `empty`.
// Exit 0 carries, 1 changed, 2 unknown sha or bad usage. Read-only: nothing from the diff is ever run.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const GIT_TIMEOUT_MS = 30000;
const USAGE =
  "usage: review-delta.mjs <verdict-sha> <head-sha> [--repo <dir>] [--base <ref>] [--json]";

export function parseArgs(argv) {
  const o = { shas: [], repo: null, base: "origin/master", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--repo" || a === "--base") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) return { error: `${a} needs a value` };
      o[a.slice(2)] = v;
    } else if (a.startsWith("--")) return { error: `unknown argument ${a}` };
    else o.shas.push(a);
  }
  if (o.shas.length !== 2) return { error: "needs <verdict-sha> and <head-sha>" };
  return o;
}

const gitIn = (repo) => (args, input) =>
  execFileSync("git", ["-c", "core.hooksPath=", ...(repo ? ["-C", repo] : []), ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: scrubbedGitEnv(),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
    timeout: GIT_TIMEOUT_MS,
  });

const mergeBase = (git, base, sha) => git(["merge-base", base, sha]).trim();
const names = (git, x, y) =>
  git(["diff-tree", "-r", "--no-renames", "--name-only", "-z", x, y]).split("\0").filter(Boolean);

export function main(argv = process.argv.slice(2), { git, log = console } = {}) {
  const o = parseArgs(argv);
  if (o.error) {
    log.error(`review-delta: ${o.error}\n${USAGE}`);
    return 2;
  }
  git ??= gitIn(o.repo ? path.resolve(o.repo) : null);
  const emit = (carries, kind, files = []) => {
    if (o.json) log.log(JSON.stringify({ carries, kind, files }));
    else if (carries) log.log(`review-delta: carries: ${kind}`);
    else {
      const hint = kind === "changed" ? "" : ` (${kind})`;
      log.log(`review-delta: changed${hint}; re-read ${files.length} file(s): ${files.join(", ")}`);
    }
    return carries ? 0 : 1;
  };
  try {
    const [a, b] = o.shas.map((s) => {
      try {
        return git(["rev-parse", "--verify", "--quiet", `${s}^{commit}`]).trim();
      } catch {
        throw new Error(`unknown commit ${s}`);
      }
    });
    const [mbA, mbB] = [mergeBase(git, o.base, a), mergeBase(git, o.base, b)];
    const touched = new Set([...names(git, mbA, a), ...names(git, mbB, b)]);
    const headMoved = names(git, a, b);
    const baseMoved = names(git, mbA, mbB).filter((f) => touched.has(f));
    if (touched.size && !baseMoved.length && !headMoved.some((f) => touched.has(f)))
      return emit(true, "same-delta");
    const files = [...new Set([...headMoved, ...baseMoved])].sort();
    if (!touched.size) return emit(false, "empty", files);
    if (baseMoved.length) return emit(false, "base-moved", files);
    const blind = !git(["diff-tree", "-p", "-w", "--ignore-blank-lines", a, b]).trim();
    return emit(false, blind ? "whitespace-only" : "changed", files);
  } catch (e) {
    log.error(`review-delta: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
