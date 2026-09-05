#!/usr/bin/env node
/**
 * Stop gate — fast, changed-files-only checks (monorepo-safe, < 10s).
 *
 * Gate 1 — formatting: `prettier --check` on the changed/untracked TS/JS
 * source files only. Blocks turn close (exit 2) with a fix list if any are
 * unformatted.
 *
 * Gate 2 — code-map freshness: CLAUDE.md requires `.claude/code-map/` to be
 * updated surgically with every code change, in every session. Only runs when
 * `.claude/code-map/_meta.json` exists (repos/worktrees with no map yet are
 * never blocked). Blocks when
 * (a) this session has uncommitted code changes but no code-map change, or
 * (b) commits since the last commit that touched `.claude/code-map/` (found
 *     via `git log -1 -- .claude/code-map`, NOT by reading `_meta.json`'s
 *     content) touched code without any of them touching the map (drift left
 *     behind by an earlier session).
 * Test/spec files (`*.spec.ts`, `*.test.ts`, `__tests__/`) don't count as
 * "code" for either gate — they don't need a map entry of their own.
 *
 * Gate 3 — lesson capture: CLAUDE.md's lessons-learned routine requires every
 * bug fix to leave a rule behind in `.claude/lessons/`. Only runs when
 * `.claude/lessons/LESSONS.md` exists. Blocks when bug-fix-shaped work left the
 * register untouched — (a) a fix/* branch with uncommitted code changes, or
 * (b) conventional `fix:` commits landed after the last commit that touched
 * `.claude/lessons/` (self-anchoring like Gate 2b). Any change under
 * `.claude/lessons/` — including a bare `_meta.json` updatedAt bump, the
 * "no transferable lesson" acknowledgement — silences both.
 *
 * Why prettier-only (no eslint here): ESLint flat config resolves from the
 * current working directory, and this repo has NO root eslint.config — eslint
 * only runs per-workspace via `npm run lint` / Turbo. tsc is likewise excluded
 * (too slow/fragile per-file with Prisma); type-checks live in the pre-push hook.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Invoke prettier directly via node — this repo's root has no node_modules/.bin
// shim, so `npx prettier` fails on Windows. Fall back to npx where the shim exists.
function prettierCli() {
  const local = "node_modules/prettier/bin/prettier.cjs";
  return existsSync(local) ? `node "${local}"` : "npx prettier";
}

function sh(cmd) {
  try {
    return { code: 0, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// Bookkeeping Option B (owner ruling 2026-09-05): a code PR may defer the
// code-map/lessons update to a docs-only follow-up PR opened right after
// merge, by carrying this trailer on its HEAD commit. Gates 2 and 3 both
// treat the trailer as a satisfying condition instead of blocking.
const bookkeepingDeferred = /^Bookkeeping-Follow-Up:\s*pending/im.test(
  sh("git log -1 --format=%B").out,
);

let changed = [];
try {
  // --diff-filter=d drops DELETED paths: prettier errors out with "No files
  // matching the pattern were found" on a path that no longer exists, which
  // failed the gate with an unfixable complaint (formatting was already clean).
  const tracked = execSync("git diff --name-only --diff-filter=d HEAD", { encoding: "utf8" });
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" });
  changed = `${tracked}\n${untracked}`
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0); // not a git repo / git unavailable — nothing to gate
}

const SKIP = /(node_modules|\.next|[/]dist[/]|[/]build[/]|[/]coverage[/]|\.turbo)/;
const source = changed.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && !SKIP.test(f));

// ── Gate 1: formatting ────────────────────────────────────────────────────
if (source.length > 0) {
  const list = source.map((f) => `"${f}"`).join(" ");
  const res = sh(`${prettierCli()} --check ${list}`);

  if (res.code !== 0) {
    const detail = res.out.trim().split(/\r?\n/).slice(0, 25).join("\n");
    process.stderr.write(
      `Stop gate: unformatted source files. Run \`npm run format\` (or \`npx prettier --write\`):\n\n${detail}\n`,
    );
    process.exit(2); // block close; stderr is fed back to Claude to self-correct
  }
}

// ── Gate 2: code-map freshness ────────────────────────────────────────────
const norm = (f) => f.replace(/\\/g, "/");
const TEST_FILE = /(\.(spec|test)\.[tj]sx?$|(^|\/)__tests__\/)/;
const isCode = (f) =>
  /^(apps|packages|scripts)\/.*\.(ts|tsx|js|jsx|cjs|mjs|prisma)$/.test(norm(f)) &&
  !SKIP.test(f) &&
  !TEST_FILE.test(norm(f));
const isMap = (f) => norm(f).startsWith(".claude/code-map/");
const hasMap = existsSync(".claude/code-map/_meta.json");

const HOW_TO_FIX =
  "Surgically update the touched entries (.claude/code-map/INDEX.md → the area file: " +
  "api/web/mobile/packages.md) and bump _meta.json (mappedSha + generatedAt). " +
  "If the map's content is genuinely unaffected, bump generatedAt to acknowledge the review.";

if (hasMap && bookkeepingDeferred) {
  console.log("Gate 2: bookkeeping deferred to the follow-up PR (trailer present)");
}

// (a) session-local: code changed in the working tree, map untouched
const uncommittedCode = changed.filter(isCode);
if (hasMap && uncommittedCode.length > 0 && !changed.some(isMap) && !bookkeepingDeferred) {
  const list = uncommittedCode.slice(0, 10).join("\n  ");
  process.stderr.write(
    `Stop gate: code changed but .claude/code-map/ was not updated (CLAUDE.md code-map routine).\n` +
      `${HOW_TO_FIX}\n\nChanged code files:\n  ${list}\n`,
  );
  process.exit(2);
}

// (b) committed drift: code committed AFTER the last commit that touched the
// map (any session's leftovers, not just this one's). Self-anchoring: the
// fixing commit touches .claude/code-map/ and becomes the new anchor, and a
// commit carrying code + map together is always clean. An uncommitted
// code-map change counts as the fix in progress — don't re-block.
if (hasMap && !changed.some(isMap) && !bookkeepingDeferred) {
  const lastMap = sh("git log -1 --format=%H -- .claude/code-map").out.trim();
  if (/^[0-9a-f]{40}$/i.test(lastMap)) {
    const codeDrift = sh(`git diff --name-only ${lastMap} HEAD -- apps packages scripts`)
      .out.split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f && isCode(f));
    if (codeDrift.length > 0) {
      const list = codeDrift.slice(0, 10).join("\n  ");
      process.stderr.write(
        `Stop gate: the code map is STALE — code was committed after the last ` +
          `.claude/code-map/ update (${lastMap.slice(0, 7)}) without refreshing the map ` +
          `(CLAUDE.md code-map routine).\n${HOW_TO_FIX}\n\n` +
          `Unmapped code files (first 10 of ${codeDrift.length}):\n  ${list}\n`,
      );
      process.exit(2);
    }
  }
}

// ── Gate 3: lesson capture after a bug fix ────────────────────────────────
const isLesson = (f) => norm(f).startsWith(".claude/lessons/");
const hasLessons = existsSync(".claude/lessons/LESSONS.md");

if (hasLessons && !changed.some(isLesson) && bookkeepingDeferred) {
  console.log("Gate 3: bookkeeping deferred to the follow-up PR (trailer present)");
}

if (hasLessons && !changed.some(isLesson) && !bookkeepingDeferred) {
  const LESSON_FIX =
    "Append an entry to .claude/lessons/LESSONS.md (Symptom / Root cause / Lesson / Guard) " +
    "and bump _meta.json (nextId, activeCount, updatedAt). If this fix genuinely carries no " +
    "transferable lesson (typo-class), bump _meta.json.updatedAt alone to acknowledge.";

  // (a) session-local: live work on a fix branch
  const branch = sh("git rev-parse --abbrev-ref HEAD").out.trim();
  if (/^(fix|hotfix|bugfix)\//.test(branch) && uncommittedCode.length > 0) {
    process.stderr.write(
      `Stop gate: bug-fix work on ${branch} without a recorded lesson ` +
        `(CLAUDE.md lessons-learned routine).\n${LESSON_FIX}\n`,
    );
    process.exit(2);
  }

  // (b) committed drift: fix commits landed after the last lessons update
  const lastLessons = sh("git log -1 --format=%H -- .claude/lessons").out.trim();
  if (/^[0-9a-f]{40}$/i.test(lastLessons)) {
    const fixCommits = sh(`git log ${lastLessons}..HEAD --format=%s`)
      .out.split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^fix(\(.+\))?!?:/.test(s));
    if (fixCommits.length > 0) {
      const list = fixCommits.slice(0, 5).join("\n  ");
      process.stderr.write(
        `Stop gate: ${fixCommits.length} fix commit(s) landed after the last ` +
          `.claude/lessons/ update (${lastLessons.slice(0, 7)}) without a recorded lesson ` +
          `(CLAUDE.md lessons-learned routine).\n${LESSON_FIX}\n\n` +
          `Fix commits (first 5):\n  ${list}\n`,
      );
      process.exit(2);
    }
  }
}

// ── Gate 4: bug-registry sync (reports, never blocks) ─────────────────────
// The registry at `.claude/campaign/bugs/B###.md` must not depend on anyone
// REMEMBERING to update it — that is exactly how the board drifted three stale
// cards and the ledger kept thirteen `proven` rows past their deploy. So this
// does not gate the turn; it runs the derivation. `sync` reads the two sources
// that move on their own (the proof ledger and git log) and appends only events
// a record does not already carry, deduped on a marker, so it is idempotent and
// safe to run every turn.
//
// Deliberately non-blocking and fully swallowed: a bookkeeping refresh must
// never be able to fail a turn or mask Gates 1-3 above it.
if (existsSync(".claude/campaign/bugs") && existsSync("scripts/campaign/bugs.mjs")) {
  // spawnSync, not sh()/execSync: execSync's return value on a SUCCESSFUL
  // exit is stdout only — stderr is silently discarded even though it is
  // piped — but `sync --quiet` deliberately writes its "an unscanned
  // commit range" notes to stderr on a perfectly clean exit, and this gate
  // needs to see them.
  const proc = spawnSync("node", ["scripts/campaign/bugs.mjs", "sync", "--quiet"], {
    encoding: "utf8",
  });
  const out = proc.stdout || "";
  const err = proc.stderr || "";
  const code = proc.status ?? 1;
  const recorded = /recorded (\d+) new event/.exec(out);
  if (code === 0 && recorded && Number(recorded[1]) > 0) {
    process.stderr.write(
      `Bug registry: recorded ${recorded[1]} new event(s) into .claude/campaign/bugs/ — ` +
        `commit them alongside your change.\n`,
    );
  } else if (code !== 0) {
    // Still never blocks — but a crash (e.g. a malformed status shard) used to
    // go completely silent: the hook swallowed the non-zero exit and printed
    // nothing, so the registry could go dark indefinitely with zero signal.
    const firstLine = (out + err).trim().split(/\r?\n/)[0] || "(no output)";
    process.stderr.write(`Bug registry: sync failed (non-blocking) — ${firstLine}\n`);
  }
  // A lost or unknown anchor drops a whole commit range with an otherwise
  // clean (code === 0, "recorded 0") exit — surface it here even though
  // nothing above triggered, so a quiet hook run never goes dark on it.
  for (const line of err.split(/\r?\n/))
    if (/no scan|not re-derived/i.test(line))
      process.stderr.write(`Bug registry: ${line.trim()}\n`);
}

process.exit(0);
