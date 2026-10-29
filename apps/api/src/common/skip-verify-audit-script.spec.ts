import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PR-11 — Item 9 / T1: scripts/skip-verify-audit.mjs contract.
//
// The pre-push hook's SKIP_VERIFY hatch must require a reason for a code push and write an
// audit line; docs-only pushes need no reason. These cases drive the real script (spawned, no
// mocking) and assert on its exit code, stdout/stderr, and the audit log file it writes.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "skip-verify-audit.mjs");

// The ONE GIT_* scrub (scripts/lib/scrubbed-git-env.cjs); fixture-git-env-scrub.spec.ts pins that every
// git spawn in a fixture-repo spec passes it (a private copy of the filter does not count). B420: git
// EXPORTS GIT_DIR/GIT_WORK_TREE/... into every child of a hook, and verify runs this spec from inside
// pre-push, so an unscrubbed fixture `git` would operate on THIS checkout.
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: () => NodeJS.ProcessEnv;
};

// RF_PUSH_REFS defaults to "": verify runs this spec from inside pre-push, where the hook may have
// exported the real push's refs, and a case that leaves it unset must not gate on those.
function run(env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...scrubbedGitEnv(), RF_PUSH_REFS: "", ...env },
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
// `git` (or the script's own `git`) would silently re-point at THIS checkout. Scrubbed for both
// (the shared `scrubbedGitEnv()` above).
function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: scrubbedGitEnv(),
    shell: false,
  });
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
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...scrubbedGitEnv(), RF_PUSH_REFS: "", ...env },
  });
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

  it("fails closed when a pushed ref's diff cannot be computed: a new docs-only branch with no origin/master refuses", () => {
    const { dir, headSha } = fixtureRepo();
    try {
      // A clone with no fetched origin/master: `git diff origin/master...<sha>` fails, so the file
      // list is unknown — and unknown is never docs-only, even for a branch that IS docs-only.
      git(dir, "update-ref", "-d", "refs/remotes/origin/master");
      const logPath = tempLogPath();
      const res = runIn(dir, {
        RF_PUSH_REFS: `refs/heads/docs/notes ${headSha} refs/heads/docs/notes ${ZERO}\n`,
        RF_AUDIT_LOG: logPath,
        SKIP_VERIFY_REASON: "",
      });
      expect(res.stderr).toContain("could not determine the changed files for docs/notes");
      expect(res.status).toBe(1);
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an update of an existing branch diffs against its remote sha, not origin/master", () => {
    const { dir, codeSha } = fixtureRepo();
    try {
      // feat/code is already on the remote at codeSha; this push adds only a .md on top of it.
      git(dir, "checkout", "-q", "feat/code");
      fs.writeFileSync(path.join(dir, "CHANGES.md"), "more notes\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "docs on top");
      const newSha = git(dir, "rev-parse", "HEAD");
      const logPath = tempLogPath();
      const res = runIn(dir, {
        RF_PUSH_REFS: `refs/heads/feat/code ${newSha} refs/heads/feat/code ${codeSha}\n`,
        RF_AUDIT_LOG: logPath,
        SKIP_VERIFY_REASON: "",
      });
      // Against origin/master the push would include apps/a.ts and refuse; against the remote sha
      // it is the one .md, so it passes with no reason.
      expect(res.stderr).not.toContain("SKIP_VERIFY_REASON");
      expect(res.status).toBe(0);
      const log = fs.readFileSync(logPath, "utf8");
      expect(log).toContain(`feat/code | ${newSha.slice(0, 7)}`);
      expect(log).toContain("docs-only=yes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ref lines that are all deletions or malformed are an unknown push, never HEAD's docs-only verdict", () => {
    const { dir, codeSha } = fixtureRepo();
    try {
      const logPath = tempLogPath();
      const res = runIn(dir, {
        // HEAD (docs/notes) is docs-only; it is not what is being pushed.
        RF_BRANCH: "docs/notes",
        RF_HEAD: "abc1234",
        RF_CHANGED_FILES: "NOTES.md",
        RF_PUSH_REFS: [`(delete) ${ZERO} refs/heads/old-branch ${codeSha}`, "garbage"].join("\n"),
        RF_AUDIT_LOG: logPath,
        SKIP_VERIFY_REASON: "",
      });
      expect(res.stderr).toContain("could not determine the changed files");
      expect(res.status).toBe(1);
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── B892: the REAL .husky/pre-push, run by a REAL `git push`, hands the audit the pushed refs ───
// The B897 push guard captures git's pre-push stdin ONCE (`refs="$(cat)"`). A second `$(cat)` in the
// SKIP_VERIFY block reads EOF, so RF_PUSH_REFS is "" and the audit silently falls back to HEAD — the
// B892 fix is then inert while a static regex over the hook text stays green. So these cases do not
// grep the hook for a shape: they install the hook's actual text in a fixture repo, push for real
// (git itself feeds the stdin and exports its GIT_* vars), and read what the audit saw and logged.
const HOOK_TEXT = fs
  .readFileSync(path.join(REPO_ROOT, ".husky", "pre-push"), "utf8")
  .replace(/\r\n/g, "\n");

/** The audit as the hook ran it AFTER the B892 fix — and as it ran it with the old double `cat`. */
const OLD_DOUBLE_CAT = 'if [ ! -t 0 ]; then export RF_PUSH_REFS="$(cat)"; fi';
const FIXED_EXPORT = 'export RF_PUSH_REFS="$refs"';

/**
 * fixtureRepo() (feat/code = code, docs/notes CHECKED OUT = docs-only) + a bare `origin` + the given
 * hook text installed as `.git/hooks/pre-push` next to copies of the real guard/audit scripts.
 */
function pushFixture(hookText: string, auditSource?: string) {
  const fx = fixtureRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "rf-b892-remote-"));
  git(remote, "init", "-q", "--bare");
  git(fx.dir, "remote", "add", "origin", remote);
  fs.mkdirSync(path.join(fx.dir, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "push-guard.mjs"),
    path.join(fx.dir, "scripts", "push-guard.mjs"),
  );
  // The hook runs the #2865 size ratchet before the SKIP_VERIFY block; the fixture has no apps/api or
  // jest, so a pass-through stub stands in (the gate has its own self-test).
  fs.writeFileSync(path.join(fx.dir, "scripts", "size-ratchet-gate.mjs"), "process.exit(0);\n");
  // Likewise the dark R4 test-tamper scan (report-only, its own self-test).
  fs.writeFileSync(path.join(fx.dir, "scripts", "test-tamper-check.mjs"), "process.exit(0);\n");
  const audit = path.join(fx.dir, "scripts", "skip-verify-audit.mjs");
  if (auditSource === undefined) fs.copyFileSync(SCRIPT, audit);
  else fs.writeFileSync(audit, auditSource);
  const hooksDir = path.join(fx.dir, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "pre-push"), `#!/bin/sh\n${hookText}`, { mode: 0o755 });
  return { ...fx, remote, hooksDir };
}

/** `git push origin feat/code` (a branch that is NOT checked out) with the verify hatch open. */
function skipPush(fx: ReturnType<typeof pushFixture>, reason: string) {
  return spawnSync("git", ["-c", `core.hooksPath=${fx.hooksDir}`, "push", "origin", "feat/code"], {
    cwd: fx.dir,
    encoding: "utf8",
    shell: false,
    env: { ...scrubbedGitEnv(), SKIP_VERIFY: "1", SKIP_VERIFY_REASON: reason },
  });
}

function cleanup(fx: { dir: string; remote: string }) {
  fs.rmSync(fx.dir, { recursive: true, force: true });
  fs.rmSync(fx.remote, { recursive: true, force: true });
}

describe("B892: the real .husky/pre-push forwards git's pushed refs to the audit", () => {
  const HOOK_TIMEOUT = 60_000;

  it("the repo hook text reads stdin exactly once and exports that capture as RF_PUSH_REFS", () => {
    expect(HOOK_TEXT.match(/\$\(cat\)/g) ?? []).toHaveLength(1);
    expect(HOOK_TEXT).toContain(FIXED_EXPORT);
    // the export sits inside the SKIP_VERIFY block, before the audit runs
    const skipAt = HOOK_TEXT.indexOf('if [ "$SKIP_VERIFY" = "1" ]');
    const exportAt = HOOK_TEXT.indexOf(FIXED_EXPORT);
    expect(exportAt).toBeGreaterThan(skipAt);
    expect(exportAt).toBeLessThan(HOOK_TEXT.indexOf("node scripts/skip-verify-audit.mjs"));
    // and the old second read of stdin is gone
    expect(HOOK_TEXT).not.toContain(OLD_DOUBLE_CAT);
  });

  it(
    "RF_PUSH_REFS is non-empty and names the pushed ref when git runs the hook (probe audit)",
    () => {
      const probeOut = path.join(os.tmpdir(), `rf-b892-probe-${process.pid}-${Date.now()}.txt`);
      const probe = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(probeOut)}, process.env.RF_PUSH_REFS ?? "<unset>");\n`;
      const fx = pushFixture(HOOK_TEXT, probe);
      try {
        const res = skipPush(fx, "hotfix: verify broken");
        expect(res.status).toBe(0);
        const seen = fs.readFileSync(probeOut, "utf8");
        expect(seen.length).toBeGreaterThan(0);
        expect(seen).toContain(`refs/heads/feat/code ${fx.codeSha} refs/heads/feat/code ${ZERO}`);
      } finally {
        cleanup(fx);
        fs.rmSync(probeOut, { force: true });
      }
    },
    HOOK_TIMEOUT,
  );

  it(
    "a skip-push of a non-HEAD code branch is gated and logged as THAT branch, not the checked-out docs HEAD",
    () => {
      const fx = pushFixture(HOOK_TEXT);
      try {
        const res = skipPush(fx, "hotfix: verify broken");
        expect(res.stderr).not.toContain("Cannot find module");
        expect(res.status).toBe(0);
        const lines = fs
          .readFileSync(path.join(fx.dir, ".git", "skip-verify.log"), "utf8")
          .trim()
          .split("\n");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("feat/code");
        expect(lines[0]).toContain(fx.codeSha.slice(0, 7));
        expect(lines[0]).toContain("docs-only=no");
        expect(lines[0]).not.toContain("docs/notes");
        expect(lines[0]).not.toContain(fx.headSha.slice(0, 7));
      } finally {
        cleanup(fx);
      }
    },
    HOOK_TIMEOUT,
  );

  it(
    "the same code push with NO reason is refused (HEAD is docs-only; the pushed branch is not)",
    () => {
      const fx = pushFixture(HOOK_TEXT);
      try {
        const res = skipPush(fx, "");
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("SKIP_VERIFY_REASON");
        expect(fs.existsSync(path.join(fx.dir, ".git", "skip-verify.log"))).toBe(false);
      } finally {
        cleanup(fx);
      }
    },
    HOOK_TIMEOUT,
  );

  it(
    "RED-FIRST pin: the old second `$(cat)` leaves RF_PUSH_REFS empty and the audit logs HEAD (the bug this fixes)",
    () => {
      const old = HOOK_TEXT.replace(FIXED_EXPORT, OLD_DOUBLE_CAT);
      expect(old).not.toBe(HOOK_TEXT); // the mutation applied — this case cannot pass vacuously
      const probeOut = path.join(os.tmpdir(), `rf-b892-old-${process.pid}-${Date.now()}.txt`);
      const probe = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(probeOut)}, process.env.RF_PUSH_REFS ?? "<unset>");\n`;
      const fx = pushFixture(old, probe);
      const fx2 = pushFixture(old);
      try {
        expect(skipPush(fx, "hotfix: verify broken").status).toBe(0);
        // stdin was already drained by the guard's `refs="$(cat)"`: the old export reads EOF
        expect(fs.readFileSync(probeOut, "utf8")).toBe("");

        expect(skipPush(fx2, "hotfix: verify broken").status).toBe(0);
        const line = fs.readFileSync(path.join(fx2.dir, ".git", "skip-verify.log"), "utf8");
        expect(line).toContain("docs/notes"); // logged as the checked-out HEAD …
        expect(line).not.toContain("feat/code"); // … not the branch actually pushed
      } finally {
        cleanup(fx);
        cleanup(fx2);
        fs.rmSync(probeOut, { force: true });
      }
    },
    HOOK_TIMEOUT,
  );
});
