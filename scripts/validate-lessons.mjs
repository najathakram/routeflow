#!/usr/bin/env node
// Lessons-register integrity validator — the check a merge does NOT do.
//
// WHY THIS EXISTS
// `.claude/lessons/_meta.json` carries `activeCount`, `archivedCount` and
// `nextId`. All three are counts OF the files sitting beside them, which makes
// them the one kind of number git cannot merge correctly: when two branches each
// append an entry, `LESSONS.md` merges cleanly — the entries land in different
// `##` sections, so there is no textual conflict — while BOTH sides'
// `activeCount` are individually correct and the merged total is neither.
//
// That is not hypothetical. On 2026-09-01 master held 28 entries; #588 added 2
// and wrote `activeCount: 30`; #590 added 2 and wrote `activeCount: 30`; the
// merged file had 32. Nothing conflicted in `LESSONS.md` at all — the only
// reason a human looked is that `_meta.json` happened to conflict on adjacent
// lines. Had those two writes landed a few lines apart, git would have
// auto-merged a register that miscounts itself, with no marker and no signal,
// and every later session would have derived its next id from a wrong number.
// Five id collisions or miscounts happened that day across parallel branches,
// and each was caught by someone noticing. This script replaces the noticing.
//
// WHAT IT CHECKS
// Everything is derivable from the two markdown files plus `_meta.json` — no
// network, no install, no git. Six classes fail the build:
//
//   COUNT MISMATCH  — heading count != the matching `_meta` count. The register
//                     no longer describes itself. This is the union-merge class
//                     above, and the reason this script exists.
//   DUPLICATE ID    — the same L-### twice, in either file or across both. An
//                     id in LESSONS.md *and* ARCHIVE.md means a compaction
//                     copied an entry where it should have moved it.
//   NEXTID          — `_meta.nextId` is not strictly greater than the highest
//                     id in EITHER file. Archived ids are retired, never
//                     reissued: the citation pointing at one still resolves.
//   DANGLING REF    — a `[[L-0xx]]` cross-reference naming an id that exists in
//                     neither file. This is what makes ids safely immutable —
//                     renumbering silently breaks citations, and nothing else
//                     notices.
//   CONFLICT MARKER — a merge was committed half-resolved.
//   OVER CAP        — LESSONS.md exceeds a cap. Deliberately fatal rather than
//                     advisory, because an advisory cap is precisely what
//                     failed here: status lines quoted the ENTRY count ("31 of
//                     40 — real headroom") while SIZE was the binding
//                     constraint and nobody was reading it. Every session loads
//                     this file in full, so an over-cap register is a cost paid
//                     on every future turn.
//
// Gaps in the id sequence are NOT a finding. A gap is normally an id reserved
// by an open branch that has not merged yet, and treating it as free is exactly
// the mistake this register keeps paying for. They are listed under --verbose
// so they can be seen without being actioned.
//
// ⚠️ THE CAPS ARE DATA, NOT CODE. They are read from `_meta.json`
// (`maxEntries` / `maxBytes`), so re-setting one is a field edit rather than a
// change here. That matters because the two caps as originally written are
// mutually unsatisfiable: at the observed ~0.9 KB per entry, 40 entries implies
// ~37 KB against a 25 KB ceiling, so the size cap really permits ~27 entries
// and the entry cap can never be reached. Which constraint is load-bearing —
// read-cost (size, paid on every task) or curation pressure (count) — is an
// owner decision, not one this script should bake in. It reports the
// contradiction on every run rather than silently enforcing the stricter of
// the two.
//
// USAGE
//   npm run validate-lessons
//   npm run validate-lessons -- --verbose   # also list every id and the gaps
//
// It is step 2 of `npm run verify`, so the pre-push hook gates the register on
// every push and CI re-checks it on Linux.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIR = path.join(REPO_ROOT, ".claude", "lessons");

const LESSONS = path.join(DIR, "LESSONS.md");
const ARCHIVE = path.join(DIR, "ARCHIVE.md");
const META = path.join(DIR, "_meta.json");

const verbose = process.argv.includes("--verbose");

// Fallbacks only — `_meta.json` is the source of truth when the fields exist.
// These match the caps written in the register's own header.
const DEFAULT_MAX_BYTES = 25 * 1024;
const DEFAULT_MAX_ENTRIES = 40;

const failures = [];
const fail = (msg) => failures.push(msg);
const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, "/");

// ─── Load ────────────────────────────────────────────────────────────────────
for (const f of [LESSONS, META]) {
  if (!existsSync(f)) {
    console.error(`✖ validate-lessons: required file not found: ${rel(f)}`);
    process.exit(1);
  }
}

const lessonsText = readFileSync(LESSONS, "utf8");
// An absent ARCHIVE.md just means the register has never been compacted. It is
// treated as empty — never as a reason to skip the nextId check, since the
// whole point of that check is that archived ids stay retired.
const archiveText = existsSync(ARCHIVE) ? readFileSync(ARCHIVE, "utf8") : "";

