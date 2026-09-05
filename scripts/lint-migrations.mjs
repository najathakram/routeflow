#!/usr/bin/env node
// Destructive-migration lint (item 3B) — wraps squawk-cli with the two extra checks this repo
// needs on top of it: an accountable reason above every squawk-ignore, and a --base/--files/--all
// mode selector matching how CI and a local dev actually want to scope the check.
//
// WHY squawk AND NOT ATLAS: the plan named Atlas's `migrate lint`; it went Pro-only in v0.38 and
// cannot read Prisma's migrations layout at all. squawk-cli parses Prisma's SQL directly (quoted
// identifiers, `ALTER TYPE … ADD VALUE`, `ADD CONSTRAINT … FOREIGN KEY`) and is free
// (Apache-2.0 OR MIT). See `apps/api/.squawk.toml` for which of its 40 rules are actually gated
// here — most are lock-hygiene advisories Prisma triggers by design and are excluded, not
// silenced case-by-case.
//
// Modes:
//   --base <ref>        diff mode (default: origin/master). Files = every changed
//                        apps/api/prisma/migrations/**/migration.sql between <ref> and HEAD.
//   --files <paths…>     explicit file list (used by the test spec and ad-hoc local runs).
//   --all                every migration.sql in the tree — informational: prints a count,
//                         always exits 0 (pass --strict alongside it to gate on the count too).
//
// Zero files in scope is not an error — but ONLY when the range actually resolved: a successful
// `git diff` that matched nothing prints "no migrations in range" and exits 0. A `git diff` that
// FAILS (unresolvable base ref, not a repo) is a gate failure, not an empty range: the script
// prints git's stderr plus "could not resolve range <base>...HEAD" and exits 2. All paths are
// resolved against the repo root, so the caller's cwd can never silence the gate either.
//
// Reason rule (runs BEFORE invoking squawk, so a reasonless ignore never even reaches it):
// every line matching `^--\s*squawk-ignore` must be immediately preceded by a line matching
// `^--\s*reason:\s*\S` — otherwise this script prints
// `<file>:<line>: squawk-ignore without a "-- reason:" line above it` and exits 1.
//
// Exit code mirrors squawk's own contract: 0 clean, 1 on any (non-excluded) finding — except
// --all without --strict, which always exits 0 (informational only). 2 is reserved for "the
// --base range could not be computed", so a broken range can never read as a clean run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SQUAWK_CONFIG = path.resolve(REPO_ROOT, "apps/api/.squawk.toml");
const SQUAWK_BIN = path.resolve(REPO_ROOT, "node_modules/squawk-cli/js/bin/squawk");
const MIGRATIONS_DIR = "apps/api/prisma/migrations";
// Anchored to the repo root like SQUAWK_CONFIG/SQUAWK_BIN: a cwd-relative migrations path would
// make the script report "no migrations in range" (exit 0) from any other directory.
const MIGRATIONS_ABS = path.resolve(REPO_ROOT, MIGRATIONS_DIR);
const REASON_RE = /^--\s*reason:\s*\S/;
const IGNORE_RE = /^--\s*squawk-ignore/;

function parseArgs(argv) {
  const opts = { mode: "base", base: "origin/master", files: [], strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      opts.mode = "base";
      opts.base = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "origin/master";
    } else if (arg === "--files") {
      opts.mode = "files";
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts.files.push(argv[++i]);
      }
    } else if (arg === "--all") {
      opts.mode = "all";
    } else if (arg === "--strict") {
      opts.strict = true;
    }
  }
  return opts;
}

function listAllMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_ABS)) return [];
  const out = [];
  for (const entry of fs.readdirSync(MIGRATIONS_ABS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(MIGRATIONS_ABS, entry.name, "migration.sql");
    if (fs.existsSync(file)) out.push(file);
  }
  return out;
}

function listChangedMigrationFiles(base) {
  const res = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`, "--", MIGRATIONS_DIR], {
    encoding: "utf8",
    shell: false,
    cwd: REPO_ROOT,
  });
  // Fail CLOSED. Treating a failed `git diff` as "zero migrations changed" would make an
  // unresolvable base ref (shallow clone, force-pushed base, a sha the runner never fetched)
  // print "no migrations in range" and exit 0 — a green destructive-migration gate that
  // examined nothing.
  if (res.error || res.status !== 0) {
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.error) console.error(res.error.message);
    console.error(
      `lint-migrations: could not resolve range ${base}...HEAD — refusing to report a clean run`,
    );
    process.exit(2);
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("migration.sql"))
    .map((line) => path.resolve(REPO_ROOT, line))
    .filter((file) => fs.existsSync(file));
}

// Reason rule — see header. Runs on file content directly, independent of squawk.
function checkReasonedIgnores(files) {
  const errors = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!IGNORE_RE.test(line)) return;
      const prev = idx > 0 ? lines[idx - 1] : "";
      if (!REASON_RE.test(prev)) {
        errors.push(`${file}:${idx + 1}: squawk-ignore without a "-- reason:" line above it`);
      }
    });
  }
  return errors;
}

const opts = parseArgs(process.argv.slice(2));

const files =
  opts.mode === "files"
    ? opts.files
    : opts.mode === "all"
      ? listAllMigrationFiles()
      : listChangedMigrationFiles(opts.base);

if (files.length === 0) {
  console.log("no migrations in range");
  process.exit(0);
}

const reasonErrors = checkReasonedIgnores(files);
if (reasonErrors.length > 0) {
  for (const err of reasonErrors) console.error(err);
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  [SQUAWK_BIN, "--config", SQUAWK_CONFIG, "--reporter", "gcc", ...files],
  { encoding: "utf8", shell: false, cwd: REPO_ROOT },
);

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);

if (opts.mode === "all" && !opts.strict) {
  const findingLines = res.stdout ? res.stdout.split("\n").filter(Boolean).length : 0;
  console.log(
    `lint:migrations --all: ${findingLines} finding line(s) over ${files.length} migration(s) (informational)`,
  );
  process.exit(0);
}

process.exit(res.status ?? 1);
