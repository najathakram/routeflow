#!/usr/bin/env node
// `npm test -w apps/api` (#2192): the parallel unit pool first, then the spawn-heavy script specs
// (`*-script.spec.ts`) serially, so their child processes never compete with the pool's workers
// for CPU (#2146, #2176). Both lanes always run; the exit code is the first non-zero one.
//
// Arguments pass through to BOTH jest runs (a path or `-t` filter narrows each lane), except the
// worker-count flags (`--maxWorkers`, `-w`, `--runInBand`, `-i`), which only the parallel lane
// takes — the script lane is serial by config (jest.scripts.config.js).
//
// RF_CAMPAIGN_RUN_ID ties the two runs' campaign artifact together: the parallel run stamps it
// on .campaign/runs/api.json and the script lane's reporter merges into that file only when the
// stamp matches (scripts/jest-campaign-reporter.cjs). A caller-provided id is kept.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jestBin = createRequire(import.meta.url).resolve("jest/bin/jest");

/** The args the serial lane keeps: everything except the worker-count flags (and their value). */
export function scriptLaneArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--maxWorkers(=|$)/.test(a) || a === "-w" || /^-w=?\d/.test(a)) {
      if ((a === "--maxWorkers" || a === "-w") && i + 1 < args.length) i++;
      continue;
    }
    if (a === "--runInBand" || a === "-i") continue;
    out.push(a);
  }
  return out;
}

/** True when the args narrow which tests run: a positional path pattern or a name filter. */
export function isFiltered(args) {
  return args.some(
    (a) =>
      !a.startsWith("-") ||
      a === "-t" ||
      /^--(testNamePattern|testPathPatterns?|findRelatedTests|onlyChanged|changedSince)(=|$)/.test(
        a,
      ),
  );
}

function jest(args, env) {
  const res = spawnSync(process.execPath, [jestBin, ...args], {
    cwd: apiDir,
    stdio: "inherit",
    env,
  });
  if (res.error) {
    console.error(`run-unit-tests: could not start jest: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const env = {
    ...process.env,
    RF_CAMPAIGN_RUN_ID: process.env.RF_CAMPAIGN_RUN_ID || randomUUID(),
  };

  // A filtered run (a path or `-t`) may match files in only one lane; the other lane must not
  // fail on "No tests found". An unfiltered run keeps jest's default, so an empty lane stays red.
  const filtered = isFiltered(scriptLaneArgs(args)) ? ["--passWithNoTests"] : [];

  const pool = jest([...args, ...filtered], env);
  console.log("\nrun-unit-tests: script specs (serial lane, jest.scripts.config.js)\n");
  const scripts = jest(["-c", "jest.scripts.config.js", ...scriptLaneArgs(args), ...filtered], env);
  process.exit(pool || scripts);
}
