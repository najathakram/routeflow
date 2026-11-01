#!/usr/bin/env node
// One runner, one job, then gone. Runs on the HOST under the lead's gh login; the container only
// ever receives a one-job JIT config on stdin. Refuses while the repo is PUBLIC, because a public
// repo lets fork PRs reach a self-hosted runner, and a job `if:` cannot stop that: a fork edits its
// own copy of the workflow. Routine: docs/runbooks/self-hosted-runner.md.
//
//   node tools/ci-runner/launch-once.mjs --branch <train> [--cpus 0-3] [--memory 16g] [--max-minutes 60]
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { withHeavySlot } from "../../scripts/lib/heavy-slot.mjs";

export const REPO = "najathakram/routeflow";
const EXIT_BAD_FLAGS = 2;
export const EXIT_NOT_PRIVATE = 3;
export const EXIT_FOREIGN_QUEUED = 4;
const EXIT_NO_SEAT = 5;
/** Owner ruling 2026-10-30: Verify runs on train heads only. One path segment, as every train is named. */
const TRAIN_BRANCH = /^train\/[A-Za-z0-9._-]+$/;
/** "verify" in the label makes this one of heavy-slot's capped verify seats. */
const SEAT_LABEL = "ci-runner-verify";
/** Under heavy-slot's 90-minute hold cap, which ends tracked children only: docker here isn't one. */
const MAX_MINUTES = 80;
const IMAGE = "routeflow-ci-runner:2.338.2-r2";
const NETWORK = "routeflow-ci-runner";
const LABELS = ["self-hosted", "Linux", "X64", "routeflow-ephemeral"];
const POLL_MS = 15_000;
/** gh has no deadline of its own: a stalled TLS handshake would freeze the poll that guards the repo. */
export const GH_TIMEOUT_MS = 20_000;
/** An idle runner with no PRIVATE reading this recent counts as being on a public repo. */
export const UNSAFE_AFTER_MS = 45_000;
/** The runner's own line for a job starting. It comes from the container, so an outage can't hide it. */
export const JOB_STARTED = /: Running job: /;
/** A started job is stopped if GitHub hasn't shown it to be ours by now. */
const JOB_CHECK_MS = 120_000;
/** 15 minutes of tries. The trial's killed runner took 5m22s to free up after its run was cancelled. */
const REAP_WAIT_MS = 15_000;
const REAP_ATTEMPTS = 60;

export function parseFlags(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    cpus: flag("--cpus", "0-3"),
    memory: flag("--memory", "16g"),
    maxMinutes: Number(flag("--max-minutes", "60")),
    branch: flag("--branch", undefined),
  };
}

export function gh(args, input, exec = execFileSync) {
  return exec("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
  });
}

function visibility() {
  return gh(["repo", "view", REPO, "--json", "visibility", "-q", ".visibility"]).trim();
}