let meta;
try {
  meta = JSON.parse(readFileSync(META, "utf8"));
} catch (e) {
  console.error(`✖ validate-lessons: ${rel(META)} is not valid JSON — ${e.message}`);
  process.exit(1);
}

for (const field of ["activeCount", "nextId"]) {
  if (!Number.isInteger(meta[field])) {
    fail(`${rel(META)}: "${field}" must be an integer, got ${JSON.stringify(meta[field])}`);
  }
}

const maxBytes = Number.isInteger(meta.maxBytes) ? meta.maxBytes : DEFAULT_MAX_BYTES;
const maxEntries = Number.isInteger(meta.maxEntries) ? meta.maxEntries : DEFAULT_MAX_ENTRIES;

// ─── Parse ids ───────────────────────────────────────────────────────────────
// Matches an entry heading only — `### L-029 · 2026-09-01 · tooling`. A bare
// L-029 in prose (a [[L-029]] cross-reference, say) is deliberately not an
// entry and must never be counted as one.
const HEADING_RE = /^### (L-(\d+))\b/gm;

function idsIn(text) {
  const out = [];
  for (const m of text.matchAll(HEADING_RE)) out.push({ id: m[1], num: Number(m[2]) });
  return out;
}

const active = idsIn(lessonsText);
const archived = idsIn(archiveText);

// ─── 1. Conflict markers ─────────────────────────────────────────────────────
// `<<<<<<<` and `>>>>>>>` are unambiguous. A bare `=======` is reported only
// alongside one of those: a row of equals signs is legal markdown, and flagging
// it on its own would make this gate cry wolf on ordinary prose.
function conflictMarkers(text, label) {
  const open = [];
  const close = [];
  const mid = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^<{7}(\s|$)/.test(line)) open.push(i + 1);
    else if (/^>{7}(\s|$)/.test(line)) close.push(i + 1);
    else if (/^={7}$/.test(line)) mid.push(i + 1);
  });
  const hard = [...open, ...close];
  if (hard.length) {
    const where = [...hard, ...mid].sort((a, b) => a - b).join(", ");
    fail(`${label}: unresolved merge conflict marker(s) at line ${where}`);
  }
}
conflictMarkers(lessonsText, rel(LESSONS));
if (archiveText) conflictMarkers(archiveText, rel(ARCHIVE));

// ─── 2. Counts match _meta ───────────────────────────────────────────────────
const countChecks = [
  ["activeCount", active.length, LESSONS, meta.activeCount],
  ["archivedCount", archived.length, ARCHIVE, meta.archivedCount],
];
for (const [field, counted, file, declared] of countChecks) {
  // archivedCount is optional on older registers; only check it once present.
  if (declared === undefined) continue;
  if (!Number.isInteger(declared)) {
    fail(`${rel(META)}: "${field}" must be an integer, got ${JSON.stringify(declared)}`);
    continue;
  }
  if (counted !== declared) {
    fail(
      `COUNT MISMATCH: ${rel(file)} has ${counted} entr${counted === 1 ? "y" : "ies"} but ` +
        `${rel(META)} says ${field} ${declared}. Re-derive by counting headings in the MERGED ` +
        `file — after a union merge both sides' numbers can be individually correct and the ` +
        `total neither.`,
    );
  }
}

