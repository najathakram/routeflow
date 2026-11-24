// Local pre-push fail-fast (SA-1251 F3). One switch, RF_VERIFY_FAIL_FAST=1, exported by .husky/pre-push. Unset (CI, a bare
// `npm run verify`) nothing here is used and the plan runs every call, exactly as before.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const FAIL_FAST_ENV = "RF_VERIFY_FAIL_FAST";
export const TAIL_LINES = 40;

/**
 * Workspaces whose lint peak RSS is above 2 GB keep their lint inside the heavy slot (phase 0 skips them). Phase 0 itself
 * adds about 1 GB outside the slot (web lint max RSS 1.00 GB, measured by the R-25 read; the 0.36 GB first figure
 * was a sampling undercount), at verify concurrency 1.
 * { "<workspace name>": "<measured peak RSS>" }. Measured once on the PC (2026-11-23).
 */
/**
 * Phase 0 builds the workspace packages first, then lints. A package's tsc-lint (scanning) needs another package's built
 * types, which the slot's bundled call gets through turbo's `^build` edge; a bare `turbo run lint` on a tree with no
 * package `dist` fails with a false TS2307. Packages only (tsc builds, cached): never the apps' builds.
 */
export const PHASE0_PREBUILD = { jest: false, args: ["build", "--filter=./packages/*"] };

export const LINT_IN_SLOT = { "@routeflow/api": "3.64 GB" };

export const isFailFast = (env) => env[FAIL_FAST_ENV] === "1";

/** Phase 0 runs before the heavy slot, unless a caller already holds it (then lint runs inside it, as today). */
export function phase0Call(calls, { env, heavy = LINT_IN_SLOT }) {
  if (!isFailFast(env) || env.RF_HEAVY_SLOT_TOKEN) return null;
  const first = calls.find((c) => !c.jest && !c.pins && !c.fsRead && c.args.includes("lint"));
  if (!first) return null;
  const filters = first.args.filter((a) => a.startsWith("--filter="));
  const names = Object.keys(heavy);
  const positive = filters.filter((f) => !f.startsWith("--filter=!"));
  let out;
  if (positive.length) {
    out = positive.filter((f) => !names.includes(f.slice("--filter=".length)));
    if (!out.length) return null;
  } else {
    out = [...filters, ...names.map((n) => `--filter=!${n}`)];
  }
  return { jest: false, args: ["lint", ...out] };
}

/** The task words of a call (its args before the first flag). */
export const callTasks = (c) => c.args.filter((a) => !a.startsWith("-")).join(" ");

/** One line per planned call that never ran, after a fail-fast stop. */
export function notRunLines(calls, ran) {
  if (ran.length >= calls.length || ran.length === 0) return [];
  const after = callTasks(calls[ran.length - 1]);
  return calls
    .slice(ran.length)
    .map((c) => `verify: ${callTasks(c)}: not run (stopped after ${after})`);
}

export const tailLines = (text, n = TAIL_LINES) =>
  text
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .slice(-n)
    .join("\n");

/** Tasks with a non-zero exit in a turbo run summary: [{ taskId, logFile }]. */
export function failedTasks(summary) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  return tasks
    .filter((t) => Number.isInteger(t?.execution?.exitCode) && t.execution.exitCode !== 0)
    .map((t) => ({
      taskId: t.taskId,
      logFile: t.logFile ?? (t.directory ? `${t.directory}/.turbo/turbo-${t.task}.log` : null),
    }));
}

/**
 * Lines naming each failed task of the newest run summary written after `sinceMs`, each with the tail of its log.
 * No summary: one line saying so. Never throws; the caller's exit code is unchanged.
 */
export function failureReport(root, sinceMs) {
  const none = ["verify: failing task unknown; see the output above"];
  try {
    const dir = join(root, ".turbo", "runs");
    if (!existsSync(dir)) return none;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .filter((x) => x.t >= sinceMs)
      .sort((a, b) => b.t - a.t);
    if (!files.length) return none;
    const failed = failedTasks(JSON.parse(readFileSync(join(dir, files[0].f), "utf8")));
    if (!failed.length) return none;
    return failed.flatMap(({ taskId, logFile }) => {
      const p = logFile && join(root, logFile);
      const tail = p && existsSync(p) ? tailLines(readFileSync(p, "utf8")) : "(no log file found)";
      return [`FAILED: ${taskId}`, tail];
    });
  } catch {
    return none;
  }
}
