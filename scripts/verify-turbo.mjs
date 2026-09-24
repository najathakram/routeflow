#!/usr/bin/env node
// The turbo step of `npm run verify`: check-types + lint + Jest (+ the api repo-truth tripwire).
//
// Affected scope is the DEFAULT on a non-master branch (scripts/lib/verify-scope.mjs): only the
// workspaces the diff reaches are checked, printed as "AFFECTED SCOPE: <workspaces>". master,
// CI, a detached HEAD, an uncomputable diff, a diff that touches a file feeding every workspace,
// and FULL_VERIFY=1 (the coordinator's landing run — the only override) run every workspace.
// A workspace whose campaign report is missing/partial/stale (`campaign-check --print-stale`) is
// added to a scoped run so its tests execute — see scripts/lib/verify-scope.mjs `withStale`.
// CI's full run is the authority.
import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { decideScope } from "./lib/verify-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Worker/concurrency caps (owner incident, 2026-09-22: an unbounded verify hit the Mac mini's
 * memory kill line in ~2 minutes — pressure 4, free 21%, swap 11.6 GB, load 17, 21-22 live
 * worker processes measured directly, not the naively-derived 18). Both env vars default to
 * exactly today's values — UNSET reproduces the prior behaviour byte-for-byte (same
 * `--concurrency=2`, same single bundled `check-types lint test` invocation, no passthrough
 * args at all), so CI (which sets neither) is bit-for-bit unchanged. See `buildTurboFlags` /
 * `jestPassthrough` below and their pins in `verify-turbo.self-test.mjs`.
 *
 * `JEST_MAX_WORKERS` was already being told to lanes tonight as the fix for exactly this
 * incident — nothing actually read it (jest has no such env var; this script read no env var
 * at all). This makes that belief true: forwarded to jest via `turbo run test -- --maxWorkers=N`
 * passthrough args, which turbo appends to the underlying `jest`/`jest --config ...` script of
 * EVERY task it runs in that invocation. `check-types` (tsc) and `lint` (eslint) do not
 * understand `--maxWorkers`, so `test`/`test:repo-truth` are NEVER in the same invocation as
 * `check-types`/`lint` once this is set — see `turboJest` vs `turbo` and their call sites below.
 *
 * RECOVERY, if a verify spikes memory again: killing only the jest worker processes is NOT
 * enough and looks like it worked while it doesn't — `--continue=dependencies-successful`
 * means turbo reads a killed task as one more failed task and, by design, moves on to the NEXT
 * task in the graph, spawning fresh jest workers seconds later (pressure drops, then ramps
 * straight back up). Kill the WHOLE tree — the root `npx turbo` process and every descendant
 * (Windows: `taskkill /T /F` on the npm/turbo parent's PID; Unix: the process group) — never
 * just the jest leaves. A live kill-mid-run process test would be slow, timing-sensitive and
 * platform-divergent for a fact this comment states outright; `verify-turbo.self-test.mjs`'s
 * SP-CONTINUE case instead pins that `--continue=dependencies-successful` — the flag this
 * recovery note depends on — is never silently dropped, which is the property that actually
 * matters and the one a code change could accidentally break.
 */
export function buildTurboFlags(verifyConcurrency) {
  return [`--concurrency=${verifyConcurrency || "2"}`, "--continue=dependencies-successful"];
}

/** `[]` (byte-identical to no passthrough at all) when unset; `["--", "--maxWorkers=<n>"]`
 *  when set — the `--` must be the LAST thing before it on the argv, after every turbo flag. */
export function jestPassthrough(jestMaxWorkers) {
  return jestMaxWorkers ? ["--", `--maxWorkers=${jestMaxWorkers}`] : [];
}

/** Pure argv builder (no spawn) so a self-test can assert the exact command line for every
 *  branch below without actually running turbo. */
export function buildArgv(args, turboFlags, passthrough = []) {
  return ["turbo", "run", ...args, ...turboFlags, ...passthrough];
}

/**
 * B772: the Mac mini is 16 GB — a bare `git push` there can't reach the memory-pressure
 * incident line (2026-09-22) unless VERIFY_CONCURRENCY=1 / JEST_MAX_WORKERS=2 are set inline,
 * which lanes forgot twice in one night. Below 24 GB total memory, default BOTH to the
 * incident's known-safe values when the env doesn't already set them — an explicit env value
 * always wins, independently per variable (a SET-BUT-EMPTY value, e.g. `VERIFY_CONCURRENCY=""`,
 * counts as an explicit opt-out — checked by presence, `"X" in env`, never by truthiness).
 *
 * CI is EXCLUDED from the low-memory default entirely (`env.CI` truthy), never by its own
 * memory size: GitHub's standard `ubuntu-latest` runner is ~16 GB on a public repo and ~7 GB on
 * a private one (GitHub's own docs) — both are UNDER this threshold, not over it, so CI would
 * silently get concurrency 1 / --maxWorkers=2 (and the split-invocation code path) without this
 * exclusion, breaking the "CI is bit-for-bit unchanged" promise the original worker-cap comment
 * above already makes, and costing Actions minutes against the 20-minute timeout. On CI (no
 * explicit override), both resolve to `""`, byte-identical to today's raw
 * `process.env.X || ""` read — never trimmed, so a whitespace-only explicit value on ANY host
 * (including a real >=24 GB one) is preserved exactly as `process.env.X || ""` always has been.
 */
export const LOW_MEM_THRESHOLD_BYTES = 24 * 1024 ** 3;
const LOW_MEM_VERIFY_CONCURRENCY = "1";
const LOW_MEM_JEST_MAX_WORKERS = "2";

/** Pure — no env/os read inside. `env` is a plain object (e.g. `process.env`); `totalMemBytes`
 *  is the host's total memory in bytes (e.g. `os.totalmem()`). Returns the two resolved values
 *  plus `message` (a single explanatory line) — `null` when nothing was defaulted, so CI, a
 *  real high-memory host, or an already-fully-explicit low-memory host prints nothing new. */
export function chooseVerifyDefaults({ totalMemBytes, env }) {
  const hasEnvConcurrency = "VERIFY_CONCURRENCY" in env;
  const hasEnvJestWorkers = "JEST_MAX_WORKERS" in env;
  const envConcurrency = env.VERIFY_CONCURRENCY || "";
  const envJestWorkers = env.JEST_MAX_WORKERS || "";
  const isLowMem = !env.CI && totalMemBytes < LOW_MEM_THRESHOLD_BYTES;

  const defaultedConcurrency = isLowMem && !hasEnvConcurrency;
  const defaultedJestWorkers = isLowMem && !hasEnvJestWorkers;

  const verifyConcurrency = hasEnvConcurrency
    ? envConcurrency
    : defaultedConcurrency
      ? LOW_MEM_VERIFY_CONCURRENCY
      : "";
  const jestMaxWorkers = hasEnvJestWorkers
    ? envJestWorkers
    : defaultedJestWorkers
      ? LOW_MEM_JEST_MAX_WORKERS
      : "";

  let message = null;
  if (defaultedConcurrency || defaultedJestWorkers) {
    const gb = Math.round(totalMemBytes / 1024 ** 3);
    message = `verify: low-memory host (${gb} GB) → concurrency ${verifyConcurrency}, jest workers ${jestMaxWorkers}`;
  }

  return { verifyConcurrency, jestMaxWorkers, message };
}

/**
 * Everything below is side-effecting (reads env, spawns real processes, calls `process.exit`) —
 * kept behind `main()` and the direct-execution guard at the bottom so `verify-turbo.self-test.mjs`
 * can `import` the pure builders above without ALSO running a real verify (an ES module runs its
 * top-level body on first import; without this guard, importing this file for its exports would
 * spawn `npx turbo` and call `process.exit` inside the test process). Same pattern as
 * `scripts/janitor.mjs`.
 */
export function main() {
  const defaults = chooseVerifyDefaults({ totalMemBytes: totalmem(), env: process.env });
  if (defaults.message) console.log(defaults.message);
  const JEST_MAX_WORKERS = defaults.jestMaxWorkers;
  const VERIFY_CONCURRENCY = defaults.verifyConcurrency;
  const TURBO_FLAGS = buildTurboFlags(VERIFY_CONCURRENCY);

  function turbo(args) {
    const r = spawnSync("npx", buildArgv(args, TURBO_FLAGS), {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return r.status ?? 1;
  }

  /** Like `turbo`, but for a jest-only task (`test`/`test:repo-truth`) — appends the
   *  `--maxWorkers` passthrough when `JEST_MAX_WORKERS` is set, appends nothing (byte-identical
   *  argv to plain `turbo`) when it is not. NEVER call this with `check-types`/`lint` in `args`. */
  function turboJest(args) {
    const r = spawnSync("npx", buildArgv(args, TURBO_FLAGS, jestPassthrough(JEST_MAX_WORKERS)), {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return r.status ?? 1;
  }

  const scope = decideScope(ROOT);

  if (scope.mode === "full") {
    console.log(`FULL SCOPE (${scope.reason}) — every workspace`);
    if (!JEST_MAX_WORKERS) {
      process.exit(turbo(["check-types", "lint", "test", "test:repo-truth"]));
    }
    // JEST_MAX_WORKERS is set: split check-types/lint from test/test:repo-truth so the
    // --maxWorkers passthrough only ever reaches jest, never tsc/eslint.
    const ctLint = turbo(["check-types", "lint"]);
    const testAll = turboJest(["test", "test:repo-truth"]);
    process.exit(ctLint || testAll);
  }

  console.log(
    `AFFECTED SCOPE: ${scope.workspaces.join(", ")} (changed: ${scope.changed.join(", ") || "none"}; ` +
      `always-run tripwires: @routeflow/pricing tests, @routeflow/api test:repo-truth). ` +
      `FULL_VERIFY=1 runs everything.`,
  );
  if (scope.stale?.length) {
    console.log(
      `+ STALE REPORTS: ${scope.stale.join(", ")} — campaign-check would refuse their report, so ` +
        `their tests join the run (turbo regenerates the report on a cache miss; the --freshness-only pre-step forces a real run on a hit). No enforcement is relaxed.`,
    );
  }
  const filters = scope.workspaces.map((w) => `--filter=${w}`);
  // Keep going after a failure so one push reports every red workspace, like the full chain does.
  // Only apps/api defines test:repo-truth today; a second workspace adding one must be added here.
  let first, second;
  if (!JEST_MAX_WORKERS) {
    first = turbo(["check-types", "lint", "test", ...filters]);
    second = turbo(["test:repo-truth", "--filter=@routeflow/api"]);
  } else {
    // Both calls always run (never `A() || B()`) so a check-types/lint failure can't skip the
    // jest run and hide its results from one push's report — same "report every red workspace"
    // property the unsplit default path gets from a single bundled invocation.
    const ctLint = turbo(["check-types", "lint", ...filters]);
    const testOnly = turboJest(["test", ...filters]);
    first = ctLint || testOnly;
    second = turboJest(["test:repo-truth", "--filter=@routeflow/api"]);
  }
  process.exit(first || second);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
