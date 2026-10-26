#!/usr/bin/env node
// Prints the risk class (green < amber < red < black) of a diff, from the paths it touches.
//
//   node scripts/risk-class.mjs [--base <ref>] [--files <a> <b> ...] [--json] [--max <class>]
//
// --base   diff the merge-base of <ref> and HEAD to HEAD (default <ref> = origin/master); both paths
//          of a rename or copy, and deleted files, count.
// --files  classify these paths instead of reading git.
// --max    exit 1 when the class is above <class> (offending paths and rules go to stderr).
// With git (--base or the default) the RULES come from the base ref (git show <merge-base>:
// scripts/lib/risk-paths.mjs), never the branch, so a diff cannot weaken its own judge; only when the base
// has no rules file yet (first introduction) does the working-tree copy apply. --files uses the working tree.
// Exit: 0 ok, 1 above --max, 2 bad usage or git failure. Rules: scripts/lib/risk-paths.mjs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import * as workingLib from "./lib/risk-paths.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const { CLASSES } = workingLib;
const RULES_AT = "scripts/lib/risk-paths.mjs";
const GIT_TIMEOUT_MS = 15000; // pre-push runs this: it must never hang

const USAGE =
  "usage: risk-class.mjs [--base <ref> | --files <path>...] [--json] [--max green|amber|red|black]";

/** Strict parse; returns { error } for any unknown flag or missing value. */
export function parseArgs(argv) {
  const o = { base: null, files: null, json: false, max: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--base" || a === "--max") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--base") o.base = v;
      else if (!CLASSES.includes(v)) return { error: `--max must be one of ${CLASSES.join(", ")}` };
      else o.max = v;
    } else if (a === "--files") {
      o.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) o.files.push(argv[++i]);
      if (!o.files.length) return { error: "--files needs at least one path" };
    } else return { error: `unknown argument ${a}` };
  }
  if (o.base && o.files) return { error: "--base and --files are mutually exclusive" };
  return o;
}

/** { base, files }: every path touched in <merge-base>..HEAD (add, copy, modify, delete, BOTH paths of a rename). */
export function diffSince(git, ref = "origin/master") {
  const base = git(["merge-base", ref, "HEAD"]).trim();
  const out = git(["diff", "--name-status", "-z", "--diff-filter=ACMRD", "-M", `${base}..HEAD`]);
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length;) {
    const n = /^[RC]/.test(parts[i++]) ? 2 : 1;
    for (let k = 0; k < n && i < parts.length; k++) files.push(parts[i++]);
  }
  return { base, files: [...new Set(files)] };
}

/** The classifier module as it stands at `base`, or null when the base has none (or it will not load). */
export async function loadBaseLib(git, base) {
  let dir;
  try {
    const src = git(["show", `${base}:${RULES_AT}`]);
    dir = mkdtempSync(path.join(tmpdir(), "risk-rules-"));
    const file = path.join(dir, "risk-paths.mjs");
    writeFileSync(file, src);
    return await import(pathToFileURL(file).href);
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const gitDefault = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });

export async function main(argv = process.argv.slice(2), { git = gitDefault, log = console } = {}) {
  const o = parseArgs(argv);
  if (o.error) {
    log.error(`risk-class: ${o.error}\n${USAGE}`);
    return 2;
  }
  let files = o.files;
  let lib = workingLib;
  let rulesFrom = "working tree";
  try {
    if (!files) {
      const d = diffSince(git, o.base ?? "origin/master");
      files = d.files;
      const baseLib = await loadBaseLib(git, d.base);
      if (baseLib) {
        lib = baseLib;
        rulesFrom = `base ${d.base.slice(0, 9)}`;
      } else rulesFrom = "working tree (base has no rules file)";
    }
  } catch (e) {
    log.error(`risk-class: cannot read the diff: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  const { exceeds } = lib;
  const r = lib.classifyDiff(files);
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
