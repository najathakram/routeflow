#!/usr/bin/env node
// Prints the risk class (green < amber < red < black) of a diff, from the paths it touches.
//
//   node scripts/risk-class.mjs [--repo <dir>] [--base <ref>] [--files <a> <b> ...] [--json] [--max <class>]
//
// --repo   the repository to diff (default: the current directory). Every git call is `git -C <repo>`.
// --base   diff the merge-base of <ref> and HEAD to HEAD (default <ref> = origin/master); both paths
//          of a rename or copy, deleted files and type changes count.
// --files  classify these paths instead of reading git.
// --max    exit 1 when the class is above <class> (offending paths and rules go to stderr).
//
// Trust: the judge must not run code the diff can edit. The gate therefore runs THIS file from its own
// (lead's) checkout and points --repo at the builder worktree; nothing is imported from the target repo.
// With git, the RULES also come from the base ref, never the branch: scripts/lib/risk-paths.mjs at BOTH the
// merge-base and the tip of --base, each file taking the higher class (a branch forked before a tightening
// is still held to it), so a diff cannot weaken the rules either. Only when the base has no rules file at all (first introduction)
// do this checkout's own rules apply; any git, tmpdir or import failure exits 2 instead. --files uses this
// checkout's rules.
// Exit: 0 ok, 1 above --max, 2 bad usage or failure. Rules: scripts/lib/risk-paths.mjs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import * as ownLib from "./lib/risk-paths.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const { CLASSES } = ownLib;
const RULES_AT = "scripts/lib/risk-paths.mjs";
const GIT_TIMEOUT_MS = 15000; // pre-push runs this: it must never hang

const USAGE =
  "usage: risk-class.mjs [--repo <dir>] [--base <ref> | --files <path>...] [--json] [--max green|amber|red|black]";

/** Strict parse; returns { error } for any unknown flag or missing value. */
export function parseArgs(argv) {
  const o = { repo: null, base: null, files: null, json: false, max: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--base" || a === "--max" || a === "--repo") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--base") o.base = v;
      else if (a === "--repo") o.repo = v;
      else if (!CLASSES.includes(v)) return { error: `--max must be one of ${CLASSES.join(", ")}` };
      else o.max = v;
    } else if (a === "--files") {
      o.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) o.files.push(argv[++i]);
      if (!o.files.length) return { error: "--files needs at least one path" };
    } else return { error: `unknown argument ${a}` };
  }
  if (o.base && o.files) return { error: "--base and --files are mutually exclusive" };
  if (o.repo && o.files) return { error: "--repo and --files are mutually exclusive" };
  return o;
}

/** { base, files }: every path touched in <merge-base>..HEAD (add, copy, modify, delete, type change, BOTH paths of a rename). */
export function diffSince(git, ref = "origin/master") {
  const base = git(["merge-base", ref, "HEAD"]).trim();
  const out = git(["diff", "--name-status", "-z", "--diff-filter=ACMRDT", "-M", `${base}..HEAD`]);
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length;) {
    const n = /^[RC]/.test(parts[i++]) ? 2 : 1;
    for (let k = 0; k < n && i < parts.length; k++) files.push(parts[i++]);
  }
  return { base, files: [...new Set(files)] };
}

/**
 * The classifier module as it stands at `base`, or null ONLY when the base has no rules file. A git
 * failure, a tmpdir failure or a base file that will not import throws (the caller exits 2).
 */
export async function loadBaseLib(git, base) {
  if (!git(["ls-tree", "--name-only", base, "--", RULES_AT]).trim()) return null;
  const src = git(["show", `${base}:${RULES_AT}`]);
  const dir = mkdtempSync(path.join(tmpdir(), "risk-rules-"));
  try {
    const file = path.join(dir, "risk-paths.mjs");
    writeFileSync(file, src);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** classifyDiff over several rule sets: each file takes the highest class any set gives it. */
export function classifyMax(libs, files) {
  const results = libs.map((l) => l.classifyDiff(files));
  const merged = results[0].files.map((f, i) =>
    results.reduce((best, r) => (ownLib.exceeds(r.files[i].cls, best.cls) ? r.files[i] : best), f),
  );
  const cls = merged.reduce((m, f) => (ownLib.exceeds(f.cls, m) ? f.cls : m), "green");
  return { cls, files: merged };
}

const gitIn = (repo) => (args) =>
  execFileSync("git", repo ? ["-C", repo, ...args] : args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });

export async function main(argv = process.argv.slice(2), { git, log = console } = {}) {
  const o = parseArgs(argv);
  if (o.error) {
    log.error(`risk-class: ${o.error}\n${USAGE}`);
    return 2;
  }
  git ??= gitIn(o.repo ? path.resolve(o.repo) : null);
  let files = o.files;
  let libs = [ownLib];
  let rulesFrom = "judge checkout";
  try {
    if (!files) {
      const ref = o.base ?? "origin/master";
      const d = diffSince(git, ref);
      files = d.files;
      // A branch forked before a rules tightening keeps the old rules at its merge-base, so judge with
      // the rules at BOTH the merge-base and the base ref's tip; each file takes the higher class.
      const baseLibs = [await loadBaseLib(git, d.base), await loadBaseLib(git, ref)].filter(
        Boolean,
      );
      if (baseLibs.length) {
        libs = baseLibs;
        rulesFrom = `base ${d.base.slice(0, 9)} + tip of ${ref}`;
      } else rulesFrom = "judge checkout (base has no rules file)";
    }
  } catch (e) {
    log.error(`risk-class: cannot judge the diff: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  const { exceeds } = ownLib;
  const r = classifyMax(libs, files);
  const over = o.max && exceeds(r.cls, o.max);
  if (o.json)
    log.log(
      JSON.stringify({ ...r, rules: rulesFrom, ...(o.max ? { max: o.max, ok: !over } : {}) }),
    );
  else {
    log.log(`risk class: ${r.cls} (${r.files.length} file(s); rules from ${rulesFrom})`);
    for (const f of r.files.filter((x) => x.cls !== "green"))
      log.log(`  ${f.cls.padEnd(5)} ${f.path}  [${f.rule ?? "default"}]`);
  }
  if (over) {
    log.error(`risk-class: ${r.cls} exceeds --max ${o.max}; offending paths:`);
    for (const f of r.files.filter((x) => exceeds(x.cls, o.max)))
      log.error(`  ${f.cls} ${f.path}  [${f.rule}]`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
