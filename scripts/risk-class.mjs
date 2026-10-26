#!/usr/bin/env node
// Prints the risk class (green < amber < red < black) of a diff, from the paths it touches.
//
//   node scripts/risk-class.mjs [--base <ref>] [--files <a> <b> ...] [--json] [--max <class>]
//
// --base   diff the merge-base of <ref> and HEAD to HEAD (default <ref> = origin/master); both paths
//          of a rename or copy, and deleted files, count.
// --files  classify these paths instead of reading git.
// --max    exit 1 when the class is above <class> (offending paths and rules go to stderr).
// Exit: 0 ok, 1 above --max, 2 bad usage or git failure. Rules: scripts/lib/risk-paths.mjs.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CLASSES, classifyDiff, exceeds } from "./lib/risk-paths.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

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

/** Every path touched in <merge-base>..HEAD: add, copy, modify, delete, and BOTH paths of a rename. */
export function touchedFiles(git, ref = "origin/master") {
  const base = git(["merge-base", ref, "HEAD"]).trim();
  const out = git(["diff", "--name-status", "-z", "--diff-filter=ACMRD", "-M", `${base}..HEAD`]);
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length;) {
    const n = /^[RC]/.test(parts[i++]) ? 2 : 1;
    for (let k = 0; k < n && i < parts.length; k++) files.push(parts[i++]);
  }
  return [...new Set(files)];
}

const gitDefault = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

export function main(argv = process.argv.slice(2), { git = gitDefault, log = console } = {}) {
  const o = parseArgs(argv);
  if (o.error) {
    log.error(`risk-class: ${o.error}\n${USAGE}`);
    return 2;
  }
  let files;
  try {
    files = o.files ?? touchedFiles(git, o.base ?? "origin/master");
  } catch (e) {
    log.error(`risk-class: cannot read the diff: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  const r = classifyDiff(files);
  const over = o.max && exceeds(r.cls, o.max);
  if (o.json) log.log(JSON.stringify({ ...r, ...(o.max ? { max: o.max, ok: !over } : {}) }));
  else {
    log.log(`risk class: ${r.cls} (${r.files.length} file(s))`);
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
  process.exitCode = main();
}
