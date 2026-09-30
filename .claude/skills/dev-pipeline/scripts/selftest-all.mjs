#!/usr/bin/env node
// selftest-all.mjs -- ESM, zero deps, Node >= 18, Windows-safe (execFileSync array-form only).
// Runs dry-run.mjs, light-loop-dry-run.mjs, then --selftest on task-brief/review-pack/fix-brief.
// One "PASS <name>" / "FAIL <name>" line each; process.exitCode = 1 on any failure.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const RUNS = [
  { name: "dry-run.mjs", args: ["dry-run.mjs"] },
  { name: "light-loop-dry-run.mjs", args: ["light-loop-dry-run.mjs"] },
  { name: "task-brief.mjs", args: ["task-brief.mjs", "--selftest"] },
  { name: "review-pack.mjs", args: ["review-pack.mjs", "--selftest"] },
  { name: "fix-brief.mjs", args: ["fix-brief.mjs", "--selftest"] },
];

export function runAll() {
  let anyFailed = false;
  const lines = [];
  for (const r of RUNS) {
    let ok = true;
    try {
      execFileSync("node", r.args, { cwd: scriptsDir, stdio: "pipe" });
    } catch (e) {
      ok = false;
    }
    lines.push((ok ? "PASS " : "FAIL ") + r.name);
    if (!ok) anyFailed = true;
  }
  return { lines, failed: anyFailed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { lines, failed } = runAll();
  for (const l of lines) console.log(l);
  process.exitCode = failed ? 1 : 0;
}
