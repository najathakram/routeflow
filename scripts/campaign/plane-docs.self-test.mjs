#!/usr/bin/env node
// Coverage for R10/R11 (test-plan.md TP6, .claude/pipeline/
// 2026-09-11-plane-harness/) — pure file-content assertions, no server or
// spawn needed. Follows the repo's standalone self-test convention (see
// plane-sync.self-test.mjs's header for why: no root-level test runner
// exists for standalone scripts, and CLAUDE.md's do-not-introduce list bars
// adding one) — a plain node script run directly
// (`node scripts/campaign/plane-docs.self-test.mjs`), printing `  ok`/`  FAIL`
// lines and exiting non-zero on any failure.
//
// Every read below is `existsSync`-guarded (test-plan.md §6's ground rule):
// none of `.claude/skills/plane/SKILL.md`, the `SessionStart` hook, or the
// `plane:*` package.json scripts exist pre-WP6, so every check here is
// expected to fail on a clean `false`/absent assertion today, never an
// ENOENT throw.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const atRoot = (...segs) => join(REPO_ROOT, ...segs);

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// ── T14 / R10 — the skill file: exists, within the byte cap, names every
// script it documents ────────────────────────────────────────────────────
{
  const skillPath = atRoot(".claude", "skills", "plane", "SKILL.md");
  const exists = existsSync(skillPath);
  const size = exists ? statSync(skillPath).size : -1;
  const src = exists ? readFileSync(skillPath, "utf8") : "";
  const scriptNames = ["plane-sync.mjs", "plane-intake.mjs", "plane-triage.mjs", "plane-apply.mjs"];
  check(
    "T14 (R10): .claude/skills/plane/SKILL.md exists, <= 6144 bytes, names all four scripts",
    {
      exists,
      sizeOk: exists ? size <= 6144 : false,
      namesAllFour: scriptNames.every((n) => src.includes(n)),
    },
    { exists: true, sizeOk: true, namesAllFour: true },
  );
}

// ── T14 / R10 — .claude/settings.json gains a SessionStart hook running the
// triage brief, WITHOUT disturbing the existing PostToolUse/Stop hooks ─────
{
  const settingsPath = atRoot(".claude", "settings.json");
  const raw = readIfExists(settingsPath);
  let parseOk = false;
  let sessionStartHasTriage = false;
  let existingHooksIntact = false;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      parseOk = true;
      const hooks = parsed?.hooks ?? {};
      sessionStartHasTriage = JSON.stringify(hooks.SessionStart ?? []).includes(
        "plane-triage.mjs --brief",
      );
      // WP6 must ADD a SessionStart array alongside PostToolUse/Stop, never
      // replace the `hooks` object (build-plan.md Landmine 12) — a broken
      // implementation that clobbers `hooks` to `{ SessionStart: [...] }`
      // must fail this half even though sessionStartHasTriage above is true.
      existingHooksIntact =
        Array.isArray(hooks.PostToolUse) &&
        hooks.PostToolUse.length > 0 &&
        Array.isArray(hooks.Stop) &&
        hooks.Stop.length > 0;
    } catch {
      parseOk = false;
    }
  }
  check(
    "T14 (R10): .claude/settings.json parses, has a SessionStart hook running plane-triage.mjs --brief, and keeps PostToolUse/Stop intact",
    { exists: raw !== null, parseOk, sessionStartHasTriage, existingHooksIntact },
    { exists: true, parseOk: true, sessionStartHasTriage: true, existingHooksIntact: true },
  );
}

// ── T14 / R10 — the rebuild skill gains a post-deploy plane:sync step ──────
{
  const rebuildPath = atRoot(".claude", "skills", "rebuild", "SKILL.md");
  const src = readIfExists(rebuildPath);
  check(
    "T14 (R10): .claude/skills/rebuild/SKILL.md mentions plane:sync",
    { exists: src !== null, mentionsPlaneSync: src !== null && src.includes("plane:sync") },
    { exists: true, mentionsPlaneSync: true },
  );
}

