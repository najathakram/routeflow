#!/usr/bin/env node
// Fleet-lead learning loop. No dependencies. Subcommands:
//   log      --what "<symptom>" --cause "<root cause>" --guard "<structural guard>" [--rule "<candidate rule>"] [--anchor "<B123|SA-045|L-207|#1234>"]
//   digest   [--n 12]         print the last N log entries, candidate counts, promotions due, stale rules
//   check                     validate SKILL.md size, rule provenance, log entry shape (exit 1 on failure)
//   promote  --rule "<text>"  mark a candidate promoted and print the rule block to paste into SKILL.md
// Data lives beside the skill: references/LEAD-LOG.md (append-only), references/RULE-CANDIDATES.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SKILL = join(root, "SKILL.md");
const REFS = join(root, "references");
const LOG = join(REFS, "LEAD-LOG.md");
const CANDIDATES = join(REFS, "RULE-CANDIDATES.md");
const SKILL_MAX_BYTES = 16 * 1024;
const PROMOTE_AT = 3; // a candidate seen in 3+ entries becomes a rule (same threshold as the pipeline law)
const STALE_DAYS = 45; // a rule whose anchor is never cited in the log for this long is flagged for archive

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const today = () => new Date().toISOString().slice(0, 10);
const ensure = () => {
  if (!existsSync(REFS)) mkdirSync(REFS, { recursive: true });
  if (!existsSync(LOG))
    writeFileSync(
      LOG,
      "# Fleet-lead log (append-only)\n\nOne entry per caught failure or reverted approach, written IN THE MOMENT, never at the end.\nFormat: `## <date> <anchor>` then `- what:` `- cause:` `- guard:` `- rule:` (optional candidate).\n\n",
    );
  if (!existsSync(CANDIDATES))
    writeFileSync(
      CANDIDATES,
      "# Rule candidates\n\nA candidate becomes a SKILL.md rule after it appears in 3 log entries. `promoted:` lines are kept for provenance.\n\n",
    );
};
const readLog = () => {
  ensure();
  const text = readFileSync(LOG, "utf8");
  const entries = [];
  const re = /^## (\d{4}-\d{2}-\d{2}) ?(.*)$/gm;
  let m;
  const idx = [];
  while ((m = re.exec(text))) idx.push({ pos: m.index, date: m[1], anchor: m[2].trim() });
  for (let i = 0; i < idx.length; i++) {
    const body = text.slice(idx[i].pos, i + 1 < idx.length ? idx[i + 1].pos : undefined);
    const field = (k) => (body.match(new RegExp(`^- ${k}:\\s*(.*)$`, "m")) || [])[1]?.trim() ?? "";
    entries.push({
      date: idx[i].date,
      anchor: idx[i].anchor,
      what: field("what"),
      cause: field("cause"),
      guard: field("guard"),
      rule: field("rule"),
      body,
    });
  }
  return entries;
};
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

if (cmd === "log") {
  ensure();
  const what = opt("what"),
    cause = opt("cause"),
    guard = opt("guard");
  if (!what || !cause || !guard) {
    console.error(
      "log needs --what, --cause and --guard (the guard is the structural fix, never 'be careful')",
    );
    process.exit(2);
  }
  if (/\bbe (more )?careful\b/i.test(guard)) {
    console.error(
      "refusing: the guard must be structural (a check, a script, a hook, a field), not 'be careful'",
    );
    process.exit(2);
  }
  const rule = opt("rule", ""),
    anchor = opt("anchor", "");
  const entry = `## ${today()} ${anchor}\n- what: ${what}\n- cause: ${cause}\n- guard: ${guard}\n${rule ? `- rule: ${rule}\n` : ""}\n`;
  appendFileSync(LOG, entry);
  if (rule) {
    const c = readFileSync(CANDIDATES, "utf8");
    const key = norm(rule);
    const seen = readLog().filter((e) => norm(e.rule) === key).length;
    if (!c.includes(key))
      appendFileSync(CANDIDATES, `- candidate: ${rule}\n  key: ${key}\n  first: ${today()}\n`);
    console.log(
      `logged; candidate seen ${seen}x${seen >= PROMOTE_AT ? " — PROMOTION DUE: run promote --rule" : ""}`,
    );
  } else console.log("logged");
  process.exit(0);
}

