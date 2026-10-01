/**
 * Process entry: load config (exit 1 naming what is missing), write the deploy key, build the
 * sources, listen, poll, and drain on SIGTERM. Exits 0 within 5 s of a SIGTERM.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { createControlServer } from "./http/server";
import type { ControlDeps } from "./http/server";
import { setupDeployKey } from "./http/deploykey";
import { createGithub } from "./sources/github";

const cleanups: Array<() => void> = [];
const die = (msg: string): never => {
  process.stderr.write(`control: ${msg}\n`);
  for (const c of cleanups) c(); // a refused boot leaves no deploy key behind
  return process.exit(1);
};

let config: Config;
try {
  config = loadConfig(process.env);
} catch (e) {
  config = die(e instanceof Error ? e.message : "bad configuration");
}
if (config.local && !config.fixtureDir && !config.repo) {
  die("CONTROL_LOCAL=1 needs CONTROL_FIXTURE or CONTROL_REPO");
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

if (!config.local && config.deployKeyB64) {
  try {
    process.env.GIT_SSH_COMMAND = setupDeployKey(config.deployKeyB64, path.join(tmpRoot, "ssh"));
  } catch (e) {
    die(e instanceof Error ? e.message : "deploy key setup failed");
  }
}

let origin: string;
let github: ControlDeps["github"];
if (config.fixtureDir) {
  origin = seedFixtureOrigin(config.fixtureDir);
  github = fixtureGithub(config.fixtureDir);
} else {
  const repo = config.repo ?? "";
  const [owner, name] = repo.split("/");
  const sshUser = "git";
  origin = `${sshUser}@github.com:${repo}.git`;
  github = config.githubToken
    ? createGithub({ token: config.githubToken, owner, repo: name })
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

void app.listen().then(({ port }) => {
  console.log(
    `[control] listening on ${config.local ? "127.0.0.1" : config.host}:${port}${config.local ? " (local)" : ""}`,
  );
  app.startPolling();
});