// ── T14 / R10 — the gitignored write-ledger + close-cache ──────────────────
{
  const gitignorePath = atRoot(".gitignore");
  const src = readIfExists(gitignorePath);
  check(
    "T14 (R10): .gitignore ignores the write ledger and the close-cache",
    {
      exists: src !== null,
      ignoresWriteLedger: src !== null && src.includes(".plane-writes.jsonl"),
      ignoresSyncState: src !== null && src.includes(".plane-sync-state.json"),
    },
    { exists: true, ignoresWriteLedger: true, ignoresSyncState: true },
  );
}

// ── T13 / R11 — package.json scripts + the verify tail ─────────────────────
{
  const pkgPath = atRoot("package.json");
  const raw = readIfExists(pkgPath);
  let parseOk = false;
  let scripts = {};
  if (raw !== null) {
    try {
      scripts = JSON.parse(raw).scripts ?? {};
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }
  const wanted = ["plane:sync", "plane:check", "plane:triage", "plane:intake", "plane:apply"];
  check(
    "T13 (R11): package.json declares plane:sync/check/triage/intake/apply, and keeps bugs:plane",
    {
      exists: raw !== null,
      parseOk,
      keepsExisting: typeof scripts["bugs:plane"] === "string" && scripts["bugs:plane"].length > 0,
      hasAllNew: wanted.every((k) => typeof scripts[k] === "string" && scripts[k].length > 0),
    },
    { exists: true, parseOk: true, keepsExisting: true, hasAllNew: true },
  );

  // The four new self-tests must run AFTER `bugs.mjs self-test` in `verify`
  // (R11, verbatim) — a script that runs them in some other order, or drops
  // `bugs.mjs self-test` itself, fails this even if all four strings appear
  // somewhere in the command.
  const verifyScript = typeof scripts.verify === "string" ? scripts.verify : "";
  const bugsIdx = verifyScript.indexOf("bugs.mjs self-test");
  const selfTestFiles = [
    "plane-sync.self-test.mjs",
    "plane-intake.self-test.mjs",
    "plane-triage.self-test.mjs",
    "plane-apply.self-test.mjs",
  ];
  check(
    "T13 (R11): verify runs the four new plane self-tests after bugs.mjs self-test",
    {
      bugsSelfTestPresent: bugsIdx !== -1,
      allFourAfterBugsSelfTest: selfTestFiles.every(
        (name) => bugsIdx !== -1 && verifyScript.indexOf(name) > bugsIdx,
      ),
    },
    { bugsSelfTestPresent: true, allFourAfterBugsSelfTest: true },
  );
}

// ── T5 / R5 (2026-09-12-plane-learning) — package.json: plane:doctor and
// plane:retro scripts exist, and `verify` runs `plane:doctor -- --offline`
// after the plane self-tests. Pre-WP5 neither script nor the verify tail
// exists, so this is expected to fail on the assertion below (a clean
// false), never an ENOENT throw — same ground rule as every other check in
// this file. ──────────────────────────────────────────────────────────────
{
  const pkgPath = atRoot("package.json");
  const raw = readIfExists(pkgPath);
  let parseOk = false;
  let scripts = {};
  if (raw !== null) {
    try {
      scripts = JSON.parse(raw).scripts ?? {};
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }
  check(
    "T5 (R5): package.json declares plane:doctor and plane:retro",
    {
      exists: raw !== null,
      parseOk,
      hasDoctor: typeof scripts["plane:doctor"] === "string" && scripts["plane:doctor"].length > 0,
      hasRetro: typeof scripts["plane:retro"] === "string" && scripts["plane:retro"].length > 0,
    },
    { exists: true, parseOk: true, hasDoctor: true, hasRetro: true },
  );

  // R5, verbatim: "`verify` gains `plane:doctor -- --offline` after the
  // self-tests" — pinned positionally against the same four self-test
  // filenames T13 (above) already checks, so this stays independent of
  // whichever other package under this run adds plane-learning.self-test.mjs
  // / plane-doctor.self-test.mjs (TP1/TP2 — not this package's files).
  const verifyScript = typeof scripts.verify === "string" ? scripts.verify : "";
  const selfTestFiles = [
    "plane-sync.self-test.mjs",
    "plane-intake.self-test.mjs",
    "plane-triage.self-test.mjs",
    "plane-apply.self-test.mjs",
  ];
  const selfTestIdxs = selfTestFiles.map((n) => verifyScript.indexOf(n));
  const lastSelfTestIdx = Math.max(-1, ...selfTestIdxs);
  const doctorOfflineIdx = verifyScript.indexOf("plane:doctor -- --offline");
  check(
    "T5 (R5): verify runs `plane:doctor -- --offline` after the plane self-tests",
    {
      selfTestsPresent: selfTestIdxs.every((i) => i !== -1),
      doctorOfflinePresent: doctorOfflineIdx !== -1,
      afterSelfTests: doctorOfflineIdx !== -1 && doctorOfflineIdx > lastSelfTestIdx,
    },
    { selfTestsPresent: true, doctorOfflinePresent: true, afterSelfTests: true },
  );
}

// ── T5 / R5 — SKILL.md documents the learning loop: still <= 6144 B (R3
// pins the same cap), and now also names doctor/retro/knobs ──────────────
{
  const skillPath = atRoot(".claude", "skills", "plane", "SKILL.md");
  const exists = existsSync(skillPath);
  const size = exists ? statSync(skillPath).size : -1;
  const src = exists ? readFileSync(skillPath, "utf8") : "";
  check(
    "T5 (R5): .claude/skills/plane/SKILL.md <= 6144 B and mentions plane-doctor, plane-retro, plane-knobs",
    {
      exists,
      sizeOk: exists ? size <= 6144 : false,
      mentionsDoctor: src.includes("plane-doctor"),
      mentionsRetro: src.includes("plane-retro"),
      mentionsKnobs: src.includes("plane-knobs"),
    },
    { exists: true, sizeOk: true, mentionsDoctor: true, mentionsRetro: true, mentionsKnobs: true },
  );
}

// ── T5 / R5 — the weekly-PR report doc ────────────────────────────────────
{
  const readmePath = atRoot("docs", "plane", "retro", "README.md");
  check(
    "T5 (R5): docs/plane/retro/README.md exists",
    { exists: existsSync(readmePath) },
    { exists: true },
  );
}

// ── T5 / R5 — the scheduled-task SKILL.md is MACHINE-LOCAL (lives under the
// user's home directory, never this repo), so its absence is not a failure
// of this package — only assert its contents when the file happens to be
// present on the machine running this test, and print a `skip` line
// otherwise (spec.md T5, verbatim: "assert it contains `plane:doctor` and
// `plane:retro` only when the file exists (skip with a printed `skip` line
// otherwise; it is machine-local)"). ───────────────────────────────────────
{
  const scheduledPath = join(
    homedir(),
    ".claude",
    "scheduled-tasks",
    "routeflow-plane-daily",
    "SKILL.md",
  );
  if (!existsSync(scheduledPath)) {
    console.log(
      `  skip  T5 (R5): scheduled-task SKILL.md not present on this machine (${scheduledPath})`,
    );
  } else {
    const src = readFileSync(scheduledPath, "utf8");
    check(
      "T5 (R5): ~/.claude/scheduled-tasks/routeflow-plane-daily/SKILL.md mentions plane:doctor and plane:retro",
      { mentionsDoctor: src.includes("plane:doctor"), mentionsRetro: src.includes("plane:retro") },
      { mentionsDoctor: true, mentionsRetro: true },
    );
  }
}

console.log(
  failures
    ? `\nplane-docs.self-test: ${failures} FAILURE(S)`
    : "\nplane-docs.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
