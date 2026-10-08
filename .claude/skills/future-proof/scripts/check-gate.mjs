#!/usr/bin/env node
// check-gate.mjs: a mechanical completeness check for a spec's Design Gate block (future-proof skill).
//
//   node .claude/skills/future-proof/scripts/check-gate.mjs <spec.md>   # "-" reads stdin (e.g. a PR body)
//   node .claude/skills/future-proof/scripts/check-gate.mjs --self-test
//
// Exit codes: 0 = PASS; 1 = FAIL (every problem is printed); 2 = a usage or read error.
//
// The checker proves the block is present, complete and well formed. Whether the answers are RIGHT is
// the reviewer's call (references/REVIEWER-CHECKLIST.md).
//
// The self-test reads references/GATE-TEMPLATE.md at run time, so the template and this checker cannot
// drift apart (lesson L-206). It uses no dependencies, only Node built-ins.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "references",
  "GATE-TEMPLATE.md",
);

// An unfilled placeholder is an angle-bracket phrase outside code. Comments, closing tags and URLs are
// not placeholders.
const PLACEHOLDER = /<(?!!--|\/|https?:)[A-Za-z][^<>\n]*>/;
const PLACEHOLDERS = new RegExp(PLACEHOLDER.source, "g");
const MARK = /^(build now|seam now|later|n\/a)\b/i;
const SIZE_AFTER_ARROW = /→.*\b(XS|S|M|L)\b/;
const BASE_SHA = /\bbase\s+[0-9a-f]{7,40}\b/i;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const DASH_ONLY = /^[-–—]*$/;

const AXES = [
  ["wholesaler / distributor", /^wholesal/i],
  ["jobber", /^jobber/i],
  ["retail POS counter", /^(retail|pos\b|counter)/i],
  ["delivery / route", /^(delivery|route)/i],
  ["mixed", /^mixed/i],
  ["super admin", /^super[\s-]*admin/i],
  ["single store / 1 user", /^single/i],
  ["small team", /^small\s+team/i],
  ["multi-branch / multi-warehouse", /^multi/i],
  ["high volume", /^high[\s-]*volume/i],
];

