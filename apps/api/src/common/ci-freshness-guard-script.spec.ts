import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

// REG-E2EGUARD-403 — the e2e job's freshness guard treats a `gh api` 403 error
// body as if it were the newest deployment sha, so a run token that lacks
// `deployments:read` makes EVERY deployment_status-triggered E2E run silently
// skip itself (`run=false`), reported green, with zero E2E coverage.
//
// The fix is scripts/ci-freshness-guard.mjs: fail OPEN (run=true, ::warning::)
// whenever `gh api` cannot be trusted (403, garbage JSON, empty array is a
// legitimate "no deployments" case, timeout), and only skip (run=false,
// ::notice::) when a real newer deployment is confirmed. ci.yml's `freshness`
// step is rewritten to call the script and grants the job
// `permissions: { contents: read, deployments: read }` so the token that was
// missing `deployments:read` stops being a possible cause.
//
// A fake `gh` driver stands in for the real CLI, selected by FAKE_GH_MODE, so
// every case here runs with no network access and no real GitHub token.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/ci-freshness-guard.mjs");
const WORKFLOW = path.join(REPO_ROOT, ".github/workflows/ci.yml");

const ERR_403_BODY =
  '{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest","status":"403"}';

let dir: string;
let fakeGhDriver: string; // node script: `node fakeGhDriver <args...>`
let ghShimDir: string; // directory containing an executable `gh` on PATH

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-freshness-guard-"));

  fakeGhDriver = path.join(dir, "fake-gh.mjs");
  fs.writeFileSync(
    fakeGhDriver,
    [
      "const mode = process.env.FAKE_GH_MODE || 'match';",
      "const deploySha = process.env.DEPLOY_SHA || '';",
      "const endpoint = process.argv[process.argv.length - 1];",
      "import fs from 'node:fs';",
      "",
      "function out(json, code) {",
      "  process.stdout.write(json);",
      "  process.exit(code);",
      "}",
      "",
      // B621: a scripted world for the successor confirmation. FAKE_GH_STEPS is JSON
      // { deployments: [...], runs: [...], statuses: [...] }; each list is a queue of
      // { code?, body } consumed one entry per call (the last repeats), counted in a state file
      // because every `gh` call is a fresh process.
      "if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, endpoint + '\\n');",
      // Slow-machine simulation: every call takes FAKE_GH_DELAY_MS of real time before it answers.
      "if (process.env.FAKE_GH_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_GH_DELAY_MS));",
      "if (process.env.FAKE_GH_STEPS) {",
      "  const steps = JSON.parse(process.env.FAKE_GH_STEPS);",
      "  const key = /\\/statuses/.test(endpoint) ? 'statuses' : /\\/runs/.test(endpoint) ? 'runs' : 'deployments';",
      "  const stateFile = process.env.FAKE_GH_STATE;",
      "  const counts = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};",
      "  const i = counts[key] || 0;",
      "  counts[key] = i + 1;",
      "  fs.writeFileSync(stateFile, JSON.stringify(counts));",
      "  const q = steps[key] || [];",
      "  const pick = q[Math.min(i, q.length - 1)] || { code: 1, body: 'no scripted response' };",
      "  out(typeof pick.body === 'string' ? pick.body : JSON.stringify(pick.body), pick.code || 0);",
      "}",
      "",
      "switch (mode) {",
      "  case 'err403':",
      `    process.stderr.write('gh: Resource not accessible by integration (HTTP 403)\\n');`,
      `    out(${JSON.stringify(ERR_403_BODY)}, 1);`,
      "    break;",
      "  case 'match':",
      "    out(JSON.stringify([{ sha: deploySha, id: 1 }]), 0);",
      "    break;",
      "  case 'newer':",
      // Superseded AND a later run exists (the confirmed case): every endpoint answers.
      "    if (/\\/runs/.test(endpoint)) out(JSON.stringify({ workflow_runs: [{ status: 'in_progress', html_url: 'https://gh/run/9' }] }), 0);",
      "    out(JSON.stringify([{ sha: 'ffffffffffffffffffffffffffffffffffffffff', id: 2 }]), 0);",
      "    break;",
      "  case 'empty':",
      "    out(JSON.stringify([]), 0);",
      "    break;",
      "  case 'garbage':",
      "    out('not json', 0);",
      "    break;",
      "  case 'hang':",
      // 10 s — comfortably longer than the fake's own CI_FRESHNESS_GH_TIMEOUT_MS (set to 500ms
      // by the test), so the hang case can only pass by taking the script's own fail-open
      // timeout path, never by the fake happening to answer in time.
      "    setTimeout(() => out(JSON.stringify([{ sha: deploySha, id: 1 }]), 0), 10000);",
      "    break;",
      "  default:",
      "    process.stderr.write(`unknown FAKE_GH_MODE: ${mode}\\n`);",
      "    process.exit(1);",
      "}",
    ].join("\n"),
  );

  // T1 needs `gh` resolvable as a bare command on PATH (the real workflow
  // step invokes `gh api ...` directly), so expose the fake driver as an
  // executable `gh` shim — a bash script with no extension, matching Git
  // Bash on Windows and bash on the CI runner.
  ghShimDir = path.join(dir, "bin");
  fs.mkdirSync(ghShimDir, { recursive: true });
  const shimPath = path.join(ghShimDir, "gh");
  fs.writeFileSync(
    shimPath,
    ["#!/usr/bin/env bash", `exec node "${fakeGhDriver}" "$@"`, ""].join("\n"),
  );
  fs.chmodSync(shimPath, 0o755);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function loadWorkflow(): any {
  return yaml.load(fs.readFileSync(WORKFLOW, "utf8"));
}

