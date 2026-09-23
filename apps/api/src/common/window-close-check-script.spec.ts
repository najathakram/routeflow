import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// scripts/window-close-check.mjs — the window-close gate that would have caught the
// 2026-09-22 incident: PR #1262 (f894d974) landed on master, its Railway deployment
// FAILED, and the API kept serving the older cb88378f for ~90 minutes before anyone
// noticed, because nothing checked deploy status before the public->private flip.
//
// This spec never talks to the real GitHub API or a real prod URL: `gh` is replaced
// with a fake driver (WINDOW_CLOSE_GH_CMD, mirroring CI_FRESHNESS_GH_CMD in
// ci-freshness-guard-script.spec.ts) and `/api/v1/health` is served by a tiny local
// HTTP server (mirroring release-health-script.spec.ts's startFixtureServer). Git
// itself is real — a throwaway repo is built per test with an actual `origin` remote
// (a local bare repo, not the network) so the script's own `git fetch`/`git log`/
// `git diff` plumbing is exercised for real, matching the repo's *-script.spec.ts
// convention of spawning the real script rather than importing its internals.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/window-close-check.mjs");

// ─── fake `gh` driver ─────────────────────────────────────────────────────────────
// Routes are supplied per-test via the FAKE_GH_ROUTES env var (a JSON array of
// { match, body, status? }). The first route whose `match` substring appears in the
// joined `gh api ...` argv wins; no match is a hard error (surfaces a test that
// forgot to stub a call, rather than silently returning empty data).

let scratchDir: string;
let fakeGhDriver: string;

