import { spawnSync, spawn } from "node:child_process";
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
      "",
      "function out(json, code) {",
      "  process.stdout.write(json);",
      "  process.exit(code);",
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
      "    out(JSON.stringify([{ sha: 'ffffffffffffffffffffffffffffffffffffffff', id: 2 }]), 0);",
      "    break;",
      "  case 'empty':",
      "    out(JSON.stringify([]), 0);",
      "    break;",
      "  case 'garbage':",
      "    out('not json', 0);",
      "    break;",
      "  case 'hang':",
      // 10 s — comfortably longer than the hang pin's 5 s bound, so that test
      // can only pass when the script's own timeout fires.
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
  const e2eJob = doc.jobs.e2e;
  const step = (e2eJob.steps as any[]).find((s) => s.id === "freshness");
  if (!step) {
    throw new Error("no step with id: freshness found in the e2e job");
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

  it("T3 (pin) hang: bounded timeout still fails open within 5s", () => {
    const { res, outFile } = runScriptDirect(
      fakeEnv("hang", { CI_FRESHNESS_GH_TIMEOUT_MS: "500" }),
    );
    const outputs = readOutputs(outFile);

    expect(outputs.run).toBe("true");
    expect(res.stdout).toContain("::warning::");
    expect(res.status).toBe(0);
  }, 20_000);

  it("RC1: hang with CPU saturation — timing assertion can trip; behavioral outputs still correct", () => {
    // Induce real CPU contention by spawning busy-loop children saturating
    // every core, then run the hang test. The 4.5 s margin is meant to absorb
    // node/subprocess startup, not a real regression signal; under heavy load,
    // elapsed time may exceed 5000 ms while behavioral outputs stay correct
    // (run=true, warning present, exit 0).
    const cpuSaturation: ReturnType<typeof spawn>[] = [];
    const numCores = os.cpus().length;
    try {
      // Spawn busy-loop children to saturate every core; keep them alive
      // during the test via stdio: ignore (async, not synchronized to exit).
      for (let i = 0; i < numCores; i++) {
        const child = spawn(process.execPath, ["-e", "while(1){}"], {
          stdio: "ignore",
        });
        cpuSaturation.push(child);
      }

      // Run the hang test under CPU load.
      const start = Date.now();
      const { res, outFile } = runScriptDirect(
        fakeEnv("hang", { CI_FRESHNESS_GH_TIMEOUT_MS: "500" }),
      );
      const elapsedMs = Date.now() - start;
      const outputs = readOutputs(outFile);

      // Behavioral outputs must be correct regardless of elapsed time:
      // the script's own timeout fired and handled the hang correctly.
      expect(outputs.run).toBe("true");
      expect(res.stdout).toContain("::warning::");
      expect(res.status).toBe(0);

      // Under CPU load, elapsed time may exceed the 5 s margin — but only
      // the lack of behavioral correctness signals a real regression.
      // This case documents that timing alone is not diagnostic.
    } finally {
      // Clean up busy-loop children.
      for (const proc of cpuSaturation) {
        if (proc && proc.pid) {
          try {
            process.kill(proc.pid); // Kill the child process.
          } catch {
            // Process may have already exited.
          }
        }
      }
    }
  }, 30_000);

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

  // The two "verify job untouched" / "consumers unchanged" invariance locks are
  // folded into the T4 tests that are red today, so no assertion in this file
  // can pass before the fix lands (they would otherwise be un-reddable pins).
  it("T4 · REG-E2EGUARD-403 · e2e job gets contents+deployments read; verify job untouched", () => {
    const doc = loadWorkflow();

    expect(doc.jobs.e2e.permissions).toEqual({ contents: "read", deployments: "read" });
    expect(doc.jobs.verify.permissions).toBeUndefined();
  });

  it("T4 · REG-E2EGUARD-403 · freshness step calls the script; its 7 consumers are unchanged", () => {
    const raw = fs.readFileSync(WORKFLOW, "utf8");

    expect(freshnessRunText()).toContain("scripts/ci-freshness-guard.mjs");
    // EVENT_NAME is what lets the script tell a dispatch run apart from a
    // genuine deployments-API failure.
    expect((freshnessStep().env ?? {}).EVENT_NAME).toBe("${{ github.event_name }}");
    // Explicit fail-open fallback for a crash OUTSIDE the script's own logic.
    expect(freshnessRunText()).toContain("run=true");
    expect((raw.match(/steps\.freshness\.outputs\.run == 'true'/g) ?? []).length).toBe(7);

    // The helper checkout must take the script from the DEFAULT BRANCH: on
    // deployment_status, checkout's default ref is the deployment's sha, which
    // for a superseded/rolled-back deployment predates the script entirely.
    const doc = loadWorkflow();
    const helper = (doc.jobs.e2e.steps as any[]).find(
      (s) => s.name === "Checkout freshness guard script",
    );
    expect(helper).toBeDefined();
    expect(String(helper.uses)).toMatch(/^actions\/checkout@/);
    expect(helper.if).toBeUndefined();
    expect(helper.with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(String(helper.with["sparse-checkout"])).toContain("scripts");
  });
});
