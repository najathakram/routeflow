#!/usr/bin/env node
// `npm run test:db -w apps/api` (#2183 / B592): the DB lane, always serial. A worker-count override
// (`--maxWorkers`, `-w`, or JEST_MAX_WORKERS, which fleet machines export for the unit lanes) would
// beat jest.db.config.js's `maxWorkers: 1` and run the shared-database specs in parallel, so this
// runner drops them and says so. Every other argument (a path, `-t`, `--ci`, ...) passes through.
// test/db-lane-serial.cjs refuses a parallel run that reaches jest some other way.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Splits the args into what jest gets and the worker overrides that were dropped. */
export function serialDbArgs(args) {
  const kept = [];
  const dropped = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--maxWorkers=/.test(a) || /^-w=?\d/.test(a)) {
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
  if (env.JEST_MAX_WORKERS) dropped.push(`JEST_MAX_WORKERS=${env.JEST_MAX_WORKERS}`);
  delete env.JEST_MAX_WORKERS;
  if (dropped.length) {
    console.warn(
      `run-db-tests: ignoring ${dropped.join(", ")}: the DB lane always runs serially ` +
        `(one shared database; B592, #2183).`,
    );
  }

  const jestBin = createRequire(import.meta.url).resolve("jest/bin/jest");
  const res = spawnSync(
    process.execPath,
    [jestBin, "-c", "jest.db.config.js", "--maxWorkers=1", ...kept],
    { cwd: apiDir, stdio: "inherit", env },
  );
  if (res.error) console.error(`run-db-tests: could not start jest: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
