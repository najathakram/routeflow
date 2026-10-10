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
// SET LOCAL rule (B896 / SA-582), also BEFORE squawk: `SET LOCAL` only lasts until the end of the
// current transaction, and a migration file is not guaranteed to run inside one, so every top-level
// `SET LOCAL` must sit inside an explicit `BEGIN;` ... `COMMIT;` (or `START TRANSACTION;` ... `END;`)
// wrap. Comments, string literals, quoted identifiers and dollar-quoted bodies are ignored (a
// function body's own SET LOCAL belongs to that statement, not to the file).
// `<file>:<line>: SET LOCAL ...` and exit 1 otherwise. Diff mode reads only the migrations in the
// range, so already-applied history (immutable) is never flagged.
//
// Exit code mirrors squawk's own contract: 0 clean, 1 on any (non-excluded) finding — except
// --all without --strict, which always exits 0 (informational only). 2 is reserved for "the
// --base range could not be computed", so a broken range can never read as a clean run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
// SA-582a: applied-on-prod migrations cannot be edited, so the SET LOCAL wrap rule (and only that
// rule) skips a file whose FOLDER NAME and migration.sql sha256 both match an entry here exactly.
// An edited applied file (sha changed) is checked normally; an entry whose folder does not exist
// yet simply matches nothing. Pinned by lint-migrations-script.spec.ts.
const EXEMPT_TABLE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "lib/set-local-exempt-migrations.json"), "utf8"),
);
function isSetLocalExempt(file) {
  const folder = path.basename(path.dirname(file));
  const entry = EXEMPT_TABLE.find((e) => e.folder === folder);
  if (!entry) return false;
  const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return sha === entry.sha256;
}
const REASON_RE = /^--\s*reason:\s*\S/;
const IGNORE_RE = /^--\s*squawk-ignore/;

function parseArgs(argv) {
  const opts = {
    mode: "base",
    base: "origin/master",
    files: [],
    strict: false,
    requireWrap: false,
  };
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
    } else if (arg === "--require-wrap") {
      opts.requireWrap = true;
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

// Blanks comments, string literals, quoted identifiers and dollar-quoted bodies to spaces (newlines
// kept), so offsets and line numbers still match the original text.
function blankNonCode(sql) {
  const out = sql.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      // An E'..' string (Postgres escape syntax) treats a backslash as an escape, so `\'` does not
      // close it; a plain '..' string and a "quoted identifier" only double their quote.
      const escapes =
        c === "'" && /[Ee]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      blank(i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (c === "$") {
      // A dollar-quote tag may carry letters, digits and underscores after the first character:
      // $$, $body$, $fn1$.
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        blank(i, stop);
        i = stop;
      } else i++;
    } else i++;
  }
  return out.join("");
}

