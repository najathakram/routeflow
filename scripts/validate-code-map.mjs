#!/usr/bin/env node
// GENERIC COPY shipped by the `code-map` skill (reference/validate-code-map.mjs) — copy this
// file into your project's `scripts/` and wire it into your verify/CI chain; see this skill's
// SKILL.md § "Optional per-project enforcement".
//
// Code-map size validator — keeps `.claude/code-map/INDEX.md` a pointers-only
// index and `.claude/code-map/CHANGELOG.md` bounded, instead of both growing
// without limit every time a session appends a note.
//
// WHY THIS EXISTS
// INDEX.md is meant to be read in full at the start of every session (its own
// header says so). A single bloated table row — one agent inlining a whole
// feature's prose into a "Where to find" cell instead of the owning area file
// — silently turns that per-session read from a few KB into hundreds of KB,
// and nothing else notices because markdown renders a huge cell exactly like
// a small one. CHANGELOG.md has the same failure mode in the other axis: it
// is append-only by convention, so with no cap it grows forever. This script
// is the noticing, run every `npm run verify`.
//
// WHAT IT CHECKS (fails the build, exit 1)
//   INDEX SIZE      — .claude/code-map/INDEX.md over 20,000 bytes.
//   ROW SIZE        — any pipe-table row IN INDEX.md over 200 bytes. A long
//                     row is prose that belongs in the owning area file
//                     under a `### <topic>` anchor, not in a table cell.
//                     (Area files' own local "Where to find" tables are out
//                     of scope for this check — they are not the per-session
//                     read INDEX.md is.)
//   CHANGELOG SIZE  — .claude/code-map/CHANGELOG.md over 40,000 bytes.
//   AREA SIZE       — any other .md file under .claude/code-map/** (an
//                     `<area>.md`, or a split-out `<area>/<module>.md` part)
//                     over 100,000 bytes. Every such file's byte size is
//                     printed on every run, pass or fail — see map-format.md
//                     "Splitting a large area file" for the fix (split into
//                     `<area>/<module>.md` parts, `<area>.md` becomes a
//                     <= 8,000-byte table of contents).
//   META MISSING    — .claude/code-map/_meta.json missing or not valid JSON.
//
// WHAT IT WARNS ON (does not fail, exit 0 — off master)
//   STALE SHA       — `_meta.json`'s `mappedSha` != `git rev-parse HEAD`. The
//                     map may be out of date; `git diff --name-only
//                     <mappedSha> HEAD` shows the drift. `mappedSha` (and
//                     `generatedAt`) are informational (owner ruling
//                     2026-09-14) precisely because every feature branch
//                     makes them stale the moment it commits anything else —
//                     that used to make `_meta.json` a near-guaranteed merge
//                     conflict between parallel PRs for a value nobody was
//                     acting on mid-branch. A feature branch is expected to
//                     carry a stale sha; only `master` (or CI running against
//                     the `master` ref) is expected to be current, so it is
//                     the one place this is still an ERROR, not a warning.
//
// `--stamp` sets `mappedSha` to HEAD and `generatedAt` to now — the landing
// follow-up's one job, run right after a code-map-touching PR merges to
// master, so master's own error case is satisfied without hand-editing JSON.
//
// USAGE
//   node scripts/validate-code-map.mjs
//   node scripts/validate-code-map.mjs --fix-report   # print every offending row
//   node scripts/validate-code-map.mjs --stamp        # set mappedSha=HEAD, generatedAt=now
//
// Wired into `npm run verify` the same way `scripts/validate-lessons.mjs` is —
// see root package.json.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MAP_DIR = path.join(REPO_ROOT, ".claude", "code-map");

const INDEX = path.join(MAP_DIR, "INDEX.md");
const CHANGELOG = path.join(MAP_DIR, "CHANGELOG.md");
const CHANGELOG_ARCHIVE = path.join(MAP_DIR, "CHANGELOG-ARCHIVE.md");
const META = path.join(MAP_DIR, "_meta.json");

const INDEX_MAX_BYTES = 20_000;
const CHANGELOG_MAX_BYTES = 40_000;
const CHANGELOG_MAX_ENTRIES = 30;
const ROW_MAX_BYTES = 200;
const AREA_MAX_BYTES = 100_000;

// CHANGELOG.md's entry delimiter is a top-level dated bullet
// ("- **YYYY-MM-DD** — ..."), NOT a "## " heading — the file has no "## "
// headings at all (see its own header prose above the first entry).
const CHANGELOG_ENTRY_RE = /^- \*\*\d{4}-\d{2}-\d{2}\*\*/;

function countChangelogEntries(file) {
  const text = readFileSync(file, "utf8");
  return text.split(/\r?\n/).filter((line) => CHANGELOG_ENTRY_RE.test(line)).length;
}

const fixReport = process.argv.includes("--fix-report");
const stampMode = process.argv.includes("--stamp");

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);
const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, "/");

// ─── 1. Required files exist ────────────────────────────────────────────────
for (const f of [INDEX, CHANGELOG]) {
  if (!existsSync(f)) {
    console.error(`✖ validate-code-map: required file not found: ${rel(f)}`);
    process.exit(1);
  }
}

