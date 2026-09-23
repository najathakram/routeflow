import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// scripts/pre-merge-ancestry-check.mjs — the second 2026-09-22 gate hole: a PR
// landed without master's tip in its history. This spec builds a real, throwaway
// git repo per case (no network, no fixtures needed beyond git itself — merge-base
// --is-ancestor is a pure local-history question) and spawns the actual script,
// matching the repo's *-script.spec.ts convention (see ci-freshness-guard-script.spec.ts).

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/pre-merge-ancestry-check.mjs");

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function commitFile(cwd: string, relPath: string, contents: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, relPath)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relPath), contents);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function initRepo(dir: string) {
  spawnSync("git", ["init", "-q", "-b", "master", dir]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Ancestry Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function run(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("pre-merge-ancestry-check.mjs contract", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("T1 · REFUSE: a PR branch cut before master advanced, never rebased — head does not contain base's tip", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ancestry-refuse-"));
    initRepo(dir);
    commitFile(dir, "README.md", "base\n", "base");

    // Cut the PR branch here, BEFORE master advances.
    git(dir, ["checkout", "-q", "-b", "feature/stale"]);
    const featureSha = commitFile(dir, "feature.txt", "work\n", "feat: stale work");

    // Master advances without the feature branch ever picking it up.
    git(dir, ["checkout", "-q", "master"]);
    const masterSha = commitFile(
      dir,
      "master-only.txt",
      "new master work\n",
      "feat: master moved on",
    );

    const { status, stdout } = run(dir, ["--base", masterSha, "--head", featureSha]);

    // The bug's own wrong value: this landed with exit 0 and no ancestry check at
    // all on 2026-09-22 — pin the concrete refusal text, not just a nonzero exit.
    expect(stdout).toContain("REFUSE");
    expect(stdout).toContain(masterSha);
    expect(stdout).toContain(featureSha);
    expect(stdout).toContain("does not contain base");
    expect(status).toBe(1);
  });

  it("T2 · ACCEPT: a PR branch that rebased onto/merged master's tip — head contains base's tip", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ancestry-accept-"));
    initRepo(dir);
    commitFile(dir, "README.md", "base\n", "base");
    const masterSha = commitFile(dir, "master-only.txt", "master work\n", "feat: master moved on");

    // Branch cut AFTER master's tip, so master is an ancestor of head by construction.
    git(dir, ["checkout", "-q", "-b", "feature/current"]);
    const featureSha = commitFile(dir, "feature.txt", "work\n", "feat: current work");

    const { status, stdout } = run(dir, ["--base", masterSha, "--head", featureSha]);

    expect(stdout).toContain("OK");
    expect(stdout).toContain(masterSha);
    expect(stdout).toContain(featureSha);
    expect(status).toBe(0);
  });

  it("T3 (pin) an unresolvable --base ref refuses, naming which ref failed to resolve", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ancestry-unresolvable-"));
    initRepo(dir);
    const headSha = commitFile(dir, "README.md", "base\n", "base");

    const { status, stdout } = run(dir, ["--base", "refs/heads/does-not-exist", "--head", headSha]);

    expect(stdout).toContain("REFUSE");
    expect(stdout).toContain("could not resolve --base");
    expect(status).toBe(1);
  });

  it("T3 (pin) missing --base/--head prints usage and refuses", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ancestry-usage-"));
    initRepo(dir);
    commitFile(dir, "README.md", "base\n", "base");

    const { status, stderr } = run(dir, ["--base", "HEAD"]);

    expect(stderr).toContain("usage:");
    expect(status).toBe(1);
  });

  it("T4 · a real `git merge --squash` scenario pins the squash mechanism directly: a stale branch predating the squash commit REFUSES, a branch cut after it ACCEPTS", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ancestry-squash-"));
    initRepo(dir);
    commitFile(dir, "README.md", "base\n", "base"); // A

    // A real PR branch, later squash-merged into master.
    git(dir, ["checkout", "-q", "-b", "feature/squashed"]);
    const featureHeadSha = commitFile(
      dir,
      "feature.txt",
      "feature work\n",
      "feat: real feature work",
    );

    // The squash merge itself: `git merge --squash` stages the diff but records no
    // parent link to featureHeadSha, then `git commit` creates a NEW commit (single
    // parent = A) — the exact shape RouteFlow's "squash" merge strategy produces on
    // master (CLAUDE.md: "merge the PR to master (squash)"). This is the load-bearing
    // difference from every other test here: featureHeadSha is deliberately NOT an
    // ancestor of the resulting commit, even though its content landed.
    git(dir, ["checkout", "-q", "master"]);
    git(dir, ["merge", "--squash", "feature/squashed"]);
    git(dir, ["commit", "-q", "-m", "feat: real feature work (squash)"]);
    const squashSha = git(dir, ["rev-parse", "HEAD"]);
    // Sanity on the fixture itself: the squash commit's sole parent is A (master^),
    // confirming this really is the single-parent shape a squash merge produces —
    // not a two-parent merge commit that would trivially keep featureHeadSha an
    // ancestor and make the REFUSE assertion below meaningless.
    expect(
      spawnSync("git", ["merge-base", "--is-ancestor", "master^", squashSha], { cwd: dir }).status,
    ).toBe(0);

    // A second PR branch cut BEFORE the squash landed, never rebased — the exact
    // 2026-09-22 shape, now with a squash-merge commit as master's tip.
    git(dir, ["checkout", "-q", "-b", "feature/stale-before-squash", "master^"]);
    const staleSha = commitFile(
      dir,
      "stale.txt",
      "stale work\n",
      "feat: stale, predates the squash",
    );

    const refuse = run(dir, ["--base", squashSha, "--head", staleSha]);
    expect(refuse.stdout).toContain("REFUSE");
    expect(refuse.stdout).toContain(squashSha);
    expect(refuse.stdout).toContain(staleSha);
    expect(refuse.status).toBe(1);

    // A third PR branch cut AFTER the squash commit landed — contains it, by
    // construction.
    git(dir, ["checkout", "-q", "-b", "feature/after-squash", squashSha]);
    const afterSha = commitFile(dir, "after.txt", "after work\n", "feat: cut after the squash");

    const accept = run(dir, ["--base", squashSha, "--head", afterSha]);
    expect(accept.stdout).toContain("OK");
    expect(accept.status).toBe(0);

    // And the squashed PR's OWN branch tip is correctly NOT treated as containing
    // the squash commit it produced — squash merges break DAG ancestry on purpose,
    // and this script must reflect that rather than special-casing it.
    const ownBranchRefuse = run(dir, ["--base", squashSha, "--head", featureHeadSha]);
    expect(ownBranchRefuse.stdout).toContain("REFUSE");
    expect(ownBranchRefuse.status).toBe(1);
  });
});
