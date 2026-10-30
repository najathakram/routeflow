#!/usr/bin/env node
// Self-test for tools/ci-runner/launch-once.mjs. Plain node; exit 1 on failure. No gh, no Docker:
// every outside call is a fake, so this runs anywhere `npm run verify` runs.
import {
  EXIT_FOREIGN_QUEUED,
  EXIT_NOT_PRIVATE,
  REPO,
  dockerArgs,
  foreignQueuedRuns,
  gh,
  launch,
  noteRunnerLine,
  parseFlags,
  pollOnce,
} from "./launch-once.mjs";

let passed = 0;
let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
  if (ok) passed++;
  else failed++;
}

function fakeDeps(over = {}) {
  const calls = [];
  const deps = {
    visibility: () => "PRIVATE",
    foreignQueuedRuns: () => [],
    mintRunner: () => {
      calls.push("mint");
      return { id: 7, jitConfig: "one-job" };
    },
    runContainer: async () => {
      calls.push("container");
      return 0;
    },
    deleteRunner: () => calls.push("delete"),
    log: () => {},
    error: () => {},
    ...over,
  };
  return { deps, calls };
}

// ── Sizing ───────────────────────────────────────────────────────────────────────────────────────
const defaults = parseFlags([]);
check("F1 default size is what passed the trial: 4 CPUs, 16 GB", defaults, {
  cpus: "0-3",
  memory: "16g",
  maxMinutes: 60,
});
check(
  "F2 flags override",
  parseFlags(["--cpus", "0-1", "--memory", "8g", "--max-minutes", "20"]).maxMinutes,
  20,
);

// ── The container stays hardened ─────────────────────────────────────────────────────────────────
const args = dockerArgs("rf-ephemeral-1", defaults);
const has = (a, b) => args.some((v, i) => v === a && args[i + 1] === b);
check("D1 every capability is dropped first", has("--cap-drop", "ALL"), true);
check("D2 no new privileges", has("--security-opt", "no-new-privileges"), true);
check("D3 swap is off: the memory cap is the real cap", has("--memory-swap", "16g"), true);
check(
  "D4 no volume, socket, env file, host network or privileged mode",
  args.filter((a) =>
    /^(-v|--volume|--mount|-e|--env|--env-file|--privileged|--pid|--userns)$|docker\.sock|^host$/.test(
      a,
    ),
  ),
  [],
);
check(
  "D5 only the root-phase capabilities are added",
  args.filter((_, i) => args[i - 1] === "--cap-add").sort(),
  ["NET_ADMIN", "SETGID", "SETPCAP", "SETUID"],
);

// ── A queued outside run blocks the next runner ──────────────────────────────────────────────────
const queued = (status) => {
  const runs = {
    queued: [{ id: 1, head_repository: { full_name: REPO } }],
    waiting: [{ id: 2, head_repository: { full_name: "someone/routeflow" } }],
    pending: [{ id: 3, head_repository: null }],
  };
  return JSON.stringify({ workflow_runs: runs[status] ?? [] });
};
check(
  "Q1 a fork's run and a run with no head repo both count; our own does not",
  foreignQueuedRuns((a) => queued(/status=(\w+)/.exec(a[1])[1])),
  [2, 3],
);

// ── The guard while the runner waits ─────────────────────────────────────────────────────────────
const tick = (visibility, busy) =>
  pollOnce(
    { deadline: 2_000, lastPrivateAt: 1_000, jobRunning: busy },
    { now: 1_000, readVisibility: () => visibility, log: () => {} },
  );
check("P1 PRIVATE and idle: keep waiting", tick("PRIVATE", false), "wait");
check("P2 PUBLIC and idle: remove the runner", tick("PUBLIC", false), "remove");
check("P3 PUBLIC with a job running: let the job finish", tick("PUBLIC", true), "wait");
check(
  "P4 past the deadline: stop",
  pollOnce(
    { deadline: 500, lastPrivateAt: 1_000, jobRunning: false },
    { now: 1_000, readVisibility: () => "PRIVATE", log: () => {} },
  ),
  "stop",
);

// ── A failed check is not a safe reading ─────────────────────────────────────────────────────────
const lastSeen = 100_000;
const blind = (now, jobRunning = false) =>
  pollOnce(
    { deadline: 9_000_000, lastPrivateAt: lastSeen, jobRunning },
    {
      now,
      readVisibility: () => {
        throw new Error("TLS handshake timeout");
      },
      log: () => {},
    },
  );
check("U1 one failed check is a blip: keep waiting", blind(lastSeen + 15_000), "wait");
check(
  "U2 45 s with no PRIVATE reading: remove the idle runner",
  blind(lastSeen + 45_000),
  "remove",
);
check("U3 a running job is left alone, even blind", blind(lastSeen + 45_000, true), "wait");
check(
  "U4 PUBLIC with a job running stays up when the busy read fails",
  pollOnce(
    { deadline: 9_000_000, lastPrivateAt: lastSeen, jobRunning: true },
    { now: lastSeen, readVisibility: () => "PUBLIC", log: () => {} },
  ),
  "wait",
);
{
  const state = { deadline: 9_000_000, lastPrivateAt: 0, jobRunning: false };
  pollOnce(state, { now: 90_000, readVisibility: () => "PRIVATE", log: () => {} });
  check("U5 a PRIVATE reading restarts the clock", state.lastPrivateAt, 90_000);
}
{
  let options;
  gh(["repo", "view"], undefined, (_cmd, _args, opts) => {
    options = opts;
    return "";
  });
  check("U6 a hung gh cannot freeze the guard", options.timeout, 20_000);
}

// ── The runner's own output says when a job is running ───────────────────────────────────────────
{
  const state = { jobRunning: false };
  noteRunnerLine(state, "2026-10-30 19:16:37Z: Listening for Jobs");
  check("J1 the runner listening is not a job", state.jobRunning, false);
  noteRunnerLine(state, "2026-10-30 19:16:43Z: Running job: Verify");
  check("J2 a job starting marks the runner busy", state.jobRunning, true);
  noteRunnerLine(state, "2026-10-30 19:54:34Z: Job Verify completed with result: Succeeded");
  check("J3 a finished job stays marked: this runner takes no other", state.jobRunning, true);
}

// ── Refusals mint nothing ────────────────────────────────────────────────────────────────────────
{
  const { deps, calls } = fakeDeps({ visibility: () => "PUBLIC" });
  check("L1 PUBLIC exits 3", await launch(defaults, deps), EXIT_NOT_PRIVATE);
  check("L2 PUBLIC registers nothing", calls, []);
}
{
  const { deps, calls } = fakeDeps({ foreignQueuedRuns: () => [41] });
  check("L3 an outside run exits 4", await launch(defaults, deps), EXIT_FOREIGN_QUEUED);
  check("L4 an outside run registers nothing", calls, []);
}
{
  const { deps, calls } = fakeDeps({
    runContainer: async () => {
      calls.push("container");
      return 137;
    },
  });
  check("L5 the container's exit code comes back", await launch(defaults, deps), 137);
  check("L6 order: mint, container, delete", calls, ["mint", "container", "delete"]);
}

console.log(`\nlaunch-once self-test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
