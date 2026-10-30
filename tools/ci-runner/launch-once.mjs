#!/usr/bin/env node
// One runner, one job, then gone. Runs on the HOST under the lead's gh login; the container only
// ever receives a one-job JIT config on stdin. Refuses while the repo is PUBLIC, because a public
// repo lets fork PRs reach a self-hosted runner, and a job `if:` cannot stop that: a fork edits its
// own copy of the workflow. Routine: docs/runbooks/self-hosted-runner.md.
//
//   node tools/ci-runner/launch-once.mjs [--cpus 0-3] [--memory 16g] [--max-minutes 60]
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "najathakram/routeflow";
export const EXIT_NOT_PRIVATE = 3;
export const EXIT_FOREIGN_QUEUED = 4;
const IMAGE = "routeflow-ci-runner:2.338.2";
const NETWORK = "routeflow-ci-runner";
const LABELS = ["self-hosted", "Linux", "X64", "routeflow-ephemeral"];
const POLL_MS = 15_000;

export function parseFlags(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    cpus: flag("--cpus", "0-3"),
    memory: flag("--memory", "16g"),
    maxMinutes: Number(flag("--max-minutes", "60")),
  };
}

export function gh(args, input, exec = execFileSync) {
  return exec("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function visibility() {
  return gh(["repo", "view", REPO, "--json", "visibility", "-q", ".visibility"]).trim();
}

/** A fork job queued in a public window stays queued for 24 h: the next runner must not take it. */
export function foreignQueuedRuns(ghFn = gh) {
  const foreign = [];
  for (const status of ["queued", "waiting", "requested", "pending"]) {
    const page = JSON.parse(
      ghFn(["api", `repos/${REPO}/actions/runs?status=${status}&per_page=100`]),
    );
    for (const run of page.workflow_runs) {
      if (run.head_repository?.full_name !== REPO) foreign.push(run.id);
    }
  }
  return foreign;
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

function deleteRunner(id) {
  try {
    gh(["api", "-X", "DELETE", `repos/${REPO}/actions/runners/${id}`]);
  } catch {
    // Already gone: an ephemeral runner deregisters itself after its job.
  }
}

function runnerIsBusy(id) {
  try {
    return JSON.parse(gh(["api", `repos/${REPO}/actions/runners/${id}`])).busy === true;
  } catch {
    return false;
  }
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

/** One guard tick: "stop" at the deadline, "remove" an idle runner on a repo that left PRIVATE. */
export function pollOnce(state, { now, readVisibility, readBusy, log }) {
  try {
    if (now > state.deadline) return "stop";
    if (readVisibility() !== "PRIVATE" && !readBusy()) return "remove";
  } catch (e) {
    log(`poll failed, will retry: ${e instanceof Error ? e.message : e}`);
  }
  return "wait";
}

function runContainer({ name, jitConfig, runnerId, flags }) {
  const container = spawn("docker", dockerArgs(name, flags), {
    stdio: ["pipe", "inherit", "inherit"],
  });
  container.stdin.end(`${jitConfig}\n`);

  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // Already removed by --rm.
    }
  };
  const state = { deadline: Date.now() + flags.maxMinutes * 60_000 };
  const poll = setInterval(() => {
    const action = pollOnce(state, {
      now: Date.now(),
      readVisibility: visibility,
      readBusy: () => runnerIsBusy(runnerId),
      log: console.error,
    });
    if (action === "stop") {
      console.error("max-minutes reached: stopping the runner");
      stop();
    } else if (action === "remove") {
      console.error("repo left PRIVATE with this runner idle: removing it");
      deleteRunner(runnerId);
      stop();
    }
  }, POLL_MS);

  return new Promise((resolve) => {
    const done = (code) => {
      clearInterval(poll);
      resolve(code);
    };
    container.on("error", () => done(1));
    container.on("exit", (code) => done(code ?? 1));
  });
}

const REAL_DEPS = {
  visibility,
  foreignQueuedRuns,
  mintRunner,
  runContainer,
  deleteRunner,
  log: console.log,
  error: console.error,
};

export async function launch(flags, deps = REAL_DEPS) {
  const seen = deps.visibility();
  if (seen !== "PRIVATE") {
    deps.error(`refusing: ${REPO} is ${seen}, not PRIVATE`);
    return EXIT_NOT_PRIVATE;
  }
  const foreign = deps.foreignQueuedRuns();
  if (foreign.length > 0) {
    deps.error(`refusing: runs from outside ${REPO} are queued: ${foreign.join(", ")}`);
    return EXIT_FOREIGN_QUEUED;
  }

  const name = `rf-ephemeral-${Date.now()}`;
  const { id, jitConfig } = deps.mintRunner(name);
  deps.log(`runner ${name} (id ${id}) registered`);
  const code = await deps.runContainer({ name, jitConfig, runnerId: id, flags });
  deps.deleteRunner(id);
  deps.log(`runner ${name} done, container exit ${code}`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await launch(parseFlags(process.argv.slice(2))));
}
