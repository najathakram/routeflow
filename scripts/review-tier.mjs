#!/usr/bin/env node
// Review tier of a PR from facts: path risk class (risk-class.mjs) and counted lines (lib/pr-size.mjs).
// Tier 1 = two independent PASSes (a red/black path, or > WARN_AT counted lines), tier 2 = one; only a
// change wholly outside apps/ packages/ scripts/ .github/ and green is a lead read. Every path is
// classified; size exclusions apply to the count alone. REVIEW_TIER_MODE "dark": exit 0 always (2 = usage).
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as riskLib from "./lib/risk-paths.mjs";
import { WARN_AT, countLines, parseNumstatZ, rowsFromGhFiles } from "./lib/pr-size.mjs";
import { GH_REPO, ghRun, gitIn } from "./pr-size.mjs";
import { classifyMax, diffSince, loadBaseLib } from "./risk-class.mjs";

export const REVIEW_TIER_MODE = "dark";
const RED_SHOWN = 5;
const CODE_ROOT = /^(?:apps|packages|scripts|\.github)\//;
const USAGE =
  "usage: review-tier.mjs [--base <ref>] [--json] | --pr <n> [--json]\n" +
  "  --pr misses rename sources and is capped at 100 files: prefer the git mode.";

/** Strict parse; returns { error } for any unknown flag or missing value. */
export function parseArgs(argv) {
  const o = { base: null, pr: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--base" || a === "--pr") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      o[a.slice(2)] = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (o.pr !== null && !/^\d+$/.test(o.pr)) return { error: "--pr must be a PR number" };
  if (o.pr !== null && o.base) return { error: "--pr is exclusive with --base" };
  return o;
}

/** The one tier rule. red: the paths above amber. leadRead: green and outside the code roots. */
export function tierOf({ cls, counted, red = [], leadRead = false }) {
  const lines = `${counted} counted lines`;
  if (red.length) {
    const more = red.length > RED_SHOWN ? ` +${red.length - RED_SHOWN}` : "";
    const shown = red.slice(0, RED_SHOWN).join(", ") + more;
    return { tier: 1, reason: `two independent PASSes (${cls}: ${shown}; ${lines})` };
  }
  if (cls === "green" && leadRead)
    return { tier: 2, reason: `docs: lead read, no agent (${lines})` };
  if (cls !== "green" && counted > WARN_AT)
    return { tier: 1, reason: `two independent PASSes (${lines} > ${WARN_AT})` };
  return { tier: 2, reason: `one PASS (${cls}; ${lines})` };
}

function decide(rows, files, libs) {
  const c = classifyMax(libs, files);
  const cls = files.length ? c.cls : "amber";
  const red = c.files.filter((f) => riskLib.exceeds(f.cls, "amber")).map((f) => f.path);
  const leadRead = files.length > 0 && files.every((f) => !CODE_ROOT.test(f));
  const { counted } = countLines(rows);
  return { ...tierOf({ cls, counted, red, leadRead }), cls, counted };
}

async function gitMode(o, git) {
  const ref = o.base ?? "origin/master";
  const d = diffSince(git, ref);
  const rows = parseNumstatZ(git(["diff", "--numstat", "-z", "-M", `${d.base}..HEAD`]));
  let libs = [riskLib];
  try {
    const base = [await loadBaseLib(git, d.base), await loadBaseLib(git, ref)].filter(Boolean);
    if (base.length) libs = base;
  } catch {
    // keep the judge checkout's rules
  }
  return decide(rows, d.files, libs);
}

function prMode(o, gh) {
  const j = JSON.parse(gh(["pr", "view", o.pr, "--repo", GH_REPO, "--json", "files"]));
  const rows = rowsFromGhFiles(j.files);
  return decide(
    rows,
    rows.map((r) => r.path),
    [riskLib],
  );
}

export async function main(argv = process.argv.slice(2), { git, gh, log = console } = {}) {
  const o = parseArgs(argv);
  if (o.error) {
    log.error(`review-tier: ${o.error}\n${USAGE}`);
    return 2;
  }
  try {
    const m = o.pr !== null ? prMode(o, gh ?? ghRun) : await gitMode(o, git ?? gitIn());
    if (o.json) log.log(JSON.stringify({ ...m, mode: REVIEW_TIER_MODE }));
    else log.log(`review-tier: ${m.tier} — ${m.reason}`);
  } catch (e) {
    // Dark never fails anything.
    log.error(`review-tier: cannot compute: ${String(e.stderr || e.message).trim()}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