function freshnessStep(): any {
  const doc = loadWorkflow();
  const gateJob = doc.jobs["e2e-gate"];
  const step = (gateJob.steps as any[]).find((s) => s.id === "freshness");
  if (!step) {
    throw new Error("no step with id: freshness found in the e2e-gate job");
  }
  return step;
}

function freshnessRunText(): string {
  return freshnessStep().run as string;
}

function runOutputFile(): string {
  return path.join(dir, `gh-output-${Math.random().toString(36).slice(2)}.txt`);
}

function readOutputs(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

// T1 — executes the ACTUAL `run:` text from ci.yml's `freshness` step, via
// bash, the way the workflow really runs it — the bug's own wrong value.
function runYamlDrivenFreshnessStep(env: NodeJS.ProcessEnv): {
  res: ReturnType<typeof spawnSync>;
  outFile: string;
} {
  const runText = freshnessRunText();
  const outFile = runOutputFile();
  const res = spawnSync("bash", ["-euo", "pipefail", "-c", runText], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...env,
      GITHUB_OUTPUT: outFile,
      PATH: `${ghShimDir}${path.delimiter}${env.PATH ?? process.env.PATH ?? ""}`,
      // On win32, libuv resolves a bare `gh` only through PATHEXT, so the
      // extensionless shim on PATH above is skipped in favor of the real
      // gh.exe (and Node >= 20.12 refuses to spawn a .cmd/.bat shim without
      // shell:true, which would fail for the wrong reason too). Route the
      // script's own `gh` invocation to the fake driver directly instead, so
      // this test never depends on real PATH resolution or the network.
      ...(process.platform === "win32"
        ? { CI_FRESHNESS_GH_CMD: JSON.stringify([process.execPath, fakeGhDriver]) }
        : {}),
    },
  });
  return { res, outFile };
}

