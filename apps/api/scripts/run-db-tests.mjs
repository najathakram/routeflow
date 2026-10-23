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
import { spawn, spawnSync } from "node:child_process";
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

/**
 * W-699: the hard ceiling on one DB-lane run. A run that never exits (an open handle after
 * "Tests:") holds the machine's heavy slot for every other lane, so the runner kills it. 60 min by
 * default; RF_DB_LANE_TIMEOUT_MIN (a positive integer up to MAX_DB_LANE_TIMEOUT_MIN) overrides
 * it. Anything else throws.
 */
// setTimeout takes at most 2^31-1 ms; a larger delay overflows and fires at once (40000 min fired
// after 72 ms), so the ceiling is the largest whole minute below it.
export const MAX_DB_LANE_TIMEOUT_MIN = Math.floor((2 ** 31 - 1) / 60_000);

export function dbLaneTimeoutMs(env) {
  const raw = env.RF_DB_LANE_TIMEOUT_MIN;
  if (raw === undefined || raw === "") return 60 * 60_000;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MAX_DB_LANE_TIMEOUT_MIN) {
    throw new Error(
      `RF_DB_LANE_TIMEOUT_MIN must be a positive whole number of minutes up to ` +
        `${MAX_DB_LANE_TIMEOUT_MIN}, got "${raw}"`,
    );
  }
  return Number(raw) * 60_000;
}

/** True while any process in POSIX process group `pgid` is still alive. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Kills `pid` and every process it started. Best-effort: a tree that is already gone is fine. */
function killTree(pid, platform) {
  try {
    if (platform === "win32") {
      // Node already ends a killed child's own children on Windows (job object); /T also reaches
      // a detached one.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

/**
 * W-723: runs `command` and kills its WHOLE process tree after `timeoutMs`. spawnSync's `timeout`
 * kills only the direct child, so on Linux/macOS a CLI that a spec spawned (a script under test, a
 * prisma CLI) outlived jest and kept its connection to the throwaway database and the heavy slot.
 * On POSIX the child leads its own process group (and session), so a terminal's or ssh's signals
 * no longer reach it directly: SIGINT, SIGTERM and SIGHUP sent to this runner are forwarded to the
 * group (without SIGHUP, a closed terminal killed the runner and its timer and left jest running
 * with no ceiling). Once the child exits, for any reason, whatever is left of the group is killed
 * and awaited, so nothing still holds the database when local-db-specs.mjs drops it.
 * Resolves `{ status, signal, timedOut }`.
 */
export function runWithHardTimeout(command, args, opts = {}) {
  const { timeoutMs, platform = process.platform, ...spawnOpts } = opts;
  const posix = platform !== "win32";
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", ...spawnOpts, detached: posix });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, platform);
    }, timeoutMs);
    const forward = (sig) => {
      try {
        if (posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const signals = posix ? ["SIGINT", "SIGTERM", "SIGHUP"] : [];
    for (const s of signals) process.on(s, forward);
    child.on("error", (error) => {
      clearTimeout(timer);
      for (const s of signals) process.off(s, forward);
      resolve({ status: null, signal: null, timedOut, error });
    });
    child.on("exit", async (status, signal) => {
      clearTimeout(timer);
      for (const s of signals) process.off(s, forward);
      if (posix && groupAlive(child.pid)) {
        killTree(child.pid, platform);
        // Capped: where no init reaps orphans (this runner as PID 1 in a bare container), SIGKILLed
        // members linger as zombies that still answer kill(0) although they hold nothing.
        const deadline = Date.now() + 10_000;
        while (groupAlive(child.pid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      resolve({ status, signal, timedOut });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { kept, dropped } = serialDbArgs(process.argv.slice(2));
  let timeoutMs;
  try {
    timeoutMs = dbLaneTimeoutMs(process.env);
  } catch (e) {
    console.error(`run-db-tests: ${e.message}`);
    process.exit(2);
  }
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
  const res = await runWithHardTimeout(
    process.execPath,
    [jestBin, "-c", "jest.db.config.js", "--maxWorkers=1", ...kept],
    { cwd: apiDir, env, timeoutMs },
  );
  if (res.timedOut) {
    console.error(
      `run-db-tests: killed jest after ${timeoutMs / 60_000} min (W-699 hard timeout). If "Tests:" ` +
        `had printed, a spec left an open handle; RF_DB_LANE_TIMEOUT_MIN raises the ceiling.`,
    );
    process.exit(124);
  }
  if (res.error) console.error(`run-db-tests: could not start jest: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
