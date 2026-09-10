import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T6 (R7) — Next 15.5 upgrade clears the two GHSA advisories that
// security/audit-allowlist.json was carrying (see security/audit-allowlist.json's own
// "$schema-note" + apps/api/src/common/ci-audit-script.spec.ts's "policy guard" describe for the
// allowlist's expiring-entry contract). Retiring the upgrade also retires those two entries: once
// next.js no longer reports either advisory, neither may sit in the allowlist suppressing nothing.
// The allowlist itself stays available — a future, unrelated advisory can still be allowlisted — so
// this pins the absence of the two retired next.js ids, never an empty list.
//
// Two tests, both red on the pre-upgrade tree, each failing on a value only the retirement changes:
//   1. the allowlist no longer carries either retired next.js advisory;
//   2. the gate no longer SUPPRESSES either advisory — a fixture audit that reports
//      GHSA-p293-qw3h-jr36 on `next` must now FAIL the gate instead of exiting 0 with an
//      ALLOWLISTED warning. This is the half that discriminates: a clean (nothing-found) audit
//      already exits 0 without an ALLOWLISTED line while the allowlist is fully populated, so a
//      clean stub alone would pass for the wrong reason and prove nothing about retirement.
//
// The real gate is spawned against a stubbed npm audit (CI_AUDIT_CMD), so nothing here touches
// the network, and CI_AUDIT_ALLOWLIST points at the real security/audit-allowlist.json — the
// file under test — rather than a fixture copy.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/ci-audit-critical.mjs");
const REAL_ALLOWLIST_PATH = path.resolve(__dirname, "../../../../security/audit-allowlist.json");

let dir: string;
let cleanAuditFixture: string;
let nextCriticalAuditFixture: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-allowlist-retired-"));

  // Emits the same shape npm audit produces when nothing is found — no network, deterministic.
  cleanAuditFixture = path.join(dir, "fake-clean-npm-audit.mjs");
  fs.writeFileSync(
    cleanAuditFixture,
    [
      "process.stdout.write(JSON.stringify({",
      "  vulnerabilities: {},",
      "  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },",
      "}));",
      "",
    ].join("\n"),
  );

  // Reports ONE critical advisory on `next`, carrying the exact GHSA id the allowlist suppresses
  // today. While the entry is present this run exits 0 with `::warning::ALLOWLISTED …`; with the
  // entries list emptied the same run must exit 1 and print no suppression line at all.
  nextCriticalAuditFixture = path.join(dir, "fake-next-critical-npm-audit.mjs");
  fs.writeFileSync(
    nextCriticalAuditFixture,
    [
      "process.stdout.write(JSON.stringify({",
      "  vulnerabilities: {",
      "    next: {",
      "      name: 'next',",
      "      severity: 'critical',",
      "      via: [",
      "        {",
      "          title: 'Windows filesystem RCE in next',",
      "          severity: 'critical',",
      "          range: '<15.5.24',",
      "          url: 'https://github.com/advisories/GHSA-p293-qw3h-jr36',",
      "        },",
      "      ],",
      "      range: '<15.5.24',",
      "    },",
      "  },",
      "  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },",
      "}));",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runGate(auditFixture: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      CI_AUDIT_ALLOWLIST: REAL_ALLOWLIST_PATH,
      CI_AUDIT_CMD: JSON.stringify([process.execPath, auditFixture]),
      CI_AUDIT_BACKOFF_MS: "0,0",
    },
  });
}

const RETIRED_NEXT_GHSAS = ["GHSA-p293-qw3h-jr36", "GHSA-2xp9-vwfh-vxw4"];

it("T6 (R7): security/audit-allowlist.json no longer allowlists either retired next.js advisory", () => {
  // Red on the pre-upgrade tree: the file carried both ids on `next` (expires 2026-09-30).
  // Deliberately NOT `entries` deep-equals [] — that would forbid ever allowlisting an unrelated
  // future advisory and leave ci-audit-script.spec.ts's per-entry shape/window loop unreachable.
  const parsed = JSON.parse(fs.readFileSync(REAL_ALLOWLIST_PATH, "utf8"));
  const stillAllowlisted = (parsed.entries as { id: string; package: string }[])
    .filter((e) => RETIRED_NEXT_GHSAS.includes(e.id))
    .map((e) => `${e.id} (${e.package})`);
  expect(stillAllowlisted).toEqual([]);
});

it("T6 (R7): the retired allowlist no longer suppresses a critical next advisory, and a clean audit still exits 0", () => {
  // Red today: with the entry present this run exits 0 and prints
  // `::warning::ALLOWLISTED GHSA-p293-qw3h-jr36 (next) until 2026-09-30 …`, so both the status
  // and the suppression-text assertions fail on their own concrete values.
  const suppressible = runGate(nextCriticalAuditFixture);
  expect(suppressible.status).toBe(1);
  expect(suppressible.stdout).toContain("::error::1 critical production advisory(ies) found");
  expect(suppressible.stdout).not.toContain("ALLOWLISTED");
  expect(suppressible.stdout).not.toContain("all critical advisories are allowlisted");

  // And the gate's clean path still passes with the now-empty list — it never depended on an
  // allowlist entry being present.
  const clean = runGate(cleanAuditFixture);
  expect(clean.status).toBe(0);
  expect(clean.stdout).toContain("advisories: critical=0");
  expect(clean.stdout).not.toContain("ALLOWLISTED");
});
