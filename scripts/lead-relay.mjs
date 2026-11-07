#!/usr/bin/env node
// lead-relay.mjs: orders a lead turn's outgoing messages so an owner decision is never the one that does not arrive.
// Lead-log W-1096 (2026-11-01): the app paused lead messaging after 10 sends in one turn, and the owner's answer, sent
// last, never reached the lanes. Guard: owner decisions go first and are written to their item before any routing.
//
//   node scripts/lead-relay.mjs <plan.json>            dry run: prints the rf commands and the send order
//   node scripts/lead-relay.mjs <plan.json> --apply    records each decision with `rf event owner-decision` first
//   add --json for the plan as JSON
//
// plan.json is an array of messages:
//   { "to": "<session>", "text": "...", "kind": "owner-decision", "item": "W-1096",
//     "question": "...", "answer": "...", "recommended": "..." }     (recommended is optional)
//   { "to": "<session>", "text": "..." }                                a routing message (any other kind)
// The script never sends: the lead sends the list in the order printed, through its own message tool. It only orders,
// splits at the per-turn cap (decisions always in this turn) and records the decisions.
//
// Exit codes: 0 = ordered (and recorded with --apply); 1 = a decision could not be recorded (nothing to send yet:
// record first); 2 = a usage or plan error.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RF = path.join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs");
/** Sends per turn before the app pauses lead messaging (W-1096 saw the pause at 10). One under, to keep a margin. */
export const TURN_CAP = 9;

const isDecision = (m) => m?.kind === "owner-decision";

/** Throws on a plan the lead could misread: every message needs `to` and `text`; a decision its item and Q/A. */
export function validatePlan(plan) {
  if (!Array.isArray(plan)) throw new Error("plan: expected a JSON array of messages");
  plan.forEach((m, i) => {
    const at = `plan[${i}]`;
    if (!m || typeof m !== "object") throw new Error(`${at}: not an object`);
    if (!String(m.to ?? "").trim()) throw new Error(`${at}: "to" is required`);
    if (!String(m.text ?? "").trim()) throw new Error(`${at}: "text" is required`);
    if (isDecision(m))
      for (const k of ["item", "question", "answer"])
        if (!String(m[k] ?? "").trim()) throw new Error(`${at}: an owner-decision needs "${k}"`);
  });
  return plan;
}

/**
 * { now, later }: decisions first (in plan order), then routing messages (in plan order), cut at `cap`. Decisions are
 * never deferred, even past the cap: a late decision is the failure this exists for.
 */
export function orderTurn(plan, cap = TURN_CAP) {
  const decisions = plan.filter(isDecision);
  const routing = plan.filter((m) => !isDecision(m));
  const room = Math.max(cap - decisions.length, 0);
  return { now: [...decisions, ...routing.slice(0, room)], later: routing.slice(room) };
}

/** The rf argv that records one decision on its item. */
export function decisionArgs(m) {
  const args = ["event", "owner-decision", "--question", m.question, "--answer", m.answer];
  if (m.recommended) args.push("--recommended", m.recommended);
  args.push(m.item);
  return args;
}

const firstLine = (t) => String(t).split("\n")[0].slice(0, 100);

export function main(
  argv = process.argv.slice(2),
  { runRf = defaultRunRf, out = console.log } = {},
) {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node scripts/lead-relay.mjs <plan.json> [--apply] [--json]");
    return 2;
  }
  let plan;
  try {
    plan = validatePlan(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const apply = argv.includes("--apply");
  const { now, later } = orderTurn(plan);
  const decisions = now.filter(isDecision);
  for (const m of decisions) {
    const args = decisionArgs(m);
    if (!apply) {
      out(`would record: node tools/ops-monitor/bin/rf.mjs ${args.map(shellQuote).join(" ")}`);
      continue;
    }
    const r = runRf(args);
    if (r.status !== 0) {
      console.error(
        `record failed for ${m.item} (rf exit ${r.status}): ${firstLine(r.stderr ?? "")}`,
      );
      console.error("nothing to send yet: record the decision first, then re-run");
      return 1;
    }
    out(`recorded: owner decision on ${m.item}`);
  }
  if (argv.includes("--json")) {
    out(JSON.stringify({ now, later }, null, 2));
    return 0;
  }
  out(`\nsend this turn, in order (${now.length}):`);
  now.forEach((m, i) =>
    out(`  ${i + 1}. ${isDecision(m) ? "[decision] " : ""}${m.to}: ${firstLine(m.text)}`),
  );
  if (later.length) {
    out(`\nnext turn (${later.length}; over the ${TURN_CAP}-send cap):`);
    later.forEach((m, i) => out(`  ${i + 1}. ${m.to}: ${firstLine(m.text)}`));
  }
  if (!apply && decisions.length)
    out("\ndry run: re-run with --apply to record the decisions before sending");
  return 0;
}

function defaultRunRf(args) {
  return spawnSync(process.execPath, [RF, ...args], { cwd: ROOT, encoding: "utf8" });
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