// The Full form's sections, the bullet labels each one must answer, and any table rules.
const FULL = [
  { id: "G1", title: "G1 Fit", bullets: ["Program", "Exists today", "Decision", "Facts"] },
  {
    id: "Area sweep",
    title: "Area sweep",
    bullets: ["Chunk"],
    rows: [
      ["bug registry", /^(bug\s+)?registry/i],
      ["tracker issues", /^(tracker\s+)?issues/i],
      ["ACTION-ITEMS", /^action/i],
      ["review nits", /^review/i],
    ],
  },
  {
    id: "G2",
    title: "G2 Variation map",
    bullets: ["Surfaces", "Capability", "Dark launch"],
    axes: true,
  },
  { id: "G3", title: "G3 Replace-later", bullets: ["Interim"], minRows: 1 },
  {
    id: "G4",
    title: "G4 Class, not instance",
    bullets: ["Class", "Inventory", "One helper", "Pin", "Red-first"],
  },
  {
    id: "G5",
    title: "G5 Data & time",
    bullets: ["Schema", "Snapshot", "Authority", "Old shape", "Money"],
  },
  { id: "G6", title: "G6 Scale", bullets: ["Queries", "Limits", "UI at"] },
  { id: "G7", title: "G7 UX lens", bullets: ["Flow", "Feature parity", "Placement"] },
  {
    id: "G8",
    title: "G8 Change-friendliness",
    bullets: ["Config", "Shared contract", "Flags", "Code map"],
    diffSizes: true,
  },
  { id: "G9", title: "G9 Cost & stop", bullets: ["Quick fix", "YAGNI", "Review-round"] },
  { id: "G10", title: "G10 Owner questions", minBullets: 1 },
];
const LITE = ["G1", "Area sweep", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"];
const HOTFIX = ["Live harm", "Final shape", "Area sweep filed"];

const missing = (msg) => ({ kind: "missing", msg });
const invalid = (msg) => ({ kind: "invalid", msg });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingRe = (id) => new RegExp(`^#{3,4}\\s*${esc(id)}\\b`, "i");
const bulletRe = (label) => new RegExp(`^\\s*[-*]\\s+(\\*\\*)?${esc(label)}\\b`, "i");
const isFence = (line) => /^\s*```/.test(line);
// Strip inline code, so that a generic such as `Record<Mode, Handler>` is not read as a placeholder.
const stripCode = (s) => s.replace(/`[^`\n]*`/g, "");
const hasPlaceholder = (s) => PLACEHOLDER.test(stripCode(s));
const answer = (line) => {
  const i = line.indexOf(":");
  return i < 0 ? "" : line.slice(i + 1).trim();
};
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
const isSeparator = (cs) => cs.length > 0 && cs.every((c) => /^:?-{2,}:?$/.test(c));
const firstCell = (cs) => (cs[0] ?? "").replace(/^[\s*_`]+/, "");
// The data rows of a section's table; the first row is the header.
const tableData = (lines) =>
  lines
    .filter((l) => l.trim().startsWith("|"))
    .map(cells)
    .filter((cs) => !isSeparator(cs))
    .slice(1);

function findGate(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence;
    if (inFence || !/^#{1,3}\s+.*\bDesign Gate\b/i.test(lines[i])) continue;
    const level = lines[i].match(/^#+/)[0].length;
    let end = lines.length;
    let fence = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (isFence(lines[j])) fence = !fence;
      const m = !fence && lines[j].match(/^(#+)\s/);
      if (m && m[1].length <= level) {
        end = j;
        break;
      }
    }
    return { heading: lines[i], body: lines.slice(i + 1, end), firstLine: i + 1 };
  }
  return null;
}

function sectionsOf(body) {
  const heads = [];
  body.forEach((l, i) => {
    if (/^#{3,4}\s/.test(l)) heads.push(i);
  });
  const out = new Map();
  for (const s of FULL) {
    const at = heads.find((h) => headingRe(s.id).test(body[h]));
    if (at === undefined) continue;
    const next = heads.find((h) => h > at);
    out.set(s.id, body.slice(at + 1, next === undefined ? body.length : next));
  }
  return out;
}

function checkPlaceholders(gate, problems) {
  let fence = false;
  [gate.heading, ...gate.body].forEach((line, i) => {
    if (isFence(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const found = stripCode(line).match(PLACEHOLDERS);
    if (found)
      problems.push({
        kind: "placeholder",
        msg: `line ${gate.firstLine + i}: fill ${found.join(" ")}`,
      });
  });
}

function checkBullets(where, lines, labels, problems) {
  for (const label of labels) {
    const line = lines.find((l) => bulletRe(label).test(l));
    if (!line) problems.push(missing(`${where}: no "- ${label} ...:" line`));
    else if (!answer(line))
      problems.push(missing(`${where}: "${label}" has no answer after the colon`));
  }
}

function checkAxes(data, problems) {
  for (const [label, re] of AXES) {
    const row = data.find((cs) => re.test(firstCell(cs)));
    if (!row) {
      problems.push(missing(`G2: no "${label}" row in the variation map`));
      continue;
    }
    if (hasPlaceholder(row.join(" | "))) continue; // already reported as a placeholder
    const [, how = "", mark = "", seam = ""] = row;
    if (!how) problems.push(invalid(`G2 ${label}: say how it differs there (or n/a and why)`));
    if (!MARK.test(mark)) {
      problems.push(
        invalid(`G2 ${label}: the mark must be BUILD NOW, SEAM NOW, LATER or n/a (got "${mark}")`),
      );
    } else if (/^seam now/i.test(mark) && DASH_ONLY.test(seam)) {
      problems.push(invalid(`G2 ${label}: SEAM NOW needs the seam it adds in this change`));
    }
  }
}

function checkDiffSizes(lines, problems) {
  const at = lines.findIndex((l) => /expected diff size/i.test(l));
  if (at < 0) {
    problems.push(missing('G8: no "Future requirement → expected diff size" list'));
    return;
  }
  const items = lines.slice(at + 1).filter((l) => l.includes("→"));
  if (!items.length) problems.push(missing("G8: list at least one future requirement → size"));
  for (const l of items) {
    if (!hasPlaceholder(l) && !SIZE_AFTER_ARROW.test(stripCode(l))) {
      problems.push(invalid(`G8: "${l.trim()}" needs a size after the arrow (XS, S, M or L)`));
    }
  }
}

function checkBaseSha(gate, problems) {
  if (!hasPlaceholder(gate.heading) && !BASE_SHA.test(gate.heading)) {
    problems.push(missing('heading: add "base" and the sha the facts were read at'));
  }
}

function checkFull(gate, problems) {
  checkBaseSha(gate, problems);
  const secs = sectionsOf(gate.body);
  for (const s of FULL) {
    const lines = secs.get(s.id);
    if (!lines) {
      problems.push(missing(`no "### ${s.title}" section`));
      continue;
    }
    if (s.bullets) checkBullets(s.title, lines, s.bullets, problems);
    if (s.minBullets && !lines.some((l) => /^\s*[-*]\s+\S/.test(l))) {
      problems.push(missing(`${s.title}: write "- none" or list the questions`));
    }
    const data = tableData(lines);
    if (s.minRows && data.length < s.minRows)
      problems.push(missing(`${s.title}: the table needs at least one row`));
    for (const [label, re] of s.rows ?? []) {
      const row = data.find((cs) => re.test(firstCell(cs)));
      if (!row) problems.push(missing(`${s.title}: no "${label}" row`));
      else if (!row[1]) problems.push(missing(`${s.title}: the "${label}" row has no query`));
    }
    if (s.axes) checkAxes(data, problems);
    if (s.diffSizes) checkDiffSizes(lines, problems);
  }
}

function checkLines(gate, labels, problems, extra) {
  for (const label of labels) {
    const line = gate.body.find((l) => bulletRe(label).test(l));
    if (!line) problems.push(missing(`no "- ${label} ...:" line`));
    else if (!answer(line)) problems.push(missing(`"${label}" has no answer after the colon`));
    else if (!hasPlaceholder(line)) extra(label, line);
  }
}

function check(text) {
  const gate = findGate(text);
  if (!gate)
    return [missing('no "## Design Gate" block; paste one from references/GATE-TEMPLATE.md')];
  const form = (gate.heading.match(/\((full|lite|hotfix)\)/i) ?? [])[1]?.toLowerCase();
  if (!form) return [missing('the heading must name the form: "(Full)", "(Lite)" or "(Hotfix)"')];
  const problems = [];
  checkPlaceholders(gate, problems);
  if (form === "full") {
    checkFull(gate, problems);
  } else if (form === "lite") {
    checkBaseSha(gate, problems);
    checkLines(gate, LITE, problems, (label, line) => {
      if (label === "G8" && !SIZE_AFTER_ARROW.test(stripCode(line))) {
        problems.push(invalid('G8: add "future: the requirement → XS, S, M or L"'));
      }
    });
  } else {
    checkLines(gate, HOTFIX, problems, (label, line) => {
      if (label === "Final shape" && !DATE.test(line)) {
        problems.push(invalid("Final shape: give the follow-up's due date (YYYY-MM-DD)"));
      }
    });
  }
  return problems;
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────────
function templateBlock(name) {
  const text = readFileSync(TEMPLATE_PATH, "utf8").replace(/\r\n?/g, "\n");
  const m = text.match(new RegExp(`<!-- gate:${name} -->\\n([\\s\\S]*?)<!-- /gate:${name} -->`));
  if (!m) throw new Error(`no "gate:${name}" block in ${TEMPLATE_PATH}`);
  return m[1]
    .split("\n")
    .filter((l) => !isFence(l))
    .join("\n");
}

// A mechanical fill of the template: what a careless but complete author would paste.
const fill = (block) =>
  block
    .replace(/<YYYY-MM-DD>/g, "2026-10-08")
    .replace(/<sha>/g, "1bf58be42")
    .replace(/<mark>/g, "LATER")
    .replace(/<size>/g, "S")
    .replace(PLACEHOLDERS, "x");

function selfTest() {
  const full = templateBlock("full");
  const lite = templateBlock("lite");
  const hotfix = templateBlock("hotfix");
  const [F, L, H] = [full, lite, hotfix].map(fill);
  const has = (re) => (p) => p.some((x) => re.test(x.msg));
  const onlyPlaceholders = (p) => p.length > 0 && p.every((x) => x.kind === "placeholder");
  const clean = (p) => p.length === 0;
  const cases = [
    ["the shipped Full template fails on placeholders only", full, onlyPlaceholders],
    ["the shipped Lite template fails on placeholders only", lite, onlyPlaceholders],
    ["the shipped Hotfix template fails on placeholders only", hotfix, onlyPlaceholders],
    ["a filled Full gate passes", F, clean],
    ["a filled Lite gate passes", L, clean],
    ["a filled Hotfix gate passes", H, clean],
    [
      "a spec with no gate fails",
      "# SA-999\n\n## Facts\n- none\n",
      has(/no "## Design Gate" block/),
    ],
    [
      "a gate quoted inside a code fence does not count",
      "# Spec\n\n```markdown\n" + F + "\n```\n",
      has(/no "## Design Gate" block/),
    ],
    ["a heading without its form fails", F.replace("(Full)", ""), has(/must name the form/)],
    [
      "a heading without the base sha fails",
      F.replace("base 1bf58be42", "base"),
      has(/the sha the facts/),
    ],
    ["a missing section fails", F.replace(/^### G6 Scale$/m, "### Scale notes"), has(/G6 Scale/)],
    ["a missing G4 bullet fails", F.replace(/^- Red-first:.*\n/m, ""), has(/Red-first/)],
    ["a missing variation-map axis fails", F.replace(/^\| Jobber .*\n/m, ""), has(/"jobber" row/)],
    [
      "an unknown mark fails",
      F.replace(/^(\| Jobber[^|]*\|[^|]*\|) LATER/m, "$1 maybe"),
      has(/mark must be/),
    ],
    [
      "SEAM NOW without a seam fails",
      F.replace(/^(\| Multi-branch[^|]*\|[^|]*\|) LATER \|[^|]*\|/m, "$1 SEAM NOW | — |"),
      has(/SEAM NOW needs/),
    ],
    [
      "a missing area-sweep source fails",
      F.replace(/^\| ACTION-ITEMS .*\n/m, ""),
      has(/ACTION-ITEMS/),
    ],
    ["a future line without a size fails", F.replace("→ S (", "→ big ("), has(/needs a size/)],
    [
      "a bare generic counts as a placeholder",
      F.replace("- Shared contract: x", "- Shared contract: Record<Mode, Handler>"),
      (p) => p.some((x) => x.kind === "placeholder"),
    ],
    [
      "a generic in backticks is fine",
      F.replace("- Shared contract: x", "- Shared contract: `Record<Mode, Handler>`"),
      clean,
    ],
    ["a Lite gate without G4 fails", L.replace(/^- G4 .*\n/m, ""), has(/G4/)],
    ["a Lite G8 without a size fails", L.replace(/→ S\b/, "→ later"), has(/G8/)],
    [
      "a Hotfix gate without a due date fails",
      H.replace(/\d{4}-\d{2}-\d{2}/g, "soon"),
      has(/due date/),
    ],
  ];
  let failed = 0;
  for (const [name, text, ok] of cases) {
    const problems = check(text);
    if (ok(problems)) {
      console.log(`ok   ${name}`);
    } else {
      failed++;
      console.log(`FAIL ${name}\n     got: ${JSON.stringify(problems)}`);
    }
  }
  console.log(`self-test: ${cases.length - failed}/${cases.length} passed`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  if (argv[0] === "--self-test" && argv.length === 1) return selfTest();
  if (argv.length !== 1 || argv[0].startsWith("--")) {
    console.error("usage: check-gate.mjs <spec.md | -> | --self-test");
    return 2;
  }
  const where = argv[0] === "-" ? "stdin" : argv[0];
  let text;
  try {
    text = readFileSync(argv[0] === "-" ? 0 : argv[0], "utf8");
  } catch (e) {
    console.error(`check-gate: cannot read ${where}: ${e.message}`);
    return 2;
  }
  const problems = check(text);
  if (!problems.length) {
    console.log(`check-gate: PASS (${where})`);
    return 0;
  }
  console.log(`check-gate: FAIL (${where}): ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  [${p.kind}] ${p.msg}`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`check-gate: ${e.message}`);
  process.exitCode = 2;
}