// T2/T3 — direct invocation of the standalone script under
// CI_FRESHNESS_GH_CMD (mirrors ci-audit-critical.mjs's CI_AUDIT_CMD pattern).
function runScriptDirect(
  env: NodeJS.ProcessEnv,
  opts: { omitGithubOutput?: boolean } = {},
): {
  res: ReturnType<typeof spawnSync>;
  outFile: string;
} {
  const outFile = runOutputFile();
  const spawnEnv: NodeJS.ProcessEnv = {
    ...env,
    GITHUB_OUTPUT: outFile,
    CI_FRESHNESS_GH_CMD:
      env.CI_FRESHNESS_GH_CMD ?? JSON.stringify([process.execPath, fakeGhDriver]),
  };
  // The runner itself may be inside a GitHub Actions job, so delete rather
  // than merely omit — the inherited GITHUB_OUTPUT must not leak through.
  if (opts.omitGithubOutput) delete spawnEnv.GITHUB_OUTPUT;
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: spawnEnv });
  return { res, outFile };
}

function fakeEnv(mode: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EVENT_NAME: "deployment_status",
    DEPLOY_SHA: "abc123",
    GITHUB_REPOSITORY: "acme/repo",
    GH_TOKEN: "x",
    FAKE_GH_MODE: mode,
    ...extra,
  };
}