// ─── 3. Duplicate ids ────────────────────────────────────────────────────────
function dupes(list) {
  const seen = new Map();
  for (const { id } of list) seen.set(id, (seen.get(id) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
}

const activeDupes = dupes(active);
if (activeDupes.length) fail(`DUPLICATE ID in ${rel(LESSONS)}: ${activeDupes.join(", ")}`);

const archiveDupes = dupes(archived);
if (archiveDupes.length) fail(`DUPLICATE ID in ${rel(ARCHIVE)}: ${archiveDupes.join(", ")}`);

const activeSet = new Set(active.map((e) => e.id));
const inBoth = archived.filter((e) => activeSet.has(e.id)).map((e) => e.id);
if (inBoth.length) {
  fail(
    `DUPLICATE ID across files: ${inBoth.join(", ")} appears in ${rel(LESSONS)} AND ` +
      `${rel(ARCHIVE)} — a compaction must MOVE an entry, not copy it.`,
  );
}

// ─── 4. nextId sits above every id ever issued ───────────────────────────────
const allIds = [...active, ...archived];
const maxNum = allIds.length ? Math.max(...allIds.map((e) => e.num)) : 0;
const maxId = `L-${String(maxNum).padStart(3, "0")}`;

if (Number.isInteger(meta.nextId) && allIds.length && meta.nextId <= maxNum) {
  const where = archived.some((e) => e.num === maxNum) ? rel(ARCHIVE) : rel(LESSONS);
  fail(
    `NEXTID: ${rel(META)} says nextId ${meta.nextId}, but ${maxId} already exists in ` +
      `${where}. nextId must be at least ${maxNum + 1}. An archived id is retired, never ` +
      `reissued — the citation pointing at it still resolves.`,
  );
}

// ─── 5. Cross-references resolve ─────────────────────────────────────────────
// `[[L-012]]` must name a real entry in one of the two files. Archiving keeps a
// reference valid; renumbering does not, which is why ids are identifiers and
// never an index.
const knownIds = new Set(allIds.map((e) => e.id));
const dangling = new Map();
for (const [file, text] of [
  [LESSONS, lessonsText],
  [ARCHIVE, archiveText],
]) {
  for (const m of text.matchAll(/\[\[(L-\d+)\]\]/g)) {
    if (!knownIds.has(m[1])) {
      const key = `${m[1]} (in ${rel(file)})`;
      dangling.set(key, (dangling.get(key) || 0) + 1);
    }
  }
}
if (dangling.size) {
  fail(
    `DANGLING REF: ${[...dangling.keys()].join(", ")} — cross-reference names an id present ` +
      `in neither file. Ids are immutable identifiers, never an index: archive an entry, ` +
      `never renumber it.`,
  );
}

// ─── 6. Caps ─────────────────────────────────────────────────────────────────
const bytes = statSync(LESSONS).size;
const kb = (bytes / 1024).toFixed(1);
const capKb = (maxBytes / 1024).toFixed(1);

// Which cap binds first, expressed as entries remaining at the observed average
// so the answer is actionable rather than a percentage.
const avgBytes = active.length ? bytes / active.length : 0;
const leftBySize = avgBytes ? Math.floor((maxBytes - bytes) / avgBytes) : Infinity;
const leftByCount = maxEntries - active.length;
const binding =
  leftBySize <= leftByCount
    ? `size (~${Math.max(0, leftBySize)} more entries at ${(avgBytes / 1024).toFixed(2)} KB each)`
    : `entry count (${leftByCount} more)`;

// The caps disagree when the entry cap implies a file larger than the size cap.
// Surfaced on every run, pass or fail, because it is a standing design question
// rather than a transient state.
const impliedBytes = avgBytes ? Math.round(avgBytes * maxEntries) : 0;
const capsConflict = impliedBytes > maxBytes;

if (bytes > maxBytes) {
  fail(
    `OVER CAP: ${rel(LESSONS)} is ${kb} KB, over the ${capKb} KB cap by ` +
      `${((bytes - maxBytes) / 1024).toFixed(1)} KB (${active.length}/${maxEntries} entries). ` +
      `Compact to ${rel(ARCHIVE)}. The archive test is not "does the entry have a guard" but ` +
      `"does the guard make the entry unnecessary to read".`,
  );
}
if (active.length > maxEntries) {
  fail(
    `OVER CAP: ${rel(LESSONS)} has ${active.length} entries, over the ${maxEntries} cap ` +
      `(${kb} KB). Compact to ${rel(ARCHIVE)}.`,
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────
if (verbose) {
  console.log(`\nactive (${active.length}): ${active.map((e) => e.id).join(" ")}`);
  if (archived.length) {
    console.log(`archived (${archived.length}): ${archived.map((e) => e.id).join(" ")}`);
  }
  const nums = new Set(allIds.map((e) => e.num));
  const gaps = [];
  for (let i = 1; i < maxNum; i++) if (!nums.has(i)) gaps.push(`L-${String(i).padStart(3, "0")}`);
  console.log(
    `gaps (reserved by open branches — not errors): ${gaps.length ? gaps.join(" ") : "none"}`,
  );
}

const counts =
  `${active.length}/${maxEntries} entries · ${kb}/${capKb} KB · archived ${archived.length} · ` +
  `nextId ${meta.nextId} (max ${maxId}) · binding: ${binding}`;

if (failures.length) {
  console.error(`\n✖ ${failures.length} register problem(s):\n`);
  for (const f of failures) console.error(`   - ${f}`);
  console.error(`\n.claude/lessons: ${counts}\n`);
  process.exit(1);
}

console.log(`✔ .claude/lessons: register is self-consistent. ${counts}`);
if (capsConflict) {
  console.log(
    `  ⚠ caps disagree: ${maxEntries} entries at ${(avgBytes / 1024).toFixed(2)} KB each is ` +
      `~${(impliedBytes / 1024).toFixed(0)} KB, over the ${capKb} KB cap — so size really ` +
      `permits ~${Math.floor(maxBytes / avgBytes)} entries and the entry cap is unreachable. ` +
      `Owner decision: which constraint is load-bearing? Re-set the other in ${rel(META)}.`,
  );
}
if (!verbose) console.log("  (--verbose lists every id and the reserved gaps)");
