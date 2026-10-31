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
//
// FAST VERIFY (owner ruling 2026-10-10, "Fast local check, full in CI"): when the pre-push hook has
// exported RF_VERIFY_MODE=fast (scripts/verify-mode.mjs decides: not CI, not master/detached,
// FULL_VERIFY unset) the plan keeps check-types + lint for the affected scope but runs Jest with
// `--changedSince=<merge-base with origin/master>` — only the tests related to the diff. The two
// always-run tripwires stay FULL (`@routeflow/pricing` tests, api `test:repo-truth`). CI, master,
// FULL_VERIFY=1 and a bare `npm run verify` (no RF_VERIFY_MODE) are byte-identical to before. See
// `planTurboCalls({ fast })`, `argvForCall` and `chooseRunMode` below.
import { cpus as osCpus, totalmem } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawnAsync, withHeavySlot } from "./lib/heavy-slot.mjs";
import { RESULT_FILE_ENV, clearStage, stageRun } from "./lib/verify-result.mjs";
import {
  FAST_VERIFY_BANNER,
  REPO_WIDE_PINS,
  SCRIPT_SPEC_PATTERN,
  changedFilesSince,
  currentBranch,
  decideScope,
  fastStampLine,
  isFastMode,
  loadScriptSpecs,
  loadWorkspaces,
  mergeBaseSha,
  repoPinsNeeded,
  selectScriptSpecs,
  wantsFastVerify,
} from "./lib/verify-scope.mjs";
import { prismaPreflight } from "./lib/prisma-fresh.mjs";

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
 *  when set — the `--` must be the LAST thing before it on the argv, after every turbo flag.
 *  FAST VERIFY adds `--changedSince=<sha> --passWithNoTests` (jest-only flags: a workspace with no
 *  related test must pass, not exit 1 "No tests found"); `changedSince` must be a 40-hex sha. */
export function jestPassthrough(jestMaxWorkers, changedSince) {
  const flags = [];
  if (jestMaxWorkers) flags.push(`--maxWorkers=${jestMaxWorkers}`);
  if (changedSince) {
    if (!/^[0-9a-f]{40}$/.test(changedSince)) {
      throw new Error(
        `verify: refusing a non-sha --changedSince base ${JSON.stringify(String(changedSince).slice(0, 60))}`,
      );
    }
    flags.push(`--changedSince=${changedSince}`, "--passWithNoTests");
  }
  return flags.length ? ["--", ...flags] : [];
}

/** Pure argv builder (no spawn) so a self-test can assert the exact command line for every
 *  branch below without actually running turbo. */
export function buildArgv(args, turboFlags, passthrough = []) {
  return ["turbo", "run", ...args, ...turboFlags, ...passthrough];
}

/**
 * VERIFY_EXCLUDE (lead ruling 2026-10-01): a comma-separated list of workspace names that THIS run
 * does not verify because CI verifies them in their OWN job (`.github/workflows/control.yml` for
 * `@routeflow/control`). ci.yml's Verify step sets it; developers do NOT, so a local FULL_VERIFY
 * and the pre-push affected scope still run control.
 *
 * ALLOW-LIST, not a free list: only EXACTLY the names in `VERIFY_EXCLUDE_ALLOWED` are accepted and
 * anything else is REFUSED LOUDLY (a thrown Error, `main()` exits 1 before any turbo call), so a
 * later ci.yml edit, a typo or a hostile value can never silently exclude api, web or anything else
 * from the shared Verify. Widening the list is a deliberate edit of this file (and its self-test).
 *
 * Pure. Trims each entry, drops empties and duplicates (first appearance wins). An allow-listed
 * name that is absent from `knownNames` (the workspace was removed) is dropped: nothing to exclude.
 * A non-string (the variable is unset) is `[]`.
 */