function runsWithStatus(status, ghFn) {
  const runs = [];
  for (let page = 1; ; page++) {
    const url = `repos/${REPO}/actions/runs?status=${status}&per_page=100&page=${page}`;
    const batch = JSON.parse(ghFn(["api", url])).workflow_runs;
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}

/**
 * A fork job queued in a public window stays queued for 24 h: the next runner must not take it. An
 * in-progress run counts too, because one hosted job starting leaves its self-hosted job queued.
 */
export function foreignQueuedRuns(ghFn = gh) {
  const foreign = [];
  for (const status of ["queued", "waiting", "requested", "pending", "in_progress"]) {
    for (const run of runsWithStatus(status, ghFn)) {
      if (run.head_repository?.full_name !== REPO) foreign.push(run.id);
    }
  }
  return foreign;
}

/** Whose job this runner took: "ours", "foreign", or null while GitHub doesn't show it. */
export function jobOrigin(runnerName, branch, ghFn = gh) {
  for (const run of runsWithStatus("in_progress", ghFn)) {
    const jobs = JSON.parse(
      ghFn(["api", `repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`]),
    ).jobs;
    if (!jobs.some((job) => job.runner_name === runnerName)) continue;
    const ours =
      run.head_repository?.full_name === REPO &&
      run.event === "workflow_dispatch" &&
      run.head_branch === branch;
    return ours ? "ours" : "foreign";
  }
  return null;
}

function mintRunner(name) {
  const jit = JSON.parse(
    gh(
      ["api", "-X", "POST", `repos/${REPO}/actions/runners/generate-jitconfig`, "--input", "-"],
      JSON.stringify({ name, runner_group_id: 1, labels: LABELS, work_folder: "_work" }),
    ),
  );
  return { id: jit.runner.id, jitConfig: jit.encoded_jit_config };
}

const runnerPath = (id) => `repos/${REPO}/actions/runners/${id}`;

export function deleteRunner(id, ghFn = gh) {
  try {
    ghFn(["api", "-X", "DELETE", runnerPath(id)]);
    return "gone";
  } catch (e) {
    // A 404 is success: an ephemeral runner deregisters itself after its job.
    return /HTTP 404/.test(e?.stderr ?? "") ? "gone" : "refused";
  }
}

/** GitHub refuses to delete a busy runner, and a killed job's runner stays busy until its run closes. */
async function reapRunner(id, { deleteRunner: del, sleep, log, error }) {
  for (let attempt = 1; attempt <= REAP_ATTEMPTS; attempt++) {
    if (del(id) === "gone") return true;
    if (attempt === 1) log(`runner ${id} not deleted yet: its run may still be closing`);
    if (attempt < REAP_ATTEMPTS) await sleep(REAP_WAIT_MS);
  }
  error(`runner ${id} would not go. Once its run closes: gh api -X DELETE ${runnerPath(id)}`);
  return false;
}

// NET_ADMIN, SETUID, SETGID and SETPCAP are for entrypoint.sh's root phase only: setpriv clears them
// all before run.sh starts. No Docker socket, no volumes, no secrets, no env from this host.
export function dockerArgs(name, flags) {
  return [
    "run",
    "-i",
    "--rm",
    "--init",
    "--name",
    name,
    "--network",
    NETWORK,
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SETPCAP",
    "--security-opt",
    "no-new-privileges",
    "--sysctl",
    "net.ipv6.conf.all.disable_ipv6=1",
    "--cpuset-cpus",
    flags.cpus,
    "--memory",
    flags.memory,
    "--memory-swap",
    flags.memory,
    "--pids-limit",
    "8192",
    IMAGE,
  ];
}

/** A started job has to be the one we dispatched. No answer within JOB_CHECK_MS fails closed. */
function checkJob(state, { now, readJob, log }) {
  if (state.jobConfirmed) return "wait";
  state.jobFirstCheckedAt ??= now;
  let origin = null;
  try {
    origin = readJob();
  } catch (e) {
    log(`job check failed: ${e instanceof Error ? e.message : e}`);
  }
  if (origin === "foreign") return "stop job";
  if (origin === "ours") {
    state.jobConfirmed = true;
    return "wait";
  }
  return now - state.jobFirstCheckedAt >= JOB_CHECK_MS ? "stop job" : "wait";
}

/**
 * One guard tick. "stop" at the deadline. "stop job" if a started job isn't ours. "remove" an idle
 * runner unless the repo reads PRIVATE: a repo that left PRIVATE, or no good reading for
 * UNSAFE_AFTER_MS, fails closed. Our own running job is left alone: a one-job runner cannot take a
 * second job, whatever the repo's visibility.
 */
export function pollOnce(state, { now, readVisibility, readJob, log }) {
  if (now > state.deadline) return "stop";
  if (state.jobRunning) return checkJob(state, { now, readJob, log });
  let seen = null;
  try {
    seen = readVisibility();
  } catch (e) {
    log(`visibility check failed: ${e instanceof Error ? e.message : e}`);
  }
  if (seen === "PRIVATE") {
    state.lastPrivateAt = now;
    return "wait";
  }
  if (seen !== null) return "remove";
  return now - state.lastPrivateAt >= UNSAFE_AFTER_MS ? "remove" : "wait";
}

export function noteRunnerLine(state, line) {
  if (JOB_STARTED.test(line)) state.jobRunning = true;
}

function removeContainer(name) {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: GH_TIMEOUT_MS });
  } catch {
    // Already removed by --rm.
  }
}

