#!/usr/bin/env node
// Coverage for the pure matcher in scripts/work/claude-hook.mjs — everything
// above its "── IO" marker. Same convention as scripts/work/run.self-test.mjs:
// no fake fs/child_process, every export here is a pure function of its
// inputs.
//
// Run: node scripts/work/claude-hook.self-test.mjs
import { commandSegments, matchesTriggerCommand } from "./claude-hook.mjs";
import { readFileSync as readPkgFile } from "node:fs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

// ── commandSegments ─────────────────────────────────────────────────────
{
  check("commandSegments: single command -> one segment", commandSegments("git push"), [
    "git push",
  ]);
  check(
    "commandSegments: && chain -> two segments, trimmed",
    commandSegments("git add x && git push"),
    ["git add x", "git push"],
  );
  check(
    "commandSegments: ; and | and newline also split",
    commandSegments("git status; gh pr view 1 | cat\ngit push"),
    ["git status", "gh pr view 1", "cat", "git push"],
  );
  check("commandSegments: null/undefined -> empty", commandSegments(undefined), []);
  check("commandSegments: blank -> empty", commandSegments("   "), []);
}

// ── matchesTriggerCommand: gh pr subcommands ────────────────────────────
{
  check("gh pr create -> match", matchesTriggerCommand('gh pr create --draft --title "x"'), true);
  check("gh pr ready -> match", matchesTriggerCommand("gh pr ready 123"), true);
  check("gh pr merge -> match", matchesTriggerCommand("gh pr merge --squash 123"), true);
  check("gh pr close -> match", matchesTriggerCommand("gh pr close 123"), true);
  check("gh pr edit -> match", matchesTriggerCommand("gh pr edit 123 --add-label x"), true);
  check("gh pr view -> NOT a trigger (read-only)", matchesTriggerCommand("gh pr view 123"), false);
  check("gh pr list -> NOT a trigger", matchesTriggerCommand("gh pr list"), false);
}

// ── matchesTriggerCommand: gh issue subcommands ─────────────────────────
{
  check("gh issue create -> match", matchesTriggerCommand('gh issue create --title "x"'), true);
  check("gh issue close -> match", matchesTriggerCommand("gh issue close 5"), true);
  check("gh issue reopen -> match", matchesTriggerCommand("gh issue reopen 5"), true);
  check("gh issue edit -> match", matchesTriggerCommand("gh issue edit 5 --add-label x"), true);
  check(
    "gh issue closed (not a real subcommand) -> NOT a trigger",
    matchesTriggerCommand("gh issue closed 5"),
    false,
  );
  check("gh issue list -> NOT a trigger", matchesTriggerCommand("gh issue list"), false);
  check("gh issue view -> NOT a trigger", matchesTriggerCommand("gh issue view 5"), false);
}

// ── matchesTriggerCommand: git push ─────────────────────────────────────
{
  check("git push (bare) -> match", matchesTriggerCommand("git push"), true);
  check(
    "git push origin <branch> -> match",
    matchesTriggerCommand("git push origin feat/work-reconciler"),
    true,
  );
  check("git push --force -> match", matchesTriggerCommand("git push --force"), true);
  check(
    "git pushd -> NOT a match (different command, same prefix)",
    matchesTriggerCommand("git pushd"),
    false,
  );
  check("git pull -> NOT a match", matchesTriggerCommand("git pull"), false);
  check("git status -> NOT a match", matchesTriggerCommand("git status"), false);
}

// ── matchesTriggerCommand: textual mentions that are not real invocations ─
{
  check(
    "echo gh pr create -> NOT a match (text, not an invocation)",
    matchesTriggerCommand("echo gh pr create"),
    false,
  );
  check(
    'git commit -m "gh pr create" -> NOT a match (quoted text in an unrelated command)',
    matchesTriggerCommand('git commit -m "gh pr create"'),
    false,
  );
  check(
    "# a comment about git push -> NOT a match",
    matchesTriggerCommand("# remember to git push later"),
    false,
  );
}

// ── matchesTriggerCommand: chained commands ─────────────────────────────
{
  check(
    "git add x && git push -> match (second segment is a real invocation)",
    matchesTriggerCommand("git add x && git push"),
    true,
  );
  check(
    "npm test && gh pr create --draft -> match",
    matchesTriggerCommand("npm test && gh pr create --draft"),
    true,
  );
  check(
    "cd apps/api && npm test -> NOT a match (no trigger command anywhere)",
    matchesTriggerCommand("cd apps/api && npm test"),
    false,
  );
  check(
    "echo gh pr create && git status -> NOT a match (neither segment is a real trigger)",
    matchesTriggerCommand("echo gh pr create && git status"),
    false,
  );
}

// ── matchesTriggerCommand: missing/malformed input ──────────────────────
{
  check("undefined command -> false", matchesTriggerCommand(undefined), false);
  check("null command -> false", matchesTriggerCommand(null), false);
  check("empty string command -> false", matchesTriggerCommand(""), false);
}

// ── result ────────────────────────────────────────────────────────────────
// ── VERIFY-PIN (#2285): `npm run verify` runs this self-test ──────────────────
// Unwired, this file protects nothing (found orphaned in the #2273 sweep), so it pins its own
// place in the root verify chain, the same pattern as the F-22 self-tests' T10v/T17v (#2283).
{
  const pkg = JSON.parse(readPkgFile(new URL("../../package.json", import.meta.url), "utf8"));
  const verify = typeof pkg.scripts?.verify === "string" ? pkg.scripts.verify : "";
  check(
    "VERIFY-PIN: verify chain runs scripts/work/claude-hook.self-test.mjs",
    verify
      .split("&&")
      .some((step) => step.trim() === "node scripts/work/claude-hook.self-test.mjs"),
    true,
  );
}

console.log(
  failures === 0
    ? `\nclaude-hook.self-test: ALL GREEN`
    : `\nclaude-hook.self-test: ${failures} FAILURE(S)`,
);
process.exitCode = failures === 0 ? 0 : 1;
