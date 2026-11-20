import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// B1298: the trunk rule in .husky/pre-push judges the refs being PUSHED (git's pre-push stdin), not
// the checked-out branch. These cases install the REAL hook text in a fixture repo with a bare
// `origin`, push for real, and assert on the exit status, the output and `git ls-remote origin`.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: () => NodeJS.ProcessEnv;
};
const HOOK_TEXT = fs
  .readFileSync(path.join(REPO_ROOT, ".husky", "pre-push"), "utf8")
  .replace(/\r\n/g, "\n");
const HOOK_TIMEOUT = 60_000;
const NOTHING_TO_VERIFY = "branch delete only, nothing to verify";

function git(cwd: string, ...args: string[]) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: scrubbedGitEnv(),
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** Fixture repo on master, bare origin carrying master + feat/x + feat/y, the real hook installed. */
function fixture(opts: { withChecker?: boolean } = {}) {
  const withChecker = opts.withChecker ?? true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-b1298-work-"));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "rf-b1298-remote-"));
  git(remote, "init", "-q", "--bare");
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "branch", "feat/x");
  git(dir, "branch", "feat/y");
  git(dir, "push", "-q", "origin", "master", "feat/x", "feat/y"); // before the hook exists
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "push-guard.mjs"),
    path.join(dir, "scripts", "push-guard.mjs"),
  );
  if (withChecker) {
    // The hook runs the REAL G0 leak checker first (fail-closed). It needs its lib and a patterns file
    // in the fixture's git-common-dir; the pattern is a dummy that matches nothing.
    fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    for (const f of ["leak-check.mjs", path.join("lib", "leak-patterns.mjs")]) {
      fs.copyFileSync(path.join(REPO_ROOT, "scripts", f), path.join(dir, "scripts", f));
    }
    const common = path.resolve(dir, git(dir, "rev-parse", "--git-common-dir").trim());
    fs.mkdirSync(path.join(common, "info"), { recursive: true });
    fs.writeFileSync(path.join(common, "info", "leak-patterns"), "zz-fixture-never-matches-9f3\n");
  }
  for (const stub of ["size-ratchet-gate.mjs", "test-tamper-check.mjs", "skip-verify-audit.mjs"]) {
    fs.writeFileSync(path.join(dir, "scripts", stub), "process.exit(0);\n");
  }
  const hooks = path.join(dir, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh\n${HOOK_TEXT}`, { mode: 0o755 });
  return { dir, remote };
}

function push(fx: { dir: string }, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("git", ["push", ...args], {
    cwd: fx.dir,
    encoding: "utf8",
    shell: false,
    env: { ...scrubbedGitEnv(), ...env },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function remoteRefs(fx: { dir: string }) {
  return git(fx.dir, "ls-remote", "--heads", "origin")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t")[1]);
}

function withFixture(fn: (fx: ReturnType<typeof fixture>) => void) {
  return () => {
    const fx = fixture();
    try {
      fn(fx);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
      fs.rmSync(fx.remote, { recursive: true, force: true });
    }
  };
}

function onFeature(fx: { dir: string }) {
  git(fx.dir, "checkout", "-q", "-b", "feat/work");
  fs.writeFileSync(path.join(fx.dir, "b.txt"), "b\n");
  git(fx.dir, "add", "b.txt");
  git(fx.dir, "commit", "-q", "-m", "work");
}

describe("B1298: pre-push trunk rule judges the pushed refs", () => {
  it(
    "on master, deleting a feature branch succeeds and the remote branch is gone",
    withFixture((fx) => {
      const res = push(fx, ["origin", "--delete", "feat/x"]);
      expect(res.out).not.toContain("Direct push to");
      expect(res.status).toBe(0);
      expect(res.out).toContain(NOTHING_TO_VERIFY);
      expect(remoteRefs(fx)).not.toContain("refs/heads/feat/x");
    }),
    HOOK_TIMEOUT,
  );

  it(
    "on master, deleting master is refused and remote master stays",
    withFixture((fx) => {
      const res = push(fx, ["origin", "--delete", "master"]);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Direct push to master is blocked");
      expect(remoteRefs(fx)).toContain("refs/heads/master");
    }),
    HOOK_TIMEOUT,
  );

  it(
    "on a feature branch, deleting master is refused with the trunk message",
    withFixture((fx) => {
      onFeature(fx);
      const res = push(fx, ["origin", "--delete", "master"]);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Direct push to master is blocked");
      expect(remoteRefs(fx)).toContain("refs/heads/master");
    }),
    HOOK_TIMEOUT,
  );

  it(
    "on a feature branch, HEAD:master is refused and remote master is unchanged",
    withFixture((fx) => {
      onFeature(fx);
      const before = git(fx.dir, "ls-remote", "origin", "refs/heads/master");
      const res = push(fx, ["origin", "HEAD:master"]);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Direct push to master is blocked");
      expect(git(fx.dir, "ls-remote", "origin", "refs/heads/master")).toBe(before);
    }),
    HOOK_TIMEOUT,
  );

  it(
    "on master, a plain push of master is still refused (regression pin)",
    withFixture((fx) => {
      const res = push(fx, ["origin", "master"]);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Direct push to master is blocked");
    }),
    HOOK_TIMEOUT,
  );

  it(
    "on a feature branch, deleting another feature branch succeeds and says nothing to verify",
    withFixture((fx) => {
      onFeature(fx);
      const res = push(fx, ["origin", "--delete", "feat/x"]);
      expect(res.status).toBe(0);
      expect(res.out).toContain(NOTHING_TO_VERIFY);
      expect(remoteRefs(fx)).not.toContain("refs/heads/feat/x");
    }),
    HOOK_TIMEOUT,
  );

  it(
    "a push that deletes one branch AND pushes another does NOT take the delete-only exit",
    withFixture((fx) => {
      onFeature(fx);
      // SKIP_VERIFY=1 ends the normal path at the (stubbed) audit instead of running verify.
      const res = push(fx, ["origin", ":feat/y", "HEAD:refs/heads/feat/x"], {
        SKIP_VERIFY: "1",
        SKIP_VERIFY_REASON: "fixture",
      });
      expect(res.out).not.toContain(NOTHING_TO_VERIFY);
      expect(res.out).toContain("SKIP_VERIFY=1");
    }),
    HOOK_TIMEOUT,
  );

  it(
    "a fixture without scripts/leak-check.mjs refuses the push with a clear message and creates nothing",
    () => {
      const fx = fixture({ withChecker: false });
      try {
        onFeature(fx);
        const before = remoteRefs(fx);
        const res = push(fx, ["origin", "HEAD:refs/heads/feat/new"]);
        expect(res.status).not.toBe(0);
        expect(res.out).toContain("leak-check: scripts/leak-check.mjs is missing");
        expect(remoteRefs(fx)).toEqual(before);
      } finally {
        fs.rmSync(fx.dir, { recursive: true, force: true });
        fs.rmSync(fx.remote, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT,
  );
});
