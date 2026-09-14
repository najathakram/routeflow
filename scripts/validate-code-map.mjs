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
// `mappedSha` != `HEAD` alone is never an error — every feature branch makes
// that true the moment it commits anything else, and failing the build on
// mere inequality is unsatisfiable: `--stamp` sets `mappedSha` to HEAD, but
// *committing* that stamp creates a new HEAD, so the sha is stale again
// before anyone can read it. Instead this is a DRIFT rule (owner ruling
// 2026-09-14):
//
//   1. `mappedSha` must name a commit that is HEAD itself or an ancestor of
//      it (`git merge-base --is-ancestor`) — otherwise the stored sha names
//      a commit outside HEAD's history (a rebase/force-push, or a hand-typed
//      typo) and there is no meaningful drift to compute. This is an ERROR
//      on every branch.
//   2. Otherwise, compute `drift` = the files changed between
//      `mappedSha..HEAD` (`git diff --name-only`) that fall under `apps/**`,
//      `packages/**`, or `scripts/**`, and `mapTouched` = whether any file
//      under `.claude/code-map/**` changed in that same range. This list
//      deliberately omits `.github/**`, `.husky/**`, and root config files —
//      those don't describe the shipped app/package/script surface the map
//      indexes, so a workflow or lint-config-only change is never drift.
//
//   0. Before either of the above, mappedSha's commit object must actually
//      be present locally. A shallow CI checkout (`actions/checkout`
//      defaults to fetch-depth 1) or a PR build's synthetic merge-ref HEAD
//      can leave mappedSha's own commit unfetched — `git merge-base
//      --is-ancestor` can't answer "is X an ancestor" when X doesn't exist
//      as an object (it exits 128, "unknown object", not the same as exit 1
//      "X exists but isn't an ancestor"). Treating 128 as "not an ancestor"
//      was the CI bug this rule fixes (owner ruling 2026-09-14): a missing
//      object, or any merge-base exit code other than 0/1, is classified
//      UNVERIFIABLE — a WARNING, never an error, on master or off — and
//      drift is skipped entirely. Only exit code 1 stays an ERROR.
//   3. STALE = `drift` is non-empty AND `mapTouched` is false — code changed
//      that could affect the map, and nothing under the map directory
//      acknowledged it. A branch that touches the map alongside its code
//      change is never stale, regardless of how far mappedSha has fallen
//      behind.
//
// WHAT IT WARNS ON (does not fail, exit 0 — off master)
//   STALE            — see rule 3 above. `mappedSha` (and `generatedAt`) are
//                     informational off master precisely because every
//                     feature branch is expected to drift mid-flight; only
//                     `master` (or CI running against the `master` ref) is
//                     expected to be current, so STALE is still an ERROR
//                     there, using the same branch detection as before.
//
// `--stamp` sets `mappedSha` to HEAD and `generatedAt` to now — the landing
// follow-up's one job, run right after a code-map-touching PR merges to
// master, so master's own error case is satisfied without hand-editing JSON.
// It runs ONLY after every structural check above has passed (the write is
// the very last thing the script does) — a failing run exits 1 and never
// touches `_meta.json`, so `--stamp` can never paper over a real problem.
//
// USAGE
//   node scripts/validate-code-map.mjs
//   node scripts/validate-code-map.mjs --fix-report   # print every offending row
//   node scripts/validate-code-map.mjs --stamp        # set mappedSha=HEAD, generatedAt=now
//
// Wired into `npm run verify` the same way `scripts/validate-lessons.mjs` is —
// see root package.json.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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

// `--stamp`'s write moved to the very end of the script (after the Report
// section) — see "USAGE" in the file header. It must run only once every
// structural check below has passed, so it cannot happen here.

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