export function runContainer({ name, jitConfig, runnerId, flags }, io = REAL_IO) {
  const container = io.spawn("docker", dockerArgs(name, flags), {
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Left open on purpose. entrypoint.sh ends the container when stdin closes, so no way of killing
  // this process leaves a runner with nothing watching it.
  container.stdin.write(`${jitConfig}\n`);
  const state = {
    deadline: Date.now() + flags.maxMinutes * 60_000,
    lastPrivateAt: Date.now(),
    jobRunning: false,
  };
  createInterface({ input: container.stdout }).on("line", (line) => {
    io.log(line);
    noteRunnerLine(state, line);
  });

  const stop = () => io.removeContainer(name);
  const poll = setInterval(() => {
    const action = pollOnce(state, {
      now: Date.now(),
      readVisibility: io.readVisibility,
      readJob: () => io.readJob(name, flags.branch),
      log: io.error,
    });
    if (action === "stop") {
      io.error("max-minutes reached: stopping the runner");
      stop();
    } else if (action === "stop job") {
      io.error(`this runner's job is not a dispatch on ${flags.branch}: stopping it`);
      stop();
    } else if (action === "remove") {
      io.error("repo not confirmed PRIVATE with this runner idle: removing it");
      io.deleteRunner(runnerId);
      stop();
    }
  }, io.pollMs);

  return new Promise((resolve) => {
    // If only docker's CLI died, the container is still up. "close" waits for its last log lines.
    const done = (code) => {
      clearInterval(poll);
      stop();
      resolve(code);
    };
    container.on("error", () => done(1));
    container.on("close", (code) => done(code ?? 1));
  });
}

const REAL_IO = {
  spawn,
  readVisibility: visibility,
  readJob: jobOrigin,
  deleteRunner,
  removeContainer,
  pollMs: POLL_MS,
  log: console.log,
  error: console.error,
};

const REAL_DEPS = {
  visibility,
  foreignQueuedRuns,
  mintRunner,
  runContainer,
  deleteRunner,
  withSlot: withHeavySlot,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: console.log,
  error: console.error,
};

export async function launch(flags, deps = REAL_DEPS) {
  if (!flags.branch) {
    deps.error("refusing: --branch is required, to check the job the runner takes");
    return EXIT_BAD_FLAGS;
  }
  if (!TRAIN_BRANCH.test(flags.branch)) {
    deps.error(`refusing: --branch must be a train head (train/<name>), not ${flags.branch}`);
    return EXIT_BAD_FLAGS;
  }
  if (!(flags.maxMinutes > 0 && flags.maxMinutes <= MAX_MINUTES)) {
    deps.error(`refusing: --max-minutes must be 1 to ${MAX_MINUTES}`);
    return EXIT_BAD_FLAGS;
  }

  // The checks wait for the seat: a PRIVATE reading taken before a long queue proves nothing.
  let runner = null;
  const code = await deps.withSlot({ label: SEAT_LABEL, branch: flags.branch }, async (seat) => {
    if (!seat.token) {
      deps.error("refusing: no heavy seat. The runner never runs beside one (CI or slot off?)");
      return EXIT_NO_SEAT;
    }
    const foreign = deps.foreignQueuedRuns();
    if (foreign.length > 0) {
      deps.error(`refusing: runs from outside ${REPO} are active: ${foreign.join(", ")}`);
      return EXIT_FOREIGN_QUEUED;
    }
    const seen = deps.visibility();
    if (seen !== "PRIVATE") {
      deps.error(`refusing: ${REPO} is ${seen}, not PRIVATE`);
      return EXIT_NOT_PRIVATE;
    }

    const name = `rf-ephemeral-${Date.now()}`;
    const { id, jitConfig } = deps.mintRunner(name);
    runner = { name, id };
    deps.log(`runner ${name} (id ${id}) registered`);
    return deps.runContainer({ name, jitConfig, runnerId: id, flags });
  });

  // Outside the seat: the container is gone, and this can wait 15 minutes on GitHub.
  if (runner) {
    await reapRunner(runner.id, deps);
    deps.log(`runner ${runner.name} done, container exit ${code}`);
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await launch(parseFlags(process.argv.slice(2))));
}
