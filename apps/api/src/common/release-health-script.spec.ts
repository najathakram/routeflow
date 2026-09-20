import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

// PR "feat/release-health-report" — scripts/release-health.mjs compares two Sentry releases
// (new-issue groups, event rate/hour, top offenders) and exits non-zero only on a real
// regression signal, fail-OPEN on any Sentry API unavailability (same rule as
// scripts/ci-audit-critical.mjs / scripts/ci-freshness-guard.mjs). This spec never talks to a
// real Sentry org: SENTRY_API_BASE points the script at a tiny local HTTP server that serves
// canned fixture JSON, and the script is spawned for real (matching the repo's *-script.spec.ts
// convention — see ci-freshness-guard-script.spec.ts) so the whole CLI, not just its internals,
// is under test.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/release-health.mjs");

type Route = { test: (url: string) => boolean; status?: number; body: unknown };

function startFixtureServer(routes: Route[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || "";
      const route = routes.find((r) => r.test(url));
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `no fixture route for ${url}` }));
        return;
      }
      res.writeHead(route.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(route.body));
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

// Async spawn, deliberately NOT spawnSync: the script under test makes real HTTP requests to a
// fixture server running IN THIS SAME Node process (below). spawnSync blocks this process's
// entire event loop until the child exits — including the event loop the fixture server itself
// needs to accept and answer the child's connection — so the child could never get a response
// and would hang until spawnSync's own timeout killed it (reproduced locally: every fixture-
// backed case timed out at exactly the configured `timeout`, status null, ETIMEDOUT). Async
// `spawn` keeps this process's event loop free while the child runs.
function runScript(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`release-health.mjs did not exit within 15s. stdout so far: ${stdout}`));
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

const issue = (overrides: Record<string, unknown> = {}) => ({
  level: "error",
  count: 1,
  title: "Error",
  culprit: "somewhere",
  metadata: {},
  ...overrides,
});

const emptyStats = { data: [] };
const statsWith = (count: number) => ({ data: [[1700000000, [{ count }]]] });

describe("scripts/release-health.mjs (PR: feat/release-health-report)", () => {
  const baseEnv = {
    SENTRY_ORG: "acme",
    SENTRY_PROJECT: "api",
    SENTRY_AUTH_TOKEN: "test-token",
  };
  let servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  it("exits 0 and reports OK when no new issue reaches the critical threshold", async () => {
    const fx = await startFixtureServer([
      { test: (u) => u.includes("/issues/"), body: [issue({ level: "warning" })] },
      { test: (u) => u.includes("/events-stats/"), body: statsWith(10) },
    ]);
    servers.push(fx);

    const result = await runScript(["shaNEW", "shaOLD"], { ...baseEnv, SENTRY_API_BASE: fx.url });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK: no new issue groups exceed the threshold");
  });

  it("exits 1 (fail loud) and prints top offenders with file/line when a new CRITICAL group appears", async () => {
    const fx = await startFixtureServer([
      {
        test: (u) => u.includes("/issues/"),
        body: [
          issue({
            level: "critical",
            count: 42,
            title: "TypeError: cannot read x",
            culprit: "OrdersService.create",
            metadata: { filename: "apps/api/src/orders/orders.service.ts", lineno: 128 },
          }),
        ],
      },
      { test: (u) => u.includes("/events-stats/"), body: statsWith(50) },
    ]);
    servers.push(fx);

    const result = await runScript(["shaNEW", "shaOLD"], { ...baseEnv, SENTRY_API_BASE: fx.url });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("REGRESSION");
    expect(result.stdout).toContain("apps/api/src/orders/orders.service.ts:128");
    // The GH Actions annotation is a stderr-only signal — stdout stays pure report/JSON so a CI
    // step piping it to JSON.parse never chokes on a stray annotation line (see script header).
    expect(result.stderr).toContain("::error::");
  });

  it("respects a raised --threshold — one new critical group under threshold 2 still passes", async () => {
    const fx = await startFixtureServer([
      { test: (u) => u.includes("/issues/"), body: [issue({ level: "critical", count: 1 })] },
      { test: (u) => u.includes("/events-stats/"), body: statsWith(1) },
    ]);
    servers.push(fx);

    const result = await runScript(["shaNEW", "shaOLD", "--threshold", "2"], {
      ...baseEnv,
      SENTRY_API_BASE: fx.url,
    });

    expect(result.status).toBe(0);
  });

  it("--json emits a parseable report whose regression flag matches the exit code", async () => {
    const fx = await startFixtureServer([
      { test: (u) => u.includes("/issues/"), body: [issue({ level: "critical", count: 5 })] },
      { test: (u) => u.includes("/events-stats/"), body: statsWith(5) },
    ]);
    servers.push(fx);

    const result = await runScript(["shaNEW", "shaOLD", "--json"], {
      ...baseEnv,
      SENTRY_API_BASE: fx.url,
    });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.regression).toBe(true);
    expect(parsed.newIssueGroups.atOrAboveThresholdSeverity).toBe(1);
    expect(result.status).toBe(1);
  });

  it("resolves 'current'/'previous' via the releases list endpoint", async () => {
    const fx = await startFixtureServer([
      {
        test: (u) => u.includes("/releases/"),
        body: [{ version: "shaCURRENT" }, { version: "shaPREVIOUS" }],
      },
      { test: (u) => u.includes("/issues/"), body: [] },
      { test: (u) => u.includes("/events-stats/"), body: emptyStats },
    ]);
    servers.push(fx);

    const result = await runScript(["current", "previous"], {
      ...baseEnv,
      SENTRY_API_BASE: fx.url,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("shaPREVIOUS -> shaCURRENT");
  });

  it("fails OPEN (exit 0, ::warning::) when SENTRY_ORG/SENTRY_AUTH_TOKEN are missing", async () => {
    const result = await runScript(["shaNEW", "shaOLD"], {
      SENTRY_ORG: undefined,
      SENTRY_AUTH_TOKEN: undefined,
      SENTRY_PROJECT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::");
  });

  it("fails OPEN (exit 0, ::warning::) when the Sentry API is unreachable", async () => {
    // Nothing listens here — spawnSync's fetch will hit ECONNREFUSED.
    const result = await runScript(["shaNEW", "shaOLD"], {
      ...baseEnv,
      SENTRY_API_BASE: "http://127.0.0.1:1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::");
  });

  it("fails OPEN (exit 0, ::warning::) when the Sentry API returns a malformed body", async () => {
    const fx = await startFixtureServer([
      { test: (u) => u.includes("/issues/"), body: { not: "an array" } },
      { test: (u) => u.includes("/events-stats/"), body: statsWith(1) },
    ]);
    servers.push(fx);

    const result = await runScript(["shaNEW", "shaOLD"], { ...baseEnv, SENTRY_API_BASE: fx.url });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::");
  });
});
