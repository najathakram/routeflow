#!/usr/bin/env node
// One runner, one job, then gone. Runs on the HOST under the owner's gh login; the container only
// ever receives a one-job JIT config on stdin. Refuses while the repo is PUBLIC, because a public
// repo lets fork PRs reach a self-hosted runner, and a job `if:` cannot stop that: a fork edits its
// own copy of the workflow. See docs/runbooks/self-hosted-runner-trial.md.
//
//   node tools/ci-runner/launch-once.mjs [--cpus 0-5] [--memory 16g] [--max-minutes 60]
import { execFileSync, spawn } from "node:child_process";

const REPO = "najathakram/routeflow";
const IMAGE = "routeflow-ci-runner:2.338.2";
const NETWORK = "routeflow-ci-runner";
const LABELS = ["self-hosted", "Linux", "X64", "routeflow-ephemeral"];
const POLL_MS = 15_000;

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function visibility() {
  return gh(["repo", "view", REPO, "--json", "visibility", "-q", ".visibility"]).trim();
}

/** A fork job queued in a public window stays queued for 24 h: the next runner must not take it. */
function foreignQueuedRuns() {
  const foreign = [];
  for (const status of ["queued", "waiting", "requested", "pending"]) {
    const page = JSON.parse(
      gh(["api", `repos/${REPO}/actions/runs?status=${status}&per_page=100`]),
    );
    for (const run of page.workflow_runs) {
      if (run.head_repository?.full_name !== REPO) foreign.push(run.id);
    }
  }
  return foreign;
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

const seen = visibility();
if (seen !== "PRIVATE") {
  console.error(`refusing: ${REPO} is ${seen}, not PRIVATE`);
  process.exit(3);
}
const foreign = foreignQueuedRuns();
if (foreign.length > 0) {
  console.error(`refusing: runs from outside ${REPO} are queued: ${foreign.join(", ")}`);
  process.exit(4);
}

const name = `rf-ephemeral-${Date.now()}`;
const jit = JSON.parse(
  gh(
    ["api", "-X", "POST", `repos/${REPO}/actions/runners/generate-jitconfig`, "--input", "-"],
    JSON.stringify({ name, runner_group_id: 1, labels: LABELS, work_folder: "_work" }),
  ),
);
const runnerId = jit.runner.id;
console.log(`runner ${name} (id ${runnerId}) registered`);

// NET_ADMIN, SETUID, SETGID and SETPCAP are for entrypoint.sh's root phase only: setpriv clears them
// all before run.sh starts. No Docker socket, no volumes, no secrets, no env from this host.
const container = spawn(
  "docker",
  [
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
    flag("--cpus", "0-5"),
    "--memory",
    flag("--memory", "16g"),
    "--memory-swap",
    flag("--memory", "16g"),
    "--pids-limit",
    "8192",
    IMAGE,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
container.stdin.end(`${jit.encoded_jit_config}\n`);

const stop = () => {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // Already removed by --rm.
  }
};
const deadline = Date.now() + Number(flag("--max-minutes", "60")) * 60_000;
const poll = setInterval(() => {
  try {
    if (Date.now() > deadline) {
      console.error("max-minutes reached: stopping the runner");
      stop();
    } else if (visibility() !== "PRIVATE" && !runnerIsBusy(runnerId)) {
      console.error("repo left PRIVATE with this runner idle: removing it");
      deleteRunner(runnerId);
      stop();
    }
  } catch (e) {
    console.error(`poll failed, will retry: ${e instanceof Error ? e.message : e}`);
  }
}, POLL_MS);

container.on("exit", (code) => {
  clearInterval(poll);
  deleteRunner(runnerId);
  console.log(`runner ${name} done, container exit ${code}`);
  process.exit(code ?? 1);
});