// SET LOCAL rule — see header. Walks the top-level statements, tracking whether an explicit
// transaction is open.
// B904 / SA-582 wrap rule: every NEW migration must carry `BEGIN; SET LOCAL lock_timeout ...;
// COMMIT;`: exactly one of each, in that order, with nothing before the BEGIN or after the COMMIT
// (comments aside), because a statement outside the wrap runs unbounded. Runs only where the caller
// asks (`--require-wrap`, on by default in --base mode: the migrations in the diff range), so
// already-applied history (--all, --files) is never asked to change. An applied migration on the
// exemption table (folder + sha256) is skipped, as for the SET LOCAL rule above; an EDITED applied
// file (sha changed) is held to it.
function checkRequiredWrap(files) {
  const errors = [];
  for (const file of files) {
    if (isSetLocalExempt(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const code = blankNonCode(text);
    const lineAt = (offset) => text.slice(0, offset).split("\n").length;
    const stmts = [];
    let offset = 0;
    for (const raw of code.split(";")) {
      const stmt = raw.trim().replace(/\s+/g, " ").toUpperCase();
      const at = offset + (raw.length - raw.trimStart().length);
      offset += raw.length + 1;
      if (stmt) stmts.push({ stmt, line: lineAt(at) });
    }
    const idx = (re) => stmts.map((s, i) => (re.test(s.stmt) ? i : -1)).filter((i) => i >= 0);
    const begins = idx(/^(BEGIN|START TRANSACTION)\b/);
    const commits = idx(/^(COMMIT|END)( (WORK|TRANSACTION))?$/);
    const locks = idx(/^SET LOCAL LOCK_TIMEOUT\b/);
    const wrapHint = "BEGIN; SET LOCAL lock_timeout = '...'; ... COMMIT;";
    const problems = [];
    if (begins.length !== 1)
      problems.push(`exactly one BEGIN; is required (found ${begins.length})`);
    if (commits.length !== 1)
      problems.push(`exactly one COMMIT; is required (found ${commits.length})`);
    if (locks.length !== 1) {
      problems.push(`exactly one SET LOCAL lock_timeout is required (found ${locks.length})`);
    }
    if (begins.length === 1 && commits.length === 1) {
      if (begins[0] > 0) {
        problems.push(`a statement before BEGIN; (line ${stmts[0].line}) runs outside the wrap`);
      }
      if (commits[0] < stmts.length - 1) {
        problems.push(
          `a statement after COMMIT; (line ${stmts[commits[0] + 1].line}) runs outside the wrap`,
        );
      }
      if (locks.length === 1 && !(begins[0] < locks[0] && locks[0] < commits[0])) {
        problems.push("SET LOCAL lock_timeout must come between BEGIN; and COMMIT;");
      }
    }
    for (const problem of problems) {
      errors.push(`${file}:1: SA-582 wrap (${wrapHint}): ${problem}`);
    }
  }
  return errors;
}

function checkSetLocalWrapped(files) {
  const errors = [];
  for (const file of files) {
    if (isSetLocalExempt(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const code = blankNonCode(text);
    if (!/\bSET\s+LOCAL\b/i.test(code)) continue;
    const lineAt = (offset) => text.slice(0, offset).split("\n").length;
    let inTxn = false;
    let beginLine = 0;
    let offset = 0;
    for (const raw of code.split(";")) {
      const stmt = raw.trim().replace(/\s+/g, " ").toUpperCase();
      const at = offset + (raw.length - raw.trimStart().length);
      offset += raw.length + 1;
      if (/^(BEGIN|START TRANSACTION)\b/.test(stmt)) {
        // BEGIN [WORK | TRANSACTION] [modes], START TRANSACTION [modes].
        inTxn = true;
        beginLine = lineAt(at);
      } else if (/^(COMMIT|END|ROLLBACK)( (WORK|TRANSACTION))?$/.test(stmt)) {
        // COMMIT | END | ROLLBACK, each with an optional WORK / TRANSACTION. ROLLBACK TO SAVEPOINT
        // (and COMMIT PREPARED) do not match: they leave the transaction open.
        inTxn = false;
      } else if (/^SET LOCAL\b/.test(stmt) && !inTxn) {
        errors.push(
          `${file}:${lineAt(at)}: SET LOCAL outside an explicit BEGIN; ... COMMIT; wrap ` +
            "(it only lasts to the end of a transaction, and a migration is not guaranteed to run in one)",
        );
      }
    }
    if (inTxn) {
      errors.push(
        `${file}:${beginLine}: BEGIN; with no COMMIT; — a SET LOCAL in this file needs the closing wrap`,
      );
    }
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

// The wrap is REQUIRED on the migrations in a --base range (new or edited), or wherever asked.
const wrapErrors = opts.mode === "base" || opts.requireWrap ? checkRequiredWrap(files) : [];
if (wrapErrors.length > 0) {
  for (const err of wrapErrors) console.error(err);
  process.exit(1);
}

const setLocalErrors = checkSetLocalWrapped(files);
if (setLocalErrors.length > 0) {
  // --all without --strict is informational (already-applied history is immutable and predates this
  // rule): report, never gate.
  for (const err of setLocalErrors) console.error(err);
  if (!(opts.mode === "all" && !opts.strict)) process.exit(1);
  console.log(
    `lint:migrations --all: ${setLocalErrors.length} SET LOCAL wrap finding(s) in existing history (informational)`,
  );
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
