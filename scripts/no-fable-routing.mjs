#!/usr/bin/env node
/**
 * R7-a pin: no routing instruction names the retired Fable model (owner ruling 2026-10-15: Opus holds every role
 * Fable had). Scans the files an agent reads as instructions: `.claude/agents/*.md`, `.claude/commands/*.md`,
 * `.claude/skills/<skill>/SKILL.md`, `.claude/skills/<skill>/templates/*.md` and `.claude/skills/<skill>/references/*.md`
 * (append-only logs such as RUN-LOG.md excepted).
 *
 * - An agent definition with `model: fable` (or `claude-fable-*`) is always a hit: it routes a real call.
 * - Any other line naming Fable is a hit unless it is history: every clause that names Fable carries a HISTORY_MARKERS
 *   word (clauses split at . ; ! ? brackets and dashes), or the line, or the blockquote it sits in, opens with a
 *   HISTORICAL banner, or its section heading says HISTORICAL (until the next heading of that level or higher). Ruling records and measurements stay readable; instructions do not survive.
 *
 * Engine code (`pipeline.js` identifiers such as `CFG.models.fable`, `fableSafe`) is not scanned: renaming them
 * breaks resume of old run directories and changes no behaviour (nothing in the engine calls the model).
 *
 * `node scripts/no-fable-routing.mjs [--root <dir>]` prints each hit as file:line and exits 1 when there is one.
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A clause carrying one of these records history, not an instruction. */
export const HISTORY_MARKERS = [
  /\bHISTORICAL\b/,
  /\bretired\b/i,
  /\bsupersed(?:e|es|ed)\b/i,
  /\b(?:do|does|did) not use\b/i,
  /\bremoved\b/i,
  /\bvoid\b/i,
  /\bnot used\b/i,
  /\bnot called\b/i,
  /\bnever fable\b/i,
  /\bany ?more\b/i,
  /\bno longer\b/i,
  /\bnever (?:use|call|route|spawn)/i,
  /\bkept (?:only )?(?:as|for) history\b/i,
  // A clause that maps a Fable role onto Opus is the ruling itself, not a routing to Fable.
  /\b(?:held by|is|are|read as|read|becomes) [*_"`]*Opus\b/i,
];

// FABLE-PROMPTING.md is a file name (its snippets apply to Opus), not a mention of the model.
const FABLE_RE = /\bfable\b(?!-PROMPTING)/i;
const AGENT_MODEL_RE = /^\s*model:\s*["']?(?:claude-)?fable/i;
// A marker excuses only the clause it sits in: "use Fable — the old tier is retired" is still an instruction.
// A period ends a clause only before a space, so "5.1" and ".md" stay whole.
const CLAUSE_SPLIT = /\.(?=\s|$)|[;!?()–—]|\s-\s/;
// A line that OPENS with this banner is history.
const BANNER_RE = /^\s*>?\s*[*_[]*\s*HISTORICAL\b/;
// A blockquote, or a paragraph inside one (after a bare ">" line), is history only when it opens with a FORMATTED
// banner (`**HISTORICAL`, `[HISTORICAL`): a plain "> HISTORICAL note." covers its own line, not the lines after it.
const SCOPE_BANNER_RE = /^\s*>\s*[*_[]+\s*HISTORICAL\b/;
// Append-only logs record what happened; they are never read as instructions.
const LOG_FILES = new Set(["RUN-LOG.md", "CATCHES.md", "ENGINE-NOTES.md", "BUGFIX-NOTES.md"]);

/** Every clause of the line that names Fable carries a history marker (or the line opens with the banner). */
function lineIsHistory(l) {
  if (BANNER_RE.test(l)) return true;
  return l
    .replace(/\bfable([\w .-]{0,12})\(([^()]*)\)/gi, "Fable$1 $2") // "Fable 5.1 (retired)" is one clause
    .split(CLAUSE_SPLIT)
    .filter((c) => FABLE_RE.test(c))
    .every((c) => HISTORY_MARKERS.some((re) => re.test(c)));
}

/** Instruction files under `root`, as repo-relative forward-slash paths. */
export function instructionFiles(root) {
  const out = [];
  const md = (dir) =>
    existsSync(path.join(root, dir))
      ? readdirSync(path.join(root, dir))
          .filter((f) => f.endsWith(".md"))
          .map((f) => `${dir}/${f}`)
      : [];
  out.push(...md(".claude/agents"), ...md(".claude/commands"));
  const skills = path.join(root, ".claude", "skills");
  if (existsSync(skills))
    for (const s of readdirSync(skills).sort()) {
      if (existsSync(path.join(skills, s, "SKILL.md"))) out.push(`.claude/skills/${s}/SKILL.md`);
      out.push(...md(`.claude/skills/${s}/templates`));
      out.push(
        ...md(`.claude/skills/${s}/references`).filter((f) => !LOG_FILES.has(path.basename(f))),
      );
    }
  return out.sort();
}

/** Hits in one file's text: [{ line, text, why }]. */
export function scanText(file, text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  const isAgent = file.startsWith(".claude/agents/");
  let quoteIsHistory = false; // the blockquote the current line sits in opened with the HISTORICAL banner
  let historyLevel = 0; // inside a section whose heading (this level) says HISTORICAL; 0 = not
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const inQuote = /^\s*>/.test(l);
    const prev = lines[i - 1] ?? "";
    if (inQuote && (!/^\s*>/.test(prev) || /^\s*>\s*$/.test(prev)))
      quoteIsHistory = SCOPE_BANNER_RE.test(l);
    if (!inQuote) quoteIsHistory = false;
    const heading = l.match(/^(#{1,6})\s/);
    if (heading) {
      const level = heading[1].length;
      if (historyLevel && level <= historyLevel) historyLevel = 0;
      if (/\bHISTORICAL\b/.test(l)) historyLevel = level;
    }
    if (isAgent && AGENT_MODEL_RE.test(l)) {
      hits.push({ line: i + 1, text: l.trim(), why: "agent routed to Fable" });
      continue;
    }
    if (!FABLE_RE.test(l)) continue;
    if (historyLevel || quoteIsHistory || lineIsHistory(l)) continue;
    hits.push({
      line: i + 1,
      text: l.trim().slice(0, 140),
      why: "names Fable without a history marker",
    });
  }
  return hits;
}

export function scanRepo(root) {
  const out = [];
  for (const f of instructionFiles(root))
    for (const h of scanText(f, readFileSync(path.join(root, f), "utf8")))
      out.push({ file: f, ...h });
  return out;
}

const isCli = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isCli()) {
  const i = process.argv.indexOf("--root");
  const root =
    i > 0
      ? path.resolve(process.argv[i + 1])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const hits = scanRepo(root);
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.why}: ${h.text}`);
  console.log(`no-fable-routing: ${hits.length} hit(s)`);
  process.exit(hits.length ? 1 : 0);
}
