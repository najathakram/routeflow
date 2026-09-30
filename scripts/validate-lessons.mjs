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
// network, no install, no git. Four classes fail the build:
//
//   DUPLICATE ID    — the same L-### twice, in either file or across both. An
//                     id in LESSONS.md *and* ARCHIVE.md means a compaction
//                     copied an entry where it should have moved it.
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
// `activeCount`/`archivedCount`/`nextId` are DERIVED from the two files, not
// checked against `_meta.json` as ground truth (owner ruling 2026-09-14): a
// stale stored value only WARNS (never fails the build), and `--digest` mode
// re-stamps it. This is what stops two PRs — each individually correct about
// its own counter — from conflicting on `_meta.json` when merged; see the
// derived-counters section below for the full rationale.
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
//   node scripts/validate-lessons.mjs --digest   # (re)generate LESSONS-DIGEST.md
//
// It is step 2 of `npm run verify`, so the pre-push hook gates the register on
// every push and CI re-checks it on Linux. A PLAIN run (no --digest) also checks
// that `.claude/lessons/LESSONS-DIGEST.md` is up to date with LESSONS.md — the
// digest is a derived artifact, and a stale one is exactly the kind of drift
// this file already exists to catch (see the `activeCount` story above).

import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// LESSONS_ROOT overrides the register directory — used by
// validate-lessons.digest.self-test.mjs (F3) so the self-test can point this
// script at a disposable copy of `.claude/lessons/` instead of mutating the
// real register on SIGINT or a concurrent `npm run verify`. Guarded like
// SCHEMA_DRIFT_PRISMA_CLI (apps/api/scripts/schema-drift.mjs): an exported
// LESSONS_ROOT alone would silently redirect both validation AND the
// --digest write away from the real register, so it is honoured ONLY when a
// second marker, LESSONS_SELF_TEST=1, is also set (the self-test sets both),
// with a loud WARNING whenever it is active; anywhere else it is ignored.
const selfTestArmed = process.env.LESSONS_SELF_TEST === "1" && Boolean(process.env.LESSONS_ROOT);
if (selfTestArmed) {
  console.error(
    `validate-lessons: WARNING — LESSONS_ROOT override in effect (${process.env.LESSONS_ROOT}); ` +
      `this is NOT the real register`,
  );
} else if (process.env.LESSONS_ROOT) {
  console.error(
    "validate-lessons: LESSONS_ROOT is ignored outside self-test (LESSONS_SELF_TEST=1 unset); " +
      "using the real .claude/lessons register",
  );
}
const DIR = selfTestArmed
  ? path.resolve(process.env.LESSONS_ROOT)
  : path.join(REPO_ROOT, ".claude", "lessons");

const LESSONS = path.join(DIR, "LESSONS.md");
const ARCHIVE = path.join(DIR, "ARCHIVE.md");
const META = path.join(DIR, "_meta.json");
const DIGEST = path.join(DIR, "LESSONS-DIGEST.md");

const verbose = process.argv.includes("--verbose");
const digestMode = process.argv.includes("--digest");

// Fallbacks only — `_meta.json` is the source of truth when the fields exist.
// These match the caps written in the register's own header.
const DEFAULT_MAX_BYTES = 25 * 1024;
const DEFAULT_MAX_ENTRIES = 40;

const failures = [];
const fail = (msg) => failures.push(msg);
const warnings = [];
const warn = (msg) => warnings.push(msg);
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

// activeCount / archivedCount / nextId are DERIVED from the two markdown files
// (see "Counters" below) — a present-but-wrong-TYPE value is still a real data
// error (something wrote non-JSON-number garbage), so that alone still fails;
// a present-but-STALE value no longer does.
for (const field of ["activeCount", "archivedCount", "nextId"]) {
  if (field in meta && !Number.isInteger(meta[field])) {
    fail(`${rel(META)}: "${field}" must be an integer, got ${JSON.stringify(meta[field])}`);
  }
}

const maxBytes = Number.isInteger(meta.maxBytes) ? meta.maxBytes : DEFAULT_MAX_BYTES;
const maxEntries = Number.isInteger(meta.maxEntries) ? meta.maxEntries : DEFAULT_MAX_ENTRIES;

// ─── Parse entries ───────────────────────────────────────────────────────────
// Matches an entry heading only — `### L-029 · 2026-09-01 · tooling`. A bare
// L-029 in prose (a [[L-029]] cross-reference, say) is deliberately not an
// entry and must never be counted as one.
//
// The SAME parse feeds both the structural checks below (id/num only) and the
// digest (category + the "- **Lesson:** ..." body) — one parser, two
// consumers, so a heading-format change can never make the digest and the
// register disagree about what an entry is.
const HEADING_RE = /^### (L-(\d+))[^\n]*$/gm;

