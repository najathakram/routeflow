#!/usr/bin/env node
// A workspace's `test:repo-truth` lane (apps/web, apps/mobile, packages/scanning): runs, with that workspace's own
// Jest, every spec of THIS workspace that reads another workspace's source. The list is derived
// (scripts/lib/cross-workspace-specs.cjs), never hand-kept; apps/api builds its lane from the same derivation in
// jest.repo-truth.config.js. Why a lane at all: `jest --changedSince` follows imports, not fs reads, so a spec that
// walks packages/ui is not "related" to a change there (see cross-workspace-lane.spec.ts).
//
// usage (cwd = the workspace, as an npm script has it): node ../../scripts/run-cross-workspace-specs.mjs [jest args...]
//         --list   print the specs and exit 0 (used by the self-check)
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { findCrossWorkspaceSpecs } = require("./lib/cross-workspace-specs.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.cwd();
const ws = path.relative(root, cwd).split(path.sep).join("/");
const args = process.argv.slice(2);
const specs = (findCrossWorkspaceSpecs(root)[ws] || []).map((s) => path.join(cwd, s.spec));

if (args.includes("--list")) {
  for (const s of specs) console.log(path.relative(root, s).split(path.sep).join("/"));
  process.exit(0);
}
if (!specs.length) {
  console.log(`test:repo-truth: no cross-workspace specs in ${ws}`);
  process.exit(0);
}
console.log(`test:repo-truth: ${specs.length} cross-workspace spec(s) in ${ws}`);
// No shell: web's route groups put parentheses in paths.
// jest's package "exports" hides bin/jest.js: find the bin through its package.json.
const jestPkg = createRequire(path.join(cwd, "package.json")).resolve("jest/package.json");
const jest = path.join(path.dirname(jestPkg), "bin", "jest.js");
// --reporters=default: web and mobile configure the campaign reporter, which would overwrite
// .campaign/runs/<ws>.json with only THIS lane's few specs and turn campaign-check falsely PARTIAL (the api lane's
// jest.repo-truth.config.js drops it the same way).
const r = spawnSync(
  process.execPath,
  [jest, "--reporters=default", "--runTestsByPath", ...specs, ...args],
  {
    cwd,
    stdio: "inherit",
    env: process.env,
  },
);
process.exit(r.status ?? 1);
