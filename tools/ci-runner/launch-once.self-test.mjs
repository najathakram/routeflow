#!/usr/bin/env node
// Self-test for tools/ci-runner/launch-once.mjs. Plain node; exit 1 on failure. No gh, no Docker:
// every outside call is a fake, so this runs anywhere `npm run verify` runs.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  EXIT_FOREIGN_QUEUED,
  EXIT_NOT_PRIVATE,
  REPO,
  deleteRunner,
  dockerArgs,
  foreignQueuedRuns,
  gh,
  launch,
  noteRunnerLine,
  parseFlags,
  pollOnce,
  runContainer,
} from "./launch-once.mjs";
import { withHeavySlot } from "../../scripts/lib/heavy-slot.mjs";

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
    deleteRunner: () => {
      calls.push("delete");
      return "gone";
    },
    sleep: async () => {},
    withSlot: async (_opts, fn) => {
      calls.push("seat");
      const result = await fn({ token: "seat-1", held: true });
      calls.push("seat released");
      return result;
    },
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
check(
  "Q2 a fork's run counts once it is in progress: its self-hosted job can still be queued",
  foreignQueuedRuns((a) =>
    JSON.stringify({
      workflow_runs: a[1].includes("status=in_progress")
        ? [{ id: 8, head_repository: { full_name: "someone/routeflow" } }]
        : [],
    }),
  ),
  [8],
);
check(
  "Q3 a fork's run on the second page counts",
  foreignQueuedRuns((a) => {
    if (!a[1].includes("status=queued")) return JSON.stringify({ workflow_runs: [] });
    const own = { id: 1, head_repository: { full_name: REPO } };
    const fork = { id: 9, head_repository: { full_name: "someone/routeflow" } };
    const page = /page=(\d+)$/.exec(a[1])?.[1];
    return JSON.stringify({
      workflow_runs: page === "2" ? [fork] : Array(100).fill(own),
    });
  }),
  [9],
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

// ── The container's whole life ───────────────────────────────────────────────────────────────────
function fakeRun(over = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  const calls = [];
  let settled = false;
  const finished = runContainer(
    { name: "rf-ephemeral-1", jitConfig: "one-job", runnerId: 7, flags: defaults },
    {
      spawn: () => child,
      readVisibility: () => "PRIVATE",
      deleteRunner: (id) => calls.push(`delete ${id}`),
      removeContainer: (name) => calls.push(`remove ${name}`),
      pollMs: 1,
      log: () => {},
      error: () => {},
      ...over,
    },
  ).then((code) => {
    settled = true;
    return code;
  });
  return { child, calls, finished, isSettled: () => settled };
}
const ticks = () => new Promise((resolve) => setTimeout(resolve, 25));
const end = (child, code = 0) => {
  child.emit("exit", code);
  child.emit("close", code);
};
{
  const { child, finished } = fakeRun();
  check("C1 stdin stays open: it is the dead-man's switch", child.stdin.writableEnded, false);
  end(child);
  await finished;
}
{
  const { child, calls, finished } = fakeRun({ readVisibility: () => "PUBLIC" });
  await ticks();
  check("C2 PUBLIC while idle: delete, then remove", calls.slice(0, 2), [
    "delete 7",
    "remove rf-ephemeral-1",
  ]);
  end(child);
  await finished;
}
{
  const { child, calls, finished } = fakeRun({ readVisibility: () => "PUBLIC" });
  child.stdout.write("2026-10-30 19:16:43Z: Running job: Verify\n");
  await new Promise((resolve) => setImmediate(resolve));
  const before = calls.length;
  await ticks();
  check("C3 the runner's job line reaches the guard", calls.length, before);
  end(child);
  await finished;
}
{
  const { child, calls, finished } = fakeRun();
  end(child, 3);
  check("C4 the exit code comes back", await finished, 3);
  check("C5 docker's CLI died: the container is removed too", calls, ["remove rf-ephemeral-1"]);
}
{
  const { child, finished, isSettled } = fakeRun();
  child.emit("exit", 0);
  await ticks();
  check("C6 the last log lines come before the end", isSettled(), false);
  child.emit("close", 0);
  await finished;
}

// ── Refusals mint nothing ────────────────────────────────────────────────────────────────────────
{
  const { deps, calls } = fakeDeps({ visibility: () => "PUBLIC" });
  check("L1 PUBLIC exits 3", await launch(defaults, deps), EXIT_NOT_PRIVATE);
  check("L2 PUBLIC registers nothing", calls.includes("mint"), false);
}
{
  const { deps, calls } = fakeDeps({ foreignQueuedRuns: () => [41] });
  check("L3 an outside run exits 4", await launch(defaults, deps), EXIT_FOREIGN_QUEUED);
  check("L4 an outside run registers nothing", calls.includes("mint"), false);
}
{
  const { deps, calls } = fakeDeps({
    runContainer: async () => {
      calls.push("container");
      return 137;
    },
  });
  check("L5 the container's exit code comes back", await launch(defaults, deps), 137);
  check("L6 order: the seat frees before the delete, which can take 15 minutes", calls, [
    "seat",
    "mint",
    "container",
    "seat released",
    "delete",
  ]);
}

{
  const order = [];
  const { deps } = fakeDeps({
    foreignQueuedRuns: () => {
      order.push("outside runs");
      return [];
    },
    visibility: () => {
      order.push("visibility");
      return "PRIVATE";
    },
    mintRunner: () => {
      order.push("mint");
      return { id: 7, jitConfig: "one-job" };
    },
  });
  await launch(defaults, deps);
  check("Q4 the PRIVATE reading comes last, right before the mint", order, [
    "outside runs",
    "visibility",
    "mint",
  ]);
}

// ── The runner takes a heavy seat, never runs beside one ─────────────────────────────────────────
{
  const { deps, calls } = fakeDeps({
    withSlot: (_opts, fn) => fn({ token: null, held: false }),
  });
  check("S1 no seat: refuse with exit 5", await launch(defaults, deps), 5);
  check("S2 no seat: register nothing", calls, []);
}
{
  const { deps, calls } = fakeDeps({
    withSlot: (opts, fn) => withHeavySlot({ ...opts, env: { CI: "true" } }, fn),
  });
  check("S3 heavy-slot's own no-seat answer refuses", await launch(defaults, deps), 5);
  check("S4 and registers nothing", calls, []);
}
{
  let opts;
  const seen = [];
  const { deps } = fakeDeps({
    withSlot: (o, fn) => {
      opts = o;
      seen.push("seat");
      return fn({ token: "seat-1", held: true });
    },
    visibility: () => {
      seen.push("visibility");
      return "PRIVATE";
    },
  });
  await launch(parseFlags(["--branch", "train/acme"]), deps);
  check("S5 checks run after the wait for a seat, not before", seen, ["seat", "visibility"]);
  check("S6 the seat counts as a capped verify", /verify/.test(opts?.label), true);
  check("S7 the seat names the train", opts?.branch, "train/acme");
}
{
  const { deps, calls } = fakeDeps();
  const code = await launch(parseFlags(["--max-minutes", "81"]), deps);
  check("S8 past the hold cap's margin: refuse with exit 2", code, 2);
  check("S9 and take no seat", calls, []);
}
check(
  "S10 80 minutes is the last allowed",
  await launch(parseFlags(["--max-minutes", "80"]), fakeDeps().deps),
  0,
);
{
  const { deps, calls } = fakeDeps();
  const code = await launch(parseFlags(["--max-minutes", "soon"]), deps);
  check("S11 a bad number is refused too", [code, calls], [2, []]);
}

// ── A killed job's runner can't be deleted until its run closes ──────────────────────────────────
{
  const replies = ["refused", "refused", "gone"];
  let deletes = 0;
  const { deps } = fakeDeps({
    deleteRunner: () => {
      deletes++;
      return replies.shift();
    },
  });
  await launch(defaults, deps);
  check("R1 a refused delete is tried again until the runner goes", deletes, 3);
}
{
  let deletes = 0;
  const errors = [];
  const { deps } = fakeDeps({
    deleteRunner: () => {
      deletes++;
      return "refused";
    },
    error: (line) => errors.push(line),
  });
  check("R2 the exit code survives a runner that won't go", await launch(defaults, deps), 0);
  check("R3 it gives up after 15 minutes of tries", deletes, 60);
  check(
    "R4 giving up prints the command to finish the job",
    errors.some((line) => line.includes(`gh api -X DELETE repos/${REPO}/actions/runners/7`)),
    true,
  );
}
{
  const failing = (stderr) => () => {
    throw Object.assign(new Error("Command failed"), { stderr });
  };
  check(
    "R5 a 200 is gone",
    deleteRunner(7, () => ""),
    "gone",
  );
  check("R6 a 404 is gone", deleteRunner(7, failing("gh: Not Found (HTTP 404)")), "gone");
  check(
    "R7 a busy 422 is refused",
    deleteRunner(7, failing("gh: Bad request (HTTP 422)")),
    "refused",
  );
  check("R8 a timeout is refused", deleteRunner(7, failing("")), "refused");
}

console.log(`\nlaunch-once self-test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
