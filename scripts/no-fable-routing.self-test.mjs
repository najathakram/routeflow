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
// A marker excuses only its own clause (Opus review of R7-a): each of these routes a real step to Fable.
const SKILL = ".claude/skills/a/SKILL.md";
for (const [name, text] of [
  ["F5 a marker inside a parenthesis", "S3: Fable @ high rules (the retired Opus 4 tier is gone)."],
  ["F5b a marker after a semicolon", "S3: Fable rules; Haiku no longer runs gates here."],
  ["F5c 'not used' about another model", "Use Fable for S3; Haiku is not used."],
  ["F5d 'never spawn' about another model", "Never spawn Sonnet for S3 — use Fable."],
  ["F5e a ruling date alone is no marker", "Per ruling 2026-10-15 the planner stays on Fable."],
  // Second review round.
  ["F5g a non-status bracket stays split", "Use Fable (it is Opus-class) for S3."],
  ["F5h a bracket naming another retired slot", "Use Fable (retired Opus slot) for S3."],
  ["F5i 'is Opus' about another role", "S3 planner is Fable and the reviewer is Opus."],
  ["F5j 'read Opus' is no mapping", "Spawn Fable to read Opus output."],
  ["F5k a comma ends a clause", "Use Fable for S3, Haiku is not used."],
  ["F5l 'now that' ends a clause", "Use Fable for S3 now that Opus 4 is retired."],
  ["F5m 'instead of' ends a clause", "Spawn Fable instead of the removed Haiku gate."],
  ["F5n a plain HISTORICAL word is no banner", "HISTORICAL runs used Opus; spawn Fable for S3."],
])
  check(name, lines(SKILL, text), [1]);
check(
  "F5f a plain '> HISTORICAL note.' covers only its own line",
  lines(SKILL, "> HISTORICAL note.\n> S3: spawn a Fable agent at high."),
  [2],
);
check(
  "F6 a formatted banner covers its blockquote paragraph, until a bare '>' line",
  lines(
    SKILL,
    "> **HISTORICAL (superseded 2026-10-15):** the old rules.\n> Fable authors S3.\n>\n> Fable rules S4.",
  ),
  [4],
);
check(
  "F6f a heading that merely contains HISTORICAL does not exempt its file",
  lines(SKILL, "# Prompting Opus (HISTORICAL file name)\n\nSpawn Fable for S3."),
  [3],
);
check(
  "F6g status words right after the name stay with it",
  lines(
    SKILL,
    "Opus (Fable, retired, before 2026-09-29) rules once.\n| Fable 5.1 (retired) | $10 |",
  ),
  [],
);
check(
  "F6b a HISTORICAL heading covers its section, until a heading of that level",
  lines(
    SKILL,
    "## Old routing — HISTORICAL\n\nFable rules S3.\n\n### detail\nFable rules S4.\n\n## Now\nFable rules S5.",
  ),
  [9],
);
check("F6c 'Fable 5.1 (retired)' is one clause", lines(SKILL, "| Fable 5.1 (retired) | $10 |"), []);
check(
  "F6d an Opus mapping is the ruling, not a routing",
  lines(SKILL, "Every role Fable had is held by Opus."),
  [],
);
check(
  "F6e the FABLE-PROMPTING file name is not the model",
  lines(SKILL, "Snippets: [FABLE-PROMPTING](references/FABLE-PROMPTING.md)."),
  [],
);
check(
  "F7 references are scanned, append-only logs are not",
  [
    instructionFiles(ROOT).includes(".claude/skills/model-routing/references/MODEL-CARDS.md"),
    instructionFiles(ROOT).some((f) => f.endsWith("/RUN-LOG.md")),
  ],
  [true, false],
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
