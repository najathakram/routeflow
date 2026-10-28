#!/usr/bin/env node
/**
 * R7-a pin: no routing instruction names the retired Fable model (owner ruling 2026-10-15: Opus holds every role
 * Fable had). Scans the files an agent reads as instructions: `.claude/agents/*.md`, `.claude/commands/*.md`,
 * `.claude/skills/<skill>/SKILL.md` and `.claude/skills/<skill>/templates/*.md`.
 *
 * - An agent definition with `model: fable` (or `claude-fable-*`) is always a hit: it routes a real call.
 * - Any other line naming Fable is a hit unless it is history: a HISTORY_MARKERS word on the same line, or in the
 *   blockquote the line sits in. Ruling records and measurements stay readable; instructions do not survive.
 *
 * Engine code (`pipeline.js` identifiers such as `CFG.models.fable`, `fableSafe`) is not scanned: renaming them
 * breaks resume of old run directories and changes no behaviour (nothing in the engine calls the model).
 *
 * `node scripts/no-fable-routing.mjs [--root <dir>]` prints each hit as file:line and exits 1 when there is one.
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A line (or its blockquote) carrying one of these records history, not an instruction. */
export const HISTORY_MARKERS = [
  /\bHISTORICAL\b/,
  /\bretired\b/i,
  /\bsuperseded\b/i,
  /\bnot used\b/i,
  /\bnot called\b/i,
  /\bnever fable\b/i,
  /\bno longer\b/i,
  /\bnever (?:use|call|route|spawn)/i,
  /\bruling 2026-10-15\b/i,
  /\bowner ruling 2026-10-15\b/i,
  /\bkept (?:only )?(?:as|for) history\b/i,
];

const FABLE_RE = /\bfable\b/i;
const AGENT_MODEL_RE = /^\s*model:\s*["']?(?:claude-)?fable/i;

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
    }
  return out.sort();
}

/** Hits in one file's text: [{ line, text, why }]. */
export function scanText(file, text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  const isAgent = file.startsWith(".claude/agents/");
  let quote = null; // text of the blockquote the current line belongs to
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) {
      if (quote === null) {
        let j = i;
        const block = [];
        while (j < lines.length && /^\s*>/.test(lines[j])) block.push(lines[j++]);
        quote = block.join("\n");
      }
    } else quote = null;
    if (isAgent && AGENT_MODEL_RE.test(l)) {
      hits.push({ line: i + 1, text: l.trim(), why: "agent routed to Fable" });
      continue;
    }
    if (!FABLE_RE.test(l)) continue;
    const context = quote === null ? l : `${l}\n${quote}`;
    if (HISTORY_MARKERS.some((re) => re.test(context))) continue;
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
