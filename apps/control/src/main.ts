/**
 * Process entry: load config (exit 1 naming what is missing), build the sources, verify the token
 * is read-only on both repos, listen, poll, and drain on SIGTERM. Exits 0 within 5 s of a SIGTERM.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { createControlServer } from "./http/server";
import type { ControlDeps } from "./http/server";
import { createGithub } from "./sources/github";
import { setGitAuth } from "./sources/git";
import { enforceReadOnly } from "./sources/probe";

const cleanups: Array<() => void> = [];
const die = (msg: string): never => {
  process.stderr.write(`control: ${msg}\n`);
  for (const c of cleanups) c(); // a refused boot leaves nothing behind
  return process.exit(1);
};

/**
 * Test seam (the schema-drift pattern in apps/api/scripts): inside a Jest worker only
 * (JEST_WORKER_ID set), CONTROL_TEST_GITHUB_BASE redirects every GitHub URL (git remotes, the write
 * probe, the REST/GraphQL API) to a fake server, and CONTROL_TEST_PROBE_BACKOFF_MS shrinks the
 * probe's retry waits. In production the base is always https://github.com: outside a Jest worker
 * both variables are ignored, loudly.
 */
const underJest = process.env.JEST_WORKER_ID !== undefined;
const testBase = process.env.CONTROL_TEST_GITHUB_BASE?.replace(/\/+$/, "");
const testBackoff = Number(process.env.CONTROL_TEST_PROBE_BACKOFF_MS);
if (!underJest && (testBase || process.env.CONTROL_TEST_PROBE_BACKOFF_MS)) {
  process.stderr.write("control: CONTROL_TEST_* variables are ignored outside a Jest worker\n");
}
const GITHUB_BASE = underJest && testBase ? testBase : "https://github.com";
const GITHUB_API = underJest && testBase ? testBase : undefined;
const PROBE_BACKOFF =
  underJest && Number.isFinite(testBackoff) && testBackoff >= 0
    ? [testBackoff, testBackoff]
    : undefined;
if (GITHUB_BASE !== "https://github.com") {
  process.stderr.write(`control: WARNING test seam active: GitHub base is ${GITHUB_BASE}\n`);
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (e) {
  config = die(e instanceof Error ? e.message : "bad configuration");
}
for (const w of config.warnings) process.stderr.write(`${w}\n`);
if (config.local && !config.fixtureDir && (!config.repo || !config.stateRepo)) {
  die("CONTROL_LOCAL=1 needs CONTROL_FIXTURE, or CONTROL_REPO and CONTROL_STATE_REPO");
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeflow-control-"));
cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** Fixture mode: a throwaway bare origin seeded with the fixture's state events on ctl/state. */
function seedFixtureOrigin(fixtureDir: string): string {
  const bare = path.join(tmpRoot, "origin.git");
  const seed = path.join(tmpRoot, "seed");
  const run = (cwd: string, args: string[]): void => {
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "ctl",
        GIT_AUTHOR_EMAIL: "ctl@localhost",
        GIT_COMMITTER_NAME: "ctl",
        GIT_COMMITTER_EMAIL: "ctl@localhost",
      },
    });
  };
  fs.mkdirSync(bare);
  run(bare, ["init", "-q", "--bare", "--initial-branch=main"]);
  fs.mkdirSync(path.join(seed, "events"), { recursive: true });
  run(seed, ["init", "-q", "--initial-branch=ctl/state"]);
  const from = path.join(fixtureDir, "state", "events");
  for (const n of fs.readdirSync(from)) {
    if (/^[a-z0-9][a-z0-9._-]*\.jsonl$/.test(n)) {
      fs.copyFileSync(path.join(from, n), path.join(seed, "events", n));
    }
  }
  fs.writeFileSync(path.join(seed, "README.md"), "state branch (local fixture seed)\n");
  run(seed, ["add", "-A"]);
  run(seed, ["commit", "-q", "-m", "seed", "--no-verify"]);
  run(seed, ["push", "-q", `file://${bare}`, "HEAD:refs/heads/ctl/state"]);
  return `file://${bare}`;
}

function fixtureGithub(dir: string): ControlDeps["github"] {
  const read = (rel: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(dir, "github", rel), "utf8")) as unknown;
  return {
    poll: () =>
      Promise.resolve({
        prs: read("prs.json") as unknown[],
        branches: read("branches.json") as unknown[],
        files: read("prs-files.json") as Record<string, never[]>,
      }),
    state: { rateLimit: { remaining: null, resetAt: null } },
  };
}

let origin: string;
let masterOrigin: string | undefined;
let github: ControlDeps["github"];
if (config.fixtureDir) {
  origin = seedFixtureOrigin(config.fixtureDir);
  github = fixtureGithub(config.fixtureDir);
} else {
  const repo = config.repo ?? "";
  const [owner, name] = repo.split("/");
  // one read-only token over HTTPS for both repos (sent as a header, never in a URL)
  setGitAuth(config.githubToken ?? null, `${GITHUB_BASE}/`);
  origin = `${GITHUB_BASE}/${config.stateRepo ?? ""}.git`; // the state repo
  masterOrigin = `${GITHUB_BASE}/${repo}.git`; // the product repo
  github = config.githubToken
    ? createGithub({ token: config.githubToken, owner, repo: name, apiUrl: GITHUB_API })
    : {
        poll: () => Promise.resolve({ prs: [], branches: [], files: {} }),
        state: { rateLimit: { remaining: null, resetAt: null } },
      };
}

const stateDir = config.stateDir ?? path.join(tmpRoot, "state");
const masterDir = config.masterDir ?? path.join(tmpRoot, "master");
const stamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

let app: ReturnType<typeof createControlServer>;
try {
  app = createControlServer({
    config,
    env: {
      origin,
      cloneDir: stateDir,
      stateBranch: "ctl/state",
      archiveBranch: "ctl/archive",
      registers: { tasks: [], releases: [] },
      now: stamp,
    },
    github,
    fetch: globalThis.fetch,
    masterDir,
    masterOrigin,
    log: (l) => console.log(`[control] ${l}`),
  });
} catch (e) {
  app = die(e instanceof Error ? e.message : "boot refused");
}

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  const hard = setTimeout(() => process.exit(0), 5_000);
  hard.unref();
  void app.close().finally(() => {
    for (const c of cleanups) c();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (e) => {
  console.error(
    `[control] unhandled rejection: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`,
  );
});

/** Refuse to serve with a token that can write (or one we cannot verify): fail closed. */
async function verifyReadOnlyToken(): Promise<void> {
  const out = await enforceReadOnly({
    token: config.githubToken ?? "",
    productRepo: config.repo ?? "",
    stateRepo: config.stateRepo ?? "",
    base: GITHUB_BASE,
    backoffMs: PROBE_BACKOFF,
    log: (l) => process.stdout.write(`${l}\n`),
  });
  if (!out.ok) die(out.message);
}

// Probe only after every config refusal above, so a misconfigured boot never touches the network.
const verified = !config.local && !config.fixtureDir ? verifyReadOnlyToken() : Promise.resolve();
void verified
  .then(() => app.listen())
  .then(({ port }) => {
    console.log(
      `[control] listening on ${config.local ? "127.0.0.1" : config.host}:${port}${config.local ? " (local)" : ""}`,
    );
    app.startPolling();
  })
  .catch((e: unknown) => {
    // a rejected boot step (e.g. the port is taken) must not leave a half-booted process behind
    const token = config.githubToken;
    const msg = e instanceof Error ? e.message : "boot failed";
    die(token ? msg.split(token).join("***") : msg);
  });