// ─── 2. _meta.json present and valid ────────────────────────────────────────
let meta = null;
if (!existsSync(META)) {
  fail(`META MISSING: ${rel(META)} does not exist.`);
} else {
  try {
    meta = JSON.parse(readFileSync(META, "utf8"));
  } catch (e) {
    fail(`META MISSING: ${rel(META)} is not valid JSON — ${e.message}`);
  }
}

// ─── 2b. --stamp: set mappedSha = HEAD, generatedAt = now ───────────────────
// The landing follow-up's one job (owner ruling 2026-09-14): run this right
// after a code-map-touching PR merges to master, so master's mappedSha is
// current without hand-editing `_meta.json`. Updates the in-memory `meta` too
// so the freshness check below (section 6) reports fresh immediately, in the
// same process, rather than needing a second run.
if (stampMode && meta) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const generatedAt = new Date().toISOString();
    const newMeta = { ...meta, mappedSha: head, generatedAt };
    writeFileSync(META, `${JSON.stringify(newMeta, null, 2)}\n`);
    meta = newMeta;
    console.log(
      `✔ stamped ${rel(META)}: mappedSha -> ${head.slice(0, 8)}, generatedAt -> ${generatedAt}`,
    );
  } catch (e) {
    fail(`STAMP FAILED: could not resolve HEAD or write ${rel(META)} — ${e.message}`);
  }
}

// ─── 3. INDEX.md size ───────────────────────────────────────────────────────
const indexBytes = statSync(INDEX).size;
if (indexBytes > INDEX_MAX_BYTES) {
  fail(
    `INDEX SIZE: ${rel(INDEX)} is ${indexBytes} bytes, over the ${INDEX_MAX_BYTES} byte cap ` +
      `(by ${indexBytes - INDEX_MAX_BYTES}). Move prose out of table cells into the owning ` +
      `area file under a new "### <topic>" section, leaving a short pointer row behind.`,
  );
}

// ─── 4. CHANGELOG.md size + entry count ─────────────────────────────────────
const changelogBytes = statSync(CHANGELOG).size;
if (changelogBytes > CHANGELOG_MAX_BYTES) {
  fail(
    `CHANGELOG SIZE: ${rel(CHANGELOG)} is ${changelogBytes} bytes, over the ` +
      `${CHANGELOG_MAX_BYTES} byte cap (by ${changelogBytes - CHANGELOG_MAX_BYTES}). Trim to the ` +
      `newest entries and replace the rest with "Older entries: \`git log -- .claude/code-map\`".`,
  );
}

const changelogEntries = countChangelogEntries(CHANGELOG);
if (changelogEntries > CHANGELOG_MAX_ENTRIES) {
  fail(
    `CHANGELOG ENTRIES: ${rel(CHANGELOG)} has ${changelogEntries} dated entries, over the ` +
      `${CHANGELOG_MAX_ENTRIES}-entry cap (by ${changelogEntries - CHANGELOG_MAX_ENTRIES}). Trim to ` +
      `the newest ${CHANGELOG_MAX_ENTRIES} and replace the rest with ` +
      `"Older entries: \`git log -- .claude/code-map\`".`,
  );
}

// ─── 4b. Area-file size cap — every .md under MAP_DIR other than INDEX/CHANGELOG ────
// Recurses so a project that already split an area into `<area>/<module>.md`
// parts (see map-format.md "Splitting a large area file") gets every part
// checked too, not just top-level `<area>.md` files. CHANGELOG-ARCHIVE.md is
// exempt for the same reason CHANGELOG.md itself is: it is an append-only
// overflow record, not a signature-level index meant to be read in full each
// session — the newest-30/40,000-byte cap on CHANGELOG.md is what keeps the
// per-session read small; the archive exists precisely to hold what that cap
// evicts, uncapped, same as `git log` would.
function listAreaMdFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listAreaMdFiles(full));
    } else if (
      e.isFile() &&
      e.name.endsWith(".md") &&
      full !== INDEX &&
      full !== CHANGELOG &&
      full !== CHANGELOG_ARCHIVE
    ) {
      out.push(full);
    }
  }
  return out;
}

const areaFiles = listAreaMdFiles(MAP_DIR);
const areaSizes = areaFiles.map((f) => ({ file: f, bytes: statSync(f).size }));

if (areaSizes.length) {
  console.log(`\narea files (${areaSizes.length}, cap ${AREA_MAX_BYTES}B each):`);
  for (const { file, bytes } of areaSizes) {
    console.log(`  ${rel(file)}: ${bytes}B${bytes > AREA_MAX_BYTES ? " ✖ OVER CAP" : ""}`);
  }
}