describe("ci-freshness-guard.mjs contract", () => {
  // FIX1 follow-up (RC1 finding): T1/T2 (REG-E2EGUARD-403, this `it` and the
  // one below) do NOT share the flaky-timing mechanism that the "(pin) hang"
  // case had (an `elapsedMs`/`toBeLessThan(5000)` assertion around a
  // CPU-load-sensitive timeout race) — neither asserts on elapsed wall-clock
  // time at all, only on `outputs.run`/`res.stdout`/`res.status`. So no fix
  // was needed here; only the hang case's timing assertion was removed.
  it("T1 · REG-E2EGUARD-403 · YAML-driven: a 403 error body must NOT be read as the newest deployment sha (fail open)", () => {
    const { res, outFile } = runYamlDrivenFreshnessStep(fakeEnv("err403"));
    const outputs = readOutputs(outFile);

    // Today: the 403 error body is captured as `$latest`, compared unequal to
    // DEPLOY_SHA, and the step wrongly emits run=false — this assertion fails
    // on that concrete wrong value, not on a missing file.
    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain("Could not read the newest deployment");
    // Discriminator: only the fixture's 403 body can produce this literal, so
    // any other fail-open path (ENOENT, a live gh 401, a timeout) goes red
    // here instead of passing for the wrong reason.
    expect(res.stdout).toContain("Resource not accessible by integration");
  });

  it("T2 · REG-E2EGUARD-403 · script-direct: exits 0, fails open (run=true), warns, and quotes the 403 body", () => {
    const { res, outFile } = runScriptDirect(fakeEnv("err403"));
    const outputs = readOutputs(outFile);

    // Assertion ORDER is load-bearing here and in every pin below: the
    // behavioural oracle (run=…, then the marker this case alone prints) comes
    // first and `res.status` last, so a red test names its own expected value
    // instead of every test reporting the same process-level exit code.
    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain(ERR_403_BODY.slice(0, 50));
    expect(res.status).toBe(0);
  });

  it("T3 (pin) match: newest deployment IS this sha -> run=true, ::notice::", () => {
    const { res, outFile } = runScriptDirect(fakeEnv("match"));
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::notice::");
    expect(res.status).toBe(0);
  });

  it("T3 (pin) newer: a genuinely superseded deployment still skips -> run=false, ::notice::Skipping", () => {
    const { res, outFile } = runScriptDirect(fakeEnv("newer"));
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("false");
    expect(res.stdout).toContain("::notice::Skipping");
    expect(res.status).toBe(0);
  });

  it("T3 (pin) empty: no deployments recorded -> run=true, explanatory notice", () => {
    const { res, outFile } = runScriptDirect(fakeEnv("empty"));
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("no deployments recorded");
    expect(res.status).toBe(0);
  });

  it("T3 (pin) garbage: unparseable API response -> run=true, ::warning::", () => {
    const { res, outFile } = runScriptDirect(fakeEnv("garbage"));
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::warning::");
    expect(res.status).toBe(0);
  });

  it("T3 (pin) hang: bounded timeout still fails open (run=true, ::warning::, exit 0)", () => {
    const { res, outFile } = runScriptDirect(
      fakeEnv("hang", { CI_FRESHNESS_GH_TIMEOUT_MS: "500" }),
    );
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::warning::");
    expect(res.status).toBe(0);
  }, 20_000);

  it("T3 (pin) missing DEPLOY_SHA: exits 0, fails open, warns", () => {
    const env = fakeEnv("match");
    delete env.DEPLOY_SHA;
    const { res, outFile } = runScriptDirect(env);
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::warning::");
    expect(res.status).toBe(0);
  });

  it("T3 (pin) missing GITHUB_OUTPUT: exits 2 rather than exiting 0 having published nothing", () => {
    const { res, outFile } = runScriptDirect(fakeEnv("match"), { omitGithubOutput: true });

    // Exiting 0 with no `run` output leaves every consumer's
    // `== 'true'` false: the suite skips and the job is green — the very
    // failure mode this guard exists to prevent.
    expect(res.stderr).toContain("GITHUB_OUTPUT");
    expect(fs.existsSync(outFile)).toBe(false);
    expect(res.status).toBe(2);
  });

  it("T3 (pin) dispatch events: no DEPLOY_SHA is normal -> run=true, ::notice::, never ::warning::", () => {
    for (const eventName of ["workflow_dispatch", "repository_dispatch"]) {
      const env = fakeEnv("match", { EVENT_NAME: eventName });
      delete env.DEPLOY_SHA;
      const { res, outFile } = runScriptDirect(env);
      const outputs = readOutputs(outFile);

      expect(outputs.run).toBe("true");
      expect(res.stdout).toContain(`::notice::${eventName} run`);
      // A warning here would claim a deployments-API read failed when none
      // was ever attempted — on exactly the manual runs an operator reads.
      expect(res.stdout).not.toContain("::warning::");
      expect(res.status).toBe(0);
    }
  });

  // ── B621: a superseded deployment is only skipped once a later E2E run is CONFIRMED ─────────────
  // The world is scripted per endpoint (deployments / runs / statuses), each a queue of responses.
  // The confirmation poll's whole budget. Linux CI keeps it tight; win32 needs room for process spawns.
  const SUCCESSOR_TIMEOUT_MS = process.platform === "win32" ? "3000" : "400";
  const NEW = "ffffffffffffffffffffffffffffffffffffffff";
  const dep = (sha: string) => ({ body: [{ sha, id: 2 }] });
  const runs = (...r: object[]) => ({ body: { workflow_runs: r } });
  const state = (st: string) => ({ body: [{ state: st }] });
  function superseded(steps: Record<string, object[]>, extra: Record<string, string> = {}) {
    const stateFile = path.join(dir, `state-${Math.random().toString(36).slice(2)}.json`);
    return runScriptDirect(
      fakeEnv("match", {
        FAKE_GH_STEPS: JSON.stringify(steps),
        FAKE_GH_STATE: stateFile,
        // Each poll spawns the fake gh as a fresh node process; on win32 that costs a few hundred
        // ms under load, so 400 ms left no room for a second poll (B621 read "unconfirmed").
        CI_E2E_SUCCESSOR_TIMEOUT_MS: SUCCESSOR_TIMEOUT_MS,
        CI_E2E_SUCCESSOR_INTERVAL_MS: "50",
        CI_FRESHNESS_VIRTUAL_CLOCK: "1",
        ...extra,
      }),
    );
  }

  it("B621 · superseded + a later run in progress -> confirmed: run=false, cites the run URL, exit 0", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs({ status: "in_progress", html_url: "https://gh/run/9" })],
    });
    const outputs = readOutputs(outFile);
    expect(outputs).toMatchObject({ run: "false", reason: "confirmed" });
    expect(res.stdout).toContain("https://gh/run/9");
    expect(res.status).toBe(0);
  });

  it("B621 · superseded + NO later run -> unconfirmed: red (exit 3), run=false, never a quiet skip", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs()],
      statuses: [state("success")],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(3);
  });

  it("B621 · a CANCELLED successor run is not confirmation (the chain would end in nothing)", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [
        runs(
          { status: "completed", conclusion: "cancelled" },
          { status: "completed", conclusion: "skipped" },
        ),
      ],
      statuses: [state("success")],
    });
    // Successor deployment LIVE (state success) with its E2E cancelled: running the OLD sha's suite
    // would only wait out the readiness gate against a newer live commit and go red later (Opus
    // fad6aa19 finding 1). So this is a clear red that names the run to re-run, not a fallback.
    expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
    expect(res.stdout).toMatch(/re-run/i);
    expect(res.status).toBe(3);
  });

  // #1134 Opus item 2: a successor whose runs were all cancelled/skipped must NOT leave a permanent
  // red on the OLD sha after the poll. The old run's E2E runs instead, against what is live (the
  // same fallback as a failed successor), and says so: real test signal, never a quiet skip.
  it("#1134 item 2 · a cancelled successor STILL DEPLOYING at the deadline -> run=true here, exit 0, says so", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs({ status: "completed", conclusion: "cancelled" })],
      statuses: [state("in_progress")],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "true", reason: "successor-unconfirmed" });
    expect(res.stdout).toMatch(/running E2E for abc123 against whatever is live/);
    expect(res.status).toBe(0);
  });

  // #1134 Opus item 1: `queued` is not confirmation. Per-SHA e2e concurrency with
  // cancel-in-progress means a queued successor can still be cancelled by a later echo.
  it.each(["queued", "pending", "waiting", "requested"])(
    "#1134 item 1 · a successor run that is only %s is never confirmation (falls back, never skips)",
    (status) => {
      const { res, outFile } = superseded({
        deployments: [dep(NEW)],
        runs: [runs({ status, html_url: "https://gh/run/11" })],
        statuses: [state("in_progress")],
      });
      expect(readOutputs(outFile)).toMatchObject({ run: "true", reason: "successor-unconfirmed" });
      expect(res.stdout).not.toContain("Skipping (confirmed)");
      expect(res.status).toBe(0);
    },
  );

  // Opus 7ec75f57 finding 1: "live" is ANY success in the successor's status history, not just the
  // newest status. A redeploy of the same sha goes in_progress again while the earlier success still
  // serves, and a live deployment can be flipped to inactive; neither may route to the fallback.
  const history = (...states: string[]) => ({ body: states.map((st) => ({ state: st })) });
  it.each([
    ["a redeploy in progress over an earlier success", ["in_progress", "success"]],
    ["an inactive status over an earlier success", ["inactive", "success"]],
  ])(
    "#1134 · %s counts as LIVE -> exit 3 with the re-run hint, never the fallback",
    (_l, states) => {
      const { res, outFile } = superseded({
        deployments: [dep(NEW)],
        runs: [
          runs({ status: "completed", conclusion: "cancelled", html_url: "https://gh/run/12" }),
        ],
        statuses: [history(...states)],
      });
      expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
      expect(res.stdout).toContain("https://gh/run/12");
      expect(res.status).toBe(3);
    },
  );

  it("#1134 · a FAILED redeploy over an earlier success is not successor-failed -> exit 3", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs({ status: "completed", conclusion: "cancelled" })],
      statuses: [history("failure", "success")],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
    expect(res.status).toBe(3);
  });

  it("#1134 · a FAILED statuses read fails closed (exit 3), never the fallback", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs({ status: "completed", conclusion: "cancelled" })],
      statuses: [{ code: 1, body: "boom 502" }],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
    expect(res.status).toBe(3);
  });

  // Opus fad6aa19 finding 2: every deployed sha carries ONE completed/skipped workflow run (the
  // deployment_status `in_progress` echo, all jobs gated off). It is not an E2E attempt, so it must not
  // count as "the successor has runs": with only that, a timeout is still the red exit 3.
  it("#1134 · the successor's lone SKIPPED echo run does not count as a run -> exit 3, not a fallback", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs({ status: "completed", conclusion: "skipped" })],
      statuses: [state("in_progress")],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
    expect(res.status).toBe(3);
  });

  // #1134 Opus item 4: the newest deployment is read for THIS deployment's environment only, so a
  // deployment to another environment (a preview, the web service) can never supersede this one.
  it("#1134 item 4 · every deployments read carries the triggering deployment's environment", () => {
    const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.txt`);
    superseded(
      { deployments: [dep(NEW)], runs: [runs({ status: "in_progress", html_url: "u" })] },
      { DEPLOY_ENV: "acme / production", FAKE_GH_LOG: log },
    );
    const deps = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => /\/deployments\?/.test(l));
    expect(deps.length).toBeGreaterThanOrEqual(2); // the first read and the confirmation poll
    for (const d of deps) expect(d).toContain("environment=acme%20%2F%20production");
  });

  it("#1134 item 4 · no DEPLOY_ENV (a dispatch-like env) -> no environment filter is invented", () => {
    const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.txt`);
    superseded(
      { deployments: [dep(NEW)], runs: [runs({ status: "in_progress", html_url: "u" })] },
      { FAKE_GH_LOG: log },
    );
    const deps = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => /\/deployments\?/.test(l));
    expect(deps.length).toBeGreaterThanOrEqual(1);
    for (const d of deps) expect(d).not.toContain("environment=");
  });

  it("B621 · successor still deploying, its run appears later -> confirmed after polling", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs(), runs({ status: "in_progress", html_url: "https://gh/run/10" })],
      statuses: [state("in_progress")],
    });
    expect(readOutputs(outFile).reason).toBe("confirmed");
    expect(res.stdout).toContain("waiting for a later E2E run");
    expect(res.status).toBe(0);
  });

  it("B621 · a slow machine (every gh call outlasts the whole window) still polls the scripted world -> confirmed", () => {
    // Forces the loaded-CI-box path: each fake `gh` call takes 600 ms of real time, longer than the
    // 400 ms window, so a wall-clock deadline expires before the second poll can read the run.
    const { res, outFile } = superseded(
      {
        deployments: [dep(NEW)],
        runs: [runs(), runs({ status: "in_progress", html_url: "https://gh/run/10" })],
        statuses: [state("in_progress")],
      },
      { FAKE_GH_DELAY_MS: "600", CI_E2E_SUCCESSOR_TIMEOUT_MS: "400" },
    );
    expect(readOutputs(outFile).reason).toBe("confirmed");
    expect(res.status).toBe(0);
  });

  it("B621 · successor deployment FAILED (never gets a run) -> run=true against what is live, and says so", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW)],
      runs: [runs()],
      statuses: [state("failure")],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "true", reason: "successor-failed" });
    expect(res.stdout).toContain("will never have an E2E run");
    expect(res.status).toBe(0);
  });

  it("B621 · an API error, or a malformed body, while confirming fails CLOSED (exit 3), not open", () => {
    for (const bad of [{ code: 1, body: "boom 403" }, { body: [] }, { body: "not json" }]) {
      const { res, outFile } = superseded({ deployments: [dep(NEW)], runs: [bad] });
      expect(readOutputs(outFile)).toMatchObject({ run: "false", reason: "unconfirmed" });
      expect(res.status).toBe(3);
    }
  });

  it("B621 · the newest deployment turns out to be this one while polling -> run=true (retargeted)", () => {
    const { res, outFile } = superseded({
      deployments: [dep(NEW), dep("abc123")],
      runs: [runs()],
      statuses: [state("in_progress")],
    });
    expect(readOutputs(outFile)).toMatchObject({ run: "true", reason: "newest" });
    expect(res.status).toBe(0);
  });

  it("B621 · YAML-driven: the workflow step lets exit 3 fail the job and publishes no run=true", () => {
    const stateFile = path.join(dir, `state-${Math.random().toString(36).slice(2)}.json`);
    const { res, outFile } = runYamlDrivenFreshnessStep(
      fakeEnv("match", {
        FAKE_GH_STEPS: JSON.stringify({
          deployments: [dep(NEW)],
          runs: [runs()],
          statuses: [state("success")],
        }),
        FAKE_GH_STATE: stateFile,
        CI_E2E_SUCCESSOR_TIMEOUT_MS: "300",
        CI_E2E_SUCCESSOR_INTERVAL_MS: "50",
      }),
    );
    expect(readOutputs(outFile).run).not.toBe("true");
    expect(res.status).toBe(3);
  });

  // The two "verify job untouched" / "consumers unchanged" invariance locks are
  // folded into the T4 tests that are red today, so no assertion in this file
  // can pass before the fix lands (they would otherwise be un-reddable pins).
  it("T4 · REG-E2EGUARD-403 · e2e job gets contents+deployments read; verify job untouched", () => {
    const doc = loadWorkflow();

    // The gate reads deployments and (B621) the workflow-runs API to confirm a later run exists;
    // the e2e job itself no longer needs either.
    expect(doc.jobs["e2e-gate"].permissions).toEqual({
      contents: "read",
      deployments: "read",
      actions: "read",
    });
    expect(doc.jobs.e2e.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.verify.permissions).toBeUndefined();
  });

  it("T4 · REG-E2EGUARD-403 · the freshness step calls the script; e2e runs only on the gate output", () => {
    const raw = fs.readFileSync(WORKFLOW, "utf8");

    expect(freshnessRunText()).toContain("scripts/ci-freshness-guard.mjs");
    // EVENT_NAME is what lets the script tell a dispatch run apart from a
    // genuine deployments-API failure.
    expect((freshnessStep().env ?? {}).EVENT_NAME).toBe("${{ github.event_name }}");
    // #1134 item 4: the environment filter comes from the triggering deployment itself.
    expect((freshnessStep().env ?? {}).DEPLOY_ENV).toBe(
      "${{ github.event.deployment.environment }}",
    );
    // Explicit fail-open fallback for a crash OUTSIDE the script's own logic.
    expect(freshnessRunText()).toContain("run=true");
    // B621: a superseded deployment must SKIP the e2e job, never leave a green job whose every step
    // skipped. So the freshness decision is its own job and `e2e` runs only on its output; no step
    // inside `e2e` reads `steps.freshness` any more.
    const doc0 = loadWorkflow();
    expect(doc0.jobs.e2e.needs).toBe("e2e-gate");
    expect(doc0.jobs.e2e.if).toBe("needs.e2e-gate.outputs.run == 'true'");
    expect(doc0.jobs["e2e-gate"].outputs.run).toBe("${{ steps.freshness.outputs.run }}");
    expect((raw.match(/steps\.freshness\.outputs\.run == 'true'/g) ?? []).length).toBe(0);
    // Exit 3 (superseded, no later run confirmed) must reach the job as a failure, not be
    // swallowed by the crash fallback that publishes run=true.
    expect(freshnessRunText()).toMatch(/"\$rc" = "3"/);

    // The helper checkout must take the script from the DEFAULT BRANCH: on
    // deployment_status, checkout's default ref is the deployment's sha, which
    // for a superseded/rolled-back deployment predates the script entirely.
    const doc = loadWorkflow();
    const helper = (doc.jobs["e2e-gate"].steps as any[]).find(
      (s) => s.name === "Checkout freshness guard script",
    );
    expect(helper).toBeDefined();
    expect(String(helper.uses)).toMatch(/^actions\/checkout@/);
    expect(helper.if).toBeUndefined();
    expect(helper.with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(String(helper.with["sparse-checkout"])).toContain("scripts");
  });
});
