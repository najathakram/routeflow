#!/usr/bin/env node
/**
 * Lessons-learned Stop gate (generic, opt-in) — blocks turn close (exit 2) when
 * bug-fix-shaped work left `.claude/lessons/` untouched. Companion to the
 * lessons-learned skill (~/.claude/skills/lessons-learned/SKILL.md).
 *
 * Fires only when `.claude/lessons/LESSONS.md` exists, and either:
 *  (a) the current branch is fix/* (or hotfix/*, bugfix/*) and the working tree
 *      has source changes, or
 *  (b) conventional `fix:` commits landed after the last commit that touched
 *      `.claude/lessons/` (drift left behind by any session).
 * Any change under `.claude/lessons/` — including a `_meta.json` updatedAt bump,
 * the no-transferable-lesson acknowledgement — silences both.
 *
 * Wire into the project's .claude/settings.json (copy this file into the repo,
 * e.g. .claude/hooks/lessons-stop-hook.mjs):
 *   "hooks": { "Stop": [ { "hooks": [ { "type": "command",
 *     "command": "node .claude/hooks/lessons-stop-hook.mjs" } ] } ] }
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

function sh(cmd) {
  try {
    return {
      code: 0,
      out: execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

if (!existsSync(".claude/lessons/LESSONS.md")) process.exit(0); // not bootstrapped — never block

let changed = [];
try {
  const tracked = execSync("git diff --name-only --diff-filter=d HEAD", {
    encoding: "utf8",
  });
  const untracked = execSync("git ls-files --others --exclude-standard", {
    encoding: "utf8",
  });
  changed = `${tracked}\n${untracked}`
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0); // not a git repo / git unavailable — nothing to gate
}

const norm = (f) => f.replace(/\\/g, "/");
const SKIP = /(node_modules|\.next|[/]dist[/]|[/]build[/]|[/]coverage[/]|\.turbo)/;
const TEST_FILE = /(\.(spec|test)\.[tj]sx?$|(^|\/)__tests__\/)/;
const isSource = (f) =>
  /\.(ts|tsx|js|jsx|cjs|mjs|py|rb|go|rs|java|cs|php|prisma|sql)$/.test(norm(f)) &&
  !norm(f).startsWith(".claude/") &&
  !SKIP.test(f) &&
  !TEST_FILE.test(norm(f));

if (changed.some((f) => norm(f).startsWith(".claude/lessons/"))) process.exit(0);

const HOW_TO_FIX =
  "Append an entry to .claude/lessons/LESSONS.md (Symptom / Root cause / Lesson / Guard) and " +
  "bump _meta.json (nextId, activeCount, updatedAt). If this fix genuinely carries no " +
  "transferable lesson (trivial typo-class fix), bump _meta.json.updatedAt to acknowledge.";

// ── (a) session-local: live work on a fix branch ──────────────────────────
const branch = sh("git rev-parse --abbrev-ref HEAD").out.trim();
if (/^(fix|hotfix|bugfix)\//.test(branch) && changed.some(isSource)) {
  process.stderr.write(
    `Stop gate: bug-fix work on ${branch} without a recorded lesson ` +
      `(lessons-learned routine).\n${HOW_TO_FIX}\n`,
  );
  process.exit(2);
}

// ── (b) committed drift: fix commits after the last lessons update ────────
const lastLessons = sh("git log -1 --format=%H -- .claude/lessons").out.trim();
if (/^[0-9a-f]{40}$/i.test(lastLessons)) {
  const fixSubjects = sh(`git log ${lastLessons}..HEAD --format=%s`)
    .out.split(/\r?\n/)
    .filter((s) => /^fix(\(.+\))?!?:/.test(s.trim()));
  if (fixSubjects.length > 0) {
    process.stderr.write(
      `Stop gate: ${fixSubjects.length} fix commit(s) landed after the last ` +
        `.claude/lessons/ update without a recorded lesson (lessons-learned routine).\n` +
        `${HOW_TO_FIX}\n\nFix commits (first 5):\n  ${fixSubjects.slice(0, 5).join("\n  ")}\n`,
    );
    process.exit(2);
  }
}

process.exit(0);
