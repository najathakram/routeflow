import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// F12 follow-up — scripts/ci-audit-critical.mjs contract.
//
// npm's registry has been serving 500s on the `/-/npm/v1/security/audits/quick`
// endpoint ("This endpoint is being retired. Use the bulk advisory endpoint
// instead"), and npm's own client retries internally for ~12 minutes before
// giving up — long enough to blow CI's 20-minute job timeout (observed twice,
// 8 minutes apart). The script under test must fail on a REAL critical finding
// but warn-and-skip (never fail) on a registry/transport outage, inside a
// bounded retry budget — and its `--report-only` mode must never fail at all.
//
// A fake npm-audit driver (mode selected by FAKE_MODE) stands in for the real
// `npm[.cmd] audit ...` invocation via CI_AUDIT_CMD, so every case here runs
// with no network access. CI_AUDIT_BACKOFF_MS="0,0" collapses the real 15s/45s
// backoff to nothing so the outage cases run in well under a second.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/ci-audit-critical.mjs");

let dir: string;
let fakeNpm: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-audit-"));
  fakeNpm = path.join(dir, "fake-npm-audit.mjs");
  fs.writeFileSync(
    fakeNpm,
    [
      "import fs from 'node:fs';",
      "",
      "const mode = process.env.FAKE_MODE || 'clean';",
      "const counterFile = process.env.FAKE_NPM_AUDIT_COUNTER_FILE;",
      "if (counterFile) fs.appendFileSync(counterFile, '1\\n');",
      "",
      "function cleanJson() {",
      "  return JSON.stringify({",
      "    vulnerabilities: {},",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },",
      "  });",
      "}",
      "",
      "function criticalJson() {",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-lib': {",
      "        name: 'acme-lib',",
      "        severity: 'critical',",
      "        via: [{ title: 'Remote Code Execution in acme-lib', severity: 'critical', range: '<2.0.1' }],",
      "        range: '<2.0.1',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 1 } },",
      "  });",
      "}",
      "",
      "switch (mode) {",
      "  case 'critical':",
      "    process.stdout.write(criticalJson());",
      "    process.exit(1);",
      "    break;",
      "  case 'clean':",
      "    process.stdout.write(cleanJson());",
      "    process.exit(0);",
      "    break;",
      "  case 'outage':",
      "    process.stderr.write('npm error code E500\\n');",
      "    process.stderr.write(",
      "      'npm error 500 Internal Server Error - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick\\n',",
      "    );",
      "    process.stderr.write(",
      "      'npm error This endpoint is being retired. Use the bulk advisory endpoint instead.\\n',",
      "    );",
      "    process.stderr.write('npm error audit endpoint returned an error.\\n');",
      "    process.exit(1);",
      "    break;",
      "  case 'unknown':",
      "    process.stdout.write('boom\\n');",
      "    process.exit(1);",
      "    break;",
      "  default:",
      "    process.stderr.write(`unknown FAKE_MODE: ${mode}\\n`);",
      "    process.exit(1);",
      "}",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

function fakeEnv(
  mode: string,
  counterFile: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI_AUDIT_CMD: JSON.stringify([process.execPath, fakeNpm]),
    CI_AUDIT_BACKOFF_MS: "0,0",
    FAKE_MODE: mode,
    FAKE_NPM_AUDIT_COUNTER_FILE: counterFile,
    ...extra,
  };
}

function newCounter(name: string): string {
  const file = path.join(dir, `${name}.counter`);
  fs.writeFileSync(file, "");
  return file;
}

function invocationCount(counterFile: string): number {
  return fs
    .readFileSync(counterFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "").length;
}

describe("ci-audit-critical.mjs contract", () => {
  it("critical: exits 1, names the advisory, and emits an ::error:: line", () => {
    const counter = newCounter("critical");
    const res = run([], fakeEnv("critical", counter));

    expect(res.stdout).toContain("acme-lib");
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
  });

  it("clean: exits 0", () => {
    const counter = newCounter("clean");
    const res = run([], fakeEnv("clean", counter));

    expect(res.status).toBe(0);
  });

  it("outage: retries 3 times, warns SKIPPED, and exits 0", () => {
    const counter = newCounter("outage");
    const res = run([], fakeEnv("outage", counter));

    expect(res.stdout).toContain("::warning::");
    expect(res.stdout).toContain("SKIPPED");
    expect(res.status).toBe(0);
    expect(invocationCount(counter)).toBe(3);
  });

  it("unknown: exits 1 (fails closed on an unrecognized error)", () => {
    const counter = newCounter("unknown");
    const res = run([], fakeEnv("unknown", counter));

    expect(res.status).toBe(1);
  });

  it("report-only outage: exits 0", () => {
    const counter = newCounter("report-only-outage");
    const res = run(["--level", "high", "--report-only"], fakeEnv("outage", counter));

    expect(res.stdout).toContain("::warning::");
    expect(res.status).toBe(0);
  });

  it("report-only critical: never fails, prints counts", () => {
    const counter = newCounter("report-only-critical");
    const res = run(["--level", "high", "--report-only"], fakeEnv("critical", counter));

    expect(res.stdout).toContain("critical=1");
    expect(res.status).toBe(0);
  });
});
