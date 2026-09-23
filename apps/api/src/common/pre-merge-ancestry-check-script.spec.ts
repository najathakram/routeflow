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
});
