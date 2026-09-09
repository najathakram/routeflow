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
      "        via: [",
      "          {",
      "            title: 'Remote Code Execution in acme-lib',",
      "            severity: 'critical',",
      "            range: '<2.0.1',",
      "            url: 'https://github.com/advisories/GHSA-test-fake-0001',",
      "          },",
      "          {",
      "            title: 'Prototype Pollution in acme-lib',",
      "            severity: 'high',",
      "            range: '<2.0.1',",
      "            url: 'https://github.com/advisories/GHSA-test-fake-0002',",
      "          },",
      "        ],",
      "        range: '<2.0.1',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 1 } },",
      "  });",
      "}",
      "",
      "function criticalTwoJson() {",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-lib': {",
      "        name: 'acme-lib',",
      "        severity: 'critical',",
      "        via: [",
      "          {",
      "            title: 'Remote Code Execution in acme-lib',",
      "            severity: 'critical',",
      "            range: '<2.0.1',",
      "            url: 'https://github.com/advisories/GHSA-test-fake-0001',",
      "          },",
      "          {",
      "            title: 'Arbitrary File Write in acme-lib',",
      "            severity: 'critical',",
      "            range: '<2.0.1',",
      "            url: 'https://github.com/advisories/GHSA-test-fake-0003',",
      "          },",
      "        ],",
      "        range: '<2.0.1',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },",
      "  });",
      "}",
      "",
      "function criticalZeroMetadataJson() {",
      "  // Round-3 pin: metadata.vulnerabilities.critical is 0 (a stale/inconsistent rollup) but",
      "  // the vulnerabilities object still carries a critical-severity package — the blocking",
      "  // decision must be derived from the vulnerabilities object, never from this count.",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-zero-meta-lib': {",
      "        name: 'acme-zero-meta-lib',",
      "        severity: 'critical',",
      "        via: [",
      "          {",
      "            title: 'RCE in acme-zero-meta-lib',",
      "            severity: 'critical',",
      "            range: '<1.0.0',",
      "            url: 'https://github.com/advisories/GHSA-zero-meta-0001',",
      "          },",
      "        ],",
      "        range: '<1.0.0',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },",
      "  });",
      "}",
      "",
      "function criticalMixedSeverityJson() {",
      "  // Round-3 pin: one package, three vias at three severities — N in the ::error:: line must",
      "  // count only the row(s) whose OWN severity is critical (one), not every remaining row.",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-mixed-sev-lib': {",
      "        name: 'acme-mixed-sev-lib',",
      "        severity: 'critical',",
      "        via: [",
      "          {",
      "            title: 'RCE in acme-mixed-sev-lib',",
      "            severity: 'critical',",
      "            range: '<1.0.0',",
      "            url: 'https://github.com/advisories/GHSA-mixd-seva-0001',",
      "          },",
      "          {",
      "            title: 'DoS in acme-mixed-sev-lib',",
      "            severity: 'high',",
      "            range: '<1.0.0',",
      "            url: 'https://github.com/advisories/GHSA-mixd-sevb-0002',",
      "          },",
      "          {",
      "            title: 'Info leak in acme-mixed-sev-lib',",
      "            severity: 'moderate',",
      "            range: '<1.0.0',",
      "            url: 'https://github.com/advisories/GHSA-mixd-sevc-0003',",
      "          },",
      "        ],",
      "        range: '<1.0.0',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1, total: 3 } },",
      "  });",
      "}",
      "",
      "function ghsaSuffixJson() {",
      "  // Round-3 pin: the via's url ends with an extra '00' suffix after a valid-looking GHSA",
      "  // id shape — a right-anchored regex must NOT match the id as a substring of it.",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-suffix-lib': {",
      "        name: 'acme-suffix-lib',",
      "        severity: 'critical',",
      "        via: [",
      "          {",
      "            title: 'RCE in acme-suffix-lib',",
      "            severity: 'critical',",
      "            range: '<1.0.0',",
      "            url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx00',",
      "          },",
      "        ],",
      "        range: '<1.0.0',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },",
      "  });",
      "}",
      "",
      "function mixedStringCriticalViaJson() {",
      "  // Round-3 pin: a string via alongside a suppressible critical object via — suppressing",
      "  // the object via must NOT lower the package below its reported (critical) severity.",
      "  return JSON.stringify({",
      "    vulnerabilities: {",
      "      'acme-mixed-via-lib': {",
      "        name: 'acme-mixed-via-lib',",
      "        severity: 'critical',",
      "        via: [",
      "          'some-dep',",
      "          {",
      "            title: 'RCE in acme-mixed-via-lib',",
      "            severity: 'critical',",
      "            range: '<1.0.0',",
      "            url: 'https://github.com/advisories/GHSA-mixd-strv-0001',",
      "          },",
      "        ],",
      "        range: '<1.0.0',",
      "      },",
      "    },",
      "    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },",
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
      "  case 'critical-two':",
      "    process.stdout.write(criticalTwoJson());",
      "    process.exit(1);",
      "    break;",
      "  case 'critical-zero-metadata':",
      "    process.stdout.write(criticalZeroMetadataJson());",
      "    process.exit(0);",
      "    break;",
      "  case 'critical-mixed-severity':",
      "    process.stdout.write(criticalMixedSeverityJson());",
      "    process.exit(1);",
      "    break;",
      "  case 'ghsa-suffix':",
      "    process.stdout.write(ghsaSuffixJson());",
      "    process.exit(1);",
      "    break;",
      "  case 'mixed-string-critical-via':",
      "    process.stdout.write(mixedStringCriticalViaJson());",
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

