import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PR-11 — Item 9 / T1: scripts/skip-verify-audit.mjs contract.
//
// The pre-push hook's SKIP_VERIFY hatch must require a reason for a code push and write an
// audit line; docs-only pushes need no reason. These cases drive the real script (spawned, no
// mocking) and assert on its exit code, stdout/stderr, and the audit log file it writes.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/skip-verify-audit.mjs");

function run(env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function tempLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-skip-verify-"));
  return path.join(dir, "skip-verify.log");
}

describe("skip-verify-audit.mjs contract (T1)", () => {
  it("T1(a): a code push with no reason refuses — exit 1, stderr names SKIP_VERIFY_REASON, no log file", () => {
    const logPath = tempLogPath();

    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "apps/api/src/x.ts",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    });

    // Content oracle first: it is the only assertion here a missing script cannot satisfy.
    expect(res.stderr).toContain("SKIP_VERIFY_REASON");
    // MODULE_NOT_FOUND also exits 1 — this keeps that failure mode from masquerading as
    // "the script correctly refused".
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.status).toBe(1);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("T1(b): a code push with a reason succeeds — exit 0, stdout warns, log line carries branch/head/docs-only=no/reason", () => {
    const logPath = tempLogPath();
    const reason = "hotfix: verify broken by dep bump";

    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "apps/api/src/x.ts",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: reason,
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("⚠ verify bypassed:");
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fix/example");
    expect(lines[0]).toContain("abc1234");
    expect(lines[0]).toContain("docs-only=no");
    expect(lines[0]).toContain(reason);
  });

  it("T1(c): a docs-only push with no reason succeeds — exit 0, log line docs-only=yes | docs-only", () => {
    const logPath = tempLogPath();

    const res = run({
      RF_BRANCH: "docs/example",
      RF_HEAD: "def5678",
      RF_CHANGED_FILES: "docs/a.md\nREADME.md",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    });

    expect(res.status).toBe(0);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("docs-only=yes");
    expect(lines[0]).toContain("docs-only");
  });

  it("T1(d): a mixed docs+code push with no reason refuses — exit 1", () => {
    const logPath = tempLogPath();

    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "docs/a.md\npackages/x/y.ts",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    });

    // A mixed push is a CODE push (R1: docs-only requires EVERY path to be docs), so it must be
    // refused with the same reason message. Asserting that message first is what makes this case
    // prove the classification — exit 1 + "no log file" alone are also what a missing/crashing
    // script produces.
    expect(res.stderr).toContain("SKIP_VERIFY_REASON");
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.status).toBe(1);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("T1(e): two runs against the same log path append two lines, not overwrite", () => {
    const logPath = tempLogPath();
    const env = {
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "docs/a.md",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    };

    const first = run(env);
    const second = run({ ...env, RF_HEAD: "abc9999" });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("abc1234");
    expect(lines[1]).toContain("abc9999");
  });

  it("T1(f): an empty changed-file list with no reason refuses — an unknown list is not docs-only", () => {
    const logPath = tempLogPath();

    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    });

    // `[].every(...)` is vacuously true, so this is the fail-open case: the hook's two `git diff`
    // attempts can both fail silently (no upstream, no fetched origin/master) and hand the script
    // an empty list for a pure code push.
    expect(res.stderr).toContain("could not determine");
    expect(res.stderr).toContain("SKIP_VERIFY_REASON");
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.status).toBe(1);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("T1(g): an executable .claude/ path with no reason refuses — .claude/ is not docs wholesale", () => {
    const logPath = tempLogPath();

    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: ".claude/hooks/stop.mjs",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    });

    // `npm run verify` executes .claude/skills/**/scripts/*.mjs and the stop hook gates turns —
    // changing them is a code push.
    expect(res.stderr).toContain("SKIP_VERIFY_REASON");
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.status).toBe(1);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("T1(h): non-executable .claude/ registry paths stay docs-only — exit 0, docs-only=yes", () => {
    const logPath = tempLogPath();

    const res = run({
      RF_BRANCH: "docs/example",
      RF_HEAD: "def5678",
      RF_CHANGED_FILES: ".claude/code-map/api.md\n.claude/lessons/LESSONS.md",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "",
    });

    expect(res.status).toBe(0);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("docs-only=yes");
  });

  it("T1(i): an empty changed-file list WITH a reason is recorded as docs-only=no | reason", () => {
    const logPath = tempLogPath();
    const reason = "hotfix: no upstream in this clone";

    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: reason,
    });

    expect(res.status).toBe(0);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("docs-only=no");
    expect(lines[0]).toContain(reason);
  });
});