beforeAll(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-check-"));
  fakeGhDriver = path.join(scratchDir, "fake-gh.mjs");
  fs.writeFileSync(
    fakeGhDriver,
    [
      "const routes = JSON.parse(process.env.FAKE_GH_ROUTES || '[]');",
      "const joined = process.argv.slice(2).join(' ');",
      "const route = routes.find((r) => joined.includes(r.match));",
      "if (!route) {",
      "  process.stderr.write(`no fake-gh route for: ${joined}\\n`);",
      "  process.exit(1);",
      "}",
      "process.stdout.write(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));",
      "process.exit(route.status ?? 0);",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

// ─── fixture prod /health server ──────────────────────────────────────────────────

function startHealthServer(
  commit: string | null,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commit, branch: "master" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ─── fixture git repo ──────────────────────────────────────────────────────────────
// C0 (base, carries the railway.toml files) -> C1 (apps/api/** — deploying) ->
// C2 (packages/** — deploying) -> C3 (.claude/campaign/** — docs-only, matching
// ci.yml's paths-ignore shape). Mirrors the real incident's cb88378f -> f894d974 ->
// bc7b0ad9 chain. `depth` controls how many of C1/C2/C3 actually get pushed to
// `origin`, so a test can put a single deploying commit at HEAD without the later
// commits also being in (--since, HEAD].

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function commitFile(cwd: string, relPath: string, contents: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, relPath)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relPath), contents);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

interface Fixture {
  workDir: string;
  c0: string;
  c1: string; // apps/api/** — "deploying"
  c2: string; // packages/** — "deploying"
  c3: string; // .claude/campaign/** — "docs-only"
}

function buildFixtureRepo(root: string, depth: 1 | 2 | 3 = 3): Fixture {
  const originDir = path.join(root, "origin.git");
  const workDir = path.join(root, "work");
  fs.mkdirSync(originDir, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare", "-b", "master", originDir]);
  spawnSync("git", ["init", "-q", "-b", "master", workDir]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  git(workDir, ["config", "user.name", "Window Close Test"]);
  git(workDir, ["config", "commit.gpgsign", "false"]);
  git(workDir, ["remote", "add", "origin", originDir]);

  // apps/api and apps/web railway.toml — the union of their watchPatterns is what
  // the script derives "deploying" from at runtime (never hardcoded).
  commitFile(
    workDir,
    "apps/api/railway.toml",
    'watchPatterns = ["apps/api/**", "packages/**"]\n',
    "base: api railway.toml",
  );
  const c0 = commitFile(
    workDir,
    "apps/web/railway.toml",
    'watchPatterns = ["apps/web/**", "packages/**"]\n',
    "base: web railway.toml",
  );

  const c1 = commitFile(
    workDir,
    "apps/api/src/thing.ts",
    "export const thing = 1;\n",
    "feat(api): thing",
  );
  const c2 =
    depth >= 2
      ? commitFile(workDir, "packages/shared/x.ts", "export const x = 1;\n", "refactor(shared): x")
      : c1;
  const c3 =
    depth >= 3
      ? commitFile(workDir, ".claude/campaign/bugs/B1.md", "# B1\n", "docs(bugs): file B1")
      : c2;

  git(workDir, ["push", "-q", "origin", "master"]);

  return { workDir, c0, c1, c2, c3 };
}

// ─── spawn the real script (async — a fixture HTTP server shares this process's
// event loop, and spawnSync would block it; mirrors release-health-script.spec.ts) ──

function runScript(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`window-close-check.mjs did not exit within 15s. stdout so far: ${stdout}`));
    }, 15_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

type Route = { match: string; body: unknown; status?: number };

function ghEnv(routes: Route[]): Record<string, string> {
  return {
    WINDOW_CLOSE_GH_CMD: JSON.stringify([process.execPath, fakeGhDriver]),
    FAKE_GH_ROUTES: JSON.stringify(routes),
  };
}

function deploymentRoute(shas: { sha: string; id: number }[]): Route {
  return { match: "deployments?per_page=100", body: shas.map((s) => ({ sha: s.sha, id: s.id })) };
}
function statusesRoute(id: number, states: string[]): Route {
  return { match: `deployments/${id}/statuses`, body: states.map((state) => ({ state })) };
}
function runsRoute(headSha: string, runs: unknown[]): Route {
  return { match: `actions/runs?head_sha=${headSha}`, body: { workflow_runs: runs } };
}
function jobsRoute(runId: number, jobs: unknown[]): Route {
  return { match: `actions/runs/${runId}/jobs`, body: { jobs } };
}
const realJobs = [
  { name: "verify", steps: [{ name: "checkout" }, { name: "npm ci" }, { name: "verify" }] },
];
const billingBlockJobs = [{ name: "verify", steps: [] as unknown[] }];
function greenCiRun(headSha: string, id: number) {
  return {
    id,
    name: "CI",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-23T00:00:00Z",
  };
}

describe("window-close-check.mjs contract", () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("T1 · tonight's exact case: a failed deploy masked by an older sha's later success -> FAIL, naming the failed sha and the served/newest-deploying mismatch", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 3);
    const health = await startHealthServer(fixture.c1); // served = c1 (the LAST sha that actually succeeded)
    try {
      const routes = [
        deploymentRoute([
          { sha: fixture.c1, id: 101 },
          { sha: fixture.c2, id: 102 },
        ]),
        statusesRoute(101, ["in_progress", "success"]), // c1: succeeded
        statusesRoute(102, ["in_progress", "failure"]), // c2: FAILED — never a success
        runsRoute(fixture.c3, [greenCiRun(fixture.c3, 199)]),
        jobsRoute(199, realJobs),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      // The bug's own wrong value: naming the failed deploy AND the served/newest
      // mismatch, not merely a nonzero exit — a script that just crashed would also
      // exit nonzero without proving it caught the right thing.
      expect(stdout).toContain(fixture.c2.slice(0, 8));
      expect(stdout).toContain("deploy FAILED");
      expect(stdout).toContain("does not match the newest deploying sha");
      expect(stdout).toContain("FAIL:");
      expect(status).toBe(1);
    } finally {
      await health.close();
    }
  });

  it("T2 · a docs-only final sha must NOT require served == HEAD — served == newest DEPLOYING sha is enough -> PASS", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 3);
    const health = await startHealthServer(fixture.c2); // served = c2 = the newest DEPLOYING sha, not c3 (HEAD)
    try {
      const routes = [
        deploymentRoute([
          { sha: fixture.c1, id: 201 },
          { sha: fixture.c2, id: 202 },
        ]),
        statusesRoute(201, ["success"]),
        statusesRoute(202, ["success"]), // this time c2 also succeeded
        runsRoute(fixture.c3, [greenCiRun(fixture.c3, 298)]),
        jobsRoute(298, realJobs),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(fixture.c2).not.toBe(fixture.c3); // sanity: served genuinely differs from HEAD
      expect(stdout).toContain("PASS:");
      expect(status).toBe(0);
    } finally {
      await health.close();
    }
  });

  it("T3 · a missing deployment (no GitHub deployment record at all for a deploying sha) -> FAIL", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1); // window = (c0, c1] only
    const health = await startHealthServer(fixture.c1);
    try {
      const routes = [
        deploymentRoute([]), // nothing recorded for c1 at all
        runsRoute(fixture.c1, [greenCiRun(fixture.c1, 301)]),
        jobsRoute(301, realJobs),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(stdout).toContain(fixture.c1.slice(0, 8));
      expect(stdout).toContain("no GitHub deployment record found");
      expect(stdout).toContain("FAIL:");
      expect(status).toBe(1);
    } finally {
      await health.close();
    }
  });

  it("T4 · a billing-block CI artifact (real success conclusion, zero recorded steps) on master's final sha -> FAIL, never mistaken for a real success", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1); // window = (c0, c1] only
    const health = await startHealthServer(fixture.c1);
    try {
      const routes = [
        deploymentRoute([{ sha: fixture.c1, id: 401 }]),
        statusesRoute(401, ["success"]),
        runsRoute(fixture.c1, [greenCiRun(fixture.c1, 402)]),
        jobsRoute(402, billingBlockJobs), // conclusion says success; 0 steps says otherwise
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      // Discriminator: the deploy itself is fine (a real success in its status
      // history) and served == newest-deploying — the ONLY reason to fail is the
      // billing-block CI artifact, so this pins that specific failure text.
      expect(stdout).not.toContain("deploy FAILED");
      expect(stdout).not.toContain("does not match the newest deploying sha");
      expect(stdout).toContain("billing-block artifact");
      expect(stdout).toContain("FAIL:");
      expect(status).toBe(1);
    } finally {
      await health.close();
    }
  });
});
