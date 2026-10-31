#!/usr/bin/env node
// One command for a train coordinator's pre-check, so nobody picks specs by hand (W31 lost 40 minutes to a hand-picked
// list that left out api-error-codes-parity). Run it on the assembled train head BEFORE the full verify:
//
//   npm run train:precheck            run every step, exit with the first non-zero status
//   npm run train:precheck -- --dry-run   print the commands only
//
// Steps (all run, none short-circuits, so one push reports every red):
//   1. tsc          turbo check-types, every workspace
//   2. repo-truth   turbo test:repo-truth, every workspace that defines it: the DERIVED cross-workspace spec list
//                   (scripts/lib/cross-workspace-specs.cjs) plus the size ratchet and the other repo pins
//   3. repo pins    every `*.pin.spec.ts` / `*.pin.test.ts` in EVERY workspace, found by rule, run with that workspace's
//                   own Jest, plus the known repo-wide pin specs (REPO_WIDE_PINS). A pin a train member adds is run the
//                   day it lands, with no list edit: W32 went red because a member's new money pin broke a sibling
//                   member's code and nobody had run it against the assembled head.
//   4. named gates  enum parity and permission-coverage (and the two cheap registries), api's own Jest, by name.
//                   A gate whose name matches NO spec FAILS the run (a rename used to drop it silently under
//                   --passWithNoTests); only a gate listed in GATES_ARRIVING is skipped, loudly, until its PR lands.
// Takes the machine-wide heavy slot like verify does. Contract pinned by train-precheck-script.spec.ts.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { withHeavySlot } from "./lib/heavy-slot.mjs";
import { REPO_WIDE_PINS } from "./lib/verify-scope.mjs";

const { workspaceDirs } = createRequire(import.meta.url)("./lib/cross-workspace-specs.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Specs run by name in apps/api (main config). Pure data; the spec pins that the lead's four are all here. */
export const NAMED_GATES = [
  "enum-parity",
  "permission-coverage",
  "addon-gate-registry",
  "no-bare-cron",
];

/**
 * Gates whose spec is not on master yet, with the PR that adds it. Skipped (and said so) only while the name matches
 * nothing; delete the entry when the PR lands, and the gate is required from then on.
 */
export const GATES_ARRIVING = { "permission-coverage": "#3799" };

const PIN_FILE = /\.pin\.(spec|test)\.[cm]?[tj]sx?$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  ".expo",
  "coverage",
  ".turbo",
  ".jest-cache",
]);

function walk(dir, rel, accept, out) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), `${rel}${e.name}/`, accept, out);
    } else if (accept(e.name)) out.push(`${rel}${e.name}`);
  }
}

/** { "apps/api": ["src/x/y.pin.spec.ts", ...], "apps/web": [...] }: the pin specs of every workspace, by rule. */
export function findPinSpecs(root = ROOT) {
  const found = {};
  for (const ws of workspaceDirs(root)) {
    const files = [];
    walk(path.join(root, ws), "", (name) => PIN_FILE.test(name), files);
    if (ws === "apps/api") {
      for (const p of REPO_WIDE_PINS) files.push(p.file.replace(/^apps\/api\//, ""));
    }
    if (files.length) found[ws] = [...new Set(files)].sort();
  }
  return found;
}

/** { present, arriving, missing }: NAMED_GATES with a spec under apps/api/src, skipped by name, and renamed away. */
export function resolveGates(root = ROOT) {
  const specs = [];
  walk(path.join(root, "apps", "api", "src"), "", (name) => name.endsWith(".spec.ts"), specs);
  const present = [];
  const arriving = [];
  const missing = [];
  for (const gate of NAMED_GATES) {
    if (specs.some((s) => s.includes(gate))) present.push(gate);
    else if (GATES_ARRIVING[gate]) arriving.push(gate);
    else missing.push(gate);
  }
  return { present, arriving, missing };
}

/** The ordered steps. `cwd` is relative to the repo root. */
export function planPrecheck(root = ROOT) {
  const turbo = ["turbo", "run"];
  const flags = ["--concurrency=2", "--continue=dependencies-successful"];
  const quote = (p) => (process.platform === "win32" ? `"${p}"` : p);
  const steps = [
    { name: "tsc", cwd: ".", cmd: "npx", args: [...turbo, "check-types", ...flags] },
    { name: "repo-truth", cwd: ".", cmd: "npx", args: [...turbo, "test:repo-truth", ...flags] },
  ];
  for (const [ws, files] of Object.entries(findPinSpecs(root))) {
    steps.push({
      name: `repo pins ${ws}`,
      cwd: ws,
      cmd: "npx",
      args: ["jest", "--maxWorkers=2", "--runTestsByPath", ...files.map(quote)],
    });
  }
  const { present } = resolveGates(root);
  if (present.length) {
    steps.push({
      name: "named gates",
      cwd: "apps/api",
      cmd: "npx",
      args: ["jest", "--maxWorkers=2", ...present],
    });
  }
  return steps;
}

export function main(argv = process.argv.slice(2)) {
  const rootAt = argv.indexOf("--root"); // a fixture tree, for the spec's red rows
  const root = rootAt >= 0 ? path.resolve(argv[rootAt + 1]) : ROOT;
  const steps = planPrecheck(root);
  const gates = resolveGates(root);
  const dry = argv.includes("--dry-run");
  const run = () => {
    let code = 0;
    for (const g of gates.arriving) {
      console.log(
        `named gate ${g}: no spec on this tree yet, skipped until ${GATES_ARRIVING[g]} lands`,
      );
    }
    for (const g of gates.missing) {
      console.log(
        `named gate ${g}: matches NO spec under apps/api/src (renamed or deleted?). Restore it or fix NAMED_GATES.`,
      );
      code = 1;
    }
    for (const s of steps) {
      console.log(
        `\n== train pre-check: ${s.name} ==\n> ${s.cmd} ${s.args.join(" ")}  (cwd ${s.cwd})`,
      );
      if (dry) continue;
      const r = spawnSync(s.cmd, s.args, {
        cwd: path.join(root, s.cwd),
        stdio: "inherit",
        env: process.env,
        shell: process.platform === "win32",
      });
      const status = r.status ?? 1;
      console.log(`== ${s.name}: ${status === 0 ? "ok" : `FAILED (exit ${status})`}`);
      if (status !== 0 && code === 0) code = status;
    }
    console.log(
      code === 0 ? "\ntrain pre-check: all green" : `\ntrain pre-check: RED (exit ${code})`,
    );
    return code;
  };
  return dry
    ? Promise.resolve(run())
    : withHeavySlot({ label: "train-precheck" }, async () => run());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(e?.name === "HeavySlotTimeout" ? 75 : 1);
    },
  );
}