// ─── 6. mappedSha drift ──────────────────────────────────────────────────────
// See file header for the full rule. `mappedSha` != HEAD alone is never an
// error — only an ancestor violation (rule 1) or genuine drift with no map
// update (rule 3) is. `master` (or CI running against the `master` ref) is
// the one place drift is a real defect — nothing else will ever bring it
// current — so it stays an ERROR there; everywhere else it warns. `--stamp`
// (moved to the very end of the script) is the fix in both cases.
if (meta && typeof meta.mappedSha === "string" && meta.mappedSha) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    if (head && head !== meta.mappedSha) {
      // See file header § 6 rule 0: check object presence before asking
      // merge-base an ancestry question it cannot answer for an absent sha.
      const catFile = spawnSync("git", ["cat-file", "-e", `${meta.mappedSha}^{commit}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      const objectMissing = catFile.status !== 0;
      const ancestor = objectMissing
        ? null
        : spawnSync("git", ["merge-base", "--is-ancestor", meta.mappedSha, "HEAD"], {
            cwd: REPO_ROOT,
            encoding: "utf8",
          });
      // Only exit 1 ("X exists, but is not an ancestor") is a real ancestry
      // violation. A missing object, or any other non-zero merge-base exit
      // (e.g. 128 "unknown object"), is UNVERIFIABLE — never an error.
      if (objectMissing || ancestor.status > 1) {
        warn(
          `mappedSha ${meta.mappedSha.slice(0, 8)} not present locally (shallow clone) — ` +
            `ancestry and drift unverifiable.`,
        );
      } else if (ancestor.status === 1) {
        fail(
          `MAPPED SHA NOT ANCESTOR: ${rel(META)}'s mappedSha (${meta.mappedSha.slice(0, 8)}) is ` +
            `not HEAD and not an ancestor of HEAD (${head.slice(0, 8)}) — it may name a commit ` +
            `from a rebased/force-pushed history, or be malformed. Fix with: ` +
            `node scripts/validate-code-map.mjs --stamp (once mappedSha's commit is reachable ` +
            `from HEAD).`,
        );
      } else {
        const diffOut = execFileSync("git", ["diff", "--name-only", `${meta.mappedSha}..${head}`], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        const changed = diffOut.split(/\r?\n/).filter(Boolean);
        const drift = changed.filter((f) => /^(apps|packages|scripts)\//.test(f));
        const mapTouched = changed.some((f) => f.startsWith(".claude/code-map/"));
        const stale = drift.length > 0 && !mapTouched;
        if (stale) {
          let branch = "";
          try {
            branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
              cwd: REPO_ROOT,
              encoding: "utf8",
            }).trim();
          } catch {
            // detached HEAD or git unavailable — treat as non-master (warn only)
          }
          // `branch === "master"` covers the normal case. The CI fallback
          // covers a detached-HEAD checkout (common for shallow/tag CI
          // checkouts, where `--abbrev-ref HEAD` reports literally "HEAD")
          // that is nonetheless building the `master` ref —
          // `GITHUB_REF_NAME`/`GITHUB_REF` name it even when the branch name
          // does not.
          const onMaster =
            branch === "master" ||
            (Boolean(process.env.CI) &&
              (process.env.GITHUB_REF_NAME === "master" ||
                process.env.GITHUB_REF === "refs/heads/master"));
          const msg =
            `STALE: ${rel(META)}'s mappedSha (${meta.mappedSha.slice(0, 8)}) is behind HEAD ` +
            `(${head.slice(0, 8)}) by ${drift.length} changed file(s) under apps/**, ` +
            `packages/**, scripts/** with no corresponding .claude/code-map/** update. Check ` +
            `with: git diff --name-only ${meta.mappedSha} HEAD. Fix with: ` +
            `node scripts/validate-code-map.mjs --stamp (after updating the map).`;
          if (onMaster) {
            fail(
              `${msg} (branch is master — this is an error, not a warning: see file header § 6).`,
            );
          } else {
            warn(msg);
          }
        }
      }
    }
  } catch {
    // No git available (or not a repo) — not this script's job to enforce
    // that; silently skip the drift check rather than fail the build.
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
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  process.exit(1);
}

// ─── --stamp: write only after every structural check above has passed ─────
if (stampMode) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const generatedAt = new Date().toISOString();
    const newMeta = { ...meta, mappedSha: head, generatedAt };
    writeFileSync(META, `${JSON.stringify(newMeta, null, 2)}\n`);
    console.log(
      `✔ stamped ${rel(META)}: mappedSha -> ${head.slice(0, 8)}, generatedAt -> ${generatedAt}`,
    );
  } catch (e) {
    console.error(`✖ STAMP FAILED: could not resolve HEAD or write ${rel(META)} — ${e.message}`);
    process.exit(1);
  }
}

console.log(`✔ .claude/code-map: sizes within cap. ${sizes}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