export const VERIFY_EXCLUDE_ALLOWED = Object.freeze(["@routeflow/control"]);
export function parseVerifyExclude(raw, knownNames) {
  if (typeof raw !== "string") return [];
  const known = knownNames ? new Set(knownNames) : null;
  const out = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (!VERIFY_EXCLUDE_ALLOWED.includes(name)) {
      throw new Error(
        `VERIFY_EXCLUDE may only name ${VERIFY_EXCLUDE_ALLOWED.join(", ")} (CI verifies that ` +
          `workspace in its own job); refusing ${JSON.stringify(name.slice(0, 60))}. Widening the ` +
          `allow-list is a deliberate edit of scripts/verify-turbo.mjs.`,
      );
    }
    if (known && !known.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The one line printed when something is excluded; `null` (print nothing) when nothing is. */
export function excludedLine(excluded) {
  return excluded.length
    ? `EXCLUDED FROM THIS RUN (separate CI job): ${excluded.join(", ")}`
    : null;
}

/**
 * Pure planner for every turbo call a run makes (no spawn, no env), so the self-test can assert the
 * exact argv for FULL/AFFECTED x unsplit/split x excluded/not. `splitJest` is "JEST_MAX_WORKERS is
 * set": check-types/lint and the jest tasks then go in separate invocations so the `--maxWorkers`
 * passthrough (`jest: true` calls) never reaches tsc/eslint. Returns `{ calls: [{ jest, args }], note }`
 * in execution order; the caller runs every call and exits with the first non-zero status.
 *
 * With `excluded` empty the calls are byte-identical to the pre-VERIFY_EXCLUDE ones.
 *  - FULL: turbo's "only negative filters = everything except those", so each call gets
 *    `--filter=!<name>` per excluded workspace.
 *  - AFFECTED: the selection already is a positive filter list, so excluded names are simply dropped
 *    from it (a negative filter next to positive ones would WIDEN the run, never narrow it). If no
 *    workspace is left that call is skipped; the api `test:repo-truth` tripwire is skipped only if
 *    api itself is excluded. `note` is set when no call is left at all.
 */
export function planTurboCalls({ scope, excluded = [], splitJest, fast = false, pins = null }) {
  const drop = new Set(excluded);
  if (fast) return withPins(planFastCalls({ scope, drop, excluded }), pins, drop);
  if (scope.mode === "full") {
    const negatives = excluded.map((name) => `--filter=!${name}`);
    return splitJest
      ? {
          calls: [
            { jest: false, args: ["check-types", "lint", ...negatives] },
            { jest: true, args: ["test", "test:repo-truth", ...negatives] },
          ],
          note: null,
        }
      : {
          calls: [
            { jest: false, args: ["check-types", "lint", "test", "test:repo-truth", ...negatives] },
          ],
          note: null,
        };
  }
  const filters = scope.workspaces.filter((w) => !drop.has(w)).map((w) => `--filter=${w}`);
  const API = "@routeflow/api";
  const calls = [];
  // Only apps/api defines test:repo-truth today; a second workspace adding one must be added here.
  const repoTruth = drop.has(API) ? [] : ["--filter=" + API];
  if (!splitJest) {
    if (filters.length)
      calls.push({ jest: false, args: ["check-types", "lint", "test", ...filters] });
    if (repoTruth.length) calls.push({ jest: false, args: ["test:repo-truth", ...repoTruth] });
  } else {
    if (filters.length) {
      calls.push({ jest: false, args: ["check-types", "lint", ...filters] });
      calls.push({ jest: true, args: ["test", ...filters] });
    }
    if (repoTruth.length) calls.push({ jest: true, args: ["test:repo-truth", ...repoTruth] });
  }
  return {
    calls,
    note: calls.length
      ? null
      : `nothing left to verify after the exclusions (${excluded.join(", ")}) — no turbo calls`,
  };
}

/**
 * FAST VERIFY plan (owner 2026-10-10). Same scope selection as above, but jest is never bundled with
 * tsc/eslint and only the `test` task of the NON-tripwire workspaces is narrowed:
 *   1. check-types + lint              — exactly the affected-scope call (no jest flags ever);
 *   2. `test` with `changedSince: true` — the related-only run (main appends --changedSince=<sha>);
 *   3. `@routeflow/pricing` `test`      — the cross-workspace tripwire stays FULL;
 *   4. api `test:repo-truth`            — the structural-pin tripwire stays FULL.
 * `changedSince` is set on call 2 ONLY — never on a `jest: false` call and never on a tripwire.
 */
const PRICING = "@routeflow/pricing";
function planFastCalls({ scope, drop, excluded }) {
  const API = "@routeflow/api";
  const calls = [];
  if (scope.mode === "full") {
    const negatives = excluded.map((name) => `--filter=!${name}`);
    calls.push({ jest: false, args: ["check-types", "lint", ...negatives] });
    // "only negative filters = everything except those": all workspaces but pricing (its own full call).
    calls.push({
      jest: true,
      changedSince: true,
      args: ["test", `--filter=!${PRICING}`, ...negatives],
    });
    if (!drop.has(PRICING)) calls.push({ jest: true, args: ["test", `--filter=${PRICING}`] });
    calls.push({ jest: true, args: ["test:repo-truth", ...negatives] });
    return { calls, note: null };
  }
  const selected = scope.workspaces.filter((w) => !drop.has(w));
  const filters = selected.map((w) => `--filter=${w}`);
  const related = selected.filter((w) => w !== PRICING).map((w) => `--filter=${w}`);
  if (filters.length) calls.push({ jest: false, args: ["check-types", "lint", ...filters] });
  if (related.length) calls.push({ jest: true, changedSince: true, args: ["test", ...related] });
  if (selected.includes(PRICING)) calls.push({ jest: true, args: ["test", `--filter=${PRICING}`] });
  if (!drop.has(API)) calls.push({ jest: true, args: ["test:repo-truth", `--filter=${API}`] });
  return {
    calls,
    note: calls.length
      ? null
      : `nothing left to verify after the exclusions (${excluded.join(", ")}) — no turbo calls`,
  };
}

/**
 * FAST only: a diff that can break a repo-wide pin (`repoPinsNeeded`) appends ONE jest call, run from
 * apps/api, over `REPO_WIDE_PINS` plus the `-script` specs `pins.scriptSpecs` names (an array from
 * `selectScriptSpecs`; anything else, incl. `pins: true`, means ALL via `SCRIPT_SPEC_PATTERN`). `pins`
 * falsy leaves the plan untouched; a failure here fails the push.
 */
function withPins(plan, pins, drop) {
  if (!pins || drop.has("@routeflow/api")) return plan;
  const files = [
    ...REPO_WIDE_PINS.map((p) => p.file.replace(/^apps\/api\//, "")),
    ...(Array.isArray(pins.scriptSpecs) ? pins.scriptSpecs : [SCRIPT_SPEC_PATTERN]),
  ];
  // "--" ends the array option: --testPathIgnorePatterns would otherwise swallow every file as one
  // more ignore pattern and jest would run the whole api suite.
  // --runInBand: these specs spawn real children and time out under parallel load (#2146, #2176), so
  // the pin call is serialized the way jest.scripts.config.js (maxWorkers 1) runs the -script set.
  // Every flag sits BEFORE "--": anything after it is a path pattern.
  const argv = [
    "jest",
    "--testPathIgnorePatterns=/node_modules/",
    "--runInBand",
    "--",
    ...new Set(files),
  ];
  return { ...plan, calls: [...plan.calls, { pins: true, cwd: "apps/api", argv }] };
}

/**
 * The argv of one planned call (pure). jest calls get the `--` passthrough (`--maxWorkers` when set,
 * `--changedSince=<sha> --passWithNoTests` on a related-only call); `jest: false` calls (tsc/eslint)
 * get NOTHING after the turbo flags, whatever else is configured.
 */
export function argvForCall(call, { turboFlags, jestMaxWorkers, changedSince }) {
  if (!call.jest) return buildArgv(call.args, turboFlags);
  return buildArgv(
    call.args,
    turboFlags,
    jestPassthrough(jestMaxWorkers, call.changedSince ? changedSince : undefined),
  );
}

/**
 * Pure: may this run be FAST? `requested` = the explicit switch (RF_VERIFY_MODE=fast, already checked
 * against CI/FULL_VERIFY by `isFastMode`) AND the branch policy; `mergeBase` = the sha the related-only
 * filter needs. Requested but no merge-base -> FULL plan, with a loud message (never a silent narrow).
 */
export function chooseRunMode({ requested, mergeBase }) {
  if (!requested) return { fast: false, changedSince: null, message: null };
  if (!mergeBase) {
    return {
      fast: false,
      changedSince: null,
      message:
        "FAST VERIFY UNAVAILABLE: cannot compute the merge-base with origin/master — falling back to the FULL plan (every test of the selected scope).",
    };
  }
  return { fast: true, changedSince: mergeBase, message: FAST_VERIFY_BANNER };
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

/** `max(2, floor(cpus * 0.75 / concurrency))`: jest workers per test task on a roomy shared host. */
export function jestWorkerBudget({ cpus, concurrency }) {
  return Math.max(2, Math.floor((cpus * 0.75) / concurrency));
}

/** Pure — no env/os read inside. `env` is a plain object (e.g. `process.env`); `totalMemBytes`
 *  is the host's total memory in bytes (e.g. `os.totalmem()`); `cpus` the logical cpu count (e.g.
 *  `os.cpus().length`; omitted/invalid = no worker budget). Returns the two resolved values
 *  plus `message` (a single explanatory line) — `null` when nothing was defaulted, so CI, a
 *  real high-memory host, or an already-fully-explicit low-memory host prints nothing new. */
export function chooseVerifyDefaults({ totalMemBytes, env, cpus }) {
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

  // Worker budget for a >= 24 GB, non-CI host whose JEST_MAX_WORKERS is not in env (a presence check,
  // like every other rule here): jest's own default is cpus-1 workers PER test task, and turbo runs
  // VERIFY_CONCURRENCY (2) tasks at once, so a bare push on a 14-cpu box asked for ~26 workers and
  // starved every other job on the host. Budget ~75% of the cpus across the concurrent tasks.
  const hasBudgetInputs = Number.isInteger(cpus) && cpus > 0;
  if (!env.CI && !isLowMem && !hasEnvJestWorkers && hasBudgetInputs) {
    const parsed = Number.parseInt(verifyConcurrency, 10);
    const concurrency = Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
    const workers = jestWorkerBudget({ cpus, concurrency });
    return {
      verifyConcurrency,
      jestMaxWorkers: String(workers),
      message: `verify: worker budget → jest workers ${workers} per task (cpus ${cpus}, concurrency ${concurrency})`,
    };
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
/**
 * FAST only: do the repo pins run, and what does the run print about it? Fails CLOSED: a diff that
 * cannot be computed (`files` null) runs the pins rather than skipping them. VERIFY_EXCLUDE naming
 * api drops the pins (they are api specs), with no line. `pins: null` means "plan none".
 */
export function planPins({ fast, files, excluded = [], specs }) {
  if (!fast || excluded.includes("@routeflow/api")) return { pins: null, line: null };
  if (files === null) {
    return {
      pins: true,
      scriptSpecs: "all",
      line: "+ REPO PINS: cannot diff against origin/master, so the pin specs and ALL -script specs run (fail closed).",
    };
  }
  if (!repoPinsNeeded(files)) return { pins: null, line: null };
  const picked = selectScriptSpecs({ files, specs: specs ?? loadScriptSpecs(ROOT) });
  return {
    pins: true,
    scriptSpecs: picked.files,
    scriptLine: picked.line,
    line: `+ REPO PINS: this diff can break a repo-wide pin, so ${REPO_WIDE_PINS.length} pin specs and the related -script specs run too.`,
  };
}

/**
 * Runs every planned call in order (never short-circuits); the first non-zero status is the run's. A status that is not
 * a number (null from a signal) is a failure, never a pass: `null ?? 0` used to read as green (W-1045). `ran` receives
 * every status so the caller can prove all planned calls finished green.
 */
export async function executePlan(calls, runCall, ran = []) {
  for (const c of calls) ran.push(await runCall(c));
  const i = ran.findIndex((s) => s !== 0); // not find(): an undefined status must not look like "none"
  return i === -1 ? 0 : typeof ran[i] === "number" ? ran[i] : 1;
}

/**
 * Whether this run settles its campaign reports inside the slot. campaign-check's pre-step predicts
 * a cache miss before the queue, and the shared turbo cache can fill during the wait, so turbo
 * replays the task and no report is written. The check at the end of the chain then forces those
 * tests outside any slot, where the slot log can't see the load. A fast run enforces no reports,
 * a failed plan has already lost, and CI holds no slot, so its end-of-chain check does this.
 */
export function settlesReports({ fast, status, env }) {
  return status === 0 && !fast && !env.CI;
}

/** The last line of a fast run is the not-proof stamp; any other run prints nothing new. */
export function finishRun({ fast, status, log = console.log }) {
  const stamp = fastStampLine(fast);
  if (stamp) log(stamp);
  return status;
}

export async function main() {
  // W-1045: any pass stage already on disk was not written by THIS run; a run that then runs nothing must not inherit it.
  clearStage(process.env);
  const defaults = chooseVerifyDefaults({
    totalMemBytes: totalmem(),
    env: process.env,
    cpus: osCpus().length,
  });
  if (defaults.message) console.log(defaults.message);
  const JEST_MAX_WORKERS = defaults.jestMaxWorkers;
  const VERIFY_CONCURRENCY = defaults.verifyConcurrency;
  const TURBO_FLAGS = buildTurboFlags(VERIFY_CONCURRENCY);

  // Awaited async spawns (not spawnSync): the heavy-slot heartbeat is a timer and must keep firing
  // for the whole turbo run, or a long verify would look dead and lose its slot.
  async function turbo(args) {
    const r = await spawnAsync("npx", buildArgv(args, TURBO_FLAGS), {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return r.status ?? 1;
  }

  /** Like `turbo`, but for a jest-only task (`test`/`test:repo-truth`) — appends the
   *  `--maxWorkers` passthrough when `JEST_MAX_WORKERS` is set, appends nothing (byte-identical
   *  argv to plain `turbo`) when it is not. NEVER call this with `check-types`/`lint` in `args`. */
  async function turboJest(args, changedSince) {
    const r = await spawnAsync(
      "npx",
      buildArgv(args, TURBO_FLAGS, jestPassthrough(JEST_MAX_WORKERS, changedSince)),
      { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
    );
    return r.status ?? 1;
  }

  /** The repo-pin call: plain jest from apps/api, the same way the repo runs its specs by hand. */
  async function pinJest(c) {
    // No --maxWorkers here: the argv is already serialized (--runInBand), and a flag appended after
    // the "--" separator would be read as a path pattern.
    const r = await spawnAsync("npx", c.argv, {
      cwd: join(ROOT, c.cwd),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return r.status ?? 1;
  }

  const scope = decideScope(ROOT);
  // FAST VERIFY: the explicit switch (hook-exported RF_VERIFY_MODE=fast) + the branch policy + a
  // computable merge-base. Anything else is the unchanged plan.
  const runMode = chooseRunMode({
    requested:
      isFastMode(process.env) && wantsFastVerify({ env: process.env, branch: currentBranch(ROOT) }),
    mergeBase: mergeBaseSha(ROOT),
  });
  if (runMode.message) console.log(runMode.message);
  let excluded;
  try {
    excluded = parseVerifyExclude(
      process.env.VERIFY_EXCLUDE,
      loadWorkspaces(ROOT).map((w) => w.name),
    );
  } catch (e) {
    // refuse BEFORE any turbo call: a bad exclusion list must never run a narrowed verify
    console.error(`verify: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const banner = excludedLine(excluded);
  if (banner) console.log(banner);

  if (scope.mode === "full") {
    console.log(`FULL SCOPE (${scope.reason}) — every workspace`);
  } else {
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
  }

  // Every planned call always runs (never `A() || B()`) so a check-types/lint failure can't skip
  // the jest run and hide its results from one push's report — a single bundled invocation gives the
  // unsplit path that property by itself. With JEST_MAX_WORKERS set the calls are split so the
  // --maxWorkers passthrough only ever reaches jest, never tsc/eslint. Exit = first non-zero status.
  let pins = null;
  if (runMode.fast) {
    const planned = planPins({ fast: true, files: changedFilesSince(ROOT), excluded });
    pins = planned.pins ? { scriptSpecs: planned.scriptSpecs } : null;
    if (planned.line) console.log(planned.line);
    if (planned.scriptLine) console.log(planned.scriptLine);
  }
  const plan = planTurboCalls({
    scope,
    excluded,
    splitJest: Boolean(JEST_MAX_WORKERS),
    fast: runMode.fast,
    pins,
  });
  if (plan.note) console.log(plan.note);
  // Fail fast BEFORE queueing for the slot: a generated Prisma client that predates this checkout's
  // schema folder otherwise surfaces ~45 min into the hold (api check-types + schema specs red).
  // Seconds, offline, skipped on CI. See scripts/lib/prisma-fresh.mjs.
  const prisma = prismaPreflight({
    env: process.env,
    scope,
    excluded,
    apiDir: join(ROOT, "apps", "api"),
  });
  if (prisma.ran && !prisma.fresh) {
    console.error(prisma.message);
    process.exit(1);
  }
  // The whole turbo step is ONE heavy-slot hold (scripts/lib/heavy-slot.mjs): one verify at a time
  // per host, FIFO, fail closed when the wait cap passes. Calls run strictly in order, awaited.
  const ran = [];
  const status = await withHeavySlot({ label: "verify" }, async () => {
    const planned = await executePlan(
      plan.calls,
      (c) =>
        c.jest
          ? turboJest(c.args, c.changedSince ? runMode.changedSince : undefined)
          : c.pins
            ? pinJest(c)
            : turbo(c.args),
      ran,
    );
    if (!settlesReports({ fast: runMode.fast, status: planned, env: process.env })) return planned;
    const settled = await spawnAsync(
      process.execPath,
      [join(ROOT, "scripts", "campaign-check.mjs"), "--reports-only"],
      { cwd: ROOT, stdio: "inherit" },
    );
    return settled.status ?? 1;
  });
  // W-1045: under the pre-push hook a pass is a written token, not an exit code. Only a run in which every planned call
  // returned the number 0, and whose reports settled, writes it (scripts/lib/verify-result.mjs); the chain's last link
  // promotes it.
  const staged = stageRun(process.env, { status, statuses: ran, planned: plan.calls.length });
  if (!staged && status === 0 && process.env[RESULT_FILE_ENV])
    console.log(
      "verify-turbo: no pass token written (nothing was planned, or a call did not finish green).",
    );
  // Last line of a fast run: a related-tests-only pass is not a merge-ready claim.
  process.exit(finishRun({ fast: runMode.fast, status }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // HeavySlotTimeout (and any other failure) is a closed failure: non-zero, nothing run.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e?.name === "HeavySlotTimeout" ? 75 : 1);
  });
}
