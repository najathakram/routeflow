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

// ─── B892: log (and gate) the PUSHED refs, not the checked-out HEAD ────────────────────────────
// .husky/pre-push hands git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>`
// per line) to the script as RF_PUSH_REFS. A skip-push of a branch that is NOT checked out must
// be recorded under that branch and sha — and gated on ITS changed files, never HEAD's.
//
// Fixture repos are throwaway (mkdtempSync + `git init`). B420: git EXPORTS repo-scoped GIT_*
// vars into every child of a hook, so when this spec runs inside the pre-push verify a fixture
// `git` (or the script's own `git`) would silently re-point at THIS checkout. Scrubbed for both.
function scrubGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubGitEnv(), shell: false });
  if (res.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

const ZERO = "0".repeat(40);

/**
 * master (a code file) → origin/master; `feat/code` adds a CODE change; `docs/notes` adds only a
 * .md and stays CHECKED OUT, so HEAD is docs-only while the pushed branch is code.
 */
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-b892-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "fixture@example.test");
  git(dir, "config", "user.name", "Fixture");
  fs.mkdirSync(path.join(dir, "apps"), { recursive: true });
  fs.writeFileSync(path.join(dir, "apps", "a.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/master", git(dir, "rev-parse", "HEAD"));
  git(dir, "checkout", "-q", "-b", "feat/code");
  fs.writeFileSync(path.join(dir, "apps", "a.ts"), "export const a = 2;\n");
  git(dir, "commit", "-q", "-am", "code change");
  const codeSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "docs/notes", "master");
  fs.writeFileSync(path.join(dir, "NOTES.md"), "notes\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "docs");
  return { dir, codeSha, headSha: git(dir, "rev-parse", "HEAD") };
}

function runIn(cwd: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8", env: scrubGitEnv(env) });
}

describe("B892: skip-verify audits the PUSHED refs, not the checked-out HEAD", () => {
  it("logs a pushed non-HEAD branch under its own ref and sha", () => {
    const { dir, codeSha, headSha } = fixtureRepo();
    try {
      const logPath = tempLogPath();
      const res = runIn(dir, {
        // HEAD-derived fallback values, as the hook still exports them — they must NOT be logged.
        RF_BRANCH: "docs/notes",
        RF_HEAD: headSha.slice(0, 7),
        RF_CHANGED_FILES: "NOTES.md",
        RF_PUSH_REFS: `refs/heads/feat/code ${codeSha} refs/heads/feat/code ${ZERO}\n`,
        RF_AUDIT_LOG: logPath,
        SKIP_VERIFY_REASON: "hotfix: verify broken",
      });
      expect(res.stderr).not.toContain("Cannot find module");
      expect(res.status).toBe(0);
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("feat/code");
      expect(lines[0]).toContain(codeSha.slice(0, 7));
      expect(lines[0]).not.toContain("docs/notes");
      expect(lines[0]).not.toContain(headSha.slice(0, 7));
      expect(lines[0]).toContain("docs-only=no");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates on the pushed branch's files: a code branch needs a reason even when HEAD is docs-only", () => {
    const { dir, codeSha, headSha } = fixtureRepo();
    try {
      const logPath = tempLogPath();
      const res = runIn(dir, {
        RF_BRANCH: "docs/notes",
        RF_HEAD: headSha.slice(0, 7),
        RF_CHANGED_FILES: "NOTES.md",
        RF_PUSH_REFS: `refs/heads/feat/code ${codeSha} refs/heads/feat/code ${ZERO}\n`,
        RF_AUDIT_LOG: logPath,
        SKIP_VERIFY_REASON: "",
      });
      expect(res.stderr).toContain("SKIP_VERIFY_REASON");
      expect(res.status).toBe(1);
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs every pushed ref; a branch deletion line is ignored", () => {
    const { dir, codeSha, headSha } = fixtureRepo();
    try {
      const logPath = tempLogPath();
      const res = runIn(dir, {
        RF_PUSH_REFS: [
          `refs/heads/feat/code ${codeSha} refs/heads/feat/code ${ZERO}`,
          `refs/heads/docs/notes ${headSha} refs/heads/docs/notes ${ZERO}`,
          `(delete) ${ZERO} refs/heads/old-branch ${codeSha}`,
        ].join("\n"),
        RF_AUDIT_LOG: logPath,
        SKIP_VERIFY_REASON: "batch skip",
      });
      expect(res.status).toBe(0);
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("feat/code");
      expect(lines[1]).toContain("docs/notes");
      expect(lines[1]).toContain("docs-only=yes");
      expect(lines.join("\n")).not.toContain("old-branch");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty stdin falls back to the HEAD values the hook exports (unchanged behaviour)", () => {
    const logPath = tempLogPath();
    const res = run({
      RF_BRANCH: "fix/example",
      RF_HEAD: "abc1234",
      RF_CHANGED_FILES: "apps/api/src/x.ts",
      RF_PUSH_REFS: "",
      RF_AUDIT_LOG: logPath,
      SKIP_VERIFY_REASON: "why",
    });
    expect(res.status).toBe(0);
    expect(fs.readFileSync(logPath, "utf8")).toContain("fix/example | abc1234");
  });
});

describe("B892: .husky/pre-push forwards git's pushed-ref stdin to the audit", () => {
  const hook = fs.readFileSync(path.resolve(__dirname, "../../../../.husky/pre-push"), "utf8");
  const skipBlock = hook.slice(
    hook.indexOf('if [ "$SKIP_VERIFY" = "1" ]'),
    hook.indexOf("node scripts/skip-verify-audit.mjs"),
  );

  it("exports RF_PUSH_REFS from stdin inside the SKIP_VERIFY block, before the audit runs", () => {
    expect(skipBlock).toMatch(/export RF_PUSH_REFS="\$\(cat\)"/);
  });

  it("never reads a terminal stdin (a hand-run hook must not hang on cat)", () => {
    expect(skipBlock).toMatch(/if \[ ! -t 0 \]; then\s+export RF_PUSH_REFS="\$\(cat\)"/);
  });
});
