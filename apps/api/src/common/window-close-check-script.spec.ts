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
// Independent review of the first version required a redesign of step (e): ci.yml has
// no `push:` trigger, so a "CI" run keyed on master's own (squash-merge) head sha
// essentially never exists — the original design could never pass. The fix looks up
// the merged PR for a commit (`commits/{sha}/pulls`), requires that PR head's Git tree
// to match the commit's own tree (`treesMatch`), and checks CI on the PR HEAD sha
// instead. A docs-only tail with no PR CI of its own carries the verdict forward from
// the newest deploying commit, verified with the same rigor — never assumed.
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
// { match, body, status? }). The LONGEST `match` substring found in the joined
// `gh api ...` argv wins — not merely the first in array order — because
// "commits/<sha>/pulls" always contains "commits/<sha>" as a substring, and route
// construction order must not silently decide which one a call resolves to. No match
// at all is a hard error (surfaces a test that forgot to stub a call, rather than
// silently returning empty data).

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
      "const candidates = routes.filter((r) => joined.includes(r.match));",
      "candidates.sort((a, b) => b.match.length - a.match.length);",
      "const route = candidates[0];",
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

/** A /health server that never responds — for the timeout fail-closed case. */
function startHangingHealthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(() => {
      // deliberately never calls res.end()
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
function pullsRoute(sha: string, prs: unknown[]): Route {
  return { match: `commits/${sha}/pulls`, body: prs };
}
function commitRoute(sha: string, treeSha: string): Route {
  return { match: `commits/${sha}`, body: { sha, commit: { tree: { sha: treeSha } } } };
}
function mergedPr(headSha: string, number = 1) {
  return { number, merged_at: "2026-09-23T00:00:00Z", head: { sha: headSha } };
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
/** The full "this commit's PR checked out clean and CI on its head sha is a real
 *  success" route bundle — the common case every deploying commit needs. */
function prCiSuccessRoutes(
  sha: string,
  prHeadSha: string,
  treeSha: string,
  runId: number,
): Route[] {
  return [
    pullsRoute(sha, [mergedPr(prHeadSha)]),
    commitRoute(sha, treeSha),
    commitRoute(prHeadSha, treeSha), // same tree — the squash carried the PR's content exactly
    runsRoute(prHeadSha, [greenCiRun(prHeadSha, runId)]),
    jobsRoute(runId, realJobs),
  ];
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
        // HEAD (c3) is docs-only and has no PR of its own -> falls back to c2, whose
        // own PR/tree/CI check is fully valid (isolates this test to the deploy
        // failure + served mismatch, not a CI finding).
        pullsRoute(fixture.c3, []),
        ...prCiSuccessRoutes(fixture.c2, "pr-head-c2", "tree-c2", 501),
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

  it("T2 · a docs-only final sha must NOT require served == HEAD, and carries its CI verdict forward from the predecessor deploying sha's PR -> PASS", async () => {
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
        pullsRoute(fixture.c3, []), // HEAD (c3) genuinely has no PR of its own
        ...prCiSuccessRoutes(fixture.c2, "pr-head-c2", "tree-c2", 502),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(fixture.c2).not.toBe(fixture.c3); // sanity: served genuinely differs from HEAD
      expect(stdout).toContain("carried forward from predecessor deploying sha");
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
        ...prCiSuccessRoutes(fixture.c1, "pr-head-c1", "tree-c1", 301),
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

  it("T4 · a billing-block CI artifact (real success conclusion, zero recorded steps) on the PR head sha -> FAIL, never mistaken for a real success", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1); // window = (c0, c1] only
    const health = await startHealthServer(fixture.c1);
    try {
      const routes = [
        deploymentRoute([{ sha: fixture.c1, id: 401 }]),
        statusesRoute(401, ["success"]),
        pullsRoute(fixture.c1, [mergedPr("pr-head-c1")]),
        commitRoute(fixture.c1, "tree-c1"),
        commitRoute("pr-head-c1", "tree-c1"),
        runsRoute("pr-head-c1", [greenCiRun("pr-head-c1", 402)]),
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

  it("T5 · the squash master head itself has no CI run keyed on its own sha, but the PR head does and the trees match -> PASS", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1); // masterHead = c1, a deploying commit with its own PR
    const health = await startHealthServer(fixture.c1);
    try {
      const routes = [
        deploymentRoute([{ sha: fixture.c1, id: 501 }]),
        statusesRoute(501, ["success"]),
        // Deliberately NO `actions/runs?head_sha=<c1>` route: if the script ever
        // regressed to checking CI on the squash commit's OWN sha again, the fake
        // driver would find no route and this test would hard-fail instead of
        // silently passing for the wrong reason.
        ...prCiSuccessRoutes(fixture.c1, "pr-head-c1-t5", "tree-t5", 900),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(stdout).toContain("PASS:");
      expect(status).toBe(0);
    } finally {
      await health.close();
    }
  });

  it("T6 · the squash commit's tree does not match its PR head's tree -> FAIL", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1);
    const health = await startHealthServer(fixture.c1);
    try {
      const routes = [
        deploymentRoute([{ sha: fixture.c1, id: 601 }]),
        statusesRoute(601, ["success"]),
        pullsRoute(fixture.c1, [mergedPr("pr-head-c1-t6")]),
        commitRoute(fixture.c1, "tree-master-side"),
        commitRoute("pr-head-c1-t6", "tree-pr-side"), // deliberately different
        runsRoute("pr-head-c1-t6", [greenCiRun("pr-head-c1-t6", 602)]),
        jobsRoute(602, realJobs),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(stdout).not.toContain("deploy FAILED");
      expect(stdout).toContain("does not match tree of its PR head");
      expect(stdout).toContain("FAIL:");
      expect(status).toBe(1);
    } finally {
      await health.close();
    }
  });

  it("T7a · API-error surface: a non-JSON gh response body -> FAIL closed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1);
    const health = await startHealthServer(fixture.c1);
    try {
      const routes: Route[] = [
        { match: "deployments?per_page=100", body: "this is not json" }, // corrupted on purpose
        ...prCiSuccessRoutes(fixture.c1, "pr-head-c1-t7a", "tree-t7a", 701),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(stdout).toContain("FAIL:");
      expect(stdout).toContain("unparseable response");
      expect(status).toBe(1);
    } finally {
      await health.close();
    }
  });

  it("T7b · API-error surface: gh exits non-zero -> FAIL closed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1);
    const health = await startHealthServer(fixture.c1);
    try {
      const routes: Route[] = [
        deploymentRoute([{ sha: fixture.c1, id: 702 }]),
        statusesRoute(702, ["success"]),
        // The PR lookup itself fails hard (rate limit / outage) — never eligible
        // for the docs-only fallback, and never silently treated as "no PR".
        {
          match: `commits/${fixture.c1}/pulls`,
          body: '{"message":"rate limit exceeded"}',
          status: 17,
        },
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(stdout).toContain("FAIL:");
      expect(stdout).toContain("CI on master HEAD");
      expect(stdout).toContain("exit 17");
      expect(status).toBe(1);
    } finally {
      await health.close();
    }
  });

  it("T7c · API-error surface: prod /health times out -> FAIL closed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1);
    const hanging = await startHangingHealthServer();
    try {
      const routes = [
        deploymentRoute([{ sha: fixture.c1, id: 703 }]),
        statusesRoute(703, ["success"]),
        ...prCiSuccessRoutes(fixture.c1, "pr-head-c1-t7c", "tree-t7c", 703),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", hanging.url],
        { ...ghEnv(routes), WINDOW_CLOSE_HTTP_TIMEOUT_MS: "300" },
      );

      expect(stdout).toContain("FAIL:");
      expect(stdout).toContain("timed out");
      expect(status).toBe(1);
    } finally {
      await hanging.close();
    }
  });

  it("T8 · the real Railway status sequence [in_progress, success, inactive] counts as a success -> PASS", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "window-close-repo-"));
    const fixture = buildFixtureRepo(root, 1);
    const health = await startHealthServer(fixture.c1);
    try {
      const routes = [
        deploymentRoute([{ sha: fixture.c1, id: 801 }]),
        statusesRoute(801, ["in_progress", "success", "inactive"]),
        ...prCiSuccessRoutes(fixture.c1, "pr-head-c1-t8", "tree-t8", 801),
      ];
      const { status, stdout } = await runScript(
        fixture.workDir,
        ["--since", fixture.c0, "--base-url", health.url],
        ghEnv(routes),
      );

      expect(stdout).toContain("PASS:");
      expect(status).toBe(0);
    } finally {
      await health.close();
    }
  });
});
