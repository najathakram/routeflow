#!/usr/bin/env node
// `npm run test:db -w apps/api` (#2183 / B592): the DB lane, always serial. A CLI worker-count
// override (`--maxWorkers`, `-w`) would beat jest.db.config.js's `maxWorkers: 1` and run the
// shared-database specs in parallel, so this runner drops it, says so, and passes `--maxWorkers=1`
// itself. `--runInBand` / `-i` are dropped too: they are serial already, and jest refuses them
// alongside `--maxWorkers`. JEST_MAX_WORKERS is not read by jest at all — it is the fleet's knob,
// which scripts/verify-turbo.mjs turns into `--maxWorkers` for the unit lanes — so it is only
// cleared from this lane's environment, where nothing downstream can forward it. Every other
// argument (a path, `-t`, `--ci`, ...) passes through. test/db-lane-serial.cjs refuses a parallel
// run that reaches jest some other way.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Splits the args into what jest gets and the worker-count flags that were dropped. */
export function serialDbArgs(args) {
  const kept = [];
  const dropped = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--maxWorkers=/.test(a) || /^-w=?\d/.test(a) || a === "--runInBand" || a === "-i") {
      dropped.push(a);
    } else if (a === "--maxWorkers" || a === "-w") {
      dropped.push(i + 1 < args.length ? `${a} ${args[++i]}` : a);
    } else {
      kept.push(a);
    }
  }
  return { kept, dropped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { kept, dropped } = serialDbArgs(process.argv.slice(2));
  const env = { ...process.env };
  if (dropped.length) {
    console.warn(
      `run-db-tests: ignoring ${dropped.join(", ")}: the DB lane always runs serially ` +
        `with --maxWorkers=1 (one shared database; B592, #2183).`,
    );
  }
  // Not a jest variable (see the header): cleared so nothing this lane spawns can forward it.
  delete env.JEST_MAX_WORKERS;

  const jestBin = createRequire(import.meta.url).resolve("jest/bin/jest");
  const res = spawnSync(
    process.execPath,
    [jestBin, "-c", "jest.db.config.js", "--maxWorkers=1", ...kept],
    { cwd: apiDir, stdio: "inherit", env },
  );
  if (res.error) console.error(`run-db-tests: could not start jest: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