if (cmd === "digest" || cmd === undefined) {
  const n = Number(opt("n", 12));
  const entries = readLog();
  const skill = existsSync(SKILL) ? readFileSync(SKILL, "utf8") : "";
  console.log(
    `fleet-lead digest — ${entries.length} log entries, SKILL.md ${Buffer.byteLength(skill)} B`,
  );
  for (const e of entries.slice(-n))
    console.log(
      `- ${e.date} ${e.anchor || ""} | ${e.what.slice(0, 90)} → guard: ${e.guard.slice(0, 70)}`,
    );
  const counts = new Map();
  for (const e of entries)
    if (e.rule) counts.set(norm(e.rule), (counts.get(norm(e.rule)) || 0) + 1);
  const cands = existsSync(CANDIDATES) ? readFileSync(CANDIDATES, "utf8") : "";
  const due = [...counts].filter(([k, c]) => c >= PROMOTE_AT && !cands.includes(`promoted: ${k}`));
  if (due.length) {
    console.log("\nPROMOTIONS DUE (seen 3+ times, not yet a rule):");
    for (const [k, c] of due)
      console.log(`  ${c}x  ${entries.find((e) => norm(e.rule) === k)?.rule}`);
  }
  // stale rules: anchors cited in SKILL.md that the log has not touched for STALE_DAYS
  const anchors = [
    ...new Set(
      (skill.match(/\((?:B\d{2,4}|SA-\d{3}|L-\d{3}|#\d{3,5}|R-\d{3})\)/g) || []).map((a) =>
        a.slice(1, -1),
      ),
    ),
  ];
  const cutoff = Date.now() - STALE_DAYS * 86400e3;
  const logAge = entries.length ? Date.now() - new Date(entries[0].date).getTime() : 0;
  if (logAge >= STALE_DAYS * 86400e3) {
    const stale = anchors.filter(
      (a) =>
        !entries.some(
          (e) =>
            (e.anchor.includes(a) || e.body.includes(a)) && new Date(e.date).getTime() >= cutoff,
        ),
    );
    if (stale.length)
      console.log(
        `\nRules with anchors not cited in the log for ${STALE_DAYS}d (consider archiving): ${stale.join(", ")}`,
      );
  }
  process.exit(0);
}

if (cmd === "check") {
  const problems = [];
  if (!existsSync(SKILL)) problems.push("SKILL.md missing");
  const skill = existsSync(SKILL) ? readFileSync(SKILL, "utf8") : "";
  const bytes = Buffer.byteLength(skill);
  if (bytes > SKILL_MAX_BYTES)
    problems.push(`SKILL.md is ${bytes} B > ${SKILL_MAX_BYTES} B cap — archive or tighten`);
  if (!/^## 1\. The one failure class/m.test(skill))
    problems.push("SKILL.md lost its §1 (the failure class)");
  if (!/## \d+\. Learning loop/m.test(skill))
    problems.push("SKILL.md has no Learning loop section");
  // provenance: every bullet under §2 and §3 must carry at least one anchor or a dated incident word
  const sec = (title) => {
    const m = skill.match(new RegExp(`^## \\d+\\. ${title}[\\s\\S]*?(?=^## \\d+\\. |\\Z)`, "m"));
    return m ? m[0] : "";
  };
  const bullets = [...sec("Standing rules").matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1]);
  const anchored = (line) =>
    /\((?:B\d{2,4}|SA-\d{3}|L-\d{3}|#\d{3,5}|R-\d{3}|SA-E\d{2})\)|20\d{2}-\d{2}-\d{2}|#\d{3,5}|B\d{3}|SA-\d{3}/.test(
      line,
    );
  // a bullet spans its continuation lines (indented) — judge provenance on the whole bullet
  const rules = sec("Standing rules")
    .split(/\n(?=- )/)
    .filter((b) => b.startsWith("- "));
  for (const b of rules)
    if (!anchored(b))
      problems.push(
        `rule without provenance in §2: "${b.slice(0, 70)}…" — add (Bnnn|SA-nnn|L-nnn|#PR) or the incident date`,
      );
  for (const e of readLog()) {
    if (!e.what || !e.cause || !e.guard)
      problems.push(`log entry ${e.date} ${e.anchor} is missing what/cause/guard`);
    if (/\bbe (more )?careful\b/i.test(e.guard))
      problems.push(`log entry ${e.date} ${e.anchor} has a non-structural guard`);
  }
  void bullets;
  if (problems.length) {
    console.error("fleet-lead check FAILED:\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log(`fleet-lead check OK — SKILL.md ${bytes} B, ${readLog().length} log entries`);
  process.exit(0);
}

if (cmd === "promote") {
  ensure();
  const rule = opt("rule");
  if (!rule) {
    console.error("promote needs --rule");
    process.exit(2);
  }
  const key = norm(rule);
  const seen = readLog().filter((e) => norm(e.rule) === key);
  if (seen.length < PROMOTE_AT) {
    console.error(`not yet: seen ${seen.length}x, promotion at ${PROMOTE_AT}`);
    process.exit(1);
  }
  appendFileSync(CANDIDATES, `promoted: ${key} (${today()}, ${seen.length}x)\n`);
  const anchors = [...new Set(seen.map((e) => e.anchor).filter(Boolean))].join(", ");
  console.log(
    `Paste into SKILL.md §2:\n- **${rule}** (${anchors || seen.map((e) => e.date).join(", ")}).`,
  );
  process.exit(0);
}

console.error("usage: lead-closeout.mjs log|digest|check|promote");
process.exit(2);
