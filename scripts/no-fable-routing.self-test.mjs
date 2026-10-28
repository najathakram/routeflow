#!/usr/bin/env node
// Self-test for scripts/no-fable-routing.mjs (R7-a). Plain node: `node scripts/no-fable-routing.self-test.mjs`.
// F1-F4 run the scanner on inline text; the last check runs it on this repo and must find nothing.
import { HISTORY_MARKERS, instructionFiles, scanRepo, scanText } from "./no-fable-routing.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const lines = (file, text) => scanText(file, text).map((h) => h.line);

check(
  "F1 an agent on model: fable is a hit",
  lines(".claude/agents/x.md", "---\nname: x\nmodel: fable\n---"),
  [3],
);
check("F1b claude-fable ids too", lines(".claude/agents/x.md", "model: claude-fable-5-1"), [1]);
check(
  "F1c even with a history word on the line: it still routes a real call",
  lines(".claude/agents/x.md", "model: fable # retired"),
  [1],
);
check(
  "F2 an instruction naming Fable is a hit, at its line",
  lines(".claude/skills/a/SKILL.md", "# S3\n\n### S3 — Fix ruling (Fable @ high rules)\n"),
  [3],
);
check(
  "F2b lower-case ids count",
  lines(".claude/commands/r.md", "agent({model:'claude-fable-5-1'})"),
  [1],
);
check(
  "F3 a HISTORICAL line is allowed",
  lines(".claude/skills/a/SKILL.md", "HISTORICAL: Fable 5.1 ruled S3 until 2026-10-15."),
  [],
);
check(
  "F3b a line inside a blockquote that records the ruling is allowed",
  lines(
    ".claude/skills/a/SKILL.md",
    "> **Owner ruling 2026-10-15:** the Fable model is not used.\n> Fable rows are kept for history.\n\nFable rules S4.",
  ),
  [4],
);
check(
  "F3c 'Never Fable' is a prohibition, not a routing",
  lines(".claude/skills/a/SKILL.md", "Never Fable for any step."),
  [],
);
check(
  "F4 engine code is not scanned",
  instructionFiles(ROOT).filter((f) => !f.endsWith(".md")),
  [],
);
check(
  "the markers are one exported array",
  Array.isArray(HISTORY_MARKERS) && HISTORY_MARKERS.length > 0,
  true,
);
check(
  "every agent, command, SKILL.md and template is scanned",
  [
    ".claude/agents/tech-lead.md",
    ".claude/commands/retro.md",
    ".claude/skills/bug-pipeline/SKILL.md",
    ".claude/skills/bug-pipeline/templates/CAUSE-RULING.md",
  ].every((f) => instructionFiles(ROOT).includes(f)),
  true,
);
const hits = scanRepo(ROOT);
check(
  "this repo: no instruction routes to Fable",
  hits.map((h) => `${h.file}:${h.line}`),
  [],
);

console.log(`no-fable-routing self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