for (const { file, bytes } of areaSizes) {
  if (bytes > AREA_MAX_BYTES) {
    fail(
      `AREA SIZE: ${rel(file)} is ${bytes} bytes, over the ${AREA_MAX_BYTES} byte cap ` +
        `(by ${bytes - AREA_MAX_BYTES}). Split into "${rel(file).replace(/\.md$/, "")}/<module>.md" ` +
        `parts, keeping ${path.basename(file)} itself as a <= 8,000 byte table of contents whose ` +
        `rows point at each part; INDEX.md rows should then point at the part file, not this one.`,
    );
  }
}

// ─── 5. Pipe-table row size — INDEX.md only ─────────────────────────────────
// A separator row (`| --- | --- |`, with optional `:` alignment markers) is
// not a content row and is skipped. Anything else starting and ending with
// `|` is treated as a table row, regardless of which table in INDEX.md it
// belongs to (the top "Build / test / run" table included) — the 200-byte
// cap applies to all of them. Scoped to INDEX.md deliberately: that is the
// file every session reads in full, so it is the one whose row size is a
// build-blocking concern here. An area file's own local "Where to find"
// table is a separate, pre-existing concern outside this script's mandate.
const SEPARATOR_RE = /^\|[\s|:-]+\|$/;

function scanRows(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const offenders = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return;
    if (SEPARATOR_RE.test(trimmed)) return;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > ROW_MAX_BYTES) offenders.push({ file, line: i + 1, bytes, text: line });
  });
  return offenders;
}

let rowOffenders = scanRows(INDEX);

if (rowOffenders.length) {
  const byFile = new Map();
  for (const o of rowOffenders) byFile.set(o.file, (byFile.get(o.file) || 0) + 1);
  const summary = [...byFile.entries()].map(([f, n]) => `${n} in ${rel(f)}`).join(", ");
  fail(
    `ROW SIZE: ${rowOffenders.length} table row(s) over ${ROW_MAX_BYTES} bytes — ${summary}. ` +
      `Rewrite as "| <topic> | <area>.md#<anchor> — <one clause> |" and move the rest of the ` +
      `prose into that area file. Re-run with --fix-report to print every offending row.`,
  );
}

if (fixReport && rowOffenders.length) {
  console.error(`\n${rowOffenders.length} offending row(s):\n`);
  for (const o of rowOffenders) {
    const preview = o.text.length > 160 ? `${o.text.slice(0, 160)}…` : o.text;
    console.error(`  ${rel(o.file)}:${o.line} (${o.bytes}B)\n    ${preview}\n`);
  }
}

// ─── 6. mappedSha freshness ──────────────────────────────────────────────────
// Informational on any branch except `master` itself: a stale sha is the
// expected state of a feature branch mid-flight (every commit after the last
// map update makes it stale), so failing the build over it there just forces
// busy-work re-stamps with no reader who benefits before merge. `master` (or
// CI running against the `master` ref) is the one place a stale sha is a real
// defect — nothing else will ever bring it current — so it stays an ERROR
// there. `--stamp` (2b above) is the fix in both cases.
if (meta && typeof meta.mappedSha === "string" && meta.mappedSha) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    if (head && head !== meta.mappedSha) {
      let branch = "";
      try {
        branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        }).trim();
      } catch {
        // detached HEAD or git unavailable — treat as non-master (warn only)
      }
      // `branch === "master"` covers the normal case. The CI fallback covers
      // a detached-HEAD checkout (common for shallow/tag CI checkouts, where
      // `--abbrev-ref HEAD` reports literally "HEAD") that is nonetheless
      // building the `master` ref — `GITHUB_REF_NAME`/`GITHUB_REF` name it
      // even when the branch name does not.
      const onMaster =
        branch === "master" ||
        (Boolean(process.env.CI) &&
          (process.env.GITHUB_REF_NAME === "master" ||
            process.env.GITHUB_REF === "refs/heads/master"));
      const msg =
        `STALE SHA: ${rel(META)}'s mappedSha (${meta.mappedSha.slice(0, 8)}) != HEAD ` +
        `(${head.slice(0, 8)}). Check drift with: git diff --name-only ${meta.mappedSha} HEAD. ` +
        `Fix with: node scripts/validate-code-map.mjs --stamp`;
      if (onMaster) {
        fail(`${msg} (branch is master — this is an error, not a warning: see file header § 6).`);
      } else {
        warn(msg);
      }
    }
  } catch {
    // No git available (or not a repo) — not this script's job to enforce
    // that; silently skip the freshness check rather than fail the build.
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────
const sizes =
  `INDEX ${indexBytes}/${INDEX_MAX_BYTES}B · CHANGELOG ${changelogBytes}/${CHANGELOG_MAX_BYTES}B, ` +
  `${changelogEntries}/${CHANGELOG_MAX_ENTRIES} entries · row cap ${ROW_MAX_BYTES}B`;

if (failures.length) {
  console.error(`\n✖ ${failures.length} code-map problem(s):\n`);
  for (const f of failures) console.error(`   - ${f}`);
  console.error(`\n.claude/code-map: ${sizes}\n`);
  if (!fixReport && rowOffenders.length) {
    console.error("  (--fix-report prints every offending row)");
  }
  process.exit(1);
}

console.log(`✔ .claude/code-map: sizes within cap. ${sizes}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