const GHSA_TEST_ID = "GHSA-test-fake-0001"; // matches criticalJson()'s (and criticalTwoJson()'s) via[0].url
const GHSA_TEST_HIGH_ID = "GHSA-test-fake-0002"; // matches criticalJson()'s via[1].url (the high via)
const GHSA_TEST_CRITICAL_2_ID = "GHSA-test-fake-0003"; // matches criticalTwoJson()'s via[1].url
const GHSA_SUFFIX_ID = "GHSA-xxxx-xxxx-xxxx"; // ghsaSuffixJson()'s via url has an extra "00" after this
const GHSA_MIXED_VIA_ID = "GHSA-mixd-strv-0001"; // matches mixedStringCriticalViaJson()'s object via

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

  it("(ii) matching entry but expires yesterday: exits 1, ALLOWLIST EXPIRED, no ALLOWLISTED, CRITICAL row printed", () => {
    // Round-3 pin: an expired entry must never suppress — this fails if the `entry.expires >=
    // today` check in partitionByAllowlist is replaced by `true`. The rot guard in main() would
    // still force exit 1 in that mutant (it's computed independently), so the exit code alone
    // can't catch it — the ALLOWLISTED/CRITICAL assertions below are load-bearing.
    const counter = newCounter("allow-expired");
    const allowlist = writeAllowlist([allowlistEntry({ expires: isoDateOffset(-1) })]);
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).not.toContain("ALLOWLISTED");
    expect(res.stdout).toContain("CRITICAL:");
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

  // Round-2 fix: a critical PACKAGE is not uniformly critical — each `via` carries its own
  // severity, and the gate's decision must be the package's EFFECTIVE severity (the max over
  // its non-suppressed vias), not npm's package-level rollup. criticalJson() now carries one
  // critical via (GHSA_TEST_ID) + one high via (GHSA_TEST_HIGH_ID) on the same package.

  it("(vii) critical via allowlisted, high via present: exits 0, the high remainder is reported (not treated as critical)", () => {
    const counter = newCounter("allow-critical-with-high");
    const allowlist = writeAllowlist([allowlistEntry()]); // matches GHSA_TEST_ID (the critical via) only
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain(`ALLOWLISTED ${GHSA_TEST_ID}`);
    expect(res.stdout).toContain("1 non-critical advisory(ies) remain");
    expect(res.status).toBe(0);
  });

  it("(viii) two critical vias, only one allowlisted: exits 1 and the remaining row reports its own advisory severity", () => {
    const counter = newCounter("allow-two-critical");
    const allowlist = writeAllowlist([allowlistEntry()]); // matches GHSA_TEST_ID; GHSA_TEST_CRITICAL_2_ID is not listed
    const res = run([], fakeEnv("critical-two", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain(`ALLOWLISTED ${GHSA_TEST_ID}`);
    expect(res.stdout).not.toContain(`ALLOWLISTED ${GHSA_TEST_CRITICAL_2_ID}`);
    expect(res.stdout).toContain("advisory=critical");
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
  });

  it("(ix) allowlisting a package's HIGH via does not suppress its remaining critical via: exits 1 (suppressing a non-critical changes nothing)", () => {
    const counter = newCounter("allow-wrong-severity");
    const allowlist = writeAllowlist([allowlistEntry({ id: GHSA_TEST_HIGH_ID })]); // matches the high via only
    const res = run([], fakeEnv("critical", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain(`ALLOWLISTED ${GHSA_TEST_HIGH_ID}`);
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

  // Round-3 (MAJOR): the blocking decision must be derived by walking `vulnerabilities` itself,
  // never from npm's `metadata.vulnerabilities.critical` rollup — a fixture where that rollup
  // says 0 but a package entry is still `severity: "critical"` must still fail the gate.
  it("(x) metadata.vulnerabilities.critical is 0 but a package is severity critical: exits 1", () => {
    const counter = newCounter("critical-zero-metadata");
    const res = run([], fakeEnv("critical-zero-metadata", counter));

    expect(res.stdout).toContain("npm metadata: critical=0");
    expect(res.stdout).toContain("CRITICAL: acme-zero-meta-lib");
    expect(res.stdout).toContain("::error::1 critical production advisory(ies) found");
    expect(res.status).toBe(1);
  });

  // Round-3 (MINOR 2): N in the ::error:: line is the count of rows whose OWN severity is
  // critical — one package with a critical + high + moderate via must print exactly one
  // CRITICAL: line (the other two print as "  also: <severity> — …" beneath it) and the error
  // count must be exactly 1, not the 3 total remaining rows.
  it("(xi) one package, three vias at three severities: exactly one CRITICAL: line, error count is exactly 1", () => {
    const counter = newCounter("critical-mixed-severity");
    const res = run([], fakeEnv("critical-mixed-severity", counter));

    const criticalLines = res.stdout.split("\n").filter((l) => l.startsWith("CRITICAL:"));
    expect(criticalLines).toHaveLength(1);
    expect(res.stdout).toContain("  also: high —");
    expect(res.stdout).toContain("  also: moderate —");
    expect(res.stdout).toContain("::error::1 critical production advisory(ies) found");
    expect(res.status).toBe(1);
  });

  // Round-3 (MINOR 6): the GHSA-id regex must be right-anchored — a via url ending
  // "…GHSA-xxxx-xxxx-xxxx00" must NOT be treated as carrying id GHSA-xxxx-xxxx-xxxx, so an
  // allowlist entry for that (shorter) id must not suppress it.
  it("(xii) via url has a valid-looking GHSA id immediately followed by more alnum chars: not suppressed", () => {
    const counter = newCounter("ghsa-suffix");
    const allowlist = writeAllowlist([
      allowlistEntry({ id: GHSA_SUFFIX_ID, package: "acme-suffix-lib" }),
    ]);
    const res = run([], fakeEnv("ghsa-suffix", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).not.toContain(`ALLOWLISTED ${GHSA_SUFFIX_ID}`);
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
  });

  // Round-3 (MINOR 7): a bare string via alongside a suppressible critical object via must keep
  // the package's reported (critical) severity alive — suppressing the object via's advisory
  // must not lower the package below what npm itself reported.
  it("(xiii) string via + allowlisted critical object via on the same package: still exits 1", () => {
    const counter = newCounter("mixed-string-critical-via");
    const allowlist = writeAllowlist([
      allowlistEntry({ id: GHSA_MIXED_VIA_ID, package: "acme-mixed-via-lib" }),
    ]);
    const res = run(
      [],
      fakeEnv("mixed-string-critical-via", counter, { CI_AUDIT_ALLOWLIST: allowlist }),
    );

    expect(res.stdout).toContain(`ALLOWLISTED ${GHSA_MIXED_VIA_ID}`);
    expect(res.stdout).toContain("CRITICAL: acme-mixed-via-lib");
    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
  });
});

// Round-3 (MINOR 4+5): `expires`/`ackedOn` must be real UTC calendar dates (not just
// YYYY-MM-DD shape), `ackedOn` is required, and the window between them is capped at 60 days —
// all fail closed (::error::, exit 1, npm never spawned) before any audit runs.
describe("ci-audit-critical.mjs contract — allowlist date validation", () => {
  it("expires is shape-valid but not a real calendar date (2026-13-45): exits 1, npm never runs", () => {
    const counter = newCounter("allow-bad-expires-date");
    const allowlist = writeAllowlist([allowlistEntry({ expires: "2026-13-45" })]);
    const res = run([], fakeEnv("clean", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
    expect(invocationCount(counter)).toBe(0);
  });

  it("ackedOn missing: exits 1, npm never runs", () => {
    const counter = newCounter("allow-missing-ackedon");
    const { ackedOn: _ackedOn, ...noAckedOn } = allowlistEntry();
    const allowlist = writeAllowlist([noAckedOn]);
    const res = run([], fakeEnv("clean", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
    expect(invocationCount(counter)).toBe(0);
  });

  it("expires 61 days after ackedOn: exits 1, npm never runs", () => {
    const counter = newCounter("allow-window-61");
    const allowlist = writeAllowlist([
      allowlistEntry({ ackedOn: isoDateOffset(-1), expires: isoDateOffset(60) }),
    ]);
    const res = run([], fakeEnv("clean", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.stdout).toContain("::error::");
    expect(res.status).toBe(1);
    expect(invocationCount(counter)).toBe(0);
  });

  it("expires exactly 60 days after ackedOn: accepted, npm runs", () => {
    const counter = newCounter("allow-window-60");
    const allowlist = writeAllowlist([
      allowlistEntry({ ackedOn: isoDateOffset(0), expires: isoDateOffset(60) }),
    ]);
    const res = run([], fakeEnv("clean", counter, { CI_AUDIT_ALLOWLIST: allowlist }));

    expect(res.status).toBe(0);
    expect(invocationCount(counter)).toBe(1);
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