function parseEntries(text) {
  const headings = [...text.matchAll(HEADING_RE)];
  return headings.map((m, i) => {
    const id = m[1];
    const num = Number(m[2]);
    // Fields on the heading line, e.g. "L-029 · 2026-09-01 · tooling · #598"
    // -> ["L-029", "2026-09-01", "tooling", "#598"]. category is always the
    // 3rd field; anything after it is a free-text descriptor we don't need.
    const fields = m[0]
      .replace(/^###\s*/, "")
      .split("·")
      .map((s) => s.trim());
    const category = fields[2] || "";

    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    const lessonMatch = body.match(/-\s*\*\*Lesson:\*\*\s*([\s\S]*?)(?=\n-\s*\*\*Guard:\*\*|$)/);
    const lessonRaw = lessonMatch ? lessonMatch[1].trim() : null;

    return { id, num, category, lessonRaw };
  });
}

const active = parseEntries(lessonsText);
const archived = parseEntries(archiveText);

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

// ─── 2. Duplicate ids ────────────────────────────────────────────────────────
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

// ─── 3. Counters (activeCount / archivedCount / nextId) — DERIVED ────────────
// All three are 100% computable from the headings in LESSONS.md/ARCHIVE.md —
// which is exactly why a stored copy is the one kind of value a git union-merge
// cannot reconcile (see the file header: two branches each add entries, the
// markdown merges clean, and BOTH sides' counters are individually correct
// while the merged total is neither). Owner ruling 2026-09-14: stop treating
// the stored value as authoritative.
//
// `_meta.json` still CARRIES these fields — `dev-pipeline/scripts/closeout.mjs`
// reads `nextId`/`activeCount` to place the next lesson stub and check cap
// headroom — so the keys are not removed. What changes is who is trusted:
//   - `--digest` mode OVERWRITES all three with the derived value (the same
//     run that already regenerates LESSONS-DIGEST.md now also re-stamps the
//     counters, so one command repairs both derived artifacts at once).
//   - A plain run only WARNS on a stale value — it never fails the build over
//     a counter, which is the actual fix for the union-merge conflict: two PRs
//     landing individually-correct-but-different counters no longer red the
//     build, because neither counter is checked as a source of truth anymore.
const allIds = [...active, ...archived];
const maxNum = allIds.length ? Math.max(...allIds.map((e) => e.num)) : 0;
const maxId = `L-${String(maxNum).padStart(3, "0")}`;
const minNextId = maxNum + 1;

// nextId is NOT derived the same way as the other two counters (F4, owner
// ruling 2026-09-14 follow-up): the register reserves ids by storing a
// nextId HIGHER than maxId + 1 — an open branch already claimed those ids
// and hasn't merged yet — and `dev-pipeline/scripts/closeout.mjs` reads
// that stored value to place the next stub. Collapsing nextId to a plain
// `maxId + 1` derivation would silently un-reserve those ids and hand them
// straight back out. So: `derivedNextId = max(maxId + 1, stored nextId)`.
// A stored value BELOW maxId + 1 is the one direction that stays a hard
// FAILURE, not a warning — a hand-lowered nextId guarantees a future
// duplicate id, which is exactly the failure mode this register exists to
// prevent (see the file header). A stored value ABOVE maxId + 1 only WARNS,
// since it's the expected shape of a live reservation.
const declaredNextId = meta.nextId;
const hasValidDeclaredNextId = Number.isInteger(declaredNextId);
if (hasValidDeclaredNextId && declaredNextId < minNextId) {
  fail(
    `NEXTID TOO LOW: ${rel(META)} says nextId ${declaredNextId}, but the highest id in the ` +
      `register is ${maxId} (needs nextId >= ${minNextId}). A hand-lowered nextId risks a future ` +
      `duplicate id — fix by raising nextId in ${rel(META)} to >= ${minNextId} (--digest refuses ` +
      `to write while this check is failing).`,
  );
} else if (hasValidDeclaredNextId && declaredNextId > minNextId) {
  warn(
    `nextId reserves ${declaredNextId - minNextId} id(s) beyond max (declared ${declaredNextId}, ` +
      `max + 1 is ${minNextId}) — informational only; an open branch likely already claimed them.`,
  );
}
const derivedNextId = hasValidDeclaredNextId ? Math.max(minNextId, declaredNextId) : minNextId;

const derivedCounters = {
  activeCount: active.length,
  archivedCount: archived.length,
  nextId: derivedNextId,
};

for (const [field, derived] of Object.entries(derivedCounters)) {
  if (field === "nextId") continue; // handled above — FAIL-below / WARN-above / floor logic
  const declared = meta[field];
  if (declared === undefined) continue; // field is optional; nothing to reconcile
  if (!Number.isInteger(declared)) continue; // already failed above as a type error
  if (declared !== derived) {
    warn(
      `STALE ${field.toUpperCase()}: ${rel(META)} says ${field} ${declared}, derived from the ` +
        `register is ${derived}. Informational only — run \`node scripts/validate-lessons.mjs ` +
        `--digest\` to re-stamp it (or ignore: nothing downstream trusts the stored value as ` +
        `authoritative anymore).`,
    );
  }
}

// ─── 4. Cross-references resolve ─────────────────────────────────────────────
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

// ─── 4b. Every active entry has a Lesson line ───────────────────────────────
// The digest is built entirely FROM the "- **Lesson:**" bodies, so an entry
// missing one cannot be represented there — reject it here rather than
// silently dropping it from the digest.
const missingLesson = active.filter((e) => !e.lessonRaw);
if (missingLesson.length) {
  fail(
    `MISSING LESSON: ${missingLesson.map((e) => e.id).join(", ")} — every active entry needs ` +
      `a "- **Lesson:** ..." line (the digest is generated from it).`,
  );
}

// ─── 5. Caps ─────────────────────────────────────────────────────────────────
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

// The summary line always reports the DERIVED nextId, not the (now purely
// informational) stored one — the stored value can be stale by design and a
// status line quoting a stale number is exactly the failure mode L-### stories
// in this file's header are about.
const counts =
  `${active.length}/${maxEntries} entries · ${kb}/${capKb} KB · archived ${archived.length} · ` +
  `nextId ${derivedCounters.nextId} (max ${maxId}) · binding: ${binding}`;

// Warnings are printed regardless of outcome (F5) — a failing run can still
// carry a real, actionable warning (e.g. a reservation note alongside an
// unrelated OVER CAP failure), and silently dropping it just because the
// build was already red hides information a fixer would want.
for (const w of warnings) console.log(`  ⚠ ${w}`);

if (failures.length) {
  console.error(`\n✖ ${failures.length} register problem(s):\n`);
  for (const f of failures) console.error(`   - ${f}`);
  console.error(`\n.claude/lessons: ${counts}\n`);
  process.exit(1);
}

// ─── Digest ──────────────────────────────────────────────────────────────────
// Deterministic given LESSONS.md + _meta.json alone: a 3-line header (title,
// "generated" notice, the counts line above), then one line per ACTIVE entry
// in id order — never file order, since the register groups by category, not
// by id. Collapsing a multi-line "- **Lesson:** ..." body to one line keeps
// this file `grep`-able without opening LESSONS.md.
function collapseLesson(raw, maxLen = 240) {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

function buildDigest(entries, countsLine) {
  const sorted = [...entries].sort((a, b) => a.num - b.num);
  const lines = [
    "# Lessons Digest — RouteFlow",
    "> Generated by `node scripts/validate-lessons.mjs --digest` — do not edit by hand.",
    `> ${countsLine}`,
    ...sorted.map((e) => `- ${e.id} · ${e.category} · ${collapseLesson(e.lessonRaw)}`),
  ];
  return `${lines.join("\n")}\n`;
}

const digestContent = buildDigest(active, counts);

if (digestMode) {
  writeFileSync(DIGEST, digestContent);
  console.log(`✔ .claude/lessons: register is self-consistent. ${counts}`);
  console.log(`✔ wrote ${rel(DIGEST)} (${active.length} entries)`);

  // Re-stamp any of the three counters that _meta.json still carries — same
  // "one command repairs the derived artifact" contract as the digest write
  // above. A field entirely absent from _meta.json is left absent (not every
  // project wants the key); a present-but-stale one is corrected in place.
  const metaUpdates = {};
  for (const [field, derived] of Object.entries(derivedCounters)) {
    if (field in meta && meta[field] !== derived) metaUpdates[field] = derived;
  }
  if (Object.keys(metaUpdates).length) {
    const newMeta = { ...meta, ...metaUpdates, updatedAt: new Date().toISOString() };
    writeFileSync(META, `${JSON.stringify(newMeta, null, 2)}\n`);
    console.log(
      `✔ re-stamped ${rel(META)}: ${Object.entries(metaUpdates)
        .map(([f, v]) => `${f} -> ${v}`)
        .join(", ")}`,
    );
  }
} else {
  // A digest written on a different OS checkout may carry CRLF line endings —
  // normalize before comparing so that alone is never a false "stale" report.
  const normalize = (s) => s.replace(/\r\n/g, "\n");
  const existingDigest = existsSync(DIGEST) ? readFileSync(DIGEST, "utf8") : null;
  if (existingDigest === null || normalize(existingDigest) !== normalize(digestContent)) {
    console.error(`✖ ${rel(DIGEST)} is stale — run: node scripts/validate-lessons.mjs --digest`);
    process.exit(1);
  }
  console.log(`✔ .claude/lessons: register is self-consistent. ${counts}`);
}

if (capsConflict) {
  console.log(
    `  ⚠ caps disagree: ${maxEntries} entries at ${(avgBytes / 1024).toFixed(2)} KB each is ` +
      `~${(impliedBytes / 1024).toFixed(0)} KB, over the ${capKb} KB cap — so size really ` +
      `permits ~${Math.floor(maxBytes / avgBytes)} entries and the entry cap is unreachable. ` +
      `Owner decision: which constraint is load-bearing? Re-set the other in ${rel(META)}.`,
  );
}
if (!verbose) console.log("  (--verbose lists every id and the reserved gaps)");
