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
      "        via: [{",
      "          title: 'Remote Code Execution in acme-lib',",
      "          severity: 'critical',",
      "          range: '<2.0.1',",
      "          url: 'https://github.com/advisories/GHSA-test-fake-0001',",
      "        }],",
      "        range: '<2.0.1',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 1 } },",
      "  });",
      "}",
      "",
      "function highJson() {",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-high-lib': {",
      "        name: 'acme-high-lib',",
      "        severity: 'high',",
      "        via: [{ title: 'Prototype Pollution in acme-high-lib', severity: 'high', range: '<3.0.0' }],",
      "        range: '<3.0.0',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } },",
      "  });",
      "}",
      "",
      "switch (mode) {",
      "  case 'critical':",
      "    process.stdout.write(criticalJson());",
      "    process.exit(1);",
      "    break;",
      "  case 'high':",
      "    process.stdout.write(highJson());",
      "    process.exit(1);",
      "    break;",
      "  case 'clean':",
      "    process.stdout.write(cleanJson());",
      "    process.exit(0);",
      "    break;",
      "  case 'lockfile503':",
      "    process.stdout.write('Fatal: cannot read lockfile at offset 503 bytes\\n');",
      "    process.exit(1);",
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

const GHSA_TEST_ID = "GHSA-test-fake-0001"; // matches criticalJson()'s via[0].url above

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function writeAllowlist(entries: unknown[]): string {
  const file = path.join(
    dir,
    `allowlist-${entries.length}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify({ entries }));
  return file;
}

function allowlistEntry(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: GHSA_TEST_ID,
    package: "acme-lib",
    reason: "test fixture",
    expires: isoDateOffset(30),
    ackedBy: "owner",
    ackedOn: isoDateOffset(-1),
    followUp: "n/a",
    ...overrides,
  };
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

  it("unparseable non-registry output (lockfile error mentioning a 503 offset): exits 1, fails closed, NOT skipped", () => {
    const counter = newCounter("lockfile503");
    const res = run([], fakeEnv("lockfile503", counter));

    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain("SKIPPED");
    expect(res.stdout).toContain("::error::");
  });

  it("report-only high: exits 0 and names the high advisory", () => {
    const counter = newCounter("report-only-high");
    const res = run(["--level", "high", "--report-only"], fakeEnv("high", counter));

    expect(res.stdout).toContain("high=2");
    expect(res.stdout).toContain("acme-high-lib");
    expect(res.status).toBe(0);
  });
});

// security/audit-allowlist.json contract — an owner-ruled EXPIRING allowlist so a specific,
// already-assessed CRITICAL (e.g. a next.js advisory unreachable in the deployed image) can be
// suppressed without disabling the gate outright, while an expired entry still fails closed so
// the list can never rot silently. CI_AUDIT_ALLOWLIST points every case here at a temp fixture
// so none of this depends on (or mutates) the real security/audit-allowlist.json.
describe("ci-audit-critical.mjs contract — allowlist", () => {
  it("(i) critical with a matching, unexpired allowlist entry: exits 0, prints ALLOWLISTED", () => {
    const counter = newCounter("allow-match");
    const allowlist = writeAllowlist([allowlistEntry()]);
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain(`ALLOWLISTED ${GHSA_TEST_ID}`);
    expect(res.stdout).toContain("all critical advisories are allowlisted (expiring)");
    expect(res.status).toBe(0);
  });

  it("(ii) matching entry but expires yesterday: exits 1, ALLOWLIST EXPIRED", () => {
    const counter = newCounter("allow-expired");
    const allowlist = writeAllowlist([allowlistEntry({ expires: isoDateOffset(-1) })]);
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain("ALLOWLIST EXPIRED");
    expect(res.status).toBe(1);
  });

  it("(iii) entry for a different package: does not suppress, exits 1", () => {
    const counter = newCounter("allow-wrong-package");
    const allowlist = writeAllowlist([allowlistEntry({ package: "not-acme-lib" })]);
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).not.toContain("ALLOWLISTED");
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
  });

  it("(iv) malformed allowlist file (missing followUp): exits 1 with ::error::, npm audit never runs", () => {
    const counter = newCounter("allow-malformed");
    const { followUp: _followUp, ...noFollowUp } = allowlistEntry();
    const allowlist = writeAllowlist([noFollowUp]);
    const res = run([], fakeEnv("clean", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
    expect(invocationCount(counter)).toBe(0);
  });

  it("(v) expired entry with no matching advisory in a clean audit: exits 1 (rot guard)", () => {
    const counter = newCounter("allow-rot");
    const allowlist = writeAllowlist([allowlistEntry({ expires: isoDateOffset(-1) })]);
    const res = run([], fakeEnv("clean", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain("ALLOWLIST EXPIRED");
    expect(res.status).toBe(1);
  });

  it("(vi) no allowlist file at the override path: today's behaviour, a critical fails", () => {
    const counter = newCounter("allow-missing");
    const missingPath = path.join(dir, "does-not-exist.json");
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: missingPath }));

    expect(res.stdout).not.toContain("ALLOWLISTED");
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
  });

  it("--report-only is unaffected by the allowlist except for printing its warnings", () => {
    const counter = newCounter("allow-report-only");
    const allowlist = writeAllowlist([allowlistEntry()]);
    const res = run(
      ["--level", "high", "--report-only"],
      fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }),
    );

    expect(res.stdout).toContain("critical=1");
    expect(res.stdout).toContain(`ALLOWLISTED ${GHSA_TEST_ID}`);
    expect(res.status).toBe(0);
  });
});

describe("security/audit-allowlist.json (policy guard)", () => {
  const REAL_ALLOWLIST_PATH = path.resolve(__dirname, "../../../../security/audit-allowlist.json");

  it("parses, carries exactly the two current next.js GHSA ids, and keeps expires within 60 days of ackedOn", () => {
    const parsed = JSON.parse(fs.readFileSync(REAL_ALLOWLIST_PATH, "utf8"));
    expect(Array.isArray(parsed.entries)).toBe(true);

    const ids = parsed.entries.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["GHSA-2xp9-vwfh-vxw4", "GHSA-p293-qw3h-jr36"]);

    for (const entry of parsed.entries) {
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.ackedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const expiresMs = Date.parse(`${entry.expires}T00:00:00Z`);
      const ackedMs = Date.parse(`${entry.ackedOn}T00:00:00Z`);
      expect(Number.isNaN(expiresMs)).toBe(false);
      expect(Number.isNaN(ackedMs)).toBe(false);

      const diffDays = (expiresMs - ackedMs) / 86_400_000;
      expect(diffDays).toBeGreaterThanOrEqual(0);
      expect(diffDays).toBeLessThanOrEqual(60);
    }
  });
});
